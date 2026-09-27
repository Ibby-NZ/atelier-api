/**
 * The catalogue is the product prices export: one product per row.
 *
 * The office (28 Sep 2026): "replace all products on the products page with
 * those from the import … all products from the product price import are
 * unique, none are variations", and the supplier colours "sit under the
 * products" rather than becoming products of their own.
 *
 * - `products.product_price_id` links a product to the product-price row it was
 *   built from (src/catalogue/product-price-catalogue.js). One row, one product:
 *   UNIQUE. SET NULL, so a price row that ever goes leaves the product standing.
 * - Every product that exists now predates that catalogue, so it is ARCHIVED —
 *   the office's decision was "archive all current products", made knowing it
 *   hides their stock and the 49 on the website. Archived, never deleted: order
 *   lines and price history still point at them.
 * - Each one archived here gives up its slug (`<slug>-archived-<id>`), so the
 *   product that replaces it takes the plain URL rather than a suffixed one.
 *
 * DOWN DROPS THE LINK AND DOES NOT UN-ARCHIVE. Nothing records which products
 * were live before this ran and which were already archived.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('products', {
    product_price_id: {
      type: 'integer',
      references: 'product_prices',
      onDelete: 'SET NULL',
      unique: true,
    },
  })
  pgm.sql(`
    UPDATE products
       SET archived_at = now(),
           slug = slug || '-archived-' || id
     WHERE archived_at IS NULL
  `)
}

export const down = (pgm) => {
  pgm.dropColumn('products', 'product_price_id')
}
