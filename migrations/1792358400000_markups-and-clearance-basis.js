/**
 * Two markups and a clearance basis (28 Sep 2026).
 *
 * `supplier_pricing_parameters.retail_markup_percent` — each house's retail
 * markup, beside its trade markup. The office: "retail price markup to be in a
 * field next to trade markup in houses". A percentage ON THE TRADE SELL, because
 * that is how Dynamics priced retail: retail ÷ trade is 1.30 on 17,692 of 19,271
 * priced rows of its product-price archive (1.40 De Le Cuona / Larsen / Liberty,
 * 1.35 Maria Flora, 1.50 Garrett Leather / Kieffer / JWALL, 1.80 JV Design). So
 * 30 is "retail = trade × 1.30". House over supplier, like every parameter; the
 * ranges import fills it (parameters-backfill.js).
 *
 * `product_prices.trade_markup_percent` — a product's OWN markup to trade, which
 * Dynamics keeps on the product price ("Markup to Trade %") for the few that do
 * not take their range's (39 of 21,054 on 28 Sep: Garrett Leather, Alpaka, Loro
 * Piana …). NULL = the range's. Written only by an export that carries the
 * column, never cleared by one that does not (product-prices-import.js).
 *
 * `supplier_pricing_parameters.clearance_basis` — whether the clearance figure
 * is a percentage of the duty-paid value plus freight ('percent', and NULL,
 * which every row was) or dollars per unit ('dollar'). The office (28 Sep): a
 * range's clearance "can also be dollar value and not %". The column keeps its
 * name `clearance_percent`; this says how to read it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('supplier_pricing_parameters', {
    retail_markup_percent: { type: 'numeric', check: 'retail_markup_percent >= 0' },
    clearance_basis: { type: 'text', check: "clearance_basis IN ('percent', 'dollar')" },
  })
  pgm.addColumn('product_prices', {
    trade_markup_percent: { type: 'numeric', check: 'trade_markup_percent >= 0' },
  })
}

export const down = (pgm) => {
  pgm.dropColumn('product_prices', 'trade_markup_percent')
  pgm.dropColumn('supplier_pricing_parameters', ['retail_markup_percent', 'clearance_basis'])
}
