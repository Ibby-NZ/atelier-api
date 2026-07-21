// Public brand read model: a flat brand list and a single brand with its
// collections, for storefront brand pages. All brands are shown (they are curated
// suppliers, not per-user data); pricing rules live on products, not brands.

const BRAND_COLUMNS = `
  slug,
  name,
  country,
  currency,
  is_international,
  story
`

const toBrand = (row) =>
  Object.freeze({
    slug: row.slug,
    name: row.name,
    country: row.country,
    currency: row.currency,
    is_international: row.is_international,
    story: row.story,
  })

const toCollection = (row) => Object.freeze({ slug: row.slug, name: row.name })

/**
 * Lists all brands, alphabetically.
 * @param {import('pg').Pool} pool
 * @returns {Promise<object[]>}
 */
export const listBrands = async (pool) => {
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS} FROM brands ORDER BY name ASC, id ASC`
  )
  return rows.map(toBrand)
}

/**
 * Loads a single brand by slug with its collections.
 * @param {import('pg').Pool} pool
 * @param {string} slug
 * @returns {Promise<object|null>} brand with a `collections` array, or null
 */
export const getBrandBySlug = async (pool, slug) => {
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS}, id FROM brands WHERE slug = $1`,
    [slug]
  )
  const brandRow = rows[0]
  if (!brandRow) {
    return null
  }

  const { rows: collections } = await pool.query(
    `SELECT slug, name FROM collections
     WHERE brand_id = $1
     ORDER BY name ASC, id ASC`,
    [brandRow.id]
  )

  return { ...toBrand(brandRow), collections: collections.map(toCollection) }
}
