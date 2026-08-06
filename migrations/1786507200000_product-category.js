/**
 * `products.category` — the axis the catalogue and the rate ledger share.
 *
 * `price_list_items.category` already classifies every supplier rate as
 * fabric / wallpaper / trimming / accessory (the converter's `item type`
 * mapping, migration 1785110400000). `products` had no counterpart, so nothing
 * could ask "what do we pay for wallpaper" against "what do we sell as
 * wallpaper". This column is that counterpart, and THE VOCABULARY MUST STAY
 * IDENTICAL — a fifth value here, or a rename, silently makes the two sides
 * un-joinable rather than failing, so `test/suppliers-product-category.test.js`
 * compares the two CHECK definitions to each other rather than to a literal.
 *
 * IT IS NOT `product_type`. That column is `fabric | finished_good` and drives
 * the colourway's inventory unit (metres vs units), which is why it is
 * create-only. `category` is a merchandising axis: a wallpaper and a trimming
 * are both `finished_good`, and both are bought on rates filed under their own
 * category.
 *
 * NULLABLE ON PURPOSE. Every existing product is uncategorised, not wrong.
 * A NOT NULL would need a default, and the only defensible default is `fabric`
 * — which would assert a category for 19k rows nobody has looked at, and the
 * mistake would be invisible because the column would read as populated.
 * Epic 6's spreadsheet round trip is how the office fills it in.
 *
 * No index: four values across a table of hundreds is not selective enough for
 * one to be read, and the joins this unblocks are aggregate, not point lookups.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('products', {
    category: {
      type: 'text',
      // Same four values, in the same order and spelling, as
      // price_list_items.category. Widening the set later is a one-line
      // migration on both tables — and it has to be both.
      check: "category IN ('fabric','wallpaper','trimming','accessory')",
    },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('products', ['category'])
}
