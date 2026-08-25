/**
 * Sample lines on a purchase order (C18).
 *
 * The client's words: "Samples listed with prices at the bottom of POs;
 * receipted samples flow values into the register via sample number." A hanger
 * or a cutting is ordered on the same paper as the cloth, priced on the same
 * paper, and receipted at the same door — so it is a LINE, not a table of its
 * own. What makes it different is what it is NOT: a sample line is never demand
 * bought against a sales order (no allocation may name one — enforced in
 * `insertAllocation`, the one path that writes an allocation), and the derived
 * plan/generate path can never produce one, because its lines come from open
 * sales demand and a sample is added by hand.
 *
 * `sample_barcode` IS A REFERENCE BY VALUE, DELIBERATELY NOT A FOREIGN KEY to
 * `samples.barcode`. The whole point of the flow is that the register row may
 * not exist yet — the tag is often printed and registered AFTER the hanger
 * arrives — and an FK would refuse the purchase-order line until the office had
 * registered a sample they do not hold. The receipt flow therefore ONLY updates
 * an existing register row and reports the barcodes it could not match, so
 * staff register the tag and key the value by hand (the manual field on the
 * sample is the fallback). A dangling barcode here is an ordinary working
 * state, not corruption.
 *
 * The CHECK is one-directional on purpose: `is_sample OR sample_barcode IS
 * NULL` — a barcode on a goods line is a keying error the schema can catch,
 * while a sample line with NO barcode is normal (the tag is not printed yet;
 * the value then flows nowhere and the manual field catches it).
 *
 * `is_sample` is NOT NULL DEFAULT false: every line raised before this
 * migration is a goods line, and a NULL third state ("we do not know whether
 * this is a sample") is not a fact anyone holds.
 *
 * NO price column is added. `unit_price` already carries the sample's price in
 * the order's own currency, with the semantics C18 needs intact: NULL is
 * "nobody priced this" and 0 is "free hanger, and we know it" — the same
 * NULL-vs-0 rule `samples.unit_cost` states (1788148800000_sample-cost.js),
 * which is exactly what lets a receipt copy the one into the other without
 * translating anything.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('purchase_order_lines', {
    is_sample: { type: 'boolean', notNull: true, default: false },
    // Nullable: only meaningful on a sample line, and even there optional. See
    // the header — by value, never an FK.
    sample_barcode: { type: 'text' },
  })

  // Named explicitly rather than left to the inline `check:` form, the
  // `samples_unit_cost_check` posture: the rule spans two columns and a later
  // reader has to be able to find it by name when the 23514 arrives.
  pgm.addConstraint('purchase_order_lines', 'purchase_order_lines_sample_barcode_check', {
    check: 'is_sample OR sample_barcode IS NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropConstraint('purchase_order_lines', 'purchase_order_lines_sample_barcode_check')
  pgm.dropColumns('purchase_order_lines', ['is_sample', 'sample_barcode'])
}
