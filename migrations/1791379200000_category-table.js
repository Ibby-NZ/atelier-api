/**
 * The category vocabulary stops being a CHECK and becomes a table the office
 * can add to and delete from.
 *
 * It was three identical inline CHECKs — `products.category`,
 * `price_list_items.category`, `supplier_freight_rates.category` — widened once
 * by hand (migration 1789651200000) from four values to nine. Every further
 * word the office needed cost a migration and a deploy, which is why the CRM's
 * Categories screen could only MOVE products between the nine and never add a
 * tenth.
 *
 * `product_categories` is that list, with the nine seeded verbatim: no stored
 * row changes, because the slugs are exactly what the CHECKs accepted.
 *
 * WHY A FOREIGN KEY RATHER THAN A CHECK OR APP VALIDATION. The three columns now
 * REFERENCE this table, which keeps the one property the three CHECKs existed to
 * give (a value in one and not the others silently stops matching, so the sets
 * must be identical) and adds the one they could not: ON DELETE RESTRICT, so the
 * database itself refuses to delete a category any product, price list line or
 * freight rate still carries. Nothing in the API has to remember to check.
 *
 * ON UPDATE CASCADE is deliberate rather than incidental: a slug is the stored
 * value, so renaming one — which nothing offers today — would otherwise strand
 * every row carrying it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

// The nine, in the order they were added to the CHECK, with the sentence-case
// label the CRM already shows for each. `sort` is spaced by ten so a category
// added later can be filed between two without renumbering the list.
const SEED = [
  ['fabric', 'Fabric'],
  ['wallpaper', 'Wallpaper'],
  ['trimming', 'Trimming'],
  ['accessory', 'Accessory'],
  ['bed-linen', 'Bed linen'],
  ['towel', 'Towel'],
  ['cushion', 'Cushion'],
  ['throw', 'Throw'],
  ['misc', 'Miscellaneous'],
]

// Each carrier of the vocabulary, with the constraint name Postgres gave the
// inline CHECK its column was created with, and the FK name that replaces it.
const TABLES = [
  ['products', 'products_category_check', 'products_category_fkey'],
  ['price_list_items', 'price_list_items_category_check', 'price_list_items_category_fkey'],
  [
    'supplier_freight_rates',
    'supplier_freight_rates_category_check',
    'supplier_freight_rates_category_fkey',
  ],
]

const CHECK_VOCABULARY = SEED.map(([slug]) => slug)

const checkFor = (values) =>
  `category IN (${values.map((value) => `'${value}'`).join(',')})`

export const up = (pgm) => {
  pgm.createTable('product_categories', {
    // The slug IS the stored value on the three referencing columns, so it is
    // the key: a surrogate id would mean rewriting every one of them.
    slug: { type: 'text', primaryKey: true },
    label: { type: 'text', notNull: true },
    sort: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('product_categories', 'product_categories_slug_shape', {
    // Lower-case words and hyphens, the shape every stored value already has.
    // The API slugifies what staff type; this is the backstop to that.
    check: `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
  })
  pgm.addConstraint('product_categories', 'product_categories_label_not_blank', {
    check: `btrim(label) <> ''`,
  })
  pgm.addConstraint('product_categories', 'product_categories_label_unique', {
    unique: 'label',
  })

  pgm.sql(`
    INSERT INTO product_categories (slug, label, sort)
    VALUES ${SEED.map(([slug, label], index) => `('${slug}', '${label}', ${(index + 1) * 10})`).join(', ')}
  `)

  for (const [table, check, fkey] of TABLES) {
    pgm.dropConstraint(table, check)
    pgm.addConstraint(table, fkey, {
      foreignKeys: {
        columns: 'category',
        references: 'product_categories(slug)',
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      },
    })
  }
}

/**
 * Back to three CHECKs over the nine seeded words. A row carrying a category the
 * office added after this migration ran would fail the re-added CHECK, which is
 * the correct behaviour: reversing this must not silently discard a category
 * somebody chose. Clear those rows first if it genuinely has to be reversed.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  for (const [table, check, fkey] of TABLES) {
    pgm.dropConstraint(table, fkey)
    pgm.addConstraint(table, check, { check: checkFor(CHECK_VOCABULARY) })
  }
  pgm.dropTable('product_categories')
}
