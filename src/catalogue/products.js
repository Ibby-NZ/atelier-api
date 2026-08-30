// Public catalogue product listing.
//
// Anonymous shoppers get the merchandising shape: imagery, availability and a
// mini colourway strip alongside the specs. Trade pricing is revealed only to
// approved trade users (FR-3) via the `includeTrade` flag the route derives
// from the optional session — exactly the same gate the detail endpoint uses.
//
// A SECOND, independent flag decides which houses appear at all:
// `includeTradeOnly` (see ./visibility.js). Without it the grid is the house's
// own workroom alone — the represented maisons are reserved for approved trade
// accounts and staff. `meta.trade_gated` tells the storefront which of the two
// libraries it is looking at, so it can invite a visitor to apply rather than
// silently serving a short grid.

import { PUBLIC_BRAND_CONDITION } from './visibility.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

// How many colourways a card carries. The strip is a visual cue, not the full
// list — the detail endpoint is the place to enumerate every colourway.
export const CARD_SWATCH_LIMIT = 6

export const DEFAULT_SORT = 'name'

// Whitelist of querystring filter -> SQL column. Keys are the only accepted
// filter names; values are trusted column references (never user input), so
// the actual filter values still flow through parameterized placeholders.
const FILTER_COLUMNS = Object.freeze({
  application: 'p.application',
  composition: 'p.composition',
  width: 'p.width',
  price_band: 'p.price_band',
  lead_time: 'p.lead_time',
  // One product per size, so this narrows to a shape of the thing — the bath
  // towels, the queen duvet covers — across every house that makes one.
  size: 'p.size',
  product_type: 'p.product_type',
  // The merchandising axis (products.category), nine values wide since
  // migrations/1789651200000_category-vocabulary.js. It is NOT product_type:
  // a cushion and a throw are both `finished_good` and a shopper browsing for
  // one has no interest in the other. Most of the catalogue is uncategorised
  // (the column is nullable on purpose — see that column's migration), so this
  // filter matches nothing until the office fills it in, which is why the
  // storefront derives its facet from the products it actually received rather
  // than from the vocabulary.
  category: 'p.category',
  // A collection slug is unique per brand, not globally, so `collection` alone
  // matches every house that happens to use that slug. Pair it with `brand` for
  // a real collection page — that pair is the storefront's collection URL.
  collection: 'col.slug',
})

// The price a shopper is actually allowed to see. International brands hide
// theirs (FR-3), so price sorting must order on this — not on the raw column —
// or the ordering itself would leak the hidden figures.
const DISPLAY_PRICE = `CASE WHEN b.is_international THEN NULL ELSE p.retail_price_cents END`

// Sort key -> trusted ORDER BY fragment. Never interpolate user input here.
const SORT_ORDERS = Object.freeze({
  name: 'p.name ASC, p.id ASC',
  price_asc: `${DISPLAY_PRICE} ASC NULLS LAST, p.name ASC, p.id ASC`,
  price_desc: `${DISPLAY_PRICE} DESC NULLS LAST, p.name ASC, p.id ASC`,
  newest: 'p.created_at DESC, p.id DESC',
})

export const SORT_KEYS = Object.freeze(Object.keys(SORT_ORDERS))

const PRODUCT_COLUMNS = `
  p.slug,
  p.name,
  p.product_type,
  p.category,
  p.size,
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
  col.slug AS collection_slug,
  col.name AS collection_name,
  cw.colourway_count,
  cw.in_stock,
  cw.colourway_image_url,
  cw.swatches
`

// The product's collection, when it still has a live one. Archiving a
// collection keeps its products on sale (see admin-brands.js), so the join
// condition — not a WHERE clause — carries the archived check: the product
// stays in the grid and simply reads as uncollected. The same join makes the
// `collection` filter unable to match an archived collection.
const COLLECTION_JOIN = `
  LEFT JOIN collections col
    ON col.id = p.collection_id AND col.archived_at IS NULL
`

// Per-product colourway rollup: how many colourways, whether any has
// uncommitted stock, the first colourway image (ordered like the detail
// endpoint) and a compact swatch list for the card strip. Aggregates over an
// empty set still yield one row, so the LEFT JOIN never produces NULL `cw`.
const COLOURWAY_ROLLUP = `
  LEFT JOIN LATERAL (
    SELECT
      count(*)::int AS colourway_count,
      bool_or(COALESCE(i.qty_available, 0) - COALESCE(i.qty_reserved, 0) > 0) AS in_stock,
      (array_remove(array_agg(c.image_url ORDER BY c.name ASC, c.id ASC), NULL))[1]
        AS colourway_image_url,
      jsonb_agg(
        jsonb_build_object('name', c.name, 'sku', c.sku, 'hex_tones', c.hex_tones)
        ORDER BY c.name ASC, c.id ASC
      ) AS swatches
    FROM colourways c
    LEFT JOIN inventory i ON i.colourway_id = c.id
    WHERE c.product_id = p.id AND c.archived_at IS NULL
  ) cw ON true
`

// Escape the LIKE wildcards so a search for "100%" matches a literal percent
// rather than everything. Pairs with the ESCAPE '\' clause in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const toSwatch = (swatch) => ({
  name: swatch?.name ?? null,
  sku: swatch?.sku ?? null,
  hex_tones: swatch?.hex_tones ?? null,
})

