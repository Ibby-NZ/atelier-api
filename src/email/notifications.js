// Order-lifecycle notifications wired to the US-011/US-012/US-014 transitions.
//
// Every helper is a no-op when `mailer` is null (the API boots and runs without
// email configured) and never throws — mailer.send() swallows delivery failures
// — so triggering a notification can never fail the request that caused it.

import { resolveOrderRecipient } from './recipients.js'
import { renderStoredTemplate } from './template-store.js'
import { uniqueEmails } from '../orders/notify-emails.js'

// Status -> the letter announcing a move INTO it (US-014, widened by the
// 24 Sep 2026 lifecycle overhaul). A status absent here sends nothing:
// `quote_requested` is the creation status (notifyOrderCreated has its own
// letter), `quote_accepted` / `quote_rejected` are the client's own doing (the
// office hears via notifyQuoteAnswered), and `processing`, `completed` and
// `refunded` are the office's bookkeeping — Xero sends the credit note.
//
// `pending_payment` maps to `order_invoiced`, NOT to `order_confirmed`: the
// client's confirmation goes out when the order is CREATED (US-005, FR-120), so
// the invoice has to say something of its own or it re-sends a mail the client
// already has (FR-121). Two events, two messages.
//
// `cancelled` joined on 23 Sep 2026 ("when the status changes on a sales
// order, an email is sent"): it is the CRM's "Cancel order", whose
// confirmation already promised the office that the client is told.
export const TRANSITION_TEMPLATES = Object.freeze({
  quote_sent: 'quote_sent',
  back_order: 'order_back_ordered',
  pending_payment: 'order_invoiced',
  paid: 'payment_received',
  shipped: 'shipped',
  cancelled: 'order_cancelled',
})

/**
 * Everyone a letter about a sales order goes to, one address each, in order:
 *   - the client (`resolveOrderRecipient`: the guest's address, else the
 *     account's);
 *   - the order's sales rep (`sales_rep_email` on the admin order shape — null
 *     when nobody is assigned, and null for a rep whose login is archived,
 *     because a person who has left must not keep receiving a client's orders);
 *   - every address on the order's Emails list (`notify_emails`, added in the
 *     CRM on the order page);
 *   - the standing copy, `mailer.orderCopyEmail` (ORDER_COPY_EMAIL, default
 *     jenettec@atelier.co.nz — 24 Sep 2026, "make sure she is always in the
 *     loop"). Last, and deduped like the rest, so if she is also the rep she
 *     gets one letter.
 *
 * Shared by the status letters (notifyOrderTransition) and the order page's
 * on-demand sends (order-letters.js), so both reach the same people.
 *
 * @param {import('./mailer.js').Mailer} mailer
 * @param {{ query: Function }} db
 * @param {{ guest_email?: string|null, user_id?: number|null, sales_rep_email?: string|null, notify_emails?: string[] }} order
 * @returns {Promise<string[]>}
 */
export const orderLetterRecipients = async (mailer, db, order) =>
  uniqueEmails([
    await resolveOrderRecipient(db, order),
    order.sales_rep_email,
    ...(order.notify_emails ?? []),
    mailer.orderCopyEmail,
  ])

/**
 * The fields every status letter reads. `tracking_url` is the courier link the
 * office typed at `ship`: null on every other status, and null for a
 * hand-delivered order, where the shipped template drops its line rather than
 * print an empty one.
 */
export const statusLetterData = (order) => ({
  order_number: order.order_number,
  xero_invoice_ref: order.xero_invoice_ref ?? null,
  tracking_url: order.tracking_url ?? null,
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
 * Announce a status change (see TRANSITION_TEMPLATES for which statuses have a
 * letter) — US-014, widened on 23 Sep 2026 to everyone the order names. Any
 * other status is a no-op.
 *
 * The SAME letter goes to the client, the order's sales rep, every address on
 * the order's Emails list and the standing copy — see orderLetterRecipients.
 *
 * **One letter per address, each address once** (`uniqueEmails`, so a rep who
 * is also the client gets one). Separate letters rather than one with CC: the
 * mailer's contract is a single `to` — the EMAIL_REDIRECT_TO valve rewrites
 * exactly that — and the client's accounts desk has no business reading the
 * rep's address in a header, or vice versa. A client with no address on file
 * no longer silences the rest: the rep still hears the order moved.
 *
 * Every caller hands over the ADMIN order shape (`getAdminOrder`: the CRM's
 * status route, the purchase-order generator's back order, and both Xero
 * directions), which is what carries the rep and the list. The back-office
 * alert on CREATION is a different letter with a different rule — one address,
 * never a per-salesperson list (sendBackofficeAlert) — and is untouched by this.
 *
 * `extra` is spread into the template data for what the order row cannot carry
 * — the `quote_url` a `quote_sent` letter links, which exists only in the
 * route that issued it.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ order_number: string, status: string, xero_invoice_ref?: string|null, tracking_url?: string|null, guest_email?: string|null, user_id?: number|null, sales_rep_email?: string|null, notify_emails?: string[] }} order
 * @param {{ quote_url?: string|null }} [extra]
 */
