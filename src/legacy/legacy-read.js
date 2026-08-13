// Back-office access to the Dynamics-365 staging tables (legacy_* — see
// migrations/1785542400000_legacy-d365-staging.js and docs/d365-export-analysis.md),
// with the office's own corrections merged over them.
//
// THE STAGING TABLES THEMSELVES ARE STILL READ-ONLY, and must stay that way:
// `importLegacyEntity` upserts every mapped column to EXCLUDED on the D365 GUID,
// and Atelier runs live on D365 until cutover, so anything written onto a
// legacy_ row is destroyed by the next `npm run import:legacy` with no error.
// Corrections therefore live in `d365_overrides`, outside the namespace
// (migration 1787025600000), and are applied HERE, at read time. Do not add a
// write to a legacy_ table in this module or any other.
//
// WHY THE MERGE IS IN SQL AND NOT IN mapRow. `q`, every filter and the ORDER BY
// all have to see the corrected value, and `meta.total` has to count it. A JS
// overlay applied after the query would mean a customer renamed here is
// unfindable by the corrected name, and pagination would count rows the user is
// looking at a different set of. That is the whole cost of this module's shape
// and it is deliberate.
//
// WHY THERE ARE TWO QUERY PATHS. The merged CTE cannot use the base table's
// index — it orders on a CASE expression — so on legacy_product_prices (19,327
// rows) a page goes from a 22 ms index scan to a ~120 ms sequential scan, twice
// over, because the count runs it too. Overrides will number in the tens against
// tens of thousands of staging rows, so an entity nobody has corrected takes the
// original query unchanged and pays nothing for a feature it is not using. The
// gate is one indexed existence check. Both projections are generated from the
// same column array and test/legacy-overrides.test.js asserts the two paths
// return identical rows, which is what keeps them from drifting.

import {
  ENTITIES,
  LEGACY_ENTITIES,
  entityConfig,
} from './read-entities.js'
import { SYNTHETIC_COLUMNS, baseSnapshotSql, mergedProjection } from './override-schema.js'

export { LEGACY_ENTITIES, ENTITIES, entityConfig }

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

// Numeric columns come back from pg as strings; coerce so the CRM gets numbers.
const num = (v) => (v === null || v === undefined ? null : Number(v))

/**
 * Coerce the numeric columns of a row to Number and turn the merged read's
 * `is_local` into the `origin` the CRM renders. `origin` is derived from which
 * UNION branch emitted the row, never read back from a stored column, so it
 * cannot contradict the tables.
 */
const mapRow = (row, config) => {
  const { is_local: isLocal, ...rest } = row
  const out = { ...rest }
  for (const col of config.numeric) {
    if (col in out) out[col] = num(out[col])
  }
  out.origin = isLocal ? 'local' : 'd365'
  if (!Object.hasOwn(out, 'overridden_fields')) out.overridden_fields = []
  if (!Object.hasOwn(out, 'archived_at')) out.archived_at = null
  // The fast path selects the staging columns only, so the synthetic ones have
  // to be defaulted here or a key appears and disappears depending on whether
  // anyone has ever corrected this entity.
  if (!Object.hasOwn(out, 'custom_fields')) out.custom_fields = {}
  return out
}

const escapeLike = (value) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/**
 * Build WHERE fragments + params from the search term and whitelisted filters,
 * EXTENDING the caller's param list rather than assuming it starts at $1 — the
 * merged CTE binds its own parameters first. Copies the array instead of
 * appending to it, the posture buildReportFilters takes.
 */
