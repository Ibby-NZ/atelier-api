/**
 * Adds orders.gst_cents — the GST a card checkout charged (Sept 2026).
 *
 * Catalogue prices are GST-exclusive; the store now shows 15% GST as its own
 * line and Stripe charges it as one, so the order must record the figure
 * rather than have every reader re-derive (and possibly re-round) it.
 * `total_cents` on a checkout order is subtotal + shipping + gst from now on.
 * Manual/request orders leave it at 0 — Xero adds the tax to those itself
 * (`LineAmountTypes: Exclusive`).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('orders', {
    gst_cents: { type: 'integer', notNull: true, default: 0 },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('orders', 'gst_cents')
}
