/**
 * Every product's Range is its house.
 *
 * The office's reading, and the corpus agrees: the D365 range IS the maison
 * (the merge files each stock item under the house its `range_name` names, and
 * 19,447 of 19,514 price-list rows put the house in Product Range). So the
 * column is filled from `brands.name` on every product, overwriting any value
 * that disagrees — a range that is not the house is the wrong range. New
 * products take the house the same way (`createProduct`, the colourway import).
 *
 * DOWN DOES NOT UN-FILL. The previous values were almost all NULL and nothing
 * records which ones were not; clearing the column would lose more than it
 * restores.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    UPDATE products p
       SET product_range = b.name
      FROM brands b
     WHERE b.id = p.brand_id
       AND p.product_range IS DISTINCT FROM b.name
  `)
}

export const down = () => {}
