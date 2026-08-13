// Back-office supplier price-list management (read model + writes).
//
// The importer (src/seed/price-lists.js) lands whole per-brand price-list drops;
// this module is the hand-editing surface the back office drives from the CRM:
// browse/search the ledger, add a one-off item, correct a rate, and soft-archive
// or restore a row. Handlers stay thin — the SQL + rules live here.
//
// Three details shape the module:
//   - `code_normalized` is DERIVED, never accepted from the client. It mirrors
//     scripts/convert-price-lists.js (platform decision 6) so a hand-keyed item
//     normalises exactly like an imported one, and it is recomputed whenever the
//     raw `code` changes so the two never drift apart.
//   - `repeat` is a Postgres non-reserved keyword and MUST be quoted as "repeat"
//     in SQL. buildUpdate interpolates the bare column name, so it cannot carry
//     `repeat`; the PATCH builder handles it with a dedicated quoted fragment
//     instead (see updatePriceListItem).
//   - pg returns numeric(12,4) as a STRING, so the mapper coerces wholesale_rate
//     back to a number before it reaches the client.

import { buildUpdate } from '../catalogue/admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'
import {
  withChangeContext,
  requireChangeReason,
  raisePriceHistoryError,
} from './price-history.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// (supplier, category, code) is unique. A duplicate is a client mistake, not a
// server fault, so the pg 23505 becomes a friendly 409 rather than a 500. Only
// this one constraint exists on the table, so a single message is enough.
const rethrowConflict = (error) => {
  if (error?.code === '23505') {
    throw httpError(
      409,
      'A price-list item with that supplier, category and code already exists.'
    )
  }
  throw error
}

// Uniform code format (platform decision 6): uppercase, every run of
// non-alphanumerics collapsed to a single '-', with no leading/trailing '-'.
// Mirrors the `code_normalized` regex in scripts/convert-price-lists.js.
const normalizeCode = (code) =>
  String(code)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// A code with no letters or digits (e.g. all punctuation/whitespace) normalises
// to '' — that is a user input mistake, so surface a 422 rather than store an
// empty normalized code or let notNull throw an opaque 500. Same posture as
// slugFrom in admin-brands.js.
const deriveNormalizedCode = (code) => {
  const normalized = normalizeCode(code)
  if (normalized === '') {
    throw httpError(422, 'Code must contain at least one letter or number.')
  }
  return normalized
}

// Columns a PATCH may write. `supplier` is deliberately absent (it is part of
// the identity key and immutable here), as are `code_normalized` (server-derived)
// and `source_file` (provenance). `repeat` is absent too — it needs quoting and
// is handled separately in updatePriceListItem.
const EDITABLE_COLUMNS = Object.freeze([
  'product_range',
  'description',
  'contents',
  'unit',
  'width',
  'vertical_repeat',
  'duty_class',
  'wholesale_rate',
  'currency',
  'freight_class',
  'date_effective',
  'category',
  'code',
  'code_normalized',
])

// The DERIVED half of drop detection: a later import covered this row's
// (supplier, category) and did not name it. Stored `discontinued_at` is the
// other half — a staff decision — and the two are not the same fact: without
// the derived state a partial file silently produces nothing, and without the
// stored one there is no way to dismiss a wrong suspicion.
//
// A row nothing has ever imported is NOT suspect (both sides NULL), and neither
// is a whole (supplier, category) no import has covered. Cheap because
// 1788753600000 indexes (supplier, category, last_seen_in_import), so the max
// is an index-only backward scan.
const SUSPECT_SQL = `(price_list_items.last_seen_in_import IS DISTINCT FROM (
    SELECT max(s.last_seen_in_import) FROM price_list_items s
     WHERE s.supplier = price_list_items.supplier
       AND s.category = price_list_items.category
  )) AS suspect`

// Full row projection. "repeat" is quoted (reserved-ish keyword); pg still keys
// the returned object as `repeat`.
const ROW_COLUMNS = `id, supplier, product_range, category, code, code_normalized,
  description, contents, unit, width, "repeat", vertical_repeat, duty_class,
  wholesale_rate, currency, freight_class, date_effective, source_file,
  created_at, updated_at, archived_at,
  last_seen_in_import, last_seen_source_file, discontinued_at`

