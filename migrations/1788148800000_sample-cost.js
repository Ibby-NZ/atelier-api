/**
 * What a sample cost (W20-US-001, FR-260…FR-264).
 *
 * The client's words: "when we bought a sample we manually type it in and it
 * gets a barcode, but it has no financial information... if you did charge the
 * client because they lost it, it's all in the system what the value is." And,
 * in the same breath: "sometimes we get hangers for free."
 *
 * `>= 0`, DELIBERATELY NOT `> 0`. `price_list_items.wholesale_rate` is
 * `CHECK (wholesale_rate > 0)` because a supplier line rate of zero is a
 * malformed price list. A sample is the opposite case: a free hanger is normal
 * and is a fact worth recording, so zero is a legal value here and refusing it
 * would push the office into typing NULL for it — which means something else.
 *
 * NULL AND 0 ARE DIFFERENT FACTS, and the whole column is only useful while
 * they stay different. NULL is "nobody recorded a cost"; 0 is "free of charge,
 * and we know it". A sample-value report sums the second and must be able to
 * COUNT the first separately, because a total that treats every unpriced hanger
 * as a gift understates the library by however many nobody has got to yet.
 * `Number(null)` is 0 in JavaScript — the house's own documented trap — so
 * every read of this column goes through `value == null ? null : Number(value)`
 * (src/samples/admin-samples.js), never a bare `Number()`.
 *
 * NUMERIC, NOT CENTS. `orders`/`order_lines` hold integer cents because they
 * are money the platform charges and arithmetic on them must not drift.
 * A sample cost is a figure typed off a supplier invoice, in the supplier's own
 * units, and `numeric(12,4)` is what `price_list_items.wholesale_rate` and
 * `supplier_brand_terms` already use for exactly that. pg hands `numeric` back
 * as a STRING, which is the other half of why the coercion above is not
 * optional.
 *
 * `cost_currency` IS FREE TEXT AND HAS NO CHECK, unlike
 * `price_list_items.currency` (`EUR|USD|GBP`). That list is the price-list
 * pipeline's own closed vocabulary; a sample can be bought from anyone in
 * anything, NZD included, and a guessed CHECK would refuse the office's own
 * currency the first time they typed it. Same posture as `duty_class` and
 * `samples.sample_type` being stored raw.
 *
 * SAMPLES ARE STILL NOT STOCK. A cost is not a valuation of inventory: nothing
 * here mirrors a quantity, no report multiplies it by one, and the order state
 * machine remains the only owner of the reservation arithmetic.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('samples', {
    // Nullable: most of the standing library was never costed and inventing a
    // figure for it would be worse than admitting there isn't one.
    unit_cost: { type: 'numeric(12,4)' },
    // What the figure is denominated in. Nullable for the same reason, and
    // uncontrolled for the reason in the header.
    cost_currency: { type: 'text' },
  })

  // Named explicitly rather than left to the inline `check:` form: an
  // `addColumns` check would be auto-named per column, and the rule is about
  // the VALUE of one column, which a later reader has to be able to find.
  pgm.addConstraint('samples', 'samples_unit_cost_check', {
    check: 'unit_cost IS NULL OR unit_cost >= 0',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropConstraint('samples', 'samples_unit_cost_check')
  pgm.dropColumns('samples', ['unit_cost', 'cost_currency'])
}
