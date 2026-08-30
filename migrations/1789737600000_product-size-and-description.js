/**
 * `products.size` and `products.description` — what a finished good IS, beyond
 * its name.
 *
 * The catalogue could say a product is a `towel` or `bed-linen` (the category
 * vocabulary, migration 1789651200000) and what it is made of (`composition`),
 * but not what size it is. So a duvet cover could not state whether it was a
 * queen or a king, and a towel could not distinguish a face cloth from a bath
 * sheet — the office was writing both into the product NAME, where nothing can
 * read them.
 *
 * ONE PRODUCT PER SIZE, and that is the whole reason this is a product column
 * rather than a colourway one. `retail_price_cents` and `trade_price_cents`
 * live on `products`; a bath sheet and a face cloth are different prices, so
 * they cannot be two variants of one product without moving price onto the
 * colourway and re-pointing every order line, price read and stock screen at
 * it. `colourways` stays the COLOUR axis (and the inventory unit), `products`
 * carries the size. "Galata Bath Towel" and "Galata Hand Towel" are two rows.
 *
 * FREE TEXT, not an enum. The vocabulary is per category and open-ended —
 * single/double/queen/king/super king for bed linen, face/hand/bath/bath sheet
 * for towels, and a dimension string for anything else — so an enum would need
 * a migration every time the office stocked a new size. The CRM offers the
 * sizes already in use as suggestions instead, the way the freight desk offers
 * its zones. Same reasoning as `product_range`, which is also free text
 * because its vocabulary lives outside this schema.
 *
 * `size` is `text` and short in practice ("Queen 210 x 210 cm"); `description`
 * is the sales prose the storefront renders under the name, and matches
 * `collections.description` in width. Both NULLABLE: a fabric has no size and
 * most of the catalogue has no description, and neither is a fault.
 *
 * No index on either. `size` is a display and filter field over a table of
 * hundreds, which a sequential scan answers faster than an index would.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('products', {
    size: { type: 'text' },
    description: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('products', ['size', 'description'])
}