export const notifyOrderTransition = async (mailer, db, order, extra = {}) => {
  if (!mailer) {
    return
  }
  const template = TRANSITION_TEMPLATES[order.status]
  if (!template) {
    return
  }
  const recipients = await orderLetterRecipients(mailer, db, order)
  const data = { ...statusLetterData(order), ...extra }
  // In turn, not in parallel: `send` never throws, so one bad address cannot
  // stop the rest, and a relay is kinder to a short queue than a burst.
  for (const to of recipients) {
    await mailer.send({ template, to, data })
  }
}

/**
 * The client answered a quote from the storefront (accept, or reject with a
 * reason): tell the office's one address and the order's rep. Reply-To is the
 * client, the back-office-alert rule, so answering from the inbox reaches them.
 * The client gets nothing — they just did it.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ query: Function }} db
 * @param {{ order_number: string, guest_email?: string|null, user_id?: number|null, sales_rep_email?: string|null }} order
 * @param {{ accepted: boolean, reason?: string|null }} answer
 */
export const notifyQuoteAnswered = async (mailer, db, order, { accepted, reason = null }) => {
  if (!mailer) {
    return
  }
  const client = await resolveOrderRecipient(db, order)
  const data = {
    order_number: order.order_number,
    answer: accepted ? 'accepted' : 'rejected',
    reason: accepted ? null : reason,
  }
  for (const to of uniqueEmails([mailer.backofficeEmail, order.sales_rep_email])) {
    await mailer.send({ template: 'backoffice_quote_answered', to, replyTo: client, data })
  }
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
      review_url: `${crmBaseUrl}/#/clients/accounts?pending=true`,
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

/**
 * The line list as the two sample-request letters print it: one line per
 * colourway — "House · Design — Colour (SKU)" — with the shopper's note under
 * it where there is one.
 *
 * @param {Array<{sku: string, product_name?: string|null, colourway_name?: string|null, brand_name?: string|null, note?: string|null}>} lines
 * @returns {string}
 */
export const sampleRequestLinesText = (lines = []) =>
  lines
    .map((line) => {
      const name = [line.brand_name, line.product_name].filter(Boolean).join(' · ')
      const colour = line.colourway_name ? ` — ${line.colourway_name}` : ''
      const head = `- ${name || line.sku}${colour} (${line.sku})`
      return line.note ? `${head}\n    ${line.note}` : head
    })
    .join('\n')

/**
 * A new sample request from the storefront's enquiry cart (16 Sep 2026):
 * acknowledge to the shopper and alert the back office, the
 * notifyRequestReceived shape. The back office's alert goes to the ONE
 * configured address, never a per-person list (see sendBackofficeAlert).
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ request_number: string, contact_email: string, lines: Array }} sampleRequest
 */
export const notifySampleRequestReceived = async (mailer, sampleRequest) => {
  if (!mailer) {
    return
  }
  const linesText = sampleRequestLinesText(sampleRequest.lines)
  await mailer.send({
    template: 'sample_request_received',
    to: sampleRequest.contact_email,
    data: { request_number: sampleRequest.request_number, lines_text: linesText },
  })
  await mailer.send({
    template: 'backoffice_new_sample_request',
    to: mailer.backofficeEmail,
    replyTo: sampleRequest.contact_email,
    data: {
      request_number: sampleRequest.request_number,
      customer_email: sampleRequest.contact_email,
      lines_text: linesText,
    },
  })
}
