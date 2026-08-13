/**
 * Universal pricing template v3 — the client's correction of v2.
 *
 * v2 appended a `Brand` column beside v1's `Product Range`. The client read the
 * template back and said the two are one field: their price lists have always
 * put the house in Product Range, and the corpus agrees — 19,447 of the 19,514
 * committed rows carry the supplier's own house name there (the 67 exceptions
 * are one Jannelli & Volpi range). So v3 renames the LABEL to Brand and keeps
 * the v1 column it has always written, and `brand_name` — v2's duplicate — goes.
 *
 * Dropping a column is only safe because nothing ever wrote this one: v2 was
 * rejected before a supplier filled one in, and every row in the committed file
 * and in the client's database is `template_version = 'v1'`. Verified before
 * writing this, not assumed:
 *
 *   SELECT template_version, count(*) FROM price_list_items GROUP BY 1;
 *   -- v1 | 19514
 *   SELECT count(*) FROM price_list_items WHERE brand_name IS NOT NULL;  -- 0
 *
 * The other three v2 columns stay exactly as they were: `pattern_match` (v3 only
 * moves the column, from the end of the row to just after Vertical Repeat),
 * `duty_percent` and `template_version`. Renaming `product_range` to match the
 * new label is deliberately NOT done — the column name is internal, 19.5k rows
 * and a byte-pinned JSON key use it, and a rename buys a translation layer in
 * the importer for something nobody can see.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.dropColumns('price_list_items', ['brand_name'])
}

/**
 * Restores the column, empty — which is exactly how it was left. Nothing wrote
 * it, so there is no data to bring back and no backfill to get wrong.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.addColumns('price_list_items', {
    brand_name: { type: 'text' },
  })
}
