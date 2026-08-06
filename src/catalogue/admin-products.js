// Back-office product + colourway management (catalogue admin).
//
// Companion to admin-brands.js, sharing its slug and duplicate-handling rules.
// Two things are specific to products:
//   - Slug shape matches the seed (src/seed/catalogue-data.js): a fabric is
//     slugged from "<brand name> <product name>" so two houses can both sell an
//     "Atlas"; a finished good is slugged from its name alone.
//   - Creating a colourway also creates its inventory row (qty 0, unit derived
//     from product_type) in one transaction, so a colourway can never exist
//     without stock tracking.

import { slugFrom, rethrowConflict, buildUpdate } from './admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// A fabric is measured in metres, a finished good in units. This is why
// product_type is create-only: changing it would strand existing stock in the
// wrong unit.
const UNIT_BY_PRODUCT_TYPE = Object.freeze({
  fabric: 'metres',
  finished_good: 'units',
})

const unitFor = (productType) => {
  if (!Object.hasOwn(UNIT_BY_PRODUCT_TYPE, productType)) {
    throw httpError(422, `Unknown product type "${productType}".`)
  }
  return UNIT_BY_PRODUCT_TYPE[productType]
}

const PRODUCT_COLUMNS = `p.id,
        p.brand_id,
        p.collection_id,
        p.name,
        p.slug,
        p.product_type,
        p.composition,
        p.width,
        p.application,
        p.rubs,
        p.price_band,
        p.lead_time,
        p.retail_price_cents,
        p.trade_price_cents,
        p.currency,
        p.show_on_website,
        p.hi_res_asset_url,
        p.archived_at,
        p.created_at,
        b.name AS brand_name,
        b.slug AS brand_slug,
        col.name AS collection_name`

const PRODUCT_FROM = `FROM products p
       JOIN brands b ON b.id = p.brand_id
       LEFT JOIN collections col ON col.id = p.collection_id`

// brand_id and product_type are absent by design: both are create-only.
const PRODUCT_UPDATE_COLUMNS = Object.freeze([
  'name',
  'collection_id',
  'composition',
  'width',
  'application',
  'rubs',
  'price_band',
  'lead_time',
  'retail_price_cents',
  'trade_price_cents',
  'currency',
  'show_on_website',
  'hi_res_asset_url',
])

const COLOURWAY_UPDATE_COLUMNS = Object.freeze([
  'name',
  'sku',
  'hex_tones',
  'image_url',
])

const toProduct = (row, extra) =>
  Object.freeze({
    id: row.id,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    brand_slug: row.brand_slug,
    collection_id: row.collection_id,
    collection_name: row.collection_name,
    name: row.name,
    slug: row.slug,
    product_type: row.product_type,
    composition: row.composition,
    width: row.width,
    application: row.application,
    rubs: row.rubs,
    price_band: row.price_band,
    lead_time: row.lead_time,
    retail_price_cents: row.retail_price_cents,
    trade_price_cents: row.trade_price_cents,
    currency: row.currency,
    show_on_website: row.show_on_website,
    hi_res_asset_url: row.hi_res_asset_url,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    ...extra,
  })

// The inventory snapshot is read-only here — quantities move through the order
// state machine (src/orders/admin-orders.js), never through catalogue edits.
const toColourway = (row) =>
  Object.freeze({
    id: row.id,
    product_id: row.product_id,
    name: row.name,
    sku: row.sku,
    hex_tones: row.hex_tones ?? null,
    image_url: row.image_url ?? null,
    archived_at: row.archived_at ?? null,
    inventory:
      row.unit === null || row.unit === undefined
        ? null
        : Object.freeze({
            qty_available: row.qty_available,
            qty_reserved: row.qty_reserved,
            unit: row.unit,
          }),
  })

const COLOURWAY_SELECT = `SELECT c.id, c.product_id, c.name, c.sku, c.hex_tones, c.image_url,
              c.archived_at, i.qty_available, i.qty_reserved, i.unit
         FROM colourways c
         LEFT JOIN inventory i ON i.colourway_id = c.id`