const buildWhere = (config, { q, filters = {} } = {}, bound = []) => {
  const clauses = []
  const params = [...bound]

  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    const ors = config.search.map((col) => `${col} ILIKE $${i} ESCAPE '\\'`)
    clauses.push(`(${ors.join(' OR ')})`)
  }

  for (const [key, type] of Object.entries(config.filters)) {
    const value = filters[key]
    if (value === undefined || value === null || value === '') continue
    if (type === 'boolean') {
      params.push(value === true || value === 'true')
    } else {
      params.push(value)
    }
    clauses.push(`${key} = $${params.length}`)
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * The synthetic columns every merged row carries, in projection order. Named in
 * override-schema.js beside the projection that emits them, so this list cannot
 * disagree with that one about either membership or order.
 */
const MERGED_EXTRAS = SYNTHETIC_COLUMNS

/**
 * The `merged` CTE: the staging rows with their corrections applied, plus the
 * records that exist only here.
 *
 * `WHERE (o.archived_at IS NULL OR $2)` on the LEFT JOIN is correct and must NOT
 * be "fixed" into the ON clause. `IS NULL` is true for the all-NULL non-matching
 * side, so the join does not degrade to an inner one; moving the predicate into
 * ON would make suppression a no-op, because an archived override row would
 * simply fail to join and the staging row would be emitted uncorrected. Only an
 * IS NULL test on the nullable side is safe in the WHERE — any other predicate
 * on `o.*` there silently turns it into an inner join.
 *
 * The local branch's `NOT EXISTS` against the staging table is what makes one
 * guid impossible to emit twice: if a D365 record ever lands under a locally
 * minted guid, the local branch stops emitting and the staged branch takes over
 * with the patch applied.
 */
const mergedSource = (entity, { includeArchived = false, guid = null } = {}) => {
  const config = entityConfig(entity)
  const { staged, local } = mergedProjection(entity)
  const params = [entity, includeArchived]

  let stagedGuid = ''
  let localGuid = ''
  if (guid) {
    params.push(guid)
    stagedGuid = ` AND t.guid = $${params.length}`
    localGuid = ` AND o.guid = $${params.length}`
  }

  const cte = `WITH merged AS (
      SELECT ${staged.join(',\n             ')}
        FROM ${config.table} t
        LEFT JOIN d365_overrides o ON o.entity = $1 AND o.guid = t.guid
       WHERE (o.archived_at IS NULL OR $2)${stagedGuid}
      UNION ALL
      SELECT ${local.join(',\n             ')}
        FROM d365_overrides o
       WHERE o.entity = $1
         AND o.local
         AND (o.archived_at IS NULL OR $2)
         AND NOT EXISTS (SELECT 1 FROM ${config.table} t WHERE t.guid = o.guid)${localGuid}
    )`

  return { cte, params, columns: [...config.columns, ...MERGED_EXTRAS] }
}

/** Does this entity have any correction at all? One indexed lookup. */
const hasOverrides = async (db, entity) => {
  const { rowCount } = await db.query(
    'SELECT 1 FROM d365_overrides WHERE entity = $1 LIMIT 1',
    [entity]
  )
  return rowCount > 0
}

/**
 * Paginated, searchable, filtered list of one legacy entity, with the office's
 * corrections merged in.
 *
 * @param {import('pg').Pool} pool
 * @param {string} entity  one of LEGACY_ENTITIES
 * @param {{ q?: string, filters?: object, page?: number, limit?: number,
 *           includeArchived?: boolean, forceMerge?: boolean }} [opts]
 *   `forceMerge` exists so a test can drive the merged path against a database
 *   with no overrides in it and assert it agrees with the fast one.
 * @returns {Promise<{ items: object[], total: number, page: number, limit: number, merged: boolean }>}
 */
export const listLegacy = async (
  pool,
  entity,
  { q, filters, page, limit, includeArchived = false, forceMerge = false } = {}
) => {
  const config = entityConfig(entity)
  const safePage = Number.isInteger(page) && page > 0 ? page : 1
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const merged = forceMerge || (await hasOverrides(pool, entity))

  const source = merged
    ? mergedSource(entity, { includeArchived })
    : { cte: '', params: [], columns: config.columns }
  const from = merged ? 'merged' : config.table

  const { where, params } = buildWhere(config, { q, filters }, source.params)

  const countResult = await pool.query(
    `${source.cte} SELECT COUNT(*)::int AS total FROM ${from} ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const listResult = await pool.query(
    `${source.cte}
     SELECT ${source.columns.join(', ')}
       FROM ${from}
       ${where}
      ORDER BY ${config.order}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    items: listResult.rows.map((row) => mapRow(row, config)),
    total,
    page: safePage,
    limit: safeLimit,
    merged,
  }
}

/**
 * Which of a record's corrections D365 has since moved underneath.
 *
 * `base` holds what the staging row said when the correction was made, so a key
 * whose staged value has changed since is one where the office corrected a field
 * that has now been corrected upstream too — a work queue, not an error. Without
 * it an override masks every future upstream change to that field silently and
 * for ever. Both sides are `to_jsonb(<column>)` so the comparison is exact.
 *
 * Skipped for a local record and for an override whose record has not landed:
 * there is no source to have diverged from, and comparing against an absent row
 * would report every field stale.
 */
const overrideDetailSql = (entity) => {
  const config = entityConfig(entity)
  return `SELECT o.patch, o.base, o.local, o.archived_at, o.created_at, o.updated_at,
                 o.created_by_user_id, o.updated_by_user_id,
                 u.name AS updated_by_name, u.email AS updated_by_email,
                 CASE WHEN o.local OR t.guid IS NULL THEN '{}'::text[] ELSE ARRAY(
                   SELECT k FROM jsonb_object_keys(o.patch) AS k
                    WHERE o.base->k IS DISTINCT FROM (${baseSnapshotSql(entity, 't')})->k
                 ) END AS stale_fields
            FROM d365_overrides o
            LEFT JOIN ${config.table} t ON t.guid = o.guid
            LEFT JOIN users u ON u.id = o.updated_by_user_id
           WHERE o.entity = $1 AND o.guid = $2`
}

const toOverrideDetail = (row) =>
  row
    ? Object.freeze({
        fields: Object.keys(row.patch ?? {}),
        stale_fields: row.stale_fields ?? [],
        // What D365 said when the correction was made, for the columns corrected.
        base: Object.fromEntries(
          Object.keys(row.patch ?? {}).map((key) => [key, row.base?.[key] ?? null])
        ),
        local: row.local,
        archived_at: row.archived_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by: row.updated_by_user_id
          ? { id: row.updated_by_user_id, name: row.updated_by_name, email: row.updated_by_email }
          : null,
      })
    : null

/**
 * One legacy record by its Dynamics GUID, corrections applied.
 *
 * `raw`, `imported_at` and `source_file` are the STAGING row exactly as D365
 * exported it and are never patched — that is the point of returning them beside
 * a merged record, and it is why the payload also carries `override` saying
 * which columns differ and what they said before. All three are null for a
 * locally created record: there is no export behind it.
 *
 * A suppressed record is still readable here (`includeArchived`), because the
 * restore screen has to be able to read the thing it is restoring — the same
 * rule every by-id admin read in this API follows.
 *
 * @returns {Promise<object|null>} null when the guid is unknown
 */
export const getLegacy = async (pool, entity, guid, { includeArchived = true } = {}) => {
  const config = entityConfig(entity)
  const source = mergedSource(entity, { includeArchived, guid })

  // Every merged column is qualified: `guid` exists on both sides of the join to
  // the staging row, so a bare projection is a 42702 "column reference is
  // ambiguous" rather than anything subtler.
  const { rows } = await pool.query(
    `${source.cte}
     SELECT ${source.columns.map((column) => `merged.${column}`).join(', ')},
            s.raw, s.imported_at, s.source_file
       FROM merged
       LEFT JOIN ${config.table} s ON s.guid = merged.guid`,
    source.params
  )
  if (!rows[0]) return null

  const { rows: overrideRows } = await pool.query(overrideDetailSql(entity), [entity, guid])
  return { ...mapRow(rows[0], config), override: toOverrideDetail(overrideRows[0]) }
}

/**
 * Does a record exist under this guid at all — as a staging row, or as a record
 * that only exists here? The write layer's 404 is decided by this and never by
 * the rowCount of an UPDATE against `d365_overrides`: the common case for a
 * correction or a suppression is a record with no override row yet.
 */
export const legacyRecordExists = async (db, entity, guid) => {
  const config = entityConfig(entity)
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM ${config.table} WHERE guid = $1) AS staged,
            EXISTS (SELECT 1 FROM d365_overrides WHERE entity = $2 AND guid = $1 AND local) AS local`,
    [guid, entity]
  )
  return { staged: rows[0].staged, local: rows[0].local, exists: rows[0].staged || rows[0].local }
}
