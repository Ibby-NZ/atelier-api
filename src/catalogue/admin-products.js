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

import {
  slugFrom,
  rethrowConflict,
  buildUpdate,
  reportingLabelFrom,
} from './admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'
import {
  withChangeContext,
  requireChangeReason,
  raisePriceHistoryError,
} from '../pricing/price-history.js'

// A product's price is the PAIR, and either half moving is a price change. The
// capture trigger watches both columns; this list is what decides whether the
// caller owes a reason, so the two must stay in step.
const PRICE_COLUMNS = Object.freeze(['retail_price_cents', 'trade_price_cents'])

// Colourways are the largest catalogue table (one row per SKU, ~19k designs
// once the colour files land), so the standalone list pages; the product list
// pages too, because the CRM will not read a whole catalogue to show one
// screen of it. Same numbers as the price-list ledger.
export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/**
 * Clamp a caller's page/limit to what a query may run with. The route schema
 * already defaults and caps them; this keeps the module safe for direct callers.
 *
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {{ page: number, limit: number, offset: number }}
 */
export const pageWindow = ({ page, limit } = {}) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  return { page: safePage, limit: safeLimit, offset: (safePage - 1) * safeLimit }
}

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// A fabric is measured in metres, a finished good in units. This is why
// product_type is create-only: changing it would strand existing stock in the
// wrong unit.
const UNIT_BY_PRODUCT_TYPE = Object.freeze({
  fabric: 'metres',
  finished_good: 'units',
})

/**
 * The stock unit a colourway of this product type is measured in. Exported so
 * the inventory admin derives it from the same map rather than its own copy —
 * `unit` is never accepted from a client, and two maps would eventually disagree
 * about which one a colourway created by the other path should have used.
 *
 * @param {string} productType
 * @returns {string}
 */
export const unitFor = (productType) => {
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
        p.product_range,
        p.category,
        p.size,
        p.description,
        p.composition,
        p.width,
        p.application,
        p.rubs,
        p.price_band,
        p.lead_time,
        p.retail_price_cents,
        p.trade_price_cents,
        p.wholesale_rate,
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
  // The W21 reporting dimension (migration 1788408000000): Atelier's own
  // spelling of the house's product line, filled from the CRM one house at a
  // time. Free text, not an FK — the range vocabulary lives in a staging mirror
  // that is re-imported wholesale. A cleared input stores NULL, never '' (the
  // CHECK refuses a blank), via reportingLabelFrom below.
  'product_range',
  // The merchandising axis. Editable rather than create-only, unlike
  // product_type beside it: product_type decides the colourway's inventory unit
  // and changing it would strand stock, where a category is a label the office
  // corrects. The spreadsheet round trip (src/products/product-sheet.js) writes
  // the same column in bulk; this is the single-design door onto it, and until
  // now the CRM had none — a category could only be set by uploading a CSV.
  'category',
  // The size is a PRODUCT column because price is: retail/trade cents live on
  // this row, and a bath sheet and a face cloth are different prices, so they
  // are two products rather than two variants of one. Free text — the
  // vocabulary is per category and open-ended (queen/king, hand/bath) — with
  // the CRM offering the sizes already in use as suggestions.
  'size',
  // Sales prose for the storefront's product page. `nullableText` in the route
  // schema, matching collections.description rather than the short spec fields.
  'description',
  'composition',
  'width',
  'application',
  'rubs',
  'price_band',
  'lead_time',
  'retail_price_cents',
  'trade_price_cents',
  // The design's wholesale rate in its supplier's currency (24 Sep 2026) — the
  // coming wholesale import fills it, and the office may key it meanwhile. A
  // purchase-order line is priced from it (src/purchasing/po-pricing.js). A
  // cost INPUT, not a sell price, so no `reason` is asked for.
  'wholesale_rate',
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
    product_range: row.product_range ?? null,
    category: row.category ?? null,
    size: row.size ?? null,
    description: row.description ?? null,
    composition: row.composition,
    width: row.width,
    application: row.application,
    rubs: row.rubs,
    price_band: row.price_band,
    lead_time: row.lead_time,
    retail_price_cents: row.retail_price_cents,
    trade_price_cents: row.trade_price_cents,
    // numeric(12,4) arrives as a string; null is "not imported yet", never 0.
    wholesale_rate: row.wholesale_rate == null ? null : Number(row.wholesale_rate),
    currency: row.currency,
    show_on_website: row.show_on_website,
    hi_res_asset_url: row.hi_res_asset_url,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    ...extra,
  })