// pg maps a raw JS array to a Postgres array literal, not jsonb — hex_tones has
// to be stringified on the way in (same rule as the seed).
const serialiseTones = (tones) => (tones ? JSON.stringify(tones) : null)

/**
 * Products, optionally narrowed to one brand. Unlike the public list this
 * includes hidden products (`show_on_website = false`) — that flag is the thing
 * staff come here to toggle.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brandId?: number }} [filter]
 * @returns {Promise<object[]>}
 */
export const listAdminProducts = async (
  pool,
  { brandId, includeArchived = false } = {}
) => {
  const clauses = []
  const params = []
  if (brandId) {
    params.push(brandId)
    clauses.push(`p.brand_id = $${params.length}`)
  }
  if (!includeArchived) {
    clauses.push('p.archived_at IS NULL')
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS},
            (SELECT COUNT(*) FROM colourways c
              WHERE c.product_id = p.id AND c.archived_at IS NULL)::int
              AS colourway_count
       ${PRODUCT_FROM}
       ${where}
      ORDER BY b.name ASC, p.name ASC, p.id ASC`,
    params
  )
  return rows.map((row) => toProduct(row, { colourway_count: row.colourway_count }))
}

/**
 * A single product with its colourways and their inventory snapshot, or null
 * when the id is unknown (the caller turns that into a 404).
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getAdminProduct = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  const { rows: colourways } = await db.query(
    `${COLOURWAY_SELECT} WHERE c.product_id = $1 ORDER BY c.name ASC, c.id ASC`,
    [id]
  )
  return toProduct(row, { colourways: colourways.map(toColourway) })
}

const getAdminColourway = async (db, id) => {
  const { rows } = await db.query(`${COLOURWAY_SELECT} WHERE c.id = $1`, [id])
  return rows[0] ? toColourway(rows[0]) : null
}

const loadBrand = async (db, brandId) => {
  const { rows } = await db.query(`SELECT id, name FROM brands WHERE id = $1`, [brandId])
  if (!rows[0]) {
    throw httpError(422, `Brand ${brandId} does not exist.`)
  }
  return rows[0]
}

// A product's collection must belong to the same brand, or the storefront would
// file it under a house that never made it.
const requireCollectionInBrand = async (db, collectionId, brandId) => {
  const { rows } = await db.query(
    `SELECT id FROM collections WHERE id = $1 AND brand_id = $2`,
    [collectionId, brandId]
  )
  if (!rows[0]) {
    throw httpError(
      422,
      `Collection ${collectionId} does not belong to brand ${brandId}.`
    )
  }
}

const productSlug = (productType, brandName, name) =>
  productType === 'fabric' ? slugFrom(`${brandName} ${name}`) : slugFrom(name)

/**
 * Create a product. Colourways are added separately (one at a time) so each one
 * gets its inventory row in its own transaction.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createProduct = async (pool, input) => {
  const brand = await loadBrand(pool, input.brand_id)
  const name = input.name.trim()
  const slug = productSlug(input.product_type, brand.name, name)

  const collectionId = input.collection_id ?? null
  if (collectionId !== null) {
    await requireCollectionInBrand(pool, collectionId, brand.id)
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO products (
         brand_id, collection_id, name, slug, product_type, composition, width,
         application, rubs, price_band, lead_time, retail_price_cents,
         trade_price_cents, currency, show_on_website, hi_res_asset_url
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        brand.id,
        collectionId,
        name,
        slug,
        input.product_type,
        input.composition ?? null,
        input.width ?? null,
        input.application ?? null,
        input.rubs ?? null,
        input.price_band ?? null,
        input.lead_time ?? null,
        input.retail_price_cents ?? null,
        input.trade_price_cents ?? null,
        input.currency,
        input.show_on_website ?? false,
        input.hi_res_asset_url ?? null,
      ]
    )
    return getAdminProduct(pool, rows[0].id)
  } catch (error) {
    return rethrowConflict(error)
  }
}

/**
 * Patch a product. The slug, brand and product_type are all immutable; a
 * non-null collection_id is checked against the product's own brand.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateProduct = async (pool, id, input) => {
  const { rows } = await pool.query(`SELECT id, brand_id FROM products WHERE id = $1`, [
    id,
  ])
  const existing = rows[0]
  if (!existing) {
    throw httpError(404, `Product ${id} not found.`)
  }
  if (input.collection_id !== undefined && input.collection_id !== null) {
    await requireCollectionInBrand(pool, input.collection_id, existing.brand_id)
  }

  const patch = Object.hasOwn(input, 'name')
    ? { ...input, name: input.name.trim() }
    : input
  const { sets, params } = buildUpdate(patch, PRODUCT_UPDATE_COLUMNS)
  try {
    await pool.query(
      `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length + 1}`,
      [...params, id]
    )
  } catch (error) {
    return rethrowConflict(error)
  }
  return getAdminProduct(pool, id)
}

/**
 * Create a colourway and its inventory row (qty 0, unit from the parent's
 * product_type) in one transaction: a failed SKU must not leave a colourway
 * behind with no stock record.
 *
 * @param {import('pg').Pool} pool
 * @param {number} productId
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createColourway = async (pool, productId, input) => {
  const client = await pool.connect()
  let colourwayId = null
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, product_type FROM products WHERE id = $1`,
      [productId]
    )
    const product = rows[0]
    if (!product) {
      throw httpError(404, `Product ${productId} not found.`)
    }

    const { rows: created } = await client.query(
      `INSERT INTO colourways (product_id, name, sku, hex_tones, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        product.id,
        input.name.trim(),
        input.sku.trim(),
        serialiseTones(input.hex_tones),
        input.image_url ?? null,
      ]
    )
    colourwayId = created[0].id

    await client.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, 0, 0, $2)
       ON CONFLICT (colourway_id) DO NOTHING`,
      [colourwayId, unitFor(product.product_type)]
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    return rethrowConflict(error)
  } finally {
    client.release()
  }
  return getAdminColourway(pool, colourwayId)
}

