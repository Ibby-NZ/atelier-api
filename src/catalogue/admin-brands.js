// Back-office brand + collection management (catalogue admin).
//
// Staff create and edit the supplier catalogue from the storefront admin UI.
// Two rules shape this module:
//   - Slugs are server-generated from the display name on create and immutable
//     afterwards: they are the storefront's public URLs and the EmDash brand-page
//     match key, so a rename must not silently break links. PATCH schemas simply
//     omit `slug`.
//   - Duplicates are detected by the database, not pre-checked: a unique
//     violation (23505) is mapped to a friendly 409 by constraint name. A
//     pre-check would race and would still need this handler.
//
// This module also exports the two helpers admin-products.js shares (slugFrom,
// rethrowConflict) so both halves of the catalogue behave identically.

import { slugify } from '../seed/slugify.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Friendly 409 text per unique constraint. A constraint rename upstream degrades
// the message to the fallback, never the status code.
const CONFLICT_MESSAGES = Object.freeze({
  brands_slug_key: 'A brand with that name already exists.',
  collections_brand_id_slug_unique:
    'That brand already has a collection with that name.',
  products_slug_key: 'A product with that name already exists for this brand.',
  colourways_sku_key: 'That SKU is already in use.',
})

/**
 * Re-throw a pg error as a 409 when it is a unique violation, otherwise rethrow
 * it untouched (so genuine failures still surface as 500s).
 *
 * @param {unknown} error
 * @returns {never}
 */
export const rethrowConflict = (error) => {
  if (error?.code === '23505') {
    const message = Object.hasOwn(CONFLICT_MESSAGES, error.constraint)
      ? CONFLICT_MESSAGES[error.constraint]
      : 'Duplicate value.'
    throw httpError(409, message)
  }
  throw error
}

/**
 * Slug for a display name. `slugify` throws on a whitespace-only string and
 * returns '' for a punctuation-only one — both are user input mistakes, so they
 * become a 422 rather than a 500 or an empty slug.
 *
 * @param {string} text
 * @returns {string}
 */
export const slugFrom = (text) => {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const slug = trimmed === '' ? '' : slugify(trimmed)
  if (slug === '') {
    throw httpError(422, 'Name must contain at least one letter or number.')
  }
  return slug
}

/**
 * Build a whitelisted `SET` clause from a patch body. Only the listed columns
 * are ever written, and `Object.hasOwn` keeps an explicit `null` (which clears a
 * field) distinct from an absent key (which leaves it alone).
 *
 * @param {object} input
 * @param {readonly string[]} columns
 * @returns {{ sets: string[], params: unknown[] }}
 */
export const buildUpdate = (input, columns) => {
  const sets = []
  const params = []
  for (const column of columns) {
    if (Object.hasOwn(input, column)) {
      params.push(input[column])
      sets.push(`${column} = $${params.length}`)
    }
  }
  if (sets.length === 0) {
    // Unreachable while the Ajv schemas enforce minProperties + a closed
    // property set; guarded because an empty SET clause is invalid SQL.
    throw httpError(400, 'No updatable fields provided.')
  }
  return { sets, params }
}

const BRAND_COLUMNS = `id, name, slug, story, country, currency, is_international, archived_at, created_at`

const BRAND_UPDATE_COLUMNS = Object.freeze([
  'name',
  'story',
  'country',
  'currency',
  'is_international',
])

const toBrand = (row) =>
  Object.freeze({
    id: row.id,
    name: row.name,
    slug: row.slug,
    story: row.story,
    country: row.country,
    currency: row.currency,
    is_international: row.is_international,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
  })

const toCollection = (row) =>
  Object.freeze({
    id: row.id,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    name: row.name,
    slug: row.slug,
    archived_at: row.archived_at ?? null,
  })

/**
 * Every brand, alphabetically. Unlike the public list this carries ids, because
 * the admin UI addresses brands by id.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object[]>}
 */