// The inventory snapshot is read-only here — quantities move through the order
// state machine (src/orders/admin-orders.js), never through catalogue edits.
// `extra` carries the parent context a standalone read adds (same shape as
// toProduct's): a bare `rows.map(toColourway)` would hand it the array index.
const toColourway = (row, extra) =>
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
    ...extra,
  })

const COLOURWAY_COLUMNS = `c.id, c.product_id, c.name, c.sku, c.hex_tones, c.image_url,
              c.archived_at, i.qty_available, i.qty_reserved, i.unit`

const COLOURWAY_SELECT = `SELECT ${COLOURWAY_COLUMNS}
         FROM colourways c
         LEFT JOIN inventory i ON i.colourway_id = c.id`

// A colourway read on its own has to say which design and house the SKU belongs
// to — that is the whole point of browsing colourways without opening their
// product. The colourways embedded in a product detail already sit under theirs,
// so they keep the narrower shape above.
const COLOURWAY_CONTEXT_COLUMNS = `p.name AS product_name,
              p.slug AS product_slug,
              p.product_type,
              p.brand_id,
              b.name AS brand_name,
              p.trade_price_cents,
              p.retail_price_cents`

// Both joins are inner: product_id and brand_id are NOT NULL, so a colourway
// always has both. inventory stays a LEFT JOIN and cannot multiply rows —
// colourway_id is unique on it — which is what lets the count query share this.
const COLOURWAY_CONTEXT_FROM = `FROM colourways c
         LEFT JOIN inventory i ON i.colourway_id = c.id
         JOIN products p ON p.id = c.product_id
         JOIN brands b ON b.id = p.brand_id`

const colourwayContext = (row) => ({
  product_name: row.product_name,
  product_slug: row.product_slug,
  product_type: row.product_type,
  brand_id: row.brand_id,
  brand_name: row.brand_name,
  // The design's catalogue prices, so a line added to a sales order is priced
  // on the order's own basis (trade or retail) without anyone retyping it.
  // The CRM always lets the office override; null means the design is quoted
  // per job.
  trade_price_cents: row.trade_price_cents ?? null,
  retail_price_cents: row.retail_price_cents ?? null,
})

