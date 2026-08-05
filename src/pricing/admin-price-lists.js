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

// Full row projection. "repeat" is quoted (reserved-ish keyword); pg still keys
// the returned object as `repeat`.
const ROW_COLUMNS = `id, supplier, product_range, category, code, code_normalized,
  description, contents, unit, width, "repeat", vertical_repeat, duty_class,
  wholesale_rate, currency, freight_class, date_effective, source_file,
  created_at, updated_at, archived_at`

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
    `SELECT ${ROW_COLUMNS} FROM price_list_items
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
    `SELECT ${ROW_COLUMNS} FROM price_list_items WHERE id = $1`,
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
       RETURNING ${ROW_COLUMNS}`,
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
    return toPriceListItem(rows[0])
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Patch an item. Only EDITABLE_COLUMNS (plus the quoted "repeat") are ever
 * written; every value is a bound placeholder. When `code` changes,
 * `code_normalized` is recomputed so the pair stays in lockstep. 404 when the id
 * is unknown; a duplicate key is a 409.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updatePriceListItem = async (pool, id, input) => {
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

  try {
    const { rows } = await pool.query(
      `UPDATE price_list_items SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING ${ROW_COLUMNS}`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Price-list item ${id} not found.`)
    }
    return toPriceListItem(rows[0])
  } catch (error) {
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
  const { rows } = await pool.query(
    `UPDATE price_list_items
        SET archived_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${ROW_COLUMNS}`,
    [id, archived]
  )
  return rows[0] ? toPriceListItem(rows[0]) : null
}
