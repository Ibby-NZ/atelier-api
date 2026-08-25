// Public brand read model: a flat brand list and a single brand with its
// collections, for storefront brand pages. All brands are shown (they are curated
// suppliers, not per-user data); pricing rules live on products, not brands.
//
// The house pages stay public even for the houses whose PRODUCTS are trade-only:
// the directory is Atelier's marketing — the whole point of representing a
// maison is that visitors know it is represented — and closing it would gut
// /brands for everyone signed out. `trade_only` rides along on the shape so the
// storefront can label the house and offer the trade application where its grid
// would otherwise read as an empty collection.
//
// Featured houses lead the list. `featured_rank ASC NULLS LAST, name ASC,
// id ASC` is deterministic even when two houses share a rank, which is why the
// column carries no unique index — a reorder never has to avoid a collision.
// The rank rides along on the shape so /brands can draw its "in focus" strip
// from the office's own choice instead of re-deriving one from is_international
// and a design count.
//
// The ordering is the SAME for every viewer: a house closed to the public
// (`trade_only`) is still listed, flagged, so featuring one cannot punch a hole
// in the strip — a consumer takes the first N featured rows it is given and
// never indexes by rank.

const BRAND_COLUMNS = `
  slug,
  name,
  country,
  currency,
  is_international,
  trade_only,
  story,
  website_url,
  image_url,
  featured_rank
`

const toBrand = (row) =>
  Object.freeze({
    slug: row.slug,
    name: row.name,
    country: row.country,
    currency: row.currency,
    is_international: row.is_international,
    trade_only: row.trade_only,
    story: row.story,
    website_url: row.website_url,
    // The house's own photograph, uploaded against the brand in the CRM. It is
    // the FIRST rung of the storefront's artwork chain (lib/houses.js) — above
    // the editorial page, a collection hero and a product shot — because it is
    // the only picture the office chose FOR THE HOUSE. Null for most houses;
    // consumers fall through the chain rather than borrowing another maison's.
    image_url: row.image_url,
    featured_rank: row.featured_rank,
  })

const toCollection = (row) =>
  Object.freeze({ slug: row.slug, name: row.name, featured_rank: row.featured_rank })

/**
 * Lists all brands: the featured ones in the office's order, then the rest
 * alphabetically.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object[]>}
 */
export const listBrands = async (pool) => {
  const { rows } = await pool.query(
    `SELECT ${BRAND_COLUMNS} FROM brands
      WHERE archived_at IS NULL
      ORDER BY featured_rank ASC NULLS LAST, name ASC, id ASC`
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
    `SELECT ${BRAND_COLUMNS}, id FROM brands WHERE slug = $1 AND archived_at IS NULL`,
    [slug]
  )
  const brandRow = rows[0]
  if (!brandRow) {
    return null
  }

  const { rows: collections } = await pool.query(
    `SELECT slug, name, featured_rank FROM collections
     WHERE brand_id = $1 AND archived_at IS NULL
     ORDER BY featured_rank ASC NULLS LAST, name ASC, id ASC`,
    [brandRow.id]
  )

  return { ...toBrand(brandRow), collections: collections.map(toCollection) }
}