// Escape the LIKE wildcards so a search for "100%" matches a literal percent
// rather than everything. Pairs with the ESCAPE '\' clause in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// WHERE fragments + bound params for the colourway list. Filter names are
// trusted column references; filter *values* always flow through $n placeholders.
const buildColourwayWhere = ({ productId, brandId, q, includeArchived }) => {
  const clauses = []
  const params = []

  // The colourway's OWN archive flag, never its product's: archiving a product
  // does not archive its colourways, and hiding them here would make this list
  // disagree with the product detail about which SKUs exist.
  if (!includeArchived) {
    clauses.push('c.archived_at IS NULL')
  }
  if (productId) {
    params.push(productId)
    clauses.push(`c.product_id = $${params.length}`)
  }
  if (brandId) {
    params.push(brandId)
    clauses.push(`p.brand_id = $${params.length}`)
  }

  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // The design name is in here because staff name a colourway by its product
    // ("Atlas in Ivory"); the house is a filter, not a search term, or one
    // maison's name would return several thousand rows.
    clauses.push(`(
      c.sku ILIKE $${i} ESCAPE '\\'
      OR c.name ILIKE $${i} ESCAPE '\\'
      OR p.name ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

// pg maps a raw JS array to a Postgres array literal, not jsonb — hex_tones has
// to be stringified on the way in (same rule as the seed).
const serialiseTones = (tones) => (tones ? JSON.stringify(tones) : null)

// The figure a product is banded on: retail first (what the storefront shows a
// shopper), the trade figure where there is no retail — a fabric from an
// international house carries only the latter. Mirrors the CRM's
// productPriceCents so a band filter and the band a row displays agree.
const PRODUCT_PRICE_SQL = 'COALESCE(p.retail_price_cents, p.trade_price_cents)'

const buildProductWhere = ({
  brandId,
  includeArchived,
  q,
  category,
  uncategorised,
  priceMinCents,
  priceMaxCents,
  unpriced,
}) => {
  const clauses = []
  const params = []
  if (brandId) {
    params.push(brandId)
    clauses.push(`p.brand_id = $${params.length}`)
  }
  if (!includeArchived) {
    clauses.push('p.archived_at IS NULL')
  }
  // "Uncategorised" is a flag, not `category=`: an empty query value cannot
  // travel, and NULL is the only way a product has no category.
  if (uncategorised) {
    clauses.push('p.category IS NULL')
  } else if (category) {
    params.push(category)
    clauses.push(`p.category = $${params.length}`)
  }
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    clauses.push(`p.name ILIKE $${params.length} ESCAPE '\\'`)
  }
  // "No price" is its own answer — the office uses it to find what still needs
  // pricing — and a range never matches it, so the two are exclusive.
  if (unpriced) {
    clauses.push(`${PRODUCT_PRICE_SQL} IS NULL`)
  } else {
    if (Number.isInteger(priceMinCents)) {
      params.push(priceMinCents)
      clauses.push(`${PRODUCT_PRICE_SQL} >= $${params.length}`)
    }
    if (Number.isInteger(priceMaxCents)) {
      params.push(priceMaxCents)
      clauses.push(`${PRODUCT_PRICE_SQL} <= $${params.length}`)
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/**
 * Filtered, paginated products. Unlike the public list this includes hidden
 * products (`show_on_website = false`) — that flag is the thing staff come here
 * to toggle. `q` is an ILIKE over the design name; the house is a filter, not a
 * search term. Returns { items, total, maxPriceCents }: the route builds the
 * meta envelope, and `maxPriceCents` (unfiltered) is the ceiling the CRM draws
 * its price-band select from, since it can no longer read every row.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   brandId?: number,
 *   includeArchived?: boolean,
 *   q?: string,
 *   category?: string,
 *   uncategorised?: boolean,
 *   priceMinCents?: number,
 *   priceMaxCents?: number,
 *   unpriced?: boolean,
 *   page?: number,
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{ items: object[], total: number, maxPriceCents: number|null }>}
 */
export const listAdminProducts = async (
  pool,
  { includeArchived = false, page, limit, ...filters } = {}
) => {
  const window = pageWindow({ page, limit })
  const { where, params } = buildProductWhere({ includeArchived, ...filters })

  const [countResult, ceilingResult] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total ${PRODUCT_FROM} ${where}`, params),
    pool.query(`SELECT max(${PRODUCT_PRICE_SQL})::int AS ceiling FROM products p`),
  ])

  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS},
            (SELECT COUNT(*) FROM colourways c
              WHERE c.product_id = p.id AND c.archived_at IS NULL)::int
              AS colourway_count
       ${PRODUCT_FROM}
       ${where}
      ORDER BY b.name ASC, p.name ASC, p.id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, window.limit, window.offset]
  )
  return {
    items: rows.map((row) => toProduct(row, { colourway_count: row.colourway_count })),
    total: countResult.rows[0].total,
    maxPriceCents: ceilingResult.rows[0].ceiling,
  }
}

/**
 * How many products sit in each category, under the same house/archived
 * filters as the list — the Categories screen's rows. Vocabulary order is the
 * CRM's to draw; this answers in count order with the uncategorised
 * (`category: null`) last, so a house that is all one thing reads at a glance.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brandId?: number, includeArchived?: boolean }} [options]
 * @returns {Promise<Array<{ category: string|null, count: number }>>}
 */
export const countAdminProductsByCategory = async (
  pool,
  { brandId, includeArchived = false } = {}
) => {
  const { where, params } = buildProductWhere({ brandId, includeArchived })
  const { rows } = await pool.query(
    `SELECT p.category, count(*)::int AS count
       ${PRODUCT_FROM}
       ${where}
      GROUP BY p.category
      ORDER BY (p.category IS NULL) ASC, count DESC, p.category ASC`,
    params
  )
  return rows.map((row) => ({ category: row.category, count: row.count }))
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
  return toProduct(row, { colourways: colourways.map((child) => toColourway(child)) })
}

