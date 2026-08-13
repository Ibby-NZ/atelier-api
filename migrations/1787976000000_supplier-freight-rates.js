/**
 * `supplier_freight_rates` — the mechanism, deliberately with NOTHING in it.
 *
 * THIS MIGRATION WRITES NO RATE, AND THAT IS THE STORY (W16 US-004, F1). The
 * table's GRAIN is unresolved and one question to the client decides it:
 *
 *   - ADR 005 proposed `(supplier_id, category, effective_from)`. Charlotte
 *     argued it well — one supplier ships four houses fortnightly, so its
 *     per-unit freight is structurally lower than a house they buy 5 m from.
 *   - The client's own engine keys on RANGE. `legacy_tracking_options.name`
 *     hits `legacy_product_prices.range_name` on 48 of 58 rows covering 99.6%
 *     of the priced corpus, while `supplier` matches a live supplier on 8 of 28
 *     (it is a lookup exported as a display name).
 *   - And the exported `Freight` column agrees with the rate the price rows
 *     imply in only 30 of 43 ranges — HAMAM's column is blank while its rows
 *     imply four distinct rates, JWALL says 30 while all 209 of its rows imply
 *     50. Until that is answered, nobody knows whether the column overrides the
 *     letters or the corpus values are stale snapshots, so no rate here could
 *     be sourced from either without guessing.
 *
 * So the scope is TWO nullable columns with a CHECK that exactly one is set.
 * That is not "both grains are supported"; it is this schema declining to
 * answer a question that is out with the client, in the one place a reader will
 * look. `src/pricing/freight-recovery.js` is the report that answers it.
 *
 * NO `brand_id`, AND RECORDING THAT ABSENCE IS THE POINT (FR-194).
 * `supplier_brand_terms` is per-brand and somebody will copy that shape by
 * reflex. Freight is what a consignment costs to land — it is a property of who
 * ships it and what is in the box, never of the maison printed on the selvedge.
 * A `brand_id` here would also put a cost column one careless join away from
 * `src/catalogue/brands.js`, which serves anonymous visitors.
 *
 * `price_list_items.freight_class` IS NEITHER DROPPED NOR READ (FR-195). It
 * stays the raw uninterpreted letter from the supplier's own file, exactly as
 * `duty_class` does, and it is the only surviving evidence of what D365
 * charged — which is what makes a 2024 landed cost reconcilable. Nothing in
 * this table is keyed by a letter and nothing backfills one.
 *
 * DOLLARS ARE THE DEFAULT AND THE RECOMMENDATION (FR-186). Freight is a dollar
 * amount per unit and never was a percentage: STOCK - INTERWEAVE prices one NZD
 * item at 38.00 ex duty and 40.00 landed on freight 2 and clearance 0
 * (38 + 2 = 40; 2% would give 38.76), and GARRETT LEATHER lands 42 hides of
 * zero wholesale value at 11.00 on freight 10 and clearance 10
 * ((0 + 10) x 1.10 = 11.00 — a percentage of zero is zero). `percent` stays in
 * the CHECK because clearance and duty are legitimately percentages and the
 * client's own team set the current 8%, but it is not the default and nothing
 * computes one unless a row says so.
 *
 * A DOLLAR RATE STATES ITS UNIT (FR-187) and a percent rate must not. The unit
 * is the range's own pack type — ALTAGAMMA's $35 is per ROLL (all 447 of its
 * rows are P/Roll), Garrett Leather's $10 is per HIDE — and the priced corpus is
 * P/M 8,574 - P/Y 5,753 - P/Roll 2,816 - P/P 2,011, so applying a per-roll
 * freight to a per-metre quantity overcharges by roughly the roll length.
 *
 * APPEND-ONLY (FR-192). A rate carries `effective_from` and a new rate never
 * overwrites the old one — that is what makes the >=5% annual uplift auditable
 * and what lets a 2024 landed cost be reconciled at all. There is no UPDATE and
 * no DELETE route; a correction is a later row. The unique index is what stops
 * two rates claiming one day, which would make the resolver pick at random —
 * the same argument `supplier_discount_tiers_fallback_unique` already makes.
 *
 * `category` carries the SAME inline CHECK text as `price_list_items.category`
 * and `products.category`, because those are ONE vocabulary and this is now the
 * third table in it. A value added to one side never raises anything, it just
 * silently stops matching, so `test/suppliers-product-category.test.js`
 * compares all three live `pg_get_constraintdef` definitions to each other.
 * NULL means "every category" — a supplier who quotes one freight rate for
 * everything is a row, not four.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('supplier_freight_rates', {
    id: 'id',

    // --- the scope: exactly one of these two, see the header ----------------
    // RESTRICT, like `brands.supplier_id`: a rate pointing at a supplier is a
    // live commercial parameter, and deleting the supplier must be refused
    // loudly rather than silently orphaning what every landed cost is built on.
    supplier_id: {
      type: 'integer',
      references: 'suppliers',
      onDelete: 'RESTRICT',
    },
    // The incumbent's own key: `legacy_tracking_options.name`, which is
    // Atelier's spelling of the house. Free text and NOT a foreign key —
    // `legacy_*` is a staging mirror that is re-imported wholesale, so an FK
    // into it would make a re-import a delete-cascade problem.
    range_name: { type: 'text' },

    // NULL means every category. Same CHECK text as the other two tables.
    category: {
      type: 'text',
      check: "category IN ('fabric','wallpaper','trimming','accessory')",
    },

    // --- the rate ------------------------------------------------------------
    basis: {
      type: 'text',
      notNull: true,
      default: 'dollar',
      check: "basis IN ('percent','dollar')",
    },
    // numeric, not integer cents: a percent basis is a fraction of a percent and
    // a dollar basis is a foreign-shaped parameter, neither of which is the
    // storefront's money. Negative freight is not a discount, it is a typo.
    rate: { type: 'numeric(12,4)', notNull: true, check: 'rate >= 0' },
    // The pack the dollar figure is PER. Same vocabulary as
    // `price_list_items.unit`; enforced against the basis below.
    unit: {
      type: 'text',
      check: "unit IN ('metre','yard','roll','piece','hide','panel')",
    },

    effective_from: { type: 'date', notNull: true },
    // Why this rate is this number — a carrier quote, an annual uplift letter.
    // Staff-typed free text, so every reader of it escapes it.
    note: { type: 'text' },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // Exactly one scope. Both would be two different claims about one rate; and
  // neither is a rate that applies to everything Atelier imports, which is not
  // a thing anybody has ever quoted.
  pgm.addConstraint('supplier_freight_rates', 'supplier_freight_rates_scope_check', {
    check: '(supplier_id IS NULL) <> (range_name IS NULL)',
  })

  // A dollar rate is per something; a percent rate is per nothing. Stating a
  // unit beside a percentage reads as "8% per metre", which is not a rule.
  //
  // NOT `..._unit_check`: node-pg-migrate emits an inline column `check:`
  // unnamed and Postgres auto-names it `<table>_<column>_check`, so `unit`
  // already holds that name and adding it again aborts the whole migration
  // with 42710.
  pgm.addConstraint('supplier_freight_rates', 'supplier_freight_rates_unit_basis_check', {
    check: "(basis = 'dollar') = (unit IS NOT NULL)",
  })

  // One rate per scope per day. The nullable scope columns are why this is an
  // expression index: Postgres treats NULLs as distinct in a unique index, so a
  // plain column list would happily accept two range-keyed rates for the same
  // range and date (both having supplier_id NULL). COALESCE collapses that.
  // `range_name` is folded to lower case for the same reason `supplier_aliases`
  // is: it is a spelling, and two casings of one house are one house.
  pgm.createIndex(
    'supplier_freight_rates',
    [
      'COALESCE(supplier_id, 0)',
      "lower(COALESCE(range_name, ''))",
      "COALESCE(category, '')",
      'effective_from',
    ],
    { name: 'supplier_freight_rates_scope_effective_unique', unique: true }
  )

  // The resolver's own access path: newest rate at or before a date, per scope.
  pgm.createIndex('supplier_freight_rates', ['supplier_id', 'effective_from'])
  pgm.createIndex('supplier_freight_rates', ['range_name', 'effective_from'])
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('supplier_freight_rates')
}
