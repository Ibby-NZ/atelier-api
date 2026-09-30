/**
 * Retail, beside "Show on the website" (1 Oct 2026). The office: a product on
 * the storefront without Retail ticked can only be quoted; with it ticked it can
 * be quoted AND added to the cart (a B2B and B2C product).
 *
 * `products.sell_retail` — whether card checkout sells the product. Every
 * listed product can be put on a quote request either way. Until now the rule
 * was the product's TYPE (a fabric was quote-only, a finished good cart-only),
 * so the column is filled to keep what each product does today in the cart:
 * finished goods sold retail, fabrics not. A new product starts unticked.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('products', { sell_retail: { type: 'boolean', notNull: true, default: false } })
  pgm.sql(`UPDATE products SET sell_retail = true WHERE product_type <> 'fabric'`)
}

export const down = (pgm) => {
  pgm.dropColumn('products', 'sell_retail')
}