/**
 * Filtered, paginated colourways across the whole catalogue — the SKU-level
 * browse, so a colour can be found without knowing which design it belongs to.
 * `q` is a free-text ILIKE over SKU, colour name and design name. Returns
 * { items, total }; the route builds the meta envelope. Ordered house, design,
 * colour, id for a stable page-to-page walk.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   productId?: number,
 *   brandId?: number,
 *   q?: string,
 *   includeArchived?: boolean,
 *   page?: number,
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{ items: object[], total: number }>}
 */
export const listAdminColourways = async (
  pool,
  { productId, brandId, q, includeArchived = false, page, limit } = {}
) => {
  const { limit: safeLimit, offset } = pageWindow({ page, limit })

  const { where, params } = buildColourwayWhere({ productId, brandId, q, includeArchived })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total ${COLOURWAY_CONTEXT_FROM} ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const { rows } = await pool.query(
    `SELECT ${COLOURWAY_COLUMNS},
            ${COLOURWAY_CONTEXT_COLUMNS}
       ${COLOURWAY_CONTEXT_FROM}
       ${where}
      ORDER BY b.name ASC, p.name ASC, c.name ASC, c.id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return { items: rows.map((row) => toColourway(row, colourwayContext(row))), total }
}

/**
 * One colourway by id with its stock snapshot and parent context, or null when
 * the id is unknown. No archived filter: this is what the CRM re-reads after a
 * write, including the archive it just made.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getAdminColourway = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${COLOURWAY_COLUMNS},
            ${COLOURWAY_CONTEXT_COLUMNS}
       ${COLOURWAY_CONTEXT_FROM}
      WHERE c.id = $1`,
    [id]
  )
  return rows[0] ? toColourway(rows[0], colourwayContext(rows[0])) : null
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
         brand_id, collection_id, name, slug, product_type, product_range,
         category, composition, width, application, rubs, price_band, lead_time,
         retail_price_cents, trade_price_cents, currency, show_on_website,
         hi_res_asset_url, size, description
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20)
       RETURNING id`,
      [
        brand.id,
        collectionId,
        name,
        slug,
        input.product_type,
        reportingLabelFrom(input.product_range),
        input.category ?? null,
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
        input.size ?? null,
        input.description ?? null,
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
 * A patch that MOVES either price demands `input.reason` and answers 422
 * without it — the client's rule, enforced here in the module rather than in the
 * route so it holds for the CRM, the AdminJS panel and any future caller (the
 * `updateUser` posture). Restating the same figures is not a change and needs
 * nothing. The write runs in a transaction that declares the change source,
 * which is how the capture trigger learns who and why.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @param {{ user?: { id: number } }} [ctx]
 * @returns {Promise<object>}
 */
export const updateProduct = async (pool, id, input, ctx = {}) => {
  const { rows } = await pool.query(
    `SELECT id, brand_id, retail_price_cents, trade_price_cents
       FROM products WHERE id = $1`,
    [id]
  )
  const existing = rows[0]
  if (!existing) {
    throw httpError(404, `Product ${id} not found.`)
  }
  if (input.collection_id !== undefined && input.collection_id !== null) {
    await requireCollectionInBrand(pool, input.collection_id, existing.brand_id)
  }

  let patch = Object.hasOwn(input, 'name')
    ? { ...input, name: input.name.trim() }
    : input
  if (Object.hasOwn(patch, 'product_range')) {
    patch = { ...patch, product_range: reportingLabelFrom(patch.product_range) }
  }
  const { sets, params } = buildUpdate(patch, PRODUCT_UPDATE_COLUMNS)

  // Advisory: the table's CHECK is the real gate, so a figure that moved under
  // this read simply reaches the database and is refused there.
  const moving = PRICE_COLUMNS.some(
    (column) =>
      Object.hasOwn(patch, column) && (patch[column] ?? null) !== (existing[column] ?? null)
  )
  const reason = moving ? requireChangeReason(input.reason) : null

  try {
    await withChangeContext(
      pool,
      { source: 'manual', reason, userId: ctx.user?.id ?? null },
      (client) =>
        client.query(
          `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length + 1}`,
          [...params, id]
        )
    )
  } catch (error) {
    raisePriceHistoryError(error)
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
