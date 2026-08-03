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

// Products counted for a collection are the ones a shopper could actually reach:
// visible, unarchived, and belonging to an unarchived house. Same predicate the
// product listing applies, so a non-zero count always yields a non-empty grid.
const VISIBLE_PRODUCT_COUNT = `(
  SELECT count(*)::int
  FROM products p
  JOIN brands pb ON pb.id = p.brand_id
  WHERE p.collection_id = c.id
    AND p.show_on_website = true
    AND p.archived_at IS NULL
    AND pb.archived_at IS NULL
) AS product_count`

const COLLECTION_SELECT = `
  SELECT c.slug,
         c.name,
         ${VISIBLE_PRODUCT_COUNT},
         b.slug AS brand_slug,
         b.name AS brand_name
    FROM collections c
    JOIN brands b ON b.id = c.brand_id
   WHERE c.archived_at IS NULL AND b.archived_at IS NULL
`

const toCollection = (row) =>
  Object.freeze({
    slug: row.slug,
    name: row.name,
    product_count: row.product_count,
    brand: Object.freeze({ slug: row.brand_slug, name: row.brand_name }),
  })

/**
 * Lists live collections, optionally narrowed to one house.
 *
 * An unknown brand slug yields an empty list rather than an error: this mirrors
 * the product listing's filter behaviour, where a filter that matches nothing is
 * an empty result, not a 404.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brandSlug?: string }} [options]
 * @returns {Promise<object[]>}
 */
export const listCollections = async (pool, { brandSlug } = {}) => {
  const scoped = brandSlug ? `AND b.slug = $1` : ''
  const { rows } = await pool.query(
    `${COLLECTION_SELECT} ${scoped}
     ORDER BY b.name ASC, c.name ASC, c.id ASC`,
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
 * @returns {Promise<object|null>} the collection, or null when either slug is
 *   unknown, archived, or the pair does not belong together
 */
export const getCollection = async (pool, brandSlug, collectionSlug) => {
  const { rows } = await pool.query(
    `${COLLECTION_SELECT} AND b.slug = $1 AND c.slug = $2`,
    [brandSlug, collectionSlug]
  )
  return rows[0] ? toCollection(rows[0]) : null
}