// Turns a DB row into the public shape. Immutable: builds a fresh object, never
// mutates the row. Pricing rules (FR-3):
//   - international brands: retail price hidden, no field at all
//   - domestic brands: retail_price_cents included only when actually set
//   - trade_price_cents: only when the caller is an approved trade user
const toPublicProduct = (row, includeTrade) => {
  const swatches = Array.isArray(row.swatches) ? row.swatches.filter(Boolean) : []

  const base = {
    slug: row.slug,
    name: row.name,
    product_type: row.product_type,
    // Always present, null included: a card can branch on the value instead of
    // on whether the key came back, and "not categorised yet" is a real state
    // across most of the catalogue.
    category: row.category ?? null,
    // Present, null included, exactly as `category` is: a fabric has no size,
    // and that is a real answer rather than a missing key. `description` is
    // deliberately NOT on the card — it is prose for the product page, and
    // carrying it would inflate a 60-row list for something nothing renders.
    size: row.size ?? null,
    composition: row.composition,
    width: row.width,
    application: row.application,
    rubs: row.rubs,
    price_band: row.price_band,
    lead_time: row.lead_time,
    currency: row.currency,
    price_hidden: row.is_international,
    // Colourway photography first (it is the actual swatch), then the product's
    // hi-res asset as a fallback so a card is rarely image-less.
    image_url: row.colourway_image_url ?? row.hi_res_asset_url ?? null,
    in_stock: row.in_stock === true,
    colourway_count: row.colourway_count ?? 0,
    colourways: swatches.slice(0, CARD_SWATCH_LIMIT).map(toSwatch),
    brand: { slug: row.brand_slug, name: row.brand_name },
    // Always present so the storefront can branch on null instead of on a
    // missing key; null covers both "no collection" and "archived collection".
    collection: row.collection_slug
      ? { slug: row.collection_slug, name: row.collection_name }
      : null,
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

// Builds the WHERE clause fragments and bound params from validated filters.
// `brand` matches on brand slug, `q` is a free-text search across the product,
// its house and its colourways; every other key maps through FILTER_COLUMNS.
const buildFilters = (filters, includeTradeOnly) => {
  // Archived products/brands are removed from the public catalogue (a soft
  // delete unpublishes the product too, but filter both so an archived brand
  // hides all of its products even if one is still flagged visible).
  const clauses = [
    'p.show_on_website = true',
    'p.archived_at IS NULL',
    'b.archived_at IS NULL',
  ]
  // Represented houses are trade-only. Applied as a WHERE clause (not a join
  // condition) because a product from a closed house must vanish entirely, not
  // read as brandless.
  if (!includeTradeOnly) {
    clauses.push(PUBLIC_BRAND_CONDITION)
  }
  const params = []

  if (filters.brand) {
    params.push(filters.brand)
    clauses.push(`b.slug = $${params.length}`)
  }

  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    const value = filters[key]
    if (value !== undefined && value !== null && value !== '') {
      params.push(value)
      clauses.push(`${column} = $${params.length}`)
    }
  }

  const term = typeof filters.q === 'string' ? filters.q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    clauses.push(`(
      p.name ILIKE $${i} ESCAPE '\\'
      OR b.name ILIKE $${i} ESCAPE '\\'
      OR p.composition ILIKE $${i} ESCAPE '\\'
      OR p.application ILIKE $${i} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM colourways c2
        WHERE c2.product_id = p.id
          AND c2.archived_at IS NULL
          AND (c2.name ILIKE $${i} ESCAPE '\\' OR c2.sku ILIKE $${i} ESCAPE '\\')
      )
    )`)
  }

  return { where: clauses.join(' AND '), params }
}

/**
 * Lists website-visible products with optional filters, search, sort and
 * pagination.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   filters?: object,
 *   page?: number,
 *   limit?: number,
 *   sort?: string,
 *   includeTrade?: boolean,
 *   includeTradeOnly?: boolean,
 * }} [options]
 * @returns {Promise<{ products: object[], total: number, page: number, limit: number, sort: string, trade_gated: boolean }>}
 */
export const listProducts = async (
  pool,
  {
    filters = {},
    page,
    limit,
    sort,
    includeTrade = false,
    includeTradeOnly = false,
  } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit
  const safeSort = Object.hasOwn(SORT_ORDERS, sort) ? sort : DEFAULT_SORT

  const { where, params } = buildFilters(filters, includeTradeOnly)

  // The collection join is in the count query too: `collection` is a filter, so
  // meta.total has to be the filtered total.
  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM products p
     JOIN brands b ON b.id = p.brand_id
     ${COLLECTION_JOIN}
     WHERE ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const listResult = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN brands b ON b.id = p.brand_id
     ${COLLECTION_JOIN}
     ${COLOURWAY_ROLLUP}
     WHERE ${where}
     ORDER BY ${SORT_ORDERS[safeSort]}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    products: listResult.rows.map((row) => toPublicProduct(row, includeTrade)),
    total,
    page: safePage,
    limit: safeLimit,
    sort: safeSort,
    // True when this response is the public subset — the storefront's cue to
    // say "the rest of the library is open to trade accounts" instead of
    // presenting a short grid as if it were everything.
    trade_gated: !includeTradeOnly,
  }
}
