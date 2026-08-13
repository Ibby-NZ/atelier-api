/**
 * `products.product_range` and `brands.brand_code` — the two reporting
 * dimensions the office's old D365 reporting was built on (W21 US-001, FR-275).
 *
 * THE CLIENT'S OWN WORDS: "the brand is generally designated a two-digit like
 * CFJC ... a lot of our old reporting used that range code. She needs to pull
 * out both from the supplier with all those brand codes underneath, and also by
 * the range code."
 *
 * BOTH ARE NULLABLE, BOTH ARE FREE TEXT, AND NEITHER IS A FOREIGN KEY.
 *
 *   - `products.product_range` is Atelier's own spelling of the house's product
 *     line — the value `legacy_tracking_options.name`,
 *     `legacy_product_prices.range_name` and `price_list_items.product_range`
 *     already carry. It is NOT a `ranges` table: the live catalogue has no range
 *     concept at all, the vocabulary lives in a staging mirror that is
 *     re-imported wholesale, and an FK into `legacy_*` would make a re-import a
 *     delete-cascade problem (the argument `supplier_freight_rates.range_name`
 *     already makes).
 *
 *   - `brands.brand_code` is the two-letter designation. It is a REPORTING
 *     LABEL: `src/products/reporting-codes-plan.js` finds no defensible source
 *     for it in any corpus Atelier has delivered, so this column ships empty and
 *     is filled from the CRM one house at a time.
 *
 * RANGE IS A REPORTING LABEL, NOT A COST AXIS (FR-277). It appears in no pricing
 * calculation and nothing here is read by `src/pricing/`. Measured: supplier x
 * category x range gives 74 groups where supplier x category gives 74, and the
 * same 15 collide — the range adds no grain to a cost key, which is what removed
 * it from W16 and put it here.
 *
 * `CFJC` IS NOT INTERPRETED AND NO COLUMN IS ADDED FOR IT (F18, FR-280). It is
 * either two brand codes run together — which reporting concatenates and nothing
 * stores — or one combined reporting line for two houses, which is a GROUP
 * column on `brands` and not a code. The two answers need different schemas, so
 * guessing produces a dimension that means different things to different rows.
 * The item-code corpus says both readings are live: `CF` appears on 866 stock
 * items across four ranges while `JC` appears on 351 across two, so `CF` and
 * `JC` are each already a code in their own right.
 *
 * WHY THE UNIQUE INDEX IS PER SUPPLIER AND NOT GLOBAL. A code identifies a house
 * inside the invoicing entity that bills it, and the corpus shows the letters
 * being reused across unrelated houses (`ST` is Stroheim under Fabricut and
 * Stoker Mills under its own name; `MA` is Manuel Canovas under Colefax &
 * Fowler). A global unique would refuse the second, correct row. Scoping it to
 * the supplier is also what refuses the case F18 exists for: `CF` cannot be
 * given to Colefax & Fowler AND Jane Churchill, which sit under one supplier, so
 * a backfill that guessed the shared token would be stopped by the database
 * rather than by a reviewer.
 *
 * Partial (`WHERE brand_code IS NOT NULL`) and folded through
 * `lower(btrim(...))`, the same normalisation `supplier_aliases` and
 * `supplier_freight_rates` already use — a code is a spelling, and two casings
 * of one code are one code. `brands.supplier_id` is NULL on 26 of 41 houses
 * today, and Postgres treats NULLs as distinct, so this index constrains only
 * the houses that have been linked. That is the right outcome: an unlinked house
 * has no invoicing entity for its code to be unique inside of.
 *
 * NEITHER COLUMN IS INDEXED FOR READING. Both are filtered with an escaped
 * `ILIKE` (`src/reports/filters.js`), which no btree can serve, over a catalogue
 * of tens of rows.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // A blank string is a second spelling of "unset" that every reader then has to
  // interpret, and the interpretations drift — the argument `featured_rank`
  // makes against rank 0. NULL is the one way to say "nobody has filled this in".
  pgm.addColumns('products', {
    product_range: {
      type: 'text',
      check: "product_range IS NULL OR btrim(product_range) <> ''",
    },
  })

  pgm.addColumns('brands', {
    brand_code: {
      type: 'text',
      check: "brand_code IS NULL OR btrim(brand_code) <> ''",
    },
  })

  pgm.createIndex('brands', ['supplier_id', 'lower(btrim(brand_code))'], {
    name: 'brands_supplier_brand_code_unique',
    unique: true,
    where: 'brand_code IS NOT NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('brands', ['supplier_id', 'lower(btrim(brand_code))'], {
    name: 'brands_supplier_brand_code_unique',
  })
  pgm.dropColumns('brands', ['brand_code'])
  pgm.dropColumns('products', ['product_range'])
}
