// The showroom address book — where samples stand and where sample orders are
// sent. Back-office reads and writes, mirroring src/suppliers/admin-suppliers.js
// and ../samples/admin-samples.js beside it.
//
// This module exists because W4-US-008 draws `AdminShowrooms` in the CRM and no
// API story creates the routes it calls: `showrooms` had a table (W4-US-001), an
// `archived_at` and nothing else. Both samples screens need it, not just the
// showrooms one — the register's `showroom_id` filter and the sample form's
// showroom picker are lists of showrooms, and there was no list.
//
// A showroom is a plain address-book row, deliberately: name, address, city,
// three contact fields, notes. It records where a place IS and who to ring, and
// nothing about what stands in it — that is `samples.showroom_id` and
// `sample_orders.showroom_id`, each pointing this way.
//
// Two shaping decisions worth naming:
//   - **The child counts are on the by-id read, never on the list.** They are
//     the only advance warning that Delete will be refused (the CRUD kit forbids
//     a pre-flight "can I delete this" GET, which would race the delete), and
//     they count ARCHIVED rows too, exactly as the delete probes do — a count
//     that filtered `archived_at` would report an empty showroom and then be
//     contradicted by the 409. Same posture as `GET /admin/brands/:id`.
//   - **`name` is the one required column and it is UNIQUE**, so a duplicate is
//     the database's 23505 mapped to a 409, never a pre-check that races.

import { buildUpdate } from '../catalogue/admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Keyed on the constraint name, as every other write module here is: an unknown
// key degrades the MESSAGE and never the status.
const CONFLICT_MESSAGES = Object.freeze({
  showrooms_name_key: 'A showroom with that name already exists.',
})

const rethrowWriteError = (error) => {
  if (error?.code === '23505') {
    throw httpError(
      409,
      CONFLICT_MESSAGES[error.constraint] ?? 'That showroom detail is already in use.'
    )
  }
  // `name` is NOT NULL. The route schema requires it on create and types it
  // `string` on a PATCH, so this is the direct caller's answer — a rejected
  // value must not surface as a 500.
  if (error?.code === '23502' && error.column === 'name') {
    throw httpError(422, 'A showroom needs a name.')
  }
  throw error
}

// Frozen, in-code, and the same list on create and PATCH — column names are
// never user input. Timestamps are absent (the UPDATE stamps `updated_at`
// itself) and so is `archived_at`, which setArchived owns.
export const SHOWROOM_UPDATE_COLUMNS = Object.freeze([
  'name',
  'address',
  'city',
  'contact_name',
  'contact_email',
  'contact_phone',
  'notes',
])

const SHOWROOM_COLUMNS = `id, name, address, city, contact_name, contact_email,
              contact_phone, notes, created_at, updated_at, archived_at`

// Archived children count too — archiving is not deletion, and the probes behind
// the 409 count them, so a count that skipped them would disagree with the
// refusal a staff member is about to see.
const SHOWROOM_COUNT_COLUMNS = `(SELECT count(*)::int FROM samples s WHERE s.showroom_id = showrooms.id)
                AS sample_count,
              (SELECT count(*)::int FROM sample_orders o WHERE o.showroom_id = showrooms.id)
                AS sample_order_count`

const toShowroom = (row, extra) =>
  Object.freeze({
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    ...extra,
  })

// Escape the LIKE wildcards so a name containing an underscore matches that
// literal character. Pairs with ESCAPE '\' in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const buildWhere = ({ q, includeArchived }) => {
  const clauses = []
  const params = []

  if (!includeArchived) {
    clauses.push('archived_at IS NULL')
  }

  // A blank/whitespace term is ignored, not treated as "match nothing".
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // The three ways staff arrive at a showroom: what it is called, what town it
    // is in, and who they deal with there.
    clauses.push(`(
      name ILIKE $${i} ESCAPE '\\'
      OR city ILIKE $${i} ESCAPE '\\'
      OR contact_name ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/**
 * Filtered, paginated showrooms. Returns { showrooms, total } — the route builds
 * the meta envelope, as every other admin list here does.
 *
 * The query is alias-free, because SHOWROOM_COLUMNS is unqualified: adding an
 * alias later would break the projection (the same rule BRAND_COLUMNS carries).
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, includeArchived?: boolean, page?: number, limit?: number }} [options]
 * @returns {Promise<{ showrooms: object[], total: number }>}
 */
export const listShowrooms = async (
  pool,
  { q, includeArchived = false, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere({ q, includeArchived })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM showrooms ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${SHOWROOM_COLUMNS}
       FROM showrooms
       ${where}
      ORDER BY name ASC, id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    showrooms: rows.map((row) => toShowroom(row)),
    total: countResult.rows[0].total,
  }
}

/**
 * One showroom by id, carrying the counts of what points at it, or null when the
 * id is unknown.
 *
 * No archived filter, like every other by-id admin read here: the caller already
 * knows the row exists, and the restore screen has to be able to read back the
 * archive it just made.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getShowroom = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${SHOWROOM_COLUMNS},
            ${SHOWROOM_COUNT_COLUMNS}
       FROM showrooms
      WHERE id = $1`,
    [id]
  )
  if (!rows[0]) return null
  return toShowroom(rows[0], {
    sample_count: rows[0].sample_count,
    sample_order_count: rows[0].sample_order_count,
  })
}

/**
 * Open a showroom. `name` is required and unique; a duplicate is the database's
 * 23505, mapped to a 409 here.
 *
 * Every write returns through `getShowroom`, so a create, a patch, an archive
 * and a plain read all hand the CRM the SAME shape — counts included. That costs
 * one round trip and buys one renderer instead of two.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createShowroom = async (pool, input) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO showrooms
         (name, address, city, contact_name, contact_email, contact_phone, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.name,
        input.address ?? null,
        input.city ?? null,
        input.contact_name ?? null,
        input.contact_email ?? null,
        input.contact_phone ?? null,
        input.notes ?? null,
      ]
    )
    return getShowroom(pool, rows[0].id)
  } catch (error) {
    return rethrowWriteError(error)
  }
}

/**
 * Patch a showroom from the frozen whitelist. `Object.hasOwn` (inside
 * buildUpdate) keeps an explicit null — which clears a nullable column — distinct
 * from an absent key.
 *
 * `name` is renameable: unlike a slug it is not a URL and nothing addresses a
 * showroom by it (`samples.showroom_id` and `sample_orders.showroom_id` both
 * point at the id), so a correction is safe and a collision is the same 409 the
 * create answers with.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateShowroom = async (pool, id, input) => {
  const { sets, params } = buildUpdate(input, SHOWROOM_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE showrooms SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING id`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Showroom ${id} not found.`)
    }
    return getShowroom(pool, id)
  } catch (error) {
    return rethrowWriteError(error)
  }
}

/**
 * Soft-archive (archived=true) or restore (archived=false) a showroom, stamping
 * `updated_at`. Returns the fresh row, or null when the id is unknown.
 *
 * This is the alternative a blocked DELETE offers, and for a showroom it is
 * usually the only one: `sample_orders.showroom_id` is NOT NULL and RESTRICT, so
 * a showroom that has ever been sent an order can never be removed without
 * destroying where the order was going.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object|null>}
 */
export const setShowroomArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'showroom', id, archived, {
    extraSets: ['updated_at = now()'],
    returning: 'id',
  })
  return row ? getShowroom(pool, row.id) : null
}
