// Public collection read model — the middle tier of brand -> collection ->
// product, for storefront collection navigation.
//
// Two things shape every query here:
//   - A collection slug is unique per brand (collections_brand_id_slug_unique),
//     never globally, so a single-collection lookup MUST be brand-scoped or two
//     houses with a "Cappuccino" would resolve to each other's products.
//   - Archiving a collection is a soft delete of the grouping only: its products
//     stay on the website (see admin-brands.js setCollectionArchived), so an
//     archived collection is hidden here while its products keep selling.
//
// The product grid for a collection is deliberately NOT built here — callers use
// GET /catalogue/products?brand=&collection= so filtering, sorting, paging and
// the trade-pricing gate stay in one read model.

// Products counted for a collection are the ones THIS VIEWER could actually
// reach: visible, unarchived, belonging to an unarchived house, and — unless
// the viewer may browse the represented houses — from an open house. Same
// predicate the product listing applies, so a non-zero count always yields a
// non-empty grid; counting hidden products would send a shopper to a tile that
// promises twelve designs and opens on none.
//
// The collections themselves stay listed for every viewer, like the brands they
// belong to: they are editorial (name, blurb, photograph) and the homepage
// merchandises out of them. Only the count moves.
const visibleProductCount = (includeTradeOnly) => `(
  SELECT count(*)::int
  FROM products p
  JOIN brands pb ON pb.id = p.brand_id
  WHERE p.collection_id = c.id
    AND p.show_on_website = true
    AND p.archived_at IS NULL
    AND pb.archived_at IS NULL
    ${includeTradeOnly ? '' : 'AND pb.trade_only = false'}
) AS product_count`

const collectionSelect = (includeTradeOnly) => `
  SELECT c.slug,
         c.name,
         c.description,
         c.image_url,
         c.featured_rank,
         ${visibleProductCount(includeTradeOnly)},
         b.slug AS brand_slug,
         b.name AS brand_name,
         b.trade_only
    FROM collections c
    JOIN brands b ON b.id = c.brand_id
   WHERE c.archived_at IS NULL AND b.archived_at IS NULL
`

const toCollection = (row) =>
  Object.freeze({
    slug: row.slug,
    name: row.name,
    description: row.description,
    image_url: row.image_url,
    featured_rank: row.featured_rank,
    product_count: row.product_count,
    brand: Object.freeze({
      slug: row.brand_slug,
      name: row.brand_name,
      trade_only: row.trade_only,
    }),
  })

/**
 * Lists live collections, optionally narrowed to one house: the featured ones
 * in the office's order, then the rest by house and collection name.
 *
 * The featured ones lead ACROSS houses, not within each — the homepage's hero
 * is one list the office ordered, and grouping by house first would scatter it.
 * `featured_rank ASC NULLS LAST` then the existing house/name/id tail keeps the
 * unfeatured majority exactly where it was and stays deterministic when two
 * collections share a rank, which is why the column carries no unique index.
 *
 * The order is the same for every viewer: a collection belonging to a house
 * closed to the public is still listed (only its `product_count` drops to 0),
 * so featuring one cannot leave a gap a consumer would have to fill.
 *
 * An unknown brand slug yields an empty list rather than an error: this mirrors
 * the product listing's filter behaviour, where a filter that matches nothing is
 * an empty result, not a 404.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brandSlug?: string, includeTradeOnly?: boolean }} [options]
 * @returns {Promise<object[]>}
 */
export const listCollections = async (
  pool,
  { brandSlug, includeTradeOnly = false } = {}
) => {
  const scoped = brandSlug ? `AND b.slug = $1` : ''
  const { rows } = await pool.query(
    `${collectionSelect(includeTradeOnly)} ${scoped}
     ORDER BY c.featured_rank ASC NULLS LAST, b.name ASC, c.name ASC, c.id ASC`,
    brandSlug ? [brandSlug] : []
  )
  return rows.map(toCollection)
}

/**
 * Loads one collection by its house slug + its own slug.
 *
 * @param {import('pg').Pool} pool
 * @param {string} brandSlug
 * @param {string} collectionSlug
 * @param {{ includeTradeOnly?: boolean }} [options]
 * @returns {Promise<object|null>} the collection, or null when either slug is
 *   unknown, archived, or the pair does not belong together
 */
export const getCollection = async (
  pool,
  brandSlug,
  collectionSlug,
  { includeTradeOnly = false } = {}
) => {
  const { rows } = await pool.query(
    `${collectionSelect(includeTradeOnly)} AND b.slug = $1 AND c.slug = $2`,
    [brandSlug, collectionSlug]
  )
  return rows[0] ? toCollection(rows[0]) : null
}
