/**
 * Adds products.trade_price_cents — the approved-trade unit price precomputed at
 * seed from the platform pricing waterfall (atelier-app pricing.js tradeUnit()).
 * Only ever exposed to approved trade users on the product-detail endpoint (FR-3).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('products', {
    trade_price_cents: { type: 'integer' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('products', 'trade_price_cents')
}
