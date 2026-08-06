// Back-office supplier admin (read models + writes).
//
// A supplier is who INVOICES Atelier; a brand is what a customer buys. One
// supplier sells several houses, so the two are separate rows and this module is
// the only place the supplier record is read or written. Handlers stay thin —
// the SQL and the rules live here, mirroring src/pricing/admin-price-lists.js
// and src/users/admin-users.js.
//
// THIS MODULE IS BACK-OFFICE ONLY. Every field it serves is cost-bearing or
// commercially sensitive: `discount_method` states how the house is rated,
// `agent`/`incoterm` are the negotiated freight terms, `po_email` is an internal
// ordering address, and `getSupplier` embeds the per-brand terms outright. None
// of it may reach a client-facing read model — `test/suppliers-admin.test.js`
// asserts that against the real /catalogue/* bodies, the response-layer
// counterpart to the source scan in test/suppliers-terms.test.js.
//
// Three details shape it:
//   - `slug` is server-generated on create and immutable after, like every other
//     slug in this API (admin-brands.js): it is the stable key the backfill and
//     any later import address a supplier by.
//   - Duplicates are detected by the database, never pre-checked. Four unique
//     constraints exist, so the 23505 is keyed on `error.constraint`; an unknown
//     constraint degrades the message, never the status.
//   - `currency` is the supplier's INVOICING currency and is nullable on
//     purpose. Blank means "no invoice on file yet"; defaulting it from
//     `country` is the exact mistake the column exists to prevent.

import { buildUpdate, slugFrom } from '../catalogue/admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'
import { listSupplierBrandTerms } from './supplier-terms.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Message per unique constraint. Keyed on the constraint name because four of
// them can fire and "already exists" alone leaves staff hunting which field.
const CONFLICT_MESSAGES = Object.freeze({
  suppliers_name_key: 'A supplier with that name already exists.',
  suppliers_slug_key: 'A supplier with that name already exists.',
  suppliers_d365_token_unique: 'Another supplier already uses that D365 token.',
  suppliers_short_code_unique: 'Another supplier already uses that short code.',
})

const rethrowConflict = (error) => {
  if (error?.code === '23505') {
    throw httpError(
      409,
      CONFLICT_MESSAGES[error.constraint] ?? 'That supplier detail is already in use.'
    )
  }
  throw error
}

// Full row projection. Unqualified, so it is only valid while the statement has
// no table alias — every query here uses the bare table name for that reason.
const SUPPLIER_COLUMNS = `id, name, slug, short_code, d365_token, country, currency,
  agent, incoterm, po_email, discount_method, created_at, updated_at, archived_at`

// Columns a PATCH may ever write. Frozen and in-code, as buildUpdate requires —
// column names are never user input. `slug` is absent (server-derived and
// immutable), as are the timestamps and `archived_at` (setArchived owns it).
export const SUPPLIER_UPDATE_COLUMNS = Object.freeze([
  'name',
  'short_code',
  'd365_token',
  'country',
  'currency',
  'agent',
  'incoterm',
  'po_email',
  'discount_method',
])

const toSupplier = (row) =>
  Object.freeze({
    id: row.id,
    name: row.name,
    slug: row.slug,
    short_code: row.short_code,
    d365_token: row.d365_token,
    country: row.country,
    currency: row.currency,
    agent: row.agent,
    incoterm: row.incoterm,
    po_email: row.po_email,
    discount_method: row.discount_method,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  })

