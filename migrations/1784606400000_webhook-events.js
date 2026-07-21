/**
 * Stripe webhook idempotency ledger: one row per processed Stripe event id.
 * The webhook claims an event with INSERT ... ON CONFLICT DO NOTHING; a zero
 * rowCount means the event was already processed (a replay) so nothing is done.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('webhook_events', {
    event_id: { type: 'text', primaryKey: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('webhook_events')
}
