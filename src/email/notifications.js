// Order-lifecycle notifications wired to the US-011/US-012/US-014 transitions.
//
// Every helper is a no-op when `mailer` is null (the API boots and runs without
// email configured) and never throws — mailer.send() swallows delivery failures
// — so triggering a notification can never fail the request that caused it.

import { resolveOrderRecipient } from './recipients.js'

// Admin status -> the template announcing that transition (US-014). A status not
// in this map (e.g. 'declined') sends nothing.
const TRANSITION_TEMPLATES = Object.freeze({
  confirmed: 'order_confirmed',
  paid: 'payment_received',
  shipped: 'shipped',
})

/**
 * A new fabric/backorder request (US-012): acknowledge to the customer and alert
 * the back office that a request needs verifying.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ order: { order_number: string, kind: string }, customerEmail: string|null }} args
 */
export const notifyRequestReceived = async (mailer, { order, customerEmail }) => {
  if (!mailer) {
    return
  }
  const data = { order_number: order.order_number, kind: order.kind }
  if (customerEmail) {
    await mailer.send({ template: 'request_received', to: customerEmail, data })
  }
  await mailer.send({
    template: 'backoffice_new_request',
    to: mailer.backofficeEmail,
    data: { ...data, customer_email: customerEmail ?? null },
  })
}

/**
 * Receipt for a paid Stripe checkout (US-011).
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ order_number: string, total_cents: number, guest_email?: string|null, user_id?: number|null }} order
 */
export const notifyCheckoutReceipt = async (mailer, db, order) => {
  if (!mailer) {
    return
  }
  const to = await resolveOrderRecipient(db, order)
  if (!to) {
    return
  }
  await mailer.send({
    template: 'checkout_receipt',
    to,
    data: { order_number: order.order_number, total_cents: order.total_cents },
  })
}

/**
 * Announce a back-office status change (confirmed/paid/shipped) to the customer
 * (US-014). Any other status is a no-op.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ order_number: string, status: string, xero_invoice_ref?: string|null, guest_email?: string|null, user_id?: number|null }} order
 */
export const notifyOrderTransition = async (mailer, db, order) => {
  if (!mailer) {
    return
  }
  const template = TRANSITION_TEMPLATES[order.status]
  if (!template) {
    return
  }
  const to = await resolveOrderRecipient(db, order)
  if (!to) {
    return
  }
  await mailer.send({
    template,
    to,
    data: {
      order_number: order.order_number,
      xero_invoice_ref: order.xero_invoice_ref ?? null,
    },
  })
}
