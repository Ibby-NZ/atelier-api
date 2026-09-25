/**
 * The small-order surcharge, as a pricing parameter of its own.
 *
 * The client's Dynamics parameter export carries it on every range — "Min Qty
 * to avoid surcharge" and "Surcharge $ per unit" (the two `fulmar_` columns,
 * stated on six ranges: BROCHIER, LINK OUTDOOR, RAMM SON & CROCKER, SETTE,
 * THE VALE LONDON at 5 / $20 and TIMNEY FOWLER at 5 / $25) — and the staging
 * mirror has held them since the 12 Aug pull, but nothing on the platform had
 * a place to keep them. September 2026: the office asked for every figure on
 * that export to be set on its house and editable there.
 *
 * They go on `supplier_pricing_parameters` beside the duty bands, the
 * clearance and the trade markup, for the reason that table exists: the
 * resolver reads a house's override, then its supplier's default, then says
 * the value is missing. A second home for them would be a second precedence
 * rule. Neither column is a waterfall input — the surcharge is charged per
 * order line under the minimum, not folded into a unit price — so the waterfall
 * never reads them.
 *
 *   surcharge_min_qty    the quantity (in the house's own unit) below which
 *                        the surcharge applies
 *   surcharge_per_unit   NZ$ added per unit on such a line
 *
 * Both nullable (an override states only what it overrides) and never
 * negative, the table's own CHECK posture.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('supplier_pricing_parameters', {
    surcharge_min_qty: { type: 'numeric(10,2)', check: 'surcharge_min_qty >= 0' },
    surcharge_per_unit: { type: 'numeric(10,2)', check: 'surcharge_per_unit >= 0' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('supplier_pricing_parameters', ['surcharge_min_qty', 'surcharge_per_unit'])
}
