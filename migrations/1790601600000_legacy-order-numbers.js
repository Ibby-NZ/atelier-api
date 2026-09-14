/**
 * Renumber the card-checkout orders that predate `src/orders/order-number.js`.
 *
 * Until 14 September 2026 a card checkout took its number from the Stripe
 * Checkout Session id: `WEB-cs_test_b1tAmrENYCGCNzGq2Es2h…` — 70 characters of
 * Stripe's opaque key, wrapping to three lines in the CRM's order column and
 * unreadable on a receipt (Userback 8367911). New orders get `WEB-XXXXXXXX`
 * (8 upper-case hex characters, `orderNumber('WEB')`); this rewrites the old
 * rows into the same shape so the queue reads as one series.
 *
 * Deterministic, not random: the new number is the first 8 hex characters of
 * md5(old number), so a re-run on a partially-migrated database lands on the
 * same values, and a collision with an existing number aborts on the unique
 * index rather than silently overwriting. Nothing else keys on the old string:
 * Xero receives the PO/client reference, never the order number; the webhook
 * ledger keys on the Stripe event; the Stripe session id stays in
 * `orders.stripe_session_id`, which is what the checkout success page looks the
 * order up by. Letters already sent carry the old number — that is why `down`
 * cannot put it back and does not try.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.sql(`
    UPDATE orders
       SET order_number = 'WEB-' || upper(substr(md5(order_number), 1, 8))
     WHERE order_number LIKE 'WEB-cs\\_%'
  `)
}

/**
 * Irreversible by design: the receipts and history rows that quoted the old
 * number are already with the client, and the Stripe session id is still on
 * the row for anyone who needs the original key.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = () => {}
