/**
 * `paid` joins the purchase-order status vocabulary (22 Sep 2026, client
 * asked: "once paid the order status should sync").
 *
 * Reachable from `sent` and from `closed` — a house is paid before delivery
 * (pro-forma) or after — and `paid` may still move to `closed`, because a
 * prepaid order's goods still arrive and the paper is still closed on them.
 * `paid_at` is its stamp, one per move like the other three. The transitions
 * live in `src/purchasing/po-states.js`; this CHECK holds the vocabulary only.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('purchase_orders', { paid_at: { type: 'timestamptz' } })
  pgm.dropConstraint('purchase_orders', 'purchase_orders_status_check')
  pgm.addConstraint('purchase_orders', 'purchase_orders_status_check', {
    check: "status IN ('draft', 'sent', 'paid', 'closed', 'cancelled')",
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql(`UPDATE purchase_orders SET status = 'closed' WHERE status = 'paid'`)
  pgm.dropConstraint('purchase_orders', 'purchase_orders_status_check')
  pgm.addConstraint('purchase_orders', 'purchase_orders_status_check', {
    check: "status IN ('draft', 'sent', 'closed', 'cancelled')",
  })
  pgm.dropColumns('purchase_orders', ['paid_at'])
}
