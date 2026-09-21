/**
 * Adds suppliers.default_discount — the one net rate an 'averaged' supplier
 * gives Atelier off its list prices.
 *
 * `discount_method = 'averaged'` (migration 1786334400000) already says a house
 * is rated by ONE supplier-level discount rather than brand by brand. The rate
 * itself had nowhere to live: `supplier_brand_terms.discount` is keyed on a
 * brand (NOT NULL, UNIQUE), so the 9 Jul rule's "Pierre Frey is 5% off list"
 * survived only in the vendored snapshot at src/seed/data/suppliers.js. The
 * consequence was visible in the waterfall: a house whose supplier averages and
 * carries no per-brand terms row resolved `discount_percent` as MISSING, and
 * the landed cost could not be previewed at all.
 *
 * PRECEDENCE IS PER-BRAND FIRST, SUPPLIER DEFAULT SECOND. The same shape
 * src/pricing/pricing-parameters.js already uses for duty and the markups
 * (house override, then supplier default, then missing) — a JV-style exception
 * stays an exception, and this column is what the houses with no exception fall
 * back to. Nothing sums the two.
 *
 * NULLABLE, because "not negotiated yet" is a real answer and a defaulted 0
 * would read as "this house gives us nothing off" — a wrong number that looks
 * right, the mistake `currency` is nullable to avoid. 0 is a legal value and
 * states something different: Loro Piana's prices arrive already net.
 *
 * THE RANGE IS THE SAME ONE EVERY OTHER RATE CARRIES: a fraction off list,
 * 0 <= r < 1. 1 would be a free metre and a negative one is a surcharge wearing
 * a discount's name.
 *
 * IT IS COST DATA. `suppliers` is back-office only and no client-facing read
 * model touches it, but `backoffice` covers the showroom as well as the
 * accounts desk — so the column is served and written through the
 * finance-gated terms routes, never through the general supplier PATCH
 * whitelist. See src/routes/admin-suppliers.js.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('suppliers', {
    default_discount: { type: 'numeric(6,4)' },
  })
  pgm.addConstraint('suppliers', 'suppliers_default_discount_range_check', {
    check: 'default_discount IS NULL OR (default_discount >= 0 AND default_discount < 1)',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropConstraint('suppliers', 'suppliers_default_discount_range_check')
  pgm.dropColumn('suppliers', 'default_discount')
}
