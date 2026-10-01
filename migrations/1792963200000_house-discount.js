/**
 * The house's own discount, apart from its supplier's (1 Oct 2026). The office:
 * supplier discounts are ONLY for purchase orders. Armani Casa sold at its
 * supplier's 50% when Dynamics prices the range at 0%, because the house page's
 * discount and the supplier's terms were one row (`supplier_brand_terms`).
 *
 * `supplier_pricing_parameters.discount_percent` — what Atelier SELLS a house
 * at: Dynamics' range figure (the ranges import) or what the office types on
 * the house page. A house row only: no supplier-wide sale discount exists.
 * The supplier's terms and `suppliers.default_discount` stay, and price
 * purchase orders alone.
 *
 * Carried over: a flat terms rate that was the house's figure in the first
 * place — written by the ranges import or typed on the house page, as its note
 * says. A rate from a supplier agreement is left with the supplier; its house
 * prices as "discount not set" until the next ranges upload fills it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('supplier_pricing_parameters', {
    discount_percent: {
      type: 'numeric(6,3)',
      check: 'discount_percent >= 0 AND discount_percent < 100 AND (discount_percent IS NULL OR brand_id IS NOT NULL)',
    },
  })
  pgm.sql(`
    INSERT INTO supplier_pricing_parameters (brand_id, discount_percent)
    SELECT brand_id, round(discount * 100, 3)
      FROM supplier_brand_terms
     WHERE discount IS NOT NULL
       AND (note LIKE 'From the Dynamics parameter export%' OR note = 'Set on the house page')
    ON CONFLICT (brand_id) WHERE brand_id IS NOT NULL
    DO UPDATE SET discount_percent = EXCLUDED.discount_percent`)
}

export const down = (pgm) => {
  pgm.dropColumn('supplier_pricing_parameters', 'discount_percent')
}
