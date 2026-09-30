// A product's — and a variation's — sell prices, recalculated when what they
// are priced from is edited: the wholesale rate (28 Sep 2026 — the office:
// "when we change the wholesale rate, the trade price remains the same"), and
// the discount, freight and duty class letters (1 Oct 2026).
//
// The product's own product-price row prices it (products.product_price_id):
// its house, duty class and own markup to trade, exactly as the import priced
// it — with the product's wholesale rate in the product's currency, its freight
// class (else the row's Dynamics letter) and its discount class. Trade and
// retail are written where the formula yields them and the person did not type
// that price in the same save; a typed price wins. A product not built from a
// price row, one Dynamics priced by hand, or one whose house cannot price it
// yet, keeps its prices, and the report says why.
//
// A VARIATION with a class letter of its own (discount, freight or duty) is
// priced the same way at its own letters (the others its product's); one with none sells at its product's
// price (NULL), which is what clearing its letters puts back.

import { createProductPricer } from './product-prices.js'

const cents = (dollars) => (dollars == null ? null : Math.round(dollars * 100))

const ROW_COLUMNS = `id, code, description, range_name, item_type, currency, wholesale_rate, duty_class,
  freight_letter, trade_markup_percent, dynamics_price_ex_duty, dynamics_price_incl_duty, dynamics_trade_sell`

/**
 * What the product's price row prices it at, at the given wholesale rate and
 * class letters. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {{ product_price_id: number|null, currency: string }} product
 * @param {{ wholesaleRate: number|null, discountClass?: string|null, freightClass?: string|null,
 *           dutyClass?: string|null }} basis
 * @returns {Promise<{ repriced: boolean, trade_price_cents?: number|null,
 *                     retail_price_cents?: number|null, reason?: string }>}
 */
export const repriceProduct = async (db, product, { wholesaleRate, discountClass = null, freightClass = null, dutyClass = null }) => {
  if (product.product_price_id == null) {
    return { repriced: false, reason: 'not built from a product price, so there is no range to price it through' }
  }
  if (wholesaleRate == null) return { repriced: false, reason: 'it has no wholesale rate' }
  const { rows } = await db.query(`SELECT ${ROW_COLUMNS} FROM product_prices WHERE id = $1`, [product.product_price_id])
  if (!rows[0]) return { repriced: false, reason: 'its product price is gone' }
  const pricing = await createProductPricer(db).price(
    { ...rows[0], wholesale_rate: wholesaleRate, currency: product.currency },
    { discountClass, freightClass, dutyClass }
  )
  if (pricing.hand_priced) {
    return { repriced: false, reason: 'Dynamics priced it by hand, so its price does not follow the wholesale rate or its classes' }
  }
  if (pricing.trade_sell == null) {
    const why = pricing.reason ?? `${pricing.missing.join(', ')} not set on ${pricing.house?.name ?? 'the house'}`
    return { repriced: false, reason: why }
  }
  return {
    repriced: true,
    trade_price_cents: cents(pricing.trade_sell),
    retail_price_cents: cents(pricing.retail_sell),
  }
}

/**
 * The prices a variation should carry: its own at its own letters, or NULL
 * (its product's) when it has no letter of its own. `null` when its price
 * cannot be worked out, so it is left as it is.
 *
 * @param {{ query: Function }} db
 * @param {{ product_price_id: number|null, currency: string, wholesale_rate: number|string|null,
 *           discount_class: string|null, freight_class: string|null, duty_class: string|null }} product
 * @param {{ discount_class: string|null, freight_class: string|null, duty_class: string|null }} variation its OWN letters
 * @returns {Promise<{ trade_price_cents: number|null, retail_price_cents: number|null }|null>}
 */
export const variationPrices = async (db, product, variation) => {
  if (variation.discount_class == null && variation.freight_class == null && variation.duty_class == null) {
    return { trade_price_cents: null, retail_price_cents: null }
  }
  const priced = await repriceProduct(db, product, {
    wholesaleRate: product.wholesale_rate == null ? null : Number(product.wholesale_rate),
    discountClass: variation.discount_class ?? product.discount_class,
    freightClass: variation.freight_class ?? product.freight_class,
    dutyClass: variation.duty_class ?? product.duty_class,
  })
  return priced.repriced
    ? { trade_price_cents: priced.trade_price_cents, retail_price_cents: priced.retail_price_cents }
    : null
}

/**
 * Re-price every variation of a product that has a class letter of its own —
 * after the product's wholesale rate or letters moved. Returns how many moved.
 *
 * @param {{ query: Function }} db
 * @param {number} productId
 * @returns {Promise<number>}
 */
export const repriceOwnClassVariations = async (db, productId) => {
  const { rows: products } = await db.query(
    `SELECT product_price_id, currency, wholesale_rate, discount_class, freight_class, duty_class FROM products WHERE id = $1`,
    [productId]
  )
  if (!products[0]) return 0
  const { rows: variations } = await db.query(
    `SELECT id, discount_class, freight_class, duty_class FROM colourways
      WHERE product_id = $1 AND (discount_class IS NOT NULL OR freight_class IS NOT NULL OR duty_class IS NOT NULL)`,
    [productId]
  )
  let moved = 0
  for (const variation of variations) {
    const prices = await variationPrices(db, products[0], variation)
    if (!prices) continue
    const { rowCount } = await db.query(
      `UPDATE colourways SET trade_price_cents = $2, retail_price_cents = $3
        WHERE id = $1 AND (trade_price_cents IS DISTINCT FROM $2 OR retail_price_cents IS DISTINCT FROM $3)`,
      [variation.id, prices.trade_price_cents, prices.retail_price_cents]
    )
    moved += rowCount
  }
  return moved
}
