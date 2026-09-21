/**
 * Xero two-way sync: suppliers as Xero contacts, purchase orders as Xero
 * bills, and the status Xero last reported for each pushed document.
 *
 * `suppliers.xero_contact_id` — the live counterpart of
 * `users.xero_contact_id` / `trade_accounts.xero_contact_id`: which Xero
 * Contact a bill from this house is raised against. TEXT, opaque, nullable
 * ("the next bill push will match-or-create").
 *
 * `purchase_orders.xero_bill_id` / `xero_bill_ref` — the ACCPAY invoice a
 * purchase order was pushed as, id for the duplicate gate and the human
 * InvoiceNumber for the screen, the same pair `orders` carries.
 *
 * `orders.xero_invoice_status` / `purchase_orders.xero_bill_status` — Xero's
 * OWN status word (DRAFT / AUTHORISED / PAID / VOIDED / DELETED) as of the last
 * pull. Stored rather than derived because it is what lets a push after a void
 * be allowed: an accountant voids the invoice in Xero, the office corrects the
 * order, and the platform must know the stored id is dead. Nullable = never
 * pulled since the push.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('suppliers', { xero_contact_id: { type: 'text' } })
  pgm.addColumns('orders', { xero_invoice_status: { type: 'text' } })
  pgm.addColumns('purchase_orders', {
    xero_bill_id: { type: 'text' },
    xero_bill_ref: { type: 'text' },
    xero_bill_status: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('purchase_orders', ['xero_bill_id', 'xero_bill_ref', 'xero_bill_status'])
  pgm.dropColumns('orders', ['xero_invoice_status'])
  pgm.dropColumns('suppliers', ['xero_contact_id'])
}
