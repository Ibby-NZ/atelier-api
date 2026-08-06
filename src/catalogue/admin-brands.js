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
import { setArchived } from '../lifecycle/archive.js'

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

const BRAND_COLUMNS = `id, name, slug, story, country, currency, is_international, trade_only, website_url, archived_at, created_at`

const BRAND_UPDATE_COLUMNS = Object.freeze([
  'name',
  'story',
  'country',
  'currency',
  'is_international',
  // Whether a signed-out visitor may browse this house's products at all (see
  // catalogue/visibility.js). Editable here because it is a commercial decision
  // per house, not a property of the vendored catalogue — and the seed never
  // overwrites it, so an office change survives every reseed.
  'trade_only',
  'website_url',
])

const toBrand = (row, extra) =>
  Object.freeze({
    id: row.id,
    name: row.name,
    slug: row.slug,
    story: row.story,
    country: row.country,
    currency: row.currency,
    is_international: row.is_international,
    trade_only: row.trade_only,
    website_url: row.website_url ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    ...extra,
  })

/**
 * Normalise a URL destined for a public storefront `href`/`src` (brand website,
 * collection image), so only absolute http(s) URLs are stored — anything else
 * (including a javascript: URL) is a business-rule 422. Blank input clears the
 * field. `label` names the field in the 422 message.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string|null}
 */
export const websiteUrlFrom = (value, label = 'Website') => {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = String(value).trim()
  if (trimmed === '') {
    return null
  }
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw httpError(422, `${label} must be a full URL, e.g. https://example.com.`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(422, `${label} must be an http(s) URL.`)
  }
  return trimmed
}

const toCollection = (row, extra) =>
  Object.freeze({
    id: row.id,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    image_url: row.image_url ?? null,
    archived_at: row.archived_at ?? null,
    ...extra,
  })

// Split into columns + FROM (the shape admin-products.js uses) so the detail
// read can slot a count subquery in between them.
const COLLECTION_COLUMNS = `c.id, c.brand_id, c.name, c.slug, c.description, c.image_url, c.archived_at, b.name AS brand_name`

const COLLECTION_FROM = `FROM collections c
       JOIN brands b ON b.id = c.brand_id`

const COLLECTION_SELECT = `SELECT ${COLLECTION_COLUMNS} ${COLLECTION_FROM}`

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
  // Arrow, not a bare `map(toBrand)`: the mapper takes a second `extra`
  // argument, and map would hand it the array index.
  return rows.map((row) => toBrand(row))
}

/**
 * One brand by id with its collections and the two child counts, or null when it
 * does not exist. This is what the CRM re-reads after a write, so that
 * server-generated fields (the slug) and anything a trigger touched appear
 * without refetching the whole list.
 *
 * Two deliberate choices, both about matching what a DELETE would do:
 *   - The counts are the same question the lifecycle probes ask — every child
 *     row, **archived included** — so a house reading 0/0 is exactly a house
 *     `DELETE /admin/brands/:id` accepts, and one reading 3/1 is one it refuses
 *     with those numbers. A count that skipped archived rows would tell staff a
 *     house was empty and then be contradicted by the 409.
 *   - Archived collections are listed too, each carrying its `archived_at`, the
 *     same way getAdminProduct returns every colourway. Filtering here would
 *     hide the rows that block the delete.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getAdminBrand = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS},
            (SELECT COUNT(*)::int FROM products WHERE brand_id = brands.id) AS product_count
       FROM brands
      WHERE id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  const { rows: collections } = await pool.query(
    `${COLLECTION_SELECT} WHERE c.brand_id = $1 ORDER BY c.name ASC, c.id ASC`,
    [id]
  )
  return toBrand(row, {
    product_count: row.product_count,
    collection_count: collections.length,
    collections: collections.map((row) => toCollection(row)),
  })
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
      `INSERT INTO brands (name, slug, story, country, currency, is_international, trade_only, website_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${BRAND_COLUMNS}`,
      [
        name,
        slug,
        input.story ?? null,
        input.country ?? null,
        input.currency,
        input.is_international ?? false,
        // Closed unless the office says otherwise: a house added mid-negotiation
        // must not appear on the public storefront because someone left a box
        // unticked.
        input.trade_only ?? true,
        websiteUrlFrom(input.website_url),
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
  let patch = Object.hasOwn(input, 'name')
    ? { ...input, name: input.name.trim() }
    : input
  if (Object.hasOwn(patch, 'website_url')) {
    patch = { ...patch, website_url: websiteUrlFrom(patch.website_url) }
  }
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
  return rows.map((row) => toCollection(row))
}

/**
 * One collection by id with its house's name and its product count, or null when
 * it does not exist. The count follows the same rule as getAdminBrand's: it
 * counts archived products too, because `products.collection_id` is SET NULL and
 * the delete probe counts them — an unprobed delete would report success while
 * silently uncollecting every one of them.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getAdminCollection = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${COLLECTION_COLUMNS},
            (SELECT COUNT(*)::int FROM products WHERE collection_id = c.id) AS product_count
       ${COLLECTION_FROM}
      WHERE c.id = $1`,
    [id]
  )
  const row = rows[0]
  return row ? toCollection(row, { product_count: row.product_count }) : null
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
      `INSERT INTO collections (brand_id, name, slug, description, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, brand_id, name, slug, description, image_url`,
      [
        brand.id,
        name,
        slug,
        input.description ?? null,
        websiteUrlFrom(input.image_url, 'Image'),
      ]
    )
    return toCollection({ ...rows[0], brand_name: brand.name })
  } catch (error) {
    return rethrowConflict(error)
  }
}

const COLLECTION_UPDATE_COLUMNS = Object.freeze(['name', 'description', 'image_url'])

/**
 * Patch a collection: name and/or the storefront tile editorial (description,
 * hero image). The slug stays as generated (see the module header). The image
 * URL is a public `src`, so it passes the same http(s)-only gate as a brand
 * website.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ name?: string, description?: string|null, image_url?: string|null }} input
 * @returns {Promise<object>}
 */
export const updateCollection = async (pool, id, input) => {
  let patch = Object.hasOwn(input, 'name') ? { ...input, name: input.name.trim() } : input
  if (Object.hasOwn(patch, 'image_url')) {
    patch = { ...patch, image_url: websiteUrlFrom(patch.image_url, 'Image') }
  }
  const { sets, params } = buildUpdate(patch, COLLECTION_UPDATE_COLUMNS)
  const { rows } = await pool.query(
    `UPDATE collections c SET ${sets.join(', ')}
       FROM brands b
      WHERE c.id = $${params.length + 1} AND b.id = c.brand_id
      RETURNING c.id, c.brand_id, c.name, c.slug, c.description, c.image_url, b.name AS brand_name`,
    [...params, id]
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
  const row = await setArchived(pool, 'brand', id, archived, {
    returning: BRAND_COLUMNS,
  })
  if (!row) {
    throw httpError(404, `Brand ${id} not found.`)
  }
  return toBrand(row)
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
  // The join is here only to decorate the projection with the house name, which
  // toCollection needs; it is not part of the write.
  const row = await setArchived(pool, 'collection', id, archived, {
    alias: 'c',
    from: 'FROM brands b',
    filter: 'AND b.id = c.brand_id',
    returning: `c.id, c.brand_id, c.name, c.slug, c.description, c.image_url, c.archived_at, b.name AS brand_name`,
  })
  if (!row) {
    throw httpError(404, `Collection ${id} not found.`)
  }
  return toCollection(row)
}