// Escape the LIKE wildcards so a search for "C&C_" matches a literal underscore
// rather than any single character. Pairs with the ESCAPE '\' clause in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// WHERE fragments + bound params for the list query. Values always flow through
// $n placeholders; nothing here interpolates user input.
const buildWhere = ({ q, includeArchived }) => {
  const clauses = []
  const params = []

  // Archived suppliers are hidden from the default working list; the caller
  // opts back in, which is what `include_archived` on the route is for.
  if (!includeArchived) {
    clauses.push('archived_at IS NULL')
  }

  // A blank/whitespace term is ignored, not treated as "match nothing".
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // Aliases are searched too: the price lists spell one house several ways
    // ('JWALL', 'C&C MILANO'), and staff look a supplier up by whichever
    // spelling is in front of them.
    clauses.push(`(
      name ILIKE $${i} ESCAPE '\\'
      OR short_code ILIKE $${i} ESCAPE '\\'
      OR d365_token ILIKE $${i} ESCAPE '\\'
      OR country ILIKE $${i} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM supplier_aliases
         WHERE supplier_aliases.supplier_id = suppliers.id
           AND supplier_aliases.alias ILIKE $${i} ESCAPE '\\'
      )
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/**
 * Filtered, paginated suppliers, alphabetical. Returns { suppliers, total } —
 * the route builds the meta envelope, as the other admin lists do.
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, includeArchived?: boolean, page?: number, limit?: number }} [options]
 * @returns {Promise<{ suppliers: object[], total: number }>}
 */
export const listSuppliers = async (
  pool,
  { q, includeArchived = false, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere({ q, includeArchived })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM suppliers ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers
     ${where}
     ORDER BY name ASC, id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return { suppliers: rows.map(toSupplier), total: countResult.rows[0].total }
}

/**
 * One supplier with everything the back office needs to judge it: its lookup
 * aliases, the houses it invoices, and the per-brand commercial terms. Null when
 * the id is unknown (the route turns that into a 404).
 *
 * Archived brands are included deliberately — a house pointing at this supplier
 * still blocks deleting it (`brands.supplier_id` is RESTRICT), so hiding the
 * archived ones would show a supplier that looks unlinked and refuses to go.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getSupplier = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${SUPPLIER_COLUMNS} FROM suppliers WHERE id = $1`,
    [id]
  )
  if (!rows[0]) return null

  const [{ rows: aliasRows }, { rows: brandRows }, terms] = await Promise.all([
    pool.query(
      `SELECT id, alias FROM supplier_aliases
        WHERE supplier_id = $1 ORDER BY lower(btrim(alias)) ASC`,
      [id]
    ),
    pool.query(
      `SELECT id, name, slug, archived_at FROM brands
        WHERE supplier_id = $1 ORDER BY name ASC, id ASC`,
      [id]
    ),
    listSupplierBrandTerms(pool, id),
  ])

  const termsByBrand = new Map(terms.map((row) => [row.brand_id, row]))

  return Object.freeze({
    ...toSupplier(rows[0]),
    aliases: Object.freeze(
      aliasRows.map((row) => Object.freeze({ id: row.id, alias: row.alias }))
    ),
    brands: Object.freeze(
      brandRows.map((row) =>
        Object.freeze({
          id: row.id,
          name: row.name,
          slug: row.slug,
          archived_at: row.archived_at,
          terms: termsByBrand.get(row.id) ?? null,
        })
      )
    ),
  })
}

/**
 * Create a supplier. The slug is derived from the name here and never accepted
 * from the client; an unsluggable name (punctuation only) is a 422, and a
 * duplicate name / token / short code is a 409 raised by the database.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createSupplier = async (pool, input) => {
  const slug = slugFrom(input.name)
  try {
    const { rows } = await pool.query(
      `INSERT INTO suppliers
         (name, slug, short_code, d365_token, country, currency, agent, incoterm,
          po_email, discount_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${SUPPLIER_COLUMNS}`,
      [
        input.name,
        slug,
        input.short_code ?? null,
        input.d365_token ?? null,
        input.country ?? null,
        // Never defaulted from country — see the module header.
        input.currency ?? null,
        input.agent ?? null,
        input.incoterm ?? null,
        input.po_email ?? null,
        input.discount_method ?? null,
      ]
    )
    return toSupplier(rows[0])
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Patch a supplier from the frozen whitelist. `Object.hasOwn` keeps an explicit
 * null (which clears an optional column) distinct from an absent key. The slug
 * is deliberately NOT recomputed from a renamed supplier: it is the stable key
 * other rows address, and a rename is a correction, not a new supplier.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateSupplier = async (pool, id, input) => {
  const { sets, params } = buildUpdate(input, SUPPLIER_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE suppliers SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING ${SUPPLIER_COLUMNS}`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Supplier ${id} not found.`)
    }
    return toSupplier(rows[0])
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Soft-archive (archived=true) or restore (archived=false) a supplier, stamping
 * updated_at. Returns the fresh row, or null when the id is unknown.
 *
 * This is the alternative a blocked DELETE offers: a supplier that still
 * invoices a house can never be removed (`brands.supplier_id` is RESTRICT), so
 * without an archive the only way to retire one would be to unlink its houses
 * first — which destroys who invoiced them.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object|null>}
 */
export const setSupplierArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'supplier', id, archived, {
    extraSets: ['updated_at = now()'],
    returning: SUPPLIER_COLUMNS,
  })
  return row ? toSupplier(row) : null
}