// What a READ selects: the row plus the derived state. Unqualified apart from
// SUSPECT_SQL's own correlation, so every query using it must stay alias-free
// (`FROM price_list_items`) — the rule BRAND_COLUMNS already carries. It is
// deliberately NOT used as a RETURNING projection: the correlated subquery
// would be evaluated against the pre-statement snapshot, so every write here
// re-reads through getPriceListItem instead and one query owns the shape.
const READ_COLUMNS = `${ROW_COLUMNS}, ${SUSPECT_SQL}`

// Turns a DB row into the public admin shape. Immutable: builds a fresh frozen
// object, never mutates the row. wholesale_rate arrives as a numeric string, so
// coerce it back to a number.
const toPriceListItem = (row) =>
  Object.freeze({
    id: row.id,
    supplier: row.supplier,
    product_range: row.product_range,
    category: row.category,
    code: row.code,
    code_normalized: row.code_normalized,
    description: row.description,
    contents: row.contents,
    unit: row.unit,
    width: row.width,
    repeat: row.repeat,
    vertical_repeat: row.vertical_repeat,
    duty_class: row.duty_class,
    wholesale_rate: Number(row.wholesale_rate),
    currency: row.currency,
    freight_class: row.freight_class,
    date_effective: row.date_effective,
    source_file: row.source_file,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    // Drop detection. `discontinued_at` is the SUPPLIER's decision recorded by
    // staff; `archived_at` above is staff taking the row out of their own list.
    // Neither implies the other and a discontinued item blocks nothing.
    last_seen_in_import: row.last_seen_in_import ?? null,
    last_seen_source_file: row.last_seen_source_file ?? null,
    discontinued_at: row.discontinued_at ?? null,
    suspect: row.suspect === true,
  })

