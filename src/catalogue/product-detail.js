// Public product-detail read model. Anonymous shoppers get the same shape as the
// list endpoint plus colourways with per-colourway availability and the hi-res
// asset. Approved trade users additionally receive trade_price_cents; nobody else
// ever does (FR-3, enforced by the `includeTrade` flag the route derives from the
// authenticated user).
//
// The house-visibility gate (./visibility.js) is deliberately NOT folded into
// the WHERE clause here, the way it is in the listing. A represented house's
// product genuinely exists and its URL is shareable, so answering 404 to a
// signed-out visitor would be a lie the storefront then has to render as a dead
// page — and the storefront's SSR fetch carries no session cookie, so a trade
// customer's own product page would 404 in the HTML and only appear once the
// island rehydrated. Instead the row is fetched, then reported as `restricted`,
// and the route turns that into a 403 the page can render as an invitation to
// apply for trade. Nothing about the product is returned with it.

const PRODUCT_COLUMNS = `
  p.slug,
  p.name,
  p.product_type,
  p.category,
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
  b.is_international,
  b.trade_only,
  col.slug AS collection_slug,
  col.name AS collection_name
`

// Mirrors the listing: an archived collection is dropped by the join condition
// rather than the WHERE clause, so the product itself stays reachable and only
// loses its collection label.
const COLLECTION_JOIN = `
  LEFT JOIN collections col
    ON col.id = p.collection_id AND col.archived_at IS NULL
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
    // Same shape as the list endpoint's card: present, null when uncategorised.
    category: row.category ?? null,
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
    collection: row.collection_slug
      ? { slug: row.collection_slug, name: row.collection_name }
      : null,
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
 *
 * Three outcomes, deliberately distinguished (the route maps them to 404 / 403 /
 * 200): the slug is unknown or unpublished; the product belongs to a house this
 * viewer may not browse; or the product itself.
 *
 * @param {import('pg').Pool} pool
 * @param {string} slug
 * @param {{ includeTrade?: boolean, includeTradeOnly?: boolean }} [options]
 * @returns {Promise<{ product: object|null, restricted: boolean }>}
 */
export const getProductDetail = async (
  pool,
  slug,
  { includeTrade = false, includeTradeOnly = false } = {}
) => {
  const { rows } = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN brands b ON b.id = p.brand_id
     ${COLLECTION_JOIN}
     WHERE p.slug = $1 AND p.show_on_website = true
       AND p.archived_at IS NULL AND b.archived_at IS NULL`,
    [slug]
  )
  const productRow = rows[0]
  if (!productRow) {
    return { product: null, restricted: false }
  }
  // Answer before loading colourways: a restricted product returns nothing at
  // all, so there is no second query to pay for and no shape to accidentally
  // leak a field through.
  if (productRow.trade_only && !includeTradeOnly) {
    return { product: null, restricted: true }
  }

  const { rows: colourways } = await pool.query(
    `SELECT c.name, c.sku, c.hex_tones, c.image_url,
            i.qty_available, i.qty_reserved
     FROM colourways c
     JOIN products p ON p.id = c.product_id
     LEFT JOIN inventory i ON i.colourway_id = c.id
     WHERE p.slug = $1 AND c.archived_at IS NULL
     ORDER BY c.name ASC, c.id ASC`,
    [slug]
  )

  return {
    product: toProductDetail(productRow, colourways, includeTrade),
    restricted: false,
  }
}
