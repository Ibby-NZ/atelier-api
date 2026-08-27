/**
 * The category vocabulary grows from four values to nine.
 *
 * `fabric | wallpaper | trimming | accessory` was the supplier price list's
 * vocabulary (migration 1785110400000) and `products.category` took it verbatim
 * so the two sides stayed joinable (1786507200000), `supplier_freight_rates`
 * joined the pair (1787976000000). It describes what Atelier BUYS ON A RATE
 * SHEET. It has never described what Atelier SELLS: the D365 item types the
 * office works from include Towels, Bed Linen, Throws/Blankets and Cushions,
 * and every one of them collapsed to `accessory` — 958 stock rows and 112 price
 * rows came through the category workbooks with no suggestion at all
 * (`src/products/CLAUDE.md`, which ends that count with "the real question they
 * raise is whether CATEGORIES should grow"). This is that growth.
 *
 * The five new values come from a curated sheet rather than from a guess:
 * `incoming/product-sheets/Copy of stock-items-in-stock-latest-Jenette edit.xlsx`,
 * the 381 active, in-stock, current-version stock items with their Item Type
 * corrected by hand at Atelier. Seven types over those rows —
 * Fabrics 242, Towels 53, Bed Linen 29, Throws/Blankets 26, Cushions 14,
 * Accessories 14, Miscellaneous 3 — which is the whole of what is on the shelf.
 *
 *   Fabrics -> fabric        Throws/Blankets -> throw
 *   Towels -> towel          Cushions -> cushion
 *   Bed Linen -> bed-linen   Accessories -> accessory
 *                            Miscellaneous -> misc
 *
 * THE FOUR EXISTING VALUES ARE UNTOUCHED, so no stored row changes and no data
 * migrates: this only widens what a CHECK will accept. `misc` is deliberately
 * NOT a synonym for NULL — NULL still means "nobody has looked at this row",
 * which is the distinction the spreadsheet round trip is built on
 * (`src/products/product-sheet.js`); `misc` means somebody looked and the
 * vocabulary had no word for it, which is a queue worth being able to list.
 *
 * ALL THREE TABLES MOVE IN ONE MIGRATION, and that is the point rather than a
 * convenience. The three CHECK definitions are compared to EACH OTHER by
 * `test/suppliers-product-category.test.js` — a value added to one and not the
 * others does not fail anywhere, it just silently stops matching, so splitting
 * this across three migrations is the failure mode the test exists to catch.
 *
 * `supplier_freight_rates_supplier_category_effective_key` indexes
 * `COALESCE(category, '')` and is unaffected: widening a CHECK does not touch
 * an index.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

// One list, spelled once, applied three times — the drift this migration exists
// to prevent must not be constructable inside the migration itself.
const CATEGORIES = [
  'fabric',
  'wallpaper',
  'trimming',
  'accessory',
  'bed-linen',
  'towel',
  'cushion',
  'throw',
  'misc',
]

const PREVIOUS = ['fabric', 'wallpaper', 'trimming', 'accessory']

// The tables carrying the vocabulary, each with the constraint name Postgres
// gave the inline CHECK its column was created with.
const TABLES = [
  ['products', 'products_category_check'],
  ['price_list_items', 'price_list_items_category_check'],
  ['supplier_freight_rates', 'supplier_freight_rates_category_check'],
]

const checkFor = (values) =>
  `category IN (${values.map((value) => `'${value}'`).join(',')})`

const setVocabulary = (pgm, values) => {
  for (const [table, constraint] of TABLES) {
    pgm.dropConstraint(table, constraint)
    pgm.addConstraint(table, constraint, { check: checkFor(values) })
  }
}

export const up = (pgm) => {
  setVocabulary(pgm, CATEGORIES)
}

/**
 * Narrowing back to four would fail on any row already carrying one of the five
 * new values, which is the correct behaviour — a down migration must not
 * silently discard a category the office typed. Clear those rows first if this
 * genuinely has to be reversed.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  setVocabulary(pgm, PREVIOUS)
}
