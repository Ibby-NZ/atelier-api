/**
 * Discount and freight classes, lettered A to E, chosen on the product and on
 * the variation (1 Oct 2026). The office: "add A B C D E discount level tags
 * for discounts for suppliers … discount class should be an option in the
 * product and variation level, and freight class should be choosable at the
 * product level as well … if the variation does not have a value, use the
 * product's; if it is set on the variation, use that."
 *
 * `supplier_discount_tiers.discount_class` — the letter a house's discount
 * class answers to (unique per terms row). The class keeps its name, rate and
 * default flag; the letter is what a product or variation chooses. Filled here:
 * a class already named A–E takes that letter, the rest take the free letters
 * in rate order (at most five per house; a sixth stays unlettered and is still
 * reached by category name or as the default).
 *
 * `products.discount_class`, `products.freight_class`,
 * `colourways.discount_class`, `colourways.freight_class` — the letter chosen;
 * NULL on a variation is its product's, NULL on a product is the house's
 * default class / every-class freight. The product's freight class is filled
 * from the Dynamics freight letter of the product price it was built from — the
 * one class Dynamics states per product. Dynamics states no discount class per
 * product (one discount per range on every archived price), so none is filled.
 *
 * `product_discount_tiers` (a product's chosen class, by id) is folded into
 * `products.discount_class` and dropped: one choice, by letter, on the product.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
const LETTER = (column) => `${column} ~ '^[A-E]$'`

export const up = (pgm) => {
  pgm.addColumn('supplier_discount_tiers', {
    discount_class: { type: 'text', check: LETTER('discount_class') },
  })
  pgm.createIndex('supplier_discount_tiers', ['supplier_brand_term_id', 'discount_class'], {
    name: 'supplier_discount_tiers_class_unique',
    unique: true,
    where: 'discount_class IS NOT NULL',
  })
  pgm.sql(`
    UPDATE supplier_discount_tiers SET discount_class = upper(btrim(label))
     WHERE upper(btrim(label)) ~ '^[A-E]$'
  `)
  pgm.sql(`
    WITH free AS (
      SELECT bt.id AS term_id, l.letter, row_number() OVER (PARTITION BY bt.id ORDER BY l.letter) AS n
        FROM supplier_brand_terms bt
        CROSS JOIN unnest(ARRAY['A', 'B', 'C', 'D', 'E']) AS l(letter)
       WHERE NOT EXISTS (SELECT 1 FROM supplier_discount_tiers t
                          WHERE t.supplier_brand_term_id = bt.id AND t.discount_class = l.letter)
    ), untagged AS (
      SELECT id, supplier_brand_term_id AS term_id,
             row_number() OVER (PARTITION BY supplier_brand_term_id ORDER BY pct, lower(label), id) AS n
        FROM supplier_discount_tiers WHERE discount_class IS NULL
    )
    UPDATE supplier_discount_tiers t SET discount_class = f.letter
      FROM untagged u JOIN free f ON f.term_id = u.term_id AND f.n = u.n
     WHERE t.id = u.id
  `)

  pgm.addColumns('products', {
    discount_class: { type: 'text', check: LETTER('discount_class') },
    freight_class: { type: 'text', check: LETTER('freight_class') },
  })
  pgm.addColumns('colourways', {
    discount_class: { type: 'text', check: LETTER('discount_class') },
    freight_class: { type: 'text', check: LETTER('freight_class') },
  })

  pgm.sql(`
    UPDATE products p SET discount_class = t.discount_class
      FROM product_discount_tiers pdt JOIN supplier_discount_tiers t ON t.id = pdt.tier_id
     WHERE pdt.product_id = p.id AND t.discount_class IS NOT NULL
  `)
  pgm.sql(`
    UPDATE products p SET freight_class = upper(btrim(pp.freight_letter))
      FROM product_prices pp
     WHERE pp.id = p.product_price_id AND upper(btrim(pp.freight_letter)) ~ '^[A-E]$'
  `)
  pgm.dropTable('product_discount_tiers')
}

// The choices by letter are not turned back into tier ids.
export const down = (pgm) => {
  pgm.createTable('product_discount_tiers', {
    product_id: { type: 'integer', primaryKey: true, references: 'products', onDelete: 'CASCADE' },
    tier_id: { type: 'integer', notNull: true, references: 'supplier_discount_tiers', onDelete: 'CASCADE' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('product_discount_tiers', 'tier_id')
  pgm.dropColumns('colourways', ['discount_class', 'freight_class'])
  pgm.dropColumns('products', ['discount_class', 'freight_class'])
  pgm.dropIndex('supplier_discount_tiers', ['supplier_brand_term_id', 'discount_class'], {
    name: 'supplier_discount_tiers_class_unique',
  })
  pgm.dropColumn('supplier_discount_tiers', 'discount_class')
}
