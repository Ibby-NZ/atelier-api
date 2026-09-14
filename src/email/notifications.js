// Order-lifecycle notifications wired to the US-011/US-012/US-014 transitions.
//
// Every helper is a no-op when `mailer` is null (the API boots and runs without
// email configured) and never throws — mailer.send() swallows delivery failures
// — so triggering a notification can never fail the request that caused it.

import { resolveOrderRecipient } from './recipients.js'
import { renderStoredTemplate } from './template-store.js'

// Admin status -> the template announcing that transition (US-014). A status not
// in this map (e.g. 'declined') sends nothing.
//
// `confirmed` maps to `order_invoiced`, NOT to `order_confirmed`: the client's
// confirmation now goes out when the order is CREATED (US-005, FR-120), so
// confirming has to say something of its own or it re-sends a mail the client
// already has (FR-121). Two events, two messages.
const TRANSITION_TEMPLATES = Object.freeze({
  confirmed: 'order_invoiced',
  paid: 'payment_received',
  shipped: 'shipped',
})

// The back office's alert that an order exists, whichever path created it
// (US-004, FR-119).
//
// **ONE address — `mailer.backofficeEmail`, the configured admin@ — and never a
// per-salesperson list.** That restriction is the client's actual requirement,
// not an implementation detail waiting to be "improved" into a routing table:
// an order that lands in one person's inbox is an order nobody else covers when
// that person is away.
const sendBackofficeAlert = (mailer, order, customerEmail) =>
  mailer.send({
    template: 'backoffice_new_request',
    to: mailer.backofficeEmail,
    replyTo: customerEmail ?? null,
    data: {
      order_number: order.order_number,
      kind: order.kind,
      customer_email: customerEmail ?? null,
    },
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
  if (customerEmail) {
    await mailer.send({
      template: 'request_received',
      to: customerEmail,
      data: { order_number: order.order_number, kind: order.kind },
    })
  }
  await sendBackofficeAlert(mailer, order, customerEmail)
}

/**
 * Alert the back office about a new order on a path that already sends the
 * client its own message — the Stripe checkout, which sends a receipt naming the
 * amount paid (US-004, FR-119). Before this, a card sale reached the office only
 * when somebody opened the queue.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ order_number: string, kind: string, guest_email?: string|null, user_id?: number|null }} order
 */
export const notifyBackofficeNewOrder = async (mailer, db, order) => {
  if (!mailer) {
    return
  }
  await sendBackofficeAlert(mailer, order, await resolveOrderRecipient(db, order))
}

/**
 * A newly created order that has no message of its own: the client's
 * confirmation (US-005, FR-120) and the back-office alert (US-004, FR-119) in
 * one call. Today that is the back office's own `POST /admin/orders`, which
 * notified nobody at all — neither the client it was keyed for nor the desk.
 *
 * The confirmation is deliberately the same `order_confirmed` copy the `confirm`
 * transition used to send, moved rather than duplicated; `confirm` now sends
 * `order_invoiced` instead.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ order_number: string, kind: string, guest_email?: string|null, user_id?: number|null }} order
 */
export const notifyOrderCreated = async (mailer, db, order) => {
  if (!mailer) {
    return
  }
  const to = await resolveOrderRecipient(db, order)
  if (to) {
    await mailer.send({
      template: 'order_confirmed',
      to,
      // A new order has no invoice yet; the template's own branch says so.
      data: { order_number: order.order_number, xero_invoice_ref: null },
    })
  }
  await sendBackofficeAlert(mailer, order, to)
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
 * @param {{ order_number: string, status: string, xero_invoice_ref?: string|null, tracking_url?: string|null, guest_email?: string|null, user_id?: number|null }} order
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
      // The courier link the office typed at `ship`. Null on every other
      // transition, and null for a hand-delivered order; the shipped template
      // drops its line rather than printing an empty one.
      tracking_url: order.tracking_url ?? null,
    },
  })
}

/**
 * A new storefront contact enquiry: acknowledge to the sender and alert the back
 * office. No-op when mailer is null; never throws (mailer.send swallows errors),
 * so a mail problem can't fail the enquiry submission.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ name: string, email: string, phone?: string|null, subject?: string|null, message: string }} enquiry
 */
export const notifyContactReceived = async (mailer, enquiry) => {
  if (!mailer) {
    return
  }
  await mailer.send({
    template: 'contact_received',
    to: enquiry.email,
    data: { name: enquiry.name },
  })
  await mailer.send({
    template: 'backoffice_new_contact',
    to: mailer.backofficeEmail,
    replyTo: enquiry.email,
    data: {
      name: enquiry.name,
      email: enquiry.email,
      phone: enquiry.phone ?? null,
      subject: enquiry.subject ?? null,
      message: enquiry.message,
    },
  })
}

/**
 * The password reset letter. No-op when mailer is null; never throws. The
 * caller decides where the link points (src/auth/password-reset.js resetUrlFor)
 * because that depends on the account's role, not on the mail.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ user: { email: string, name?: string|null }, resetUrl: string, expiresMinutes: number }} reset
 */
export const notifyPasswordReset = async (mailer, { user, resetUrl, expiresMinutes }) => {
  if (!mailer) {
    return
  }
  await mailer.send({
    template: 'password_reset',
    to: user.email,
    data: { name: user.name, reset_url: resetUrl, expires_minutes: expiresMinutes },
  })
}

/**
 * A new trade application is waiting: alert the back office (the single
 * configured address, like every other alert) with a link to the CRM's
 * Applicants tab. The applicant is NOT mailed here — a pending account cannot
 * sign in, and the acceptance letter on approval is the one letter they get.
 * No-op when mailer is null; never throws.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ user: { email: string }, application: { business_name: string, business_type?: string|null, signatory_name?: string|null }, crmBaseUrl: string }} args
 */
export const notifyTradeApplicationReceived = async (mailer, { user, application, crmBaseUrl }) => {
  if (!mailer) {
    return
  }
  await mailer.send({
    template: 'backoffice_new_trade_application',
    to: mailer.backofficeEmail,
    replyTo: user.email,
    data: {
      business_name: application.business_name,
      business_type: application.business_type ?? null,
      signatory_name: application.signatory_name ?? null,
      email: user.email,
      // The CRM is a hash router; this is its Applicants tab.
      review_url: `${crmBaseUrl}/#/clients/applicants`,
    },
  })
}

// The store-backed acceptance letter; the CRM Letters screen edits it by name.
export const TRADE_APPROVED_TEMPLATE = 'trade_application_approved'

/**
 * The acceptance letter, sent when a trade application is approved. The caller
 * (PATCH /admin/users/:id) decides WHEN — only on the false -> true flip, so a
 * re-saved approval never re-sends it. Greets by the login's name, else by the
 * signatory on the application (`name` is optional on the form; "Dear ," is
 * not a letter). No-op when mailer is null; never throws.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ id: number, email: string, name?: string|null }} user
 */
export const notifyTradeApproved = async (mailer, db, user) => {
  if (!mailer) {
    return
  }
  let name = user.name
  if (!name) {
    // The approval is already committed by now, so a failed lookup degrades
    // the greeting rather than 500ing the PATCH.
    const { rows } = await db
      .query(
        `SELECT signatory_name FROM trade_applications
          WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
        [user.id]
      )
      .catch(() => ({ rows: [] }))
    name = rows[0]?.signatory_name || 'Customer'
  }
  const { subject, text } = await renderStoredTemplate(db, TRADE_APPROVED_TEMPLATE, { name })
  await mailer.send({ to: user.email, subject, text })
}