/**
 * Patch a colourway. The SKU is editable — order lines reference colourway_id,
 * not the SKU text, so a correction cannot orphan commerce records.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateColourway = async (pool, id, input) => {
  const patch = {
    ...input,
    ...(Object.hasOwn(input, 'name') ? { name: input.name.trim() } : {}),
    ...(Object.hasOwn(input, 'sku') ? { sku: input.sku.trim() } : {}),
    ...(Object.hasOwn(input, 'hex_tones')
      ? { hex_tones: serialiseTones(input.hex_tones) }
      : {}),
  }
  const { sets, params } = buildUpdate(patch, COLOURWAY_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE colourways SET ${sets.join(', ')}
        WHERE id = $${params.length + 1}
        RETURNING id`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Colourway ${id} not found.`)
    }
  } catch (error) {
    return rethrowConflict(error)
  }
  return getAdminColourway(pool, id)
}

/**
 * Archive (soft-delete) or restore a product. Archiving also unpublishes it
 * (`show_on_website = false`) so it leaves the public catalogue immediately;
 * restore clears the archive flag but leaves it unpublished, so staff choose
 * when it goes back on the website. Inventory and any order lines are untouched.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object>}
 */
export const setProductArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'product', id, archived, {
    // Archiving unpublishes; restoring deliberately leaves it unpublished, so
    // staff choose when it goes back on the website.
    extraSets: archived ? ['show_on_website = false'] : [],
  })
  if (!row) {
    throw httpError(404, `Product ${id} not found.`)
  }
  return getAdminProduct(pool, id)
}

/**
 * Archive or restore a colourway. An archived colourway drops out of the public
 * product page and the merchandising rollup; its inventory row and any order
 * lines survive (order_lines reference colourway_id with ON DELETE RESTRICT).
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object>}
 */
export const setColourwayArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'colourway', id, archived)
  if (!row) {
    throw httpError(404, `Colourway ${id} not found.`)
  }
  return getAdminColourway(pool, id)
}
