/**
 * The sales-order lifecycle overhaul (24 Sep 2026): quote → order → invoice →
 * paid → shipped, every status settable from the CRM, the client accepting or
 * rejecting a quote on the storefront, and an audit row for every move.
 *
 * `orders.status` — twelve words instead of five. Existing rows are renamed in
 * place: `requested` → `quote_requested`, `confirmed` → `pending_payment` (a
 * confirmation was the invoice going out), `declined` → `cancelled`; `paid` and
 * `shipped` keep their word. The transitions live in
 * `src/orders/order-states.js`; this CHECK holds the vocabulary only, and
 * `test/order-states.test.js` asserts the two agree.
 *
 * THE `orders` TABLE ONLY. `reserve_lines`, `sample_orders`, `sample_requests`
 * and `purchase_orders` share some of these words and are untouched.
 *
 * `orders.quote_token_hash` — the SHA-256 of the link the `quote_sent` letter
 * carries, so a guest can accept or reject without an account. The raw token is
 * never stored (the password-reset posture); the partial unique index is the
 * lookup. `orders.quote_sent_at` dates the latest send.
 *
 * `order_events` — one row per status move: who (staff, the client, or the
 * Xero pull), from, to, and an optional note. A rejected quote's reason is the
 * note on its `quote_rejected` row; there is deliberately no column for it on
 * `orders`. CASCADE with the order: the trail describes the order and has no
 * meaning without it. The actor is SET NULL so a departed staff login can be
 * deleted without taking the history with it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.dropConstraint('orders', 'orders_status_check')
  pgm.sql(`UPDATE orders SET status = 'quote_requested' WHERE status = 'requested'`)
  pgm.sql(`UPDATE orders SET status = 'pending_payment' WHERE status = 'confirmed'`)
  pgm.sql(`UPDATE orders SET status = 'cancelled' WHERE status = 'declined'`)
  pgm.addConstraint('orders', 'orders_status_check', {
    check:
      "status IN ('quote_requested', 'quote_sent', 'quote_accepted', 'quote_rejected', " +
      "'back_order', 'processing', 'pending_payment', 'paid', 'shipped', 'completed', " +
      "'cancelled', 'refunded')",
  })

  pgm.addColumns('orders', {
    quote_token_hash: { type: 'text' },
    quote_sent_at: { type: 'timestamptz' },
  })
  pgm.createIndex('orders', 'quote_token_hash', {
    name: 'orders_quote_token_hash_key',
    unique: true,
    where: 'quote_token_hash IS NOT NULL',
  })

  pgm.createTable('order_events', {
    id: 'id',
    order_id: {
      type: 'integer',
      notNull: true,
      references: 'orders',
      onDelete: 'CASCADE',
    },
    from_status: { type: 'text' },
    to_status: { type: 'text', notNull: true },
    actor_kind: {
      type: 'text',
      notNull: true,
      check: "actor_kind IN ('staff', 'customer', 'xero')",
    },
    actor_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    note: { type: 'text' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  })
  pgm.createIndex('order_events', 'order_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('order_events')
  pgm.dropIndex('orders', 'quote_token_hash', { name: 'orders_quote_token_hash_key' })
  pgm.dropColumns('orders', ['quote_token_hash', 'quote_sent_at'])

  pgm.dropConstraint('orders', 'orders_status_check')
  pgm.sql(
    `UPDATE orders SET status = 'requested'
      WHERE status IN ('quote_requested', 'quote_sent', 'quote_accepted',
                       'quote_rejected', 'back_order', 'processing')`
  )
  pgm.sql(`UPDATE orders SET status = 'confirmed' WHERE status = 'pending_payment'`)
  pgm.sql(`UPDATE orders SET status = 'shipped' WHERE status = 'completed'`)
  pgm.sql(`UPDATE orders SET status = 'declined' WHERE status = 'cancelled'`)
  pgm.sql(`UPDATE orders SET status = 'paid' WHERE status = 'refunded'`)
  pgm.addConstraint('orders', 'orders_status_check', {
    check: "status IN ('requested', 'confirmed', 'paid', 'shipped', 'declined')",
  })
}
