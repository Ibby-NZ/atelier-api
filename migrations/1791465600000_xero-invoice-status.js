/**
 * Xero two-way sync: the status Xero last reported for a pushed invoice.
 *
 * `orders.xero_invoice_status` — Xero's OWN status word (DRAFT / AUTHORISED /
 * PAID / VOIDED / DELETED) as of the last pull, the sales-side twin of
 * `purchase_orders.xero_bill_status` (1791292800000_purchase-order-xero-bills).
 * Stored rather than derived because it is what lets a push after a void be
 * allowed: an accountant voids the invoice in Xero, the office corrects the
 * order, and the platform must know the stored id is dead. Nullable = never
 * pulled since the push.
 *
 * `suppliers.xero_contact_id` and the `purchase_orders.xero_bill_*` columns
 * this sync also reads arrived with the purchase-order bill push (#72).
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', { xero_invoice_status: { type: 'text' } })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['xero_invoice_status'])
}
