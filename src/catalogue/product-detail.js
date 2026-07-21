// Public product-detail read model. Anonymous shoppers get the same shape as the
// list endpoint plus colourways with per-colourway availability and the hi-res
// asset. Approved trade users additionally receive trade_price_cents; nobody else
// ever does (FR-3, enforced by the `includeTrade` flag the route derives from the
// authenticated user).

const PRODUCT_COLUMNS = `
  p.slug,
  p.name,
  p.product_type,
  p.composition,
  p.width,
  p.application,
  p.rubs,
  p.price_band,
  p.lead_time,
  p.currency,
  p.retail_price_cents,
  p.trade_price_cents,
  p.hi_res_asset_url,
  b.slug AS brand_slug,
  b.name AS brand_name,
  b.is_international
`

// A colourway is in stock when uncommitted quantity remains. Missing inventory
// row (LEFT JOIN → nulls) reads as out of stock. Postgres numeric columns come
// back as strings via pg, so coerce before the subtraction.
const isInStock = (row) => {
  const available = Number(row.qty_available)
  const reserved = Number(row.qty_reserved)
  if (!Number.isFinite(available) || !Number.isFinite(reserved)) {
    return false
  }
  return available - reserved > 0
}

const toColourway = (row) =>
  Object.freeze({
    name: row.name,
    sku: row.sku,
    hex_tones: row.hex_tones ?? null,
    image_url: row.image_url ?? null,
    in_stock: isInStock(row),
  })

// Builds the public product shape. Pricing mirrors the list endpoint: domestic
// brands expose retail_price_cents when set, international brands hide price.
// trade_price_cents is added only when includeTrade is true AND the product has one.
const toProductDetail = (row, colourways, includeTrade) => {
  const base = {
    slug: row.slug,
    name: row.name,
    product_type: row.product_type,
    composition: row.composition,
    width: row.width,
    application: row.application,
    rubs: row.rubs,
    price_band: row.price_band,
    lead_time: row.lead_time,
    currency: row.currency,
    price_hidden: row.is_international,
    hi_res_asset_url: row.hi_res_asset_url,
    brand: { slug: row.brand_slug, name: row.brand_name },
    colourways: colourways.map(toColourway),
  }

  const withRetail =
    !row.is_international && row.retail_price_cents !== null
      ? { ...base, retail_price_cents: row.retail_price_cents }
      : base

  if (includeTrade && row.trade_price_cents !== null) {
    return { ...withRetail, trade_price_cents: row.trade_price_cents }
  }
  return withRetail
}

/**
 * Loads a website-visible product by slug with its colourways and availability.
 * @param {import('pg').Pool} pool
 * @param {string} slug
 * @param {{ includeTrade?: boolean }} [options]
 * @returns {Promise<object|null>} the product detail, or null if not found/hidden
 */
export const getProductDetail = async (pool, slug, { includeTrade = false } = {}) => {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN brands b ON b.id = p.brand_id
     WHERE p.slug = $1 AND p.show_on_website = true`,
    [slug]
  )
  const productRow = rows[0]
  if (!productRow) {
    return null
  }

  const { rows: colourways } = await pool.query(
    `SELECT c.name, c.sku, c.hex_tones, c.image_url,
            i.qty_available, i.qty_reserved
     FROM colourways c
     JOIN products p ON p.id = c.product_id
     LEFT JOIN inventory i ON i.colourway_id = c.id
     WHERE p.slug = $1
     ORDER BY c.name ASC, c.id ASC`,
    [slug]
  )

  return toProductDetail(productRow, colourways, includeTrade)
}