// Escape the LIKE wildcards so a search for "100%" matches a literal percent
// rather than everything. Pairs with the ESCAPE '\' clause in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// Build the WHERE fragments + bound params for the list query. Filter names are
// trusted column references; filter *values* always flow through $n placeholders.
const buildWhere = ({ supplier, category, q, includeArchived }) => {
  const clauses = []
  const params = []

  // Archived rows are hidden from the default working list; the caller opts in.
  if (!includeArchived) {
    clauses.push('archived_at IS NULL')
  }
  if (supplier) {
    params.push(supplier)
    clauses.push(`supplier = $${params.length}`)
  }
  if (category) {
    params.push(category)
    clauses.push(`category = $${params.length}`)
  }

  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    clauses.push(`(
      code ILIKE $${i} ESCAPE '\\'
      OR description ILIKE $${i} ESCAPE '\\'
      OR product_range ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/**
 * Filtered, paginated price-list items. `q` is a free-text ILIKE over code,
 * description and product_range. Returns { items, total } — the route builds the
 * meta envelope. Ordered supplier, code, id for a stable, browsable list.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   supplier?: string,
 *   category?: string,
 *   q?: string,
 *   includeArchived?: boolean,
 *   page?: number,
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{ items: object[], total: number }>}
 */
export const listPriceListItems = async (
  pool,
  { supplier, category, q, includeArchived = false, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere({ supplier, category, q, includeArchived })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM price_list_items ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const { rows } = await pool.query(
    `SELECT ${READ_COLUMNS} FROM price_list_items
     ${where}
     ORDER BY supplier ASC, code ASC, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return { items: rows.map(toPriceListItem), total }
}

/**
 * One item by id, or null when it does not exist.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getPriceListItem = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${READ_COLUMNS} FROM price_list_items WHERE id = $1`,
    [id]
  )
  return rows[0] ? toPriceListItem(rows[0]) : null
}

/**
 * Insert a hand-keyed item. `code_normalized` is derived from the code and
 * `source_file` defaults to 'manual-entry' so a manual row is distinguishable
 * from an imported one. A duplicate (supplier, category, code) is a 409.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createPriceListItem = async (pool, input) => {
  const codeNormalized = deriveNormalizedCode(input.code)
  try {
    const { rows } = await pool.query(
      `INSERT INTO price_list_items
         (supplier, product_range, category, code, code_normalized, description,
          contents, unit, width, "repeat", vertical_repeat, duty_class,
          wholesale_rate, currency, freight_class, date_effective, source_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        input.supplier,
        input.product_range ?? null,
        input.category,
        input.code,
        codeNormalized,
        input.description ?? null,
        input.contents ?? null,
        input.unit,
        input.width ?? null,
        input.repeat ?? null,
        input.vertical_repeat ?? null,
        input.duty_class ?? null,
        input.wholesale_rate,
        input.currency,
        input.freight_class ?? null,
        input.date_effective ?? null,
        input.source_file ?? 'manual-entry',
      ]
    )
    // Re-read: `suspect` is derived from the row's whole (supplier, category)
    // group, which a RETURNING projection cannot see.
    return getPriceListItem(pool, rows[0].id)
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Read the rate back so a patch that does not actually move it needs no reason.
 * Advisory only, and deliberately outside the transaction: the table's CHECK is
 * the real gate, so a value that changed under this read simply arrives at the
 * database and is refused there. Probe first, database as backstop — the same
 * order deleteOrExplain takes with its 23503.
 */
const rateIsMoving = async (pool, id, next) => {
  const { rows } = await pool.query(
    `SELECT wholesale_rate FROM price_list_items WHERE id = $1`,
    [id]
  )
  if (rows.length === 0) {
    throw httpError(404, `Price-list item ${id} not found.`)
  }
  return Number(rows[0].wholesale_rate) !== Number(next)
}

/**
 * Patch an item. Only EDITABLE_COLUMNS (plus the quoted "repeat") are ever
 * written; every value is a bound placeholder. When `code` changes,
 * `code_normalized` is recomputed so the pair stays in lockstep. 404 when the id
 * is unknown; a duplicate key is a 409.
 *
 * A patch that MOVES `wholesale_rate` demands `input.reason` and answers 422
 * without it — Shalakha's rule, and it lives here rather than in the route so it
 * holds for the CRM, the AdminJS panel and any future caller (the `updateUser`
 * posture). A patch that restates the same rate is not a change and needs
 * nothing. The write runs inside a transaction that declares the change source,
 * because that declaration is how the capture trigger learns who and why; see
 * src/pricing/price-history.js.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @param {{ user?: { id: number } }} [ctx]
 * @returns {Promise<object>}
 */
export const updatePriceListItem = async (pool, id, input, ctx = {}) => {
  // Recompute code_normalized in lockstep with a code change; leave it untouched
  // otherwise (it is never client-supplied).
  const patch = Object.hasOwn(input, 'code')
    ? { ...input, code_normalized: deriveNormalizedCode(input.code) }
    : input

  // Reuse the shared whitelist builder for the plain columns. It throws on an
  // empty set, so only call it when at least one whitelisted column is present —
  // a body of only { repeat } must still update.
  let sets = []
  let params = []
  if (EDITABLE_COLUMNS.some((column) => Object.hasOwn(patch, column))) {
    ;({ sets, params } = buildUpdate(patch, EDITABLE_COLUMNS))
  }

  // "repeat" is handled here because it must be quoted — buildUpdate can't.
  if (Object.hasOwn(patch, 'repeat')) {
    params.push(patch.repeat)
    sets.push(`"repeat" = $${params.length}`)
  }

  if (sets.length === 0) {
    // Unreachable while the schema enforces minProperties:1 over the editable
    // set; guarded because an empty SET clause is invalid SQL.
    throw httpError(400, 'No updatable fields provided.')
  }

  const reason =
    Object.hasOwn(patch, 'wholesale_rate') &&
    (await rateIsMoving(pool, id, patch.wholesale_rate))
      ? requireChangeReason(input.reason)
      : null

  try {
    const updatedId = await withChangeContext(
      pool,
      { source: 'manual', reason, userId: ctx.user?.id ?? null },
      async (client) => {
        const { rows } = await client.query(
          `UPDATE price_list_items SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $${params.length + 1}
            RETURNING id`,
          [...params, id]
        )
        if (rows.length === 0) {
          throw httpError(404, `Price-list item ${id} not found.`)
        }
        return rows[0].id
      }
    )
    return getPriceListItem(pool, updatedId)
  } catch (error) {
    // The trigger's own refusals first (a wiring fault or a missing reason that
    // slipped past the pre-check), then the existing duplicate-key path.
    raisePriceHistoryError(error)
    return rethrowConflict(error)
  }
}

/**
 * Soft-archive (archived=true) or restore (archived=false) an item, stamping
 * updated_at. Returns the fresh row, or null when the id is unknown.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object|null>}
 */
export const setPriceListItemArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'price_list_item', id, archived, {
    extraSets: ['updated_at = now()'],
    returning: 'id',
  })
  // Re-read for the same reason the create does: `suspect` is a fact about the
  // row's whole (supplier, category) group and cannot ride on a RETURNING.
  return row ? getPriceListItem(pool, row.id) : null
}

