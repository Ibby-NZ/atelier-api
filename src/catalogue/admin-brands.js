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
// rethrowConflict) so both halves of the catalogue behave identically, plus
// `buildUpdate` — which is NOT catalogue-only: it is the house SET-clause
// builder every admin PATCH in the API imports from here (suppliers,
// purchasing, samples, users, inventory, pricing, reserves, /auth/me). Moving
// or renaming it is a codebase-wide change, not a catalogue one.

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
  // Per supplier, not global (migration 1788408000000): a code identifies a
  // house inside the invoicing entity that bills it, and the index folds through
  // lower(btrim(...)) — so "cf" against an existing "CF" under the same supplier
  // lands here too.
  brands_supplier_brand_code_unique:
    'That supplier already has a house with that brand code.',
})

// Friendly 422 text per foreign key. Same degradation rule as above: a rename
// upstream costs the message, never the status code.
const REFERENCE_MESSAGES = Object.freeze({
  brands_supplier_id_fkey: 'That supplier does not exist.',
  // Since migration 1791379200000 the category vocabulary is a table rather than
  // a CHECK, so an unknown category arrives as a 23503 instead of a 23514 — and
  // the fix is a screen staff can reach, not a migration.
  products_category_fkey: 'That category does not exist. Add it on Categories first.',
  price_list_items_category_fkey:
    'That category does not exist. Add it on Categories first.',
  supplier_freight_rates_category_fkey:
    'That category does not exist. Add it on Categories first.',
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
  // A reference to a row that does not exist is the caller's mistake, not this
  // server's: pointing a house at supplier 9999 is a bad value in a body, and a
  // 500 tells the office nothing it can act on. Named separately from 23505
  // because they mean different things — one is "that already exists", the
  // other is "that does not".
  if (error?.code === '23503') {
    const message = Object.hasOwn(REFERENCE_MESSAGES, error.constraint)
      ? REFERENCE_MESSAGES[error.constraint]
      : 'That reference does not exist.'
    throw httpError(422, message)
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

// `supplier_id` is on the ADMIN projection only. It is a commercial fact — who
// invoices this house — and belongs nowhere near the public read models in
// catalogue/brands.js, which serve signed-out visitors. `brand_code` follows it:
// it is the office's D365 reporting designation, deliberately absent from the
// public brand read model (test/reporting-codes.test.js scans for the VALUE as
// well as the key), and readable here because the CRM is where it is typed in.
const BRAND_COLUMNS = `id, name, slug, headline, story, country, currency, is_international, trade_only, bespoke, website_url, image_url, logo_url, featured_rank, supplier_id, brand_code, archived_at, created_at`

const BRAND_UPDATE_COLUMNS = Object.freeze([
  'name',
  // The one line the storefront house page opens on, above the story.
  'headline',
  'story',
  'country',
  'currency',
  'is_international',
  // Whether a signed-out visitor may browse this house's products at all (see
  // catalogue/visibility.js). Editable here because it is a commercial decision
  // per house, not a property of the vendored catalogue — and the seed never
  // overwrites it, so an office change survives every reseed.
  'trade_only',
  // Takes made-to-measure commissions: lists the house on the storefront's
  // /bespoke page and puts the quote enquiry form on its own page.
  'bespoke',
  'website_url',
  // The house's image. Same public-`src` gate as a collection's.
  'image_url',
  // The maison's mark the storefront tile centres over that image. Same gate.
  'logo_url',
  // Where this house sits in the storefront's featured order; NULL means not
  // featured. Patchable one house at a time as well as through the whole-list
  // reorder below, because correcting a single rank should not require the
  // caller to restate the entire list. Absent from create on purpose — a house
  // is not featured at birth.
  'featured_rank',
  // Which supplier invoices this house. Writable so the office can onboard a
  // supplier end to end from the CRM: a brand new supplier has no linked houses,
  // and without this the commercial terms it is given are attached to nothing a
  // screen can reach — `getSupplier` attaches terms per house, so they would be
  // invisible on the supplier it was created for. `npm run backfill:suppliers`
  // remains the bulk path; this is the correction and the onboarding path.
  //
  // NULL is a legitimate value (a house nobody invoices yet), and the FK is
  // RESTRICT, so pointing at a supplier that does not exist is a 23503 the
  // route turns into a 422 rather than a silent no-op.
  'supplier_id',
  // The W21 reporting dimension. Migration 1788408000000 found no defensible
  // source for it in any corpus Atelier has delivered, so the column ships
  // empty and is filled from the CRM one house at a time — which is this
  // whitelist entry. Uniqueness is per supplier (see CONFLICT_MESSAGES) and a
  // clash surfaces as a 409, never a pre-check.
  'brand_code',
])

const toBrand = (row, extra) =>
  Object.freeze({
    id: row.id,
    name: row.name,
    slug: row.slug,
    headline: row.headline ?? null,
    story: row.story,
    country: row.country,
    currency: row.currency,
    is_international: row.is_international,
    trade_only: row.trade_only,
    bespoke: row.bespoke,
    website_url: row.website_url ?? null,
    image_url: row.image_url ?? null,
    logo_url: row.logo_url ?? null,
    featured_rank: row.featured_rank ?? null,
    supplier_id: row.supplier_id ?? null,
    brand_code: row.brand_code ?? null,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    ...extra,
  })

/**
 * Normalise a staff-typed reporting label (a brand code, a product range) on
 * its way to a column whose CHECK refuses a blank: a cleared CRM input arrives
 * as '' and must store NULL, never '' — a stored blank is a second spelling of
 * "unset" that every `IS NULL` read misses (the order-header rule, FR-127).
 * Trimmed rather than passed through, because '   ' is the same statement as ''
 * and would otherwise reach the CHECK as an opaque 23514.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export const reportingLabelFrom = (value) => {
  if (value === null || value === undefined) {
    return null
  }
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

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
    featured_rank: row.featured_rank ?? null,
    archived_at: row.archived_at ?? null,
    ...extra,
  })

// Split into columns + FROM (the shape admin-products.js uses) so the detail
// read can slot a count subquery in between them.
const COLLECTION_COLUMNS = `c.id, c.brand_id, c.name, c.slug, c.description, c.image_url, c.featured_rank, c.archived_at, b.name AS brand_name`

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
  // The supplier's NAME, not only its id: a list showing `supplier_id: 7` says
  // nothing, and every screen that reads this one asks the same question —
  // which house does this supplier invoice, and which house has no supplier at
  // all. A correlated subquery rather than a join, because BRAND_COLUMNS is
  // unqualified and only valid while the statement has no alias. The NAME is
  // not a rate: what Atelier PAYS a supplier stays on the finance-gated terms
  // routes (src/suppliers/supplier-terms.js).
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS},
            (SELECT name FROM suppliers WHERE suppliers.id = brands.supplier_id)
              AS supplier_name
       FROM brands ${where} ORDER BY name ASC, id ASC`
  )
  // Arrow, not a bare `map(toBrand)`: the mapper takes a second `extra`
  // argument, and map would hand it the array index.
  return rows.map((row) => toBrand(row, { supplier_name: row.supplier_name ?? null }))
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
      `INSERT INTO brands (name, slug, story, country, currency, is_international, trade_only, bespoke, website_url, image_url, logo_url, brand_code, headline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.bespoke ?? false,
        websiteUrlFrom(input.website_url),
        websiteUrlFrom(input.image_url, 'Image'),
        websiteUrlFrom(input.logo_url, 'Logo'),
        reportingLabelFrom(input.brand_code),
        input.headline ?? null,
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
  if (Object.hasOwn(patch, 'image_url')) {
    patch = { ...patch, image_url: websiteUrlFrom(patch.image_url, 'Image') }
  }
  if (Object.hasOwn(patch, 'logo_url')) {
    patch = { ...patch, logo_url: websiteUrlFrom(patch.logo_url, 'Logo') }
  }
  if (Object.hasOwn(patch, 'brand_code')) {
    patch = { ...patch, brand_code: reportingLabelFrom(patch.brand_code) }
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
       RETURNING id, brand_id, name, slug, description, image_url, featured_rank`,
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

// `featured_rank` joins the patch whitelist for the same reason it does on
// brands: a single-rank correction should not have to restate the whole list.
// It is absent from COLLECTION create.
const COLLECTION_UPDATE_COLUMNS = Object.freeze([
  'name',
  'description',
  'image_url',
  'featured_rank',
])

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
      RETURNING c.id, c.brand_id, c.name, c.slug, c.description, c.image_url, c.featured_rank, b.name AS brand_name`,
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
    returning: `c.id, c.brand_id, c.name, c.slug, c.description, c.image_url, c.featured_rank, c.archived_at, b.name AS brand_name`,
  })
  if (!row) {
    throw httpError(404, `Collection ${id} not found.`)
  }
  return toCollection(row)
}

// ---------------------------------------------------------------------------
// Featured ordering (whole-list reorder)
//
// A reorder is the office saying "this IS the featured list, in this order", so
// POSITION IN THE ARRAY IS THE RANK and anything absent from it is cleared. That
// is why each write clears every rank first and then re-applies from the
// submitted order, in one transaction: a diff would have to sequence its updates
// to avoid colliding halfway through a swap, and the column deliberately carries
// no unique index precisely so nobody has to.
//
// An entry naming a row that does not exist is a 422 naming it, never a silent
// drop. A whole-list write that quietly kept four of five is indistinguishable
// from success to the caller, who now believes it featured something it did not.
// ---------------------------------------------------------------------------

// Boundary sanity limit, not a product rule. The homepage leads with three and
// its latest row shows four, so a list this long is already a mistake somebody
// should see as a 400. The CRM's own ordering module caps at the same number.
export const FEATURED_LIMIT = 12

/**
 * Refuse a list that names the same thing twice. `UPDATE … FROM` picks one of
 * the matching source rows non-deterministically rather than raising, so a
 * duplicate would silently resolve to an arbitrary rank.
 *
 * @param {readonly string[]} keys
 * @param {string} label
 */
const assertNoDuplicates = (keys, label) => {
  const seen = new Set()
  for (const key of keys) {
    if (seen.has(key)) {
      throw httpError(422, `${label} "${key}" is listed twice.`)
    }
    seen.add(key)
  }
}

/**
 * Run `fn` inside one transaction, rolling back on any throw — including the
 * 422 raised when an entry named nothing, so a partly-applied reorder can never
 * commit.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
const withTransaction = async (pool, fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Report the entries whose key never came back from the applying UPDATE. An
 * unknown slug simply matches no row, so the RETURNING set is the only evidence
 * that anything was dropped.
 *
 * @param {readonly string[]} requested
 * @param {Set<string>} matched
 * @param {{ one: string, many: string }} label
 */
const assertAllMatched = (requested, matched, label) => {
  const unknown = requested.filter((key) => !matched.has(key))
  if (unknown.length > 0) {
    const noun = unknown.length === 1 ? label.one : label.many
    throw httpError(422, `Unknown ${noun}: ${unknown.join(', ')}.`)
  }
}

/**
 * The featured houses, in rank order. The `name`/`id` tie-break is the same one
 * the public read model uses, so two houses sharing a rank still order the same
 * way in both places.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object[]>}
 */
export const listFeaturedBrands = async (pool) => {
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS} FROM brands
      WHERE featured_rank IS NOT NULL
      ORDER BY featured_rank ASC, name ASC, id ASC`
  )
  return rows.map(toBrand)
}

/**
 * The featured collections, in rank order, each with its house name.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object[]>}
 */
export const listFeaturedCollections = async (pool) => {
  const { rows } = await pool.query(
    `${COLLECTION_SELECT}
      WHERE c.featured_rank IS NOT NULL
      ORDER BY c.featured_rank ASC, c.name ASC, c.id ASC`
  )
  return rows.map(toCollection)
}

/**
 * Replace the featured house list with `slugs`, ranked by position. An empty
 * list features nothing, which is how the office turns the strip off.
 *
 * @param {import('pg').Pool} pool
 * @param {readonly string[]} slugs
 * @returns {Promise<object[]>}
 */
export const setFeaturedBrands = async (pool, slugs) => {
  assertNoDuplicates(slugs, 'Brand')
  await withTransaction(pool, async (client) => {
    await client.query(`UPDATE brands SET featured_rank = NULL WHERE featured_rank IS NOT NULL`)
    if (slugs.length === 0) {
      return
    }
    // WITH ORDINALITY turns the array's position into the rank, so the order the
    // office submitted is the order stored — nothing re-derives it.
    const { rows } = await client.query(
      `UPDATE brands b
          SET featured_rank = v.rank
         FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, rank)
        WHERE b.slug = v.slug
    RETURNING b.slug`,
      [[...slugs]]
    )
    assertAllMatched(slugs, new Set(rows.map((row) => row.slug)), {
      one: 'brand slug',
      many: 'brand slugs',
    })
  })
  return listFeaturedBrands(pool)
}

/** A collection's identity is the PAIR, so that is what is deduped and reported. */
const collectionKey = (entry) => `${entry.brand_slug}/${entry.slug}`

/**
 * Replace the featured collection list with `entries`, ranked by position.
 *
 * Each entry is a `(brand_slug, slug)` PAIR and the UPDATE joins through
 * `brands` accordingly: `collections_brand_id_slug_unique` is per brand and
 * never global, so a slug-only match would feature another house's
 * identically-slugged collection as well — or instead.
 *
 * @param {import('pg').Pool} pool
 * @param {ReadonlyArray<{ brand_slug: string, slug: string }>} entries
 * @returns {Promise<object[]>}
 */
export const setFeaturedCollections = async (pool, entries) => {
  const keys = entries.map(collectionKey)
  assertNoDuplicates(keys, 'Collection')
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE collections SET featured_rank = NULL WHERE featured_rank IS NOT NULL`
    )
    if (entries.length === 0) {
      return
    }
    const { rows } = await client.query(
      `UPDATE collections c
          SET featured_rank = v.rank
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS v(brand_slug, slug, rank)
         JOIN brands b ON b.slug = v.brand_slug
        WHERE c.brand_id = b.id AND c.slug = v.slug
    RETURNING b.slug AS brand_slug, c.slug`,
      [entries.map((entry) => entry.brand_slug), entries.map((entry) => entry.slug)]
    )
    assertAllMatched(keys, new Set(rows.map(collectionKey)), {
      one: 'collection',
      many: 'collections',
    })
  })
  return listFeaturedCollections(pool)
}