export const listAdminBrands = async (pool, { includeArchived = false } = {}) => {
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL'
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS} FROM brands ${where} ORDER BY name ASC, id ASC`
  )
  return rows.map(toBrand)
}

/**
 * Create a brand. The slug is derived from the name; a duplicate name is a 409.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createBrand = async (pool, input) => {
  const name = input.name.trim()
  const slug = slugFrom(name)
  try {
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, story, country, currency, is_international)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${BRAND_COLUMNS}`,
      [
        name,
        slug,
        input.story ?? null,
        input.country ?? null,
        input.currency,
        input.is_international ?? false,
      ]
    )
    return toBrand(rows[0])
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Patch a brand. The slug is deliberately left untouched by a rename.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateBrand = async (pool, id, input) => {
  const patch = Object.hasOwn(input, 'name')
    ? { ...input, name: input.name.trim() }
    : input
  const { sets, params } = buildUpdate(patch, BRAND_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE brands SET ${sets.join(', ')}
        WHERE id = $${params.length + 1}
        RETURNING ${BRAND_COLUMNS}`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Brand ${id} not found.`)
    }
    return toBrand(rows[0])
  } catch (error) {
    return rethrowConflict(error)
  }
}

const COLLECTION_SELECT = `SELECT c.id, c.brand_id, c.name, c.slug, c.archived_at, b.name AS brand_name
       FROM collections c
       JOIN brands b ON b.id = c.brand_id`

/**
 * Collections, optionally narrowed to one brand, with the owning brand's name.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brandId?: number }} [filter]
 * @returns {Promise<object[]>}
 */
export const listAdminCollections = async (
  pool,
  { brandId, includeArchived = false } = {}
) => {
  const clauses = []
  const params = []
  if (brandId) {
    params.push(brandId)
    clauses.push(`c.brand_id = $${params.length}`)
  }
  if (!includeArchived) {
    clauses.push('c.archived_at IS NULL')
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `${COLLECTION_SELECT} ${where} ORDER BY b.name ASC, c.name ASC, c.id ASC`,
    params
  )
  return rows.map(toCollection)
}

/**
 * Create a collection under a brand. An unknown brand is a business-rule 422
 * (the FK would otherwise surface as an opaque 500).
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createCollection = async (pool, input) => {
  const { rows: brands } = await pool.query(`SELECT id, name FROM brands WHERE id = $1`, [
    input.brand_id,
  ])
  const brand = brands[0]
  if (!brand) {
    throw httpError(422, `Brand ${input.brand_id} does not exist.`)
  }

  const name = input.name.trim()
  const slug = slugFrom(name)
  try {
    const { rows } = await pool.query(
      `INSERT INTO collections (brand_id, name, slug)
       VALUES ($1, $2, $3)
       RETURNING id, brand_id, name, slug`,
      [brand.id, name, slug]
    )
    return toCollection({ ...rows[0], brand_name: brand.name })
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Rename a collection. Its slug stays as generated (see the module header).
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ name: string }} input
 * @returns {Promise<object>}
 */
export const updateCollection = async (pool, id, input) => {
  const { rows } = await pool.query(
    `UPDATE collections c SET name = $1
       FROM brands b
      WHERE c.id = $2 AND b.id = c.brand_id
      RETURNING c.id, c.brand_id, c.name, c.slug, b.name AS brand_name`,
    [input.name.trim(), id]
  )
  if (rows.length === 0) {
    throw httpError(404, `Collection ${id} not found.`)
  }
  return toCollection(rows[0])
}

/**
 * Archive (soft-delete) or restore a brand. Archiving hides it and all of its
 * products from the public catalogue and the default admin lists; the rows and
 * every commerce reference stay intact, so it is fully reversible.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object>}
 */
export const setBrandArchived = async (pool, id, archived) => {
  const { rows } = await pool.query(
    `UPDATE brands SET archived_at = ${archived ? 'now()' : 'NULL'}
      WHERE id = $1
      RETURNING ${BRAND_COLUMNS}`,
    [id]
  )
  if (rows.length === 0) {
    throw httpError(404, `Brand ${id} not found.`)
  }
  return toBrand(rows[0])
}

/**
 * Archive or restore a collection. Products keep their collection_id; an
 * archived collection simply drops out of the public and default admin lists.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object>}
 */
export const setCollectionArchived = async (pool, id, archived) => {
  const { rows } = await pool.query(
    `UPDATE collections c SET archived_at = ${archived ? 'now()' : 'NULL'}
       FROM brands b
      WHERE c.id = $1 AND b.id = c.brand_id
      RETURNING c.id, c.brand_id, c.name, c.slug, c.archived_at, b.name AS brand_name`,
    [id]
  )
  if (rows.length === 0) {
    throw httpError(404, `Collection ${id} not found.`)
  }
  return toCollection(rows[0])
}
