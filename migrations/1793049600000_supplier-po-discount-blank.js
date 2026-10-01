/**
 * The supplier's own discount, for its purchase orders, starts blank (1 Oct
 * 2026). The office: each supplier page carries its own discount, used for
 * purchase orders from that supplier, and they fill every one in by hand.
 *
 * `suppliers.default_discount` is cleared on every supplier. Blank prices a
 * purchase-order line at nothing (the office keys it), never at 0%.
 *
 * DOWN DOES NOTHING: the cleared rates are not kept anywhere to put back.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`UPDATE suppliers SET default_discount = NULL WHERE default_discount IS NOT NULL`)
}

export const down = () => {}
