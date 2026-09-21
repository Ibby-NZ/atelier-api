/**
 * A purchase order as a Xero BILL (ACCPAY), the buy-side twin of
 * `orders.xero_invoice_id`.
 *
 * `purchase_orders.xero_bill_id` is the API identifier the push stores — the
 * duplicate gate, a second push 409s. `xero_bill_ref` is Xero's InvoiceNumber,
 * the human number the office reconciles against the supplier's paperwork.
 *
 * `xero_bill_status` / `xero_bill_paid_at` are a MIRROR of Xero's own answer
 * (AUTHORISED, PAID, VOIDED… and FullyPaidOnDate), refreshed by the sync route.
 * They live BESIDE `status`, never in it: `status` is what a person did here
 * (draft/sent/closed/cancelled), and whether the bill has been paid is a fact
 * about the bank, answered by Xero. Folding "paid" into the state machine would
 * give two answers to one question the first time a paid bill is closed short.
 *
 * `suppliers.xero_contact_id` — which Xero Contact this house bills as, the
 * supplier-side twin of `users.xero_contact_id`. TEXT, nullable, same posture.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('purchase_orders', {
    xero_bill_id: { type: 'text' },
    xero_bill_ref: { type: 'text' },
    xero_bill_status: { type: 'text' },
    xero_bill_paid_at: { type: 'timestamptz' },
  })
  pgm.addColumns('suppliers', {
    xero_contact_id: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('suppliers', ['xero_contact_id'])
  pgm.dropColumns('purchase_orders', [
    'xero_bill_id',
    'xero_bill_ref',
    'xero_bill_status',
    'xero_bill_paid_at',
  ])
}
