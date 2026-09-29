// A product's sell prices, recalculated when its wholesale rate is edited
// (28 Sep 2026 — the office: "when we change the wholesale rate, the trade
// price remains the same").
//
// The product's own product-price row prices it (products.product_price_id):
// its house, duty class, freight letter and own markup to trade, exactly as the
// import priced it — with the NEW wholesale rate in the product's currency.
// Trade and retail are written where the formula yields them and the person
// did not type that price in the same save; a typed price wins. A product not
// built from a price row, or one whose house cannot price it yet, keeps its
// prices, and the report says why.

import { createProductPricer } from './product-prices.js'

const cents = (dollars) => (dollars == null ? null : Math.round(dollars * 100))

/**
 * What the new wholesale rate prices the product at. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {{ id: number, product_price_id: number|null, currency: string }} product
 * @param {number} wholesaleRate the rate being saved, in `product.currency`
 * @returns {Promise<{ repriced: boolean, trade_price_cents?: number|null,
 *                     retail_price_cents?: number|null, reason?: string }>}
 */
export const repriceFromWholesale = async (db, product, wholesaleRate) => {
  if (product.product_price_id == null) {
    return { repriced: false, reason: 'not built from a product price, so there is no range to price it through' }
  }
  const { rows } = await db.query(
    `SELECT id, code, description, range_name, item_type, currency, wholesale_rate, duty_class,
            freight_letter, trade_markup_percent, dynamics_price_ex_duty, dynamics_price_incl_duty,
            dynamics_trade_sell
       FROM product_prices WHERE id = $1`,
    [product.product_price_id]
  )
  if (!rows[0]) return { repriced: false, reason: 'its product price is gone' }
  const pricing = await createProductPricer(db).price({
    ...rows[0],
    wholesale_rate: wholesaleRate,
    currency: product.currency,
  })
  if (pricing.hand_priced) {
    return { repriced: false, reason: 'Dynamics priced it by hand, so its price does not follow the wholesale rate' }
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
