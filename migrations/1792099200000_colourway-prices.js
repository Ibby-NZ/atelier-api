/**
 * Variation prices: a colourway may carry its own retail and trade price.
 *
 * September 2026, the office: a variation's price is editable on the product
 * page; left blank it sells at its product's price, filled in it sells at its
 * own. Each figure falls back on its own — a variation with only a retail price
 * still quotes its product's trade price to trade.
 *
 * NULL is "use the product's", which is what every existing row already is, so
 * nothing here moves a price. Every selling read resolves
 * COALESCE(c.<price>, p.<price>): checkout, the cart/request resolver
 * (src/catalogue/line-prices.js), the storefront product detail and the admin
 * order line's catalogue figure.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('colourways', {
    retail_price_cents: { type: 'integer', check: 'retail_price_cents >= 0' },
    trade_price_cents: { type: 'integer', check: 'trade_price_cents >= 0' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('colourways', ['retail_price_cents', 'trade_price_cents'])
}
