// Public catalogue product listing. Anonymous shoppers only — no trade pricing
// is ever computed or selected here (trade pricing lands in US-008 on the
// product-detail endpoint, guarded by an approved-trade check).

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

// Whitelist of querystring filter -> SQL column. Keys are the only accepted
// filter names; values are trusted column references (never user input), so
// the actual filter values still flow through parameterized placeholders.
const FILTER_COLUMNS = Object.freeze({
  application: 'p.application',
  composition: 'p.composition',
  width: 'p.width',
  price_band: 'p.price_band',
  lead_time: 'p.lead_time',
  product_type: 'p.product_type',
})

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
  b.slug AS brand_slug,
  b.name AS brand_name,
  b.is_international
`

// Turns a DB row into the anonymous public shape. Immutable: builds a fresh
// object, never mutates the row. Pricing rules (FR-3):
//   - international brands: price hidden, no price field at all
//   - domestic brands: retail_price_cents included only when actually set
const toPublicProduct = (row) => {
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
    brand: { slug: row.brand_slug, name: row.brand_name },
  }

  if (!row.is_international && row.retail_price_cents !== null) {
    return { ...base, retail_price_cents: row.retail_price_cents }
  }
  return base
}

// Builds the WHERE clause fragments and bound params from validated filters.
// `brand` matches on brand slug; every other key maps through FILTER_COLUMNS.
const buildFilters = (filters) => {
  const clauses = ['p.show_on_website = true']
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

  return { where: clauses.join(' AND '), params }
}

/**
 * Lists website-visible products with optional filters and pagination.
 * @returns {Promise<{ products: object[], total: number, page: number, limit: number }>}
 */
export const listProducts = async (pool, { filters = {}, page, limit } = {}) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildFilters(filters)

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total FROM products p JOIN brands b ON b.id = p.brand_id WHERE ${where}`,
    params
  )
  const total = countResult.rows[0].total

  const listResult = await pool.query(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     JOIN brands b ON b.id = p.brand_id
     WHERE ${where}
     ORDER BY p.name ASC, p.id ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    products: listResult.rows.map(toPublicProduct),
    total,
    page: safePage,
    limit: safeLimit,
  }
}
