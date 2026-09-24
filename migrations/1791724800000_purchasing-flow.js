/**
 * The purchase-order lifecycle, bulk orders to a supplier, and the purchase
 * price worked out from a wholesale rate (24 Sep 2026).
 *
 * `purchase_orders.status` — seven words instead of five: draft →
 * pending_payment ("Send PO": the letter goes to the house and the bill is
 * raised in Xero) → paid / awaiting_delivery → received → completed, plus
 * cancelled. Existing rows are renamed in place: `sent` → `pending_payment`,
 * `closed` → `completed`; draft, paid and cancelled keep their word. The moves
 * are `ALLOWED_TRANSITIONS` in src/purchasing/po-states.js; this CHECK holds the
 * vocabulary only. Each status keeps ONE stamp: pending_payment reuses
 * `sent_at` and completed reuses `closed_at` (the same moments under their new
 * names), and the two new states get `awaiting_delivery_at` / `received_at`.
 *
 * `purchase_orders.notify_emails` — the purchase order's own Emails list, the
 * sales order's rule: extra addresses that receive every letter about it. `[]`
 * is the one spelling of "nobody extra".
 *
 * `purchase_order_bulks` — ONE letter to a house covering several purchase
 * orders (the Bulk orders tab). A bulk is created at the moment it is sent, so
 * it has no status of its own: its purchase orders carry theirs, and receiving
 * still happens line by line on them. `purchase_orders.bulk_order_id` points
 * back; RESTRICT, because a bulk that went to a house is a record of what was
 * asked for.
 *
 * `purchase_order_lines.freight_per_unit` — the freight estimate, NZ$ per unit,
 * snapshotted from the house's freight rate when the line was priced (the
 * supplier's own price stays `unit_price`, in its currency).
 *
 * `products.wholesale_rate` — the design's wholesale rate in its supplier's
 * currency, filled by the coming wholesale import (and editable on the product
 * meanwhile). A purchase-order line is priced from it, less the supplier's
 * discount for the house.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.dropConstraint('purchase_orders', 'purchase_orders_status_check')
  pgm.sql(`UPDATE purchase_orders SET status = 'pending_payment' WHERE status = 'sent'`)
  pgm.sql(`UPDATE purchase_orders SET status = 'completed' WHERE status = 'closed'`)
  pgm.addConstraint('purchase_orders', 'purchase_orders_status_check', {
    check:
      "status IN ('draft', 'pending_payment', 'paid', 'awaiting_delivery', 'received', " +
      "'completed', 'cancelled')",
  })

  pgm.createTable('purchase_order_bulks', {
    id: 'id',
    bulk_number: { type: 'text', notNull: true, unique: true },
    supplier_id: { type: 'integer', notNull: true, references: 'suppliers', onDelete: 'RESTRICT' },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createSequence('purchase_order_bulks_number_seq', { start: 1 })

  pgm.addColumns('purchase_orders', {
    awaiting_delivery_at: { type: 'timestamptz' },
    received_at: { type: 'timestamptz' },
    notify_emails: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
    bulk_order_id: { type: 'integer', references: 'purchase_order_bulks', onDelete: 'RESTRICT' },
  })
  pgm.createIndex('purchase_orders', 'bulk_order_id')

  pgm.addColumns('purchase_order_lines', {
    freight_per_unit: { type: 'numeric(12,4)' },
  })
  pgm.addColumns('products', {
    wholesale_rate: { type: 'numeric(12,4)' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('products', ['wholesale_rate'])
  pgm.dropColumns('purchase_order_lines', ['freight_per_unit'])
  pgm.dropIndex('purchase_orders', 'bulk_order_id')
  pgm.dropColumns('purchase_orders', [
    'awaiting_delivery_at',
    'received_at',
    'notify_emails',
    'bulk_order_id',
  ])
  pgm.dropSequence('purchase_order_bulks_number_seq')
  pgm.dropTable('purchase_order_bulks')

  pgm.dropConstraint('purchase_orders', 'purchase_orders_status_check')
  pgm.sql(
    `UPDATE purchase_orders SET status = 'sent'
      WHERE status IN ('pending_payment', 'awaiting_delivery', 'received')`
  )
  pgm.sql(`UPDATE purchase_orders SET status = 'closed' WHERE status = 'completed'`)
  pgm.addConstraint('purchase_orders', 'purchase_orders_status_check', {
    check: "status IN ('draft', 'sent', 'paid', 'closed', 'cancelled')",
  })
}