// Drop detection. One statement, so the coverage it reports and the rows it
// marks come off ONE snapshot and the sentence staff read cannot be a lie about
// what happened.
//
// SCOPE IS (supplier, category) AND NOT A FILE. Filenames carry the year
// ("BOUSSAC FABRIC PL 2026.csv") and change annually, so file-to-file has no
// stable key; per supplier is wrong the other way, because a house that sends
// only its wallpaper list in March would mark its whole fabric range
// discontinued.
//
// `latest` is the group's most recent import, not a wall-clock date: a row is
// only ever judged against an import that actually covered its own
// (supplier, category).
const MARK_DISCONTINUED_SQL = `
  WITH latest AS (
    SELECT max(last_seen_in_import) AS at
      FROM price_list_items
     WHERE supplier = $1 AND category = $2
  ),
  scope AS (
    SELECT last_seen_in_import, last_seen_source_file
      FROM price_list_items
     WHERE supplier = $1 AND category = $2
  ),
  marked AS (
    UPDATE price_list_items p
       SET discontinued_at = now()
     WHERE p.supplier = $1 AND p.category = $2
       AND p.discontinued_at IS NULL
       AND (SELECT at FROM latest) IS NOT NULL
       AND p.last_seen_in_import IS DISTINCT FROM (SELECT at FROM latest)
    RETURNING p.id
  )
  SELECT (SELECT count(*)::int FROM scope) AS held,
         (SELECT count(*)::int FROM scope
           WHERE last_seen_in_import = (SELECT at FROM latest)) AS covered,
         (SELECT count(*)::int FROM marked) AS marked,
         (SELECT at FROM latest) AS last_import_at,
         (SELECT last_seen_source_file FROM scope
           WHERE last_seen_in_import = (SELECT at FROM latest) LIMIT 1) AS last_source_file`

const groupLabel = (supplier, category) => `${supplier} ${category}`

/**
 * Mark every item of one (supplier, category) that the group's most recent
 * import did not name as discontinued. An EXPLICIT STAFF ACT: no import run
 * ever flags anything, it only records what it saw.
 *
 * The response states coverage before anything else — "this file covered 412 of
 * the 2,516 codes we hold for Boussac fabric" — because that number is the whole
 * defence against a partial file. No percentage threshold is coded.
 * ponytail: add a refusal ceiling (and a `confirm` flag to override it) the
 * first time somebody actually clicks through a coverage number that low; the
 * count is already in hand, so it is one comparison.
 *
 * @param {import('pg').Pool} pool
 * @param {{ supplier: string, category: string }} scope
 * @returns {Promise<Readonly<object>>}
 */
export const markPriceListItemsDiscontinued = async (pool, { supplier, category }) => {
  const { rows } = await pool.query(MARK_DISCONTINUED_SQL, [supplier, category])
  const { held, covered, marked, last_import_at, last_source_file } = rows[0]

  if (held === 0) {
    throw httpError(422, `No price-list items are held for ${groupLabel(supplier, category)}.`)
  }
  // Nothing marked and nothing markable: with no import behind the group there
  // is no statement about what a supplier still lists, so there is nothing to
  // infer from. A 422 rather than a 200 saying "0" — those read the same on a
  // screen and only one of them is something a person can act on.
  if (last_import_at === null) {
    throw httpError(
      422,
      `No import has covered ${groupLabel(supplier, category)}, so there is nothing ` +
        'to compare against. Run npm run import:pricing with that supplier\'s file first.'
    )
  }

  return Object.freeze({
    supplier,
    category,
    held,
    covered,
    marked,
    last_import_at,
    last_source_file,
    message:
      `${last_source_file ?? 'The last import'} covered ${covered} of the ${held} ` +
      `codes held for ${groupLabel(supplier, category)} — marked ${marked} discontinued.`,
  })
}
