/**
 * The duty class (A, B or C — the house's duty bands) on the product and the
 * variation (1 Oct 2026). The office: "duty rate (from house duty classes,
 * also variation level)", beside the discount and freight classes of
 * migration 1792531200000.
 *
 * `products.duty_class` — the band the product is dutied at; NULL is no duty
 * (what a Dynamics price whose two duty prices agree was charged).
 * `colourways.duty_class` — the variation's own; NULL is its product's.
 * The product's is filled from the duty class of the Dynamics price it was
 * built from (`product_prices.duty_class`, inferred from its two prices).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('products', { duty_class: { type: 'text', check: `duty_class ~ '^[A-C]$'` } })
  pgm.addColumn('colourways', { duty_class: { type: 'text', check: `duty_class ~ '^[A-C]$'` } })
  pgm.sql(`
    UPDATE products p SET duty_class = upper(btrim(pp.duty_class))
      FROM product_prices pp
     WHERE pp.id = p.product_price_id AND upper(btrim(pp.duty_class)) ~ '^[A-C]$'
  `)
}

export const down = (pgm) => {
  pgm.dropColumn('colourways', 'duty_class')
  pgm.dropColumn('products', 'duty_class')
}
