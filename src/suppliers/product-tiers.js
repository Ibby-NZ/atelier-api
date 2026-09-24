// The discount tier staff pick for a product (migration 1791638400000).
//
// A house with labelled tiers (JV: 40 / 45 / 50%) used to have its tier chosen
// only by matching the line's category to the label. This is the explicit
// choice: any tier on the product's own house's terms. It lives in the
// suppliers domain because it names `supplier_discount_tiers` (see
// test/suppliers-terms.test.js), and it is COST DATA — served only behind the
// finance gate, never joined by a storefront read model.
//
// Precedence in resolveTermsChain: a compounded chain still wins, then this
// choice, then category matching and the fallback tier, then the flat rate.

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode })

// The tiers on the house's terms (UNIQUE brand_id, so one set per house).
const TIERS_FOR_BRAND = `SELECT t.id, t.label, t.pct, t.is_fallback
    FROM supplier_discount_tiers t
    JOIN supplier_brand_terms bt ON bt.id = t.supplier_brand_term_id
   WHERE bt.brand_id = $1
   ORDER BY t.pct ASC, t.label ASC`

const loadProduct = async (db, productId) => {
  const { rows } = await db.query(
    `SELECT p.id, p.brand_id, pdt.tier_id
       FROM products p
       LEFT JOIN product_discount_tiers pdt ON pdt.product_id = p.id
      WHERE p.id = $1`,
    [productId]
  )
  if (rows.length === 0) throw httpError(404, `Product ${productId} not found.`)
  return rows[0]
}

/**
 * The product's chosen tier and every tier its house offers.
 *
 * @param {{ query: Function }} db
 * @param {number} productId
 * @returns {Promise<{product_id: number, brand_id: number, tier_id: number|null, tiers: object[]}>}
 */
export const getProductTier = async (db, productId) => {
  const product = await loadProduct(db, productId)
  const { rows } = await db.query(TIERS_FOR_BRAND, [product.brand_id])
  return Object.freeze({
    product_id: product.id,
    brand_id: product.brand_id,
    tier_id: product.tier_id ?? null,
    tiers: Object.freeze(
      rows.map((row) =>
        Object.freeze({ id: row.id, label: row.label, pct: Number(row.pct), is_fallback: row.is_fallback })
      )
    ),
  })
}

/**
 * Choose a tier for a product, or clear the choice with null. The tier must be
 * on the product's own house's terms — another house's tier is a 422, because
 * the FK alone would accept it and price the product off a stranger's terms.
 *
 * @param {import('pg').Pool} db
 * @param {number} productId
 * @param {number|null} tierId
 */
export const setProductTier = async (db, productId, tierId) => {
  const product = await loadProduct(db, productId)
  if (tierId == null) {
    await db.query('DELETE FROM product_discount_tiers WHERE product_id = $1', [productId])
    return getProductTier(db, productId)
  }
  const { rows } = await db.query(TIERS_FOR_BRAND, [product.brand_id])
  if (!rows.some((row) => row.id === tierId)) {
    throw httpError(422, `Tier ${tierId} is not one of this product's house tiers.`)
  }
  await db.query(
    `INSERT INTO product_discount_tiers (product_id, tier_id) VALUES ($1, $2)
     ON CONFLICT (product_id) DO UPDATE SET tier_id = EXCLUDED.tier_id, updated_at = now()`,
    [productId, tierId]
  )
  return getProductTier(db, productId)
}

/**
 * The tier id the pricing resolver should use for a product, or null. The
 * product must belong to the house being priced.
 *
 * @param {{ query: Function }} db
 * @param {number} productId
 * @param {number} brandId
 * @returns {Promise<number|null>}
 */
export const getProductTierId = async (db, productId, brandId) => {
  const product = await loadProduct(db, productId)
  if (product.brand_id !== brandId) {
    throw httpError(422, `Product ${productId} is not one of this house's products.`)
  }
  return product.tier_id ?? null
}
