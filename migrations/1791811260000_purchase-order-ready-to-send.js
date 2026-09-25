/**
 * `ready_to_send` — a purchase-order status between draft and pending payment
 * (25 Sep 2026, the client: "add a status to purchase orders called Ready to
 * Send after draft status, so that admin knows they can add it to other
 * purchase orders for bulk order for that supplier").
 *
 * A draft is still being written; a ready purchase order is finished and
 * waiting to go to the house, and it is what the Bulk purchase orders tab
 * groups by supplier. Nothing has left the building in either state. The moves
 * are `ALLOWED_TRANSITIONS` in src/purchasing/po-states.js; this CHECK holds
 * the vocabulary only, and `ready_at` is the state's one stamp.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.dropConstraint('purchase_orders', 'purchase_orders_status_check')
  pgm.addConstraint('purchase_orders', 'purchase_orders_status_check', {
    check:
      "status IN ('draft', 'ready_to_send', 'pending_payment', 'paid', 'awaiting_delivery', " +
      "'received', 'completed', 'cancelled')",
  })
  pgm.addColumns('purchase_orders', {
    ready_at: { type: 'timestamptz' },
  })
}

/**
 * A ready purchase order goes back to draft: neither has been sent, so no
 * document changes meaning.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropConstraint('purchase_orders', 'purchase_orders_status_check')
  pgm.sql(`UPDATE purchase_orders SET status = 'draft' WHERE status = 'ready_to_send'`)
  pgm.dropColumns('purchase_orders', ['ready_at'])
  pgm.addConstraint('purchase_orders', 'purchase_orders_status_check', {
    check:
      "status IN ('draft', 'pending_payment', 'paid', 'awaiting_delivery', 'received', " +
      "'completed', 'cancelled')",
  })
}
