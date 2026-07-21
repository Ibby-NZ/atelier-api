/**
 * Users, orders, and shipping schema: users, orders, order_lines, shipping_rates.
 * Order lifecycle: requested -> confirmed -> paid -> shipped (or declined).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('users', {
    id: 'id',
    email: { type: 'text', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    name: { type: 'text' },
    role: { type: 'text', notNull: true, default: 'customer' },
    trade_approved: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('users', 'users_role_check', {
    check: "role IN ('customer', 'trade', 'backoffice', 'director')",
  })

  pgm.createTable('orders', {
    id: 'id',
    user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    guest_email: { type: 'text' },
    order_number: { type: 'text', notNull: true, unique: true },
    kind: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true },
    subtotal_cents: { type: 'integer', notNull: true, default: 0 },
    shipping_cents: { type: 'integer', notNull: true, default: 0 },
    total_cents: { type: 'integer', notNull: true, default: 0 },
    shipping_zone: { type: 'text' },
    stripe_session_id: { type: 'text' },
    xero_invoice_ref: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('orders', 'orders_kind_check', {
    check: "kind IN ('checkout', 'order_request', 'backorder_request')",
  })
  pgm.addConstraint('orders', 'orders_status_check', {
    check: "status IN ('requested', 'confirmed', 'paid', 'shipped', 'declined')",
  })
  pgm.createIndex('orders', 'user_id')
  pgm.createIndex('orders', 'status')

  // Colourway delete is RESTRICTed: order lines are commerce records and must survive
  // catalogue cleanups; deleting an order cascades its lines.
  pgm.createTable('order_lines', {
    id: 'id',
    order_id: {
      type: 'integer',
      notNull: true,
      references: 'orders',
      onDelete: 'CASCADE',
    },
    colourway_id: {
      type: 'integer',
      notNull: true,
      references: 'colourways',
      onDelete: 'RESTRICT',
    },
    qty: { type: 'numeric(12,2)', notNull: true },
    unit_price_cents: { type: 'integer', notNull: true },
    cut_requirements: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('order_lines', 'order_id')
  pgm.createIndex('order_lines', 'colourway_id')

  // Two tiers per zone (under/over threshold); (zone, threshold_qty) is the seed upsert key.
  pgm.createTable('shipping_rates', {
    id: 'id',
    zone: { type: 'text', notNull: true },
    threshold_qty: { type: 'numeric(12,2)', notNull: true },
    rate_cents: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('shipping_rates', 'shipping_rates_zone_threshold_unique', {
    unique: ['zone', 'threshold_qty'],
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('shipping_rates')
  pgm.dropTable('order_lines')
  pgm.dropTable('orders')
  pgm.dropTable('users')
}
