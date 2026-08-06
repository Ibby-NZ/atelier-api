/**
 * Supplier commercial terms, per brand — the structure the current CRM cannot model.
 *
 * A supplier-level averaged discount (the 9 Jul rule) already lives on
 * `suppliers.discount_method = 'averaged'`. This migration adds the exception
 * path: the houses excluded from averaging, whose terms are negotiated brand by
 * brand. `src/seed/data/suppliers.js` is the vocabulary — Janelli Volpi carries
 * three labelled tiers on one brand, a flat rate on five sister brands and a
 * compounded chain on a sixth; Fabricut carries a per-brand retail markup.
 *
 * DISCOUNT CHAINS ARE MULTIPLICATIVE, WHICH IS WHY THEY ARE AN ARRAY.
 * JV Fabrics is "40% off, then 40% off the result" — each rate applies to what
 * the one before it left, so {0.4, 0.4} nets to x0.36. Summing the two into a
 * single 0.8 gives -80% and undercharges Atelier by 44% of the list price on
 * every metre. A numeric column cannot hold that structure, so the chain is
 * stored as the sequence it is and evaluated by `src/suppliers/discount-chain.js`.
 * A flat rate is not a one-entry chain here: it has its own column, because
 * `discount` and a populated `discount_chain` on one row would leave two
 * answers and no rule for which wins (see the shape CHECK below).
 *
 * THESE TABLES ARE BACK-OFFICE ONLY AND NO CLIENT-FACING READ MODEL MAY JOIN
 * THEM. They hold what Atelier pays, not what a customer is quoted: a discount
 * off a maison's list price is that maison's confidential term. `brands` is
 * served to anonymous visitors by `src/catalogue/brands.js`, which is why the
 * terms live out here on their own tables rather than as columns on it, and why
 * `test/suppliers-terms.test.js` scans `src/` for any mention of them outside
 * the suppliers domain.
 *
 * FK POLICIES. Both are CASCADE, deliberately. A terms row is a description of
 * a live supplier-brand relationship, not a business record that outlives it —
 * the posture `supplier_aliases` already takes. It also keeps US-005's supplier
 * DELETE story intact: `brands` (RESTRICT) and `price_list_items` (SET NULL)
 * stay the only two blockers a caller is told about, rather than a third
 * RESTRICT edge surfacing as an uncounted 23503. Note that a brand is
 * effectively never hard-deleted — it is archivable, and `deleteOrExplain`
 * refuses one that has any product or collection — so the cascade only ever
 * reaches a stub house.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('supplier_brand_terms', {
    id: 'id',
    supplier_id: {
      type: 'integer',
      notNull: true,
      references: 'suppliers',
      onDelete: 'CASCADE',
    },
    // UNIQUE, not part of a composite: one brand has one set of terms, whoever
    // invoices it. A second row would make "the discount for this house"
    // ambiguous, which is the same failure the alias index exists to prevent.
    brand_id: {
      type: 'integer',
      notNull: true,
      unique: true,
      references: 'brands',
      onDelete: 'CASCADE',
    },
    // A flat per-brand rate, as a fraction: 0.5 is 50% off. The JV sister
    // brands (Altagamma, JWall, JV Design, Armani, Missoni) are all this shape.
    discount: { type: 'numeric(6,4)' },
    // The compounded sequence — see the header. Empty means "no chain", never
    // "no discount": a discount-inclusive supplier is recorded on the supplier.
    discount_chain: {
      type: 'numeric(6,4)[]',
      notNull: true,
      default: pgm.func("'{}'::numeric(6,4)[]"),
    },
    // Retail multiplier applied to the landed cost (Fabricut: 2.1 - 2.5).
    markup: { type: 'numeric(6,4)' },
    // The seed flags several rows as indicative pending the real terms (A13),
    // so the CRM can badge a number it should not yet be trusted with.
    indicative: { type: 'boolean', notNull: true, default: false },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // A rate is a fraction off list. 1.0 would be a free metre and a negative one
  // would be a surcharge wearing a discount's name; both are typos, not terms.
  pgm.addConstraint('supplier_brand_terms', 'supplier_brand_terms_discount_range_check', {
    check: 'discount IS NULL OR (discount >= 0 AND discount < 1)',
  })
  // A markup multiplies, so it must be positive; 1.0 (sell at cost) is legal.
  pgm.addConstraint('supplier_brand_terms', 'supplier_brand_terms_markup_check', {
    check: 'markup IS NULL OR markup > 0',
  })
  // A NULL inside the chain propagates through the multiplication and turns the
  // whole net rate into NULL — a silently free metre. CHECK cannot contain a
  // subquery, so element ranges are validated in the module; a NULL element is
  // catchable here because array_position is an ordinary immutable function.
  pgm.addConstraint('supplier_brand_terms', 'supplier_brand_terms_chain_not_null_check', {
    check: 'array_position(discount_chain, NULL) IS NULL',
  })
  // Exactly one shape per row. Carrying both a flat rate and a chain would make
  // the net rate depend on which reader's precedence rule ran.
  pgm.addConstraint('supplier_brand_terms', 'supplier_brand_terms_discount_shape_check', {
    check: 'discount IS NULL OR cardinality(discount_chain) = 0',
  })

  pgm.createIndex('supplier_brand_terms', 'supplier_id')

  // The third shape: rates that differ by what is being bought. Janelli Volpi
  // quotes 45% on new collections, 40% on wallpapers by the metre and 50% on
  // everything else, so the tier is matched by label against the line's
  // category with a fallback for the unmatched.
  pgm.createTable('supplier_discount_tiers', {
    id: 'id',
    supplier_brand_term_id: {
      type: 'integer',
      notNull: true,
      references: 'supplier_brand_terms',
      onDelete: 'CASCADE',
    },
    label: { type: 'text', notNull: true },
    pct: { type: 'numeric(6,4)', notNull: true },
    // Which tier catches a line no label matched. A flag, not the magic string
    // 'All other collections' the snapshot happens to use.
    is_fallback: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.addConstraint('supplier_discount_tiers', 'supplier_discount_tiers_pct_check', {
    check: 'pct >= 0 AND pct < 1',
  })

  // Labels are matched case-insensitively against a category, so two tiers
  // whose labels differ only in case or padding would resolve at random.
  pgm.createIndex('supplier_discount_tiers', ['supplier_brand_term_id', 'lower(btrim(label))'], {
    name: 'supplier_discount_tiers_label_unique',
    unique: true,
  })
  // At most one fallback per brand, for the same reason: two would make the
  // unmatched case non-deterministic, and the unmatched case is the common one.
  pgm.createIndex('supplier_discount_tiers', 'supplier_brand_term_id', {
    name: 'supplier_discount_tiers_fallback_unique',
    unique: true,
    where: 'is_fallback',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('supplier_discount_tiers')
  pgm.dropTable('supplier_brand_terms')
}
