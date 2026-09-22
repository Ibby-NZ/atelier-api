// Transactional email templates (US-015, FR-8). Each template is a pure function
// of its data returning { subject, text } — no I/O, no side effects — so they
// unit-test without a transport. The mailer renders one of these and hands the
// result to the transport.
//
// Templates (one per order-lifecycle moment):
//   request_received        -> customer, after an order/backorder request (US-012)
//   backoffice_new_request  -> staff, whenever ANY path creates an order (W12 US-004)
//   checkout_receipt        -> customer, after a paid Stripe checkout (US-011)
//   order_confirmed         -> customer, when the order is CREATED (W12 US-005)
//   order_invoiced          -> customer, when staff confirm + attach a Xero ref (W12 US-005)
//   payment_received        -> customer, when staff mark the order paid (US-014)
//   shipped                 -> customer, when staff ship the order (US-014)

const BRAND = 'Atelier Textiles'

// pg money is stored in integer cents; render as NZ dollars for humans.
const formatCents = (cents) => {
  const amount = Number(cents ?? 0) / 100
  return `$${amount.toFixed(2)} NZD`
}

const TEMPLATES = Object.freeze({
  request_received: ({ order_number }) => ({
    subject: `${BRAND}: we've received your request ${order_number}`,
    text: [
      `Thank you for your request (reference ${order_number}).`,
      '',
      'Our team will verify stock, cutting, and batch shading, then be in touch',
      'within 24 hours to confirm details and pricing.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  sample_request_received: ({ request_number, lines_text }) => ({
    subject: `${BRAND}: we've received your sample request ${request_number}`,
    text: [
      `Thank you for your sample request (reference ${request_number}).`,
      '',
      'You asked for:',
      lines_text ?? '',
      '',
      'We will confirm what is available and send your cuttings out shortly.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  backoffice_new_sample_request: ({ request_number, customer_email, lines_text }) => ({
    subject: `New sample request: ${request_number}`,
    text: [
      'A new sample request has come in from the website.',
      '',
      `Reference: ${request_number}`,
      `Customer: ${customer_email ?? 'unknown'}`,
      '',
      lines_text ?? '',
      '',
      'Review it under Samples → Sample requests in the back office.',
    ].join('\n'),
  }),

  backoffice_new_request: ({ order_number, kind, customer_email }) => ({
    subject: `New ${kind} to verify: ${order_number}`,
    text: [
      `A new ${kind} has been placed and needs back-office verification.`,
      '',
      `Reference: ${order_number}`,
      `Customer: ${customer_email ?? 'unknown'}`,
      '',
      'Review it in the back-office order queue.',
    ].join('\n'),
  }),

  checkout_receipt: ({ order_number, total_cents }) => ({
    subject: `${BRAND}: receipt for order ${order_number}`,
    text: [
      `Thank you for your purchase (order ${order_number}).`,
      '',
      `Amount paid: ${formatCents(total_cents)}`,
      '',
      'Your order is confirmed and will be dispatched shortly.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // Sent when the order is CREATED (FR-120), not when staff later confirm it —
  // the client is told their order exists at the moment it does. A freshly
  // created order carries no invoice reference, so the second branch is the one
  // that renders on that path; the first is kept because nothing stops a caller
  // creating an order that already has a ref.
  order_confirmed: ({ order_number, xero_invoice_ref }) => ({
    subject: `${BRAND}: order ${order_number} confirmed`,
    text: [
      `Your order ${order_number} has been confirmed.`,
      '',
      xero_invoice_ref
        ? `Invoice reference: ${xero_invoice_ref}`
        : 'An invoice will follow shortly.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // The back-office `confirm` transition: stock and cutting have been checked
  // and the invoice has been raised in Xero. A message of its OWN (FR-121) —
  // reusing order_confirmed here would send the client the same mail twice and
  // tell them nothing new the second time.
  order_invoiced: ({ order_number, xero_invoice_ref }) => ({
    subject: `${BRAND}: invoice for order ${order_number}`,
    text: [
      `We've checked stock and cutting for order ${order_number} and raised your invoice.`,
      '',
      xero_invoice_ref
        ? `Invoice reference: ${xero_invoice_ref}`
        : 'The invoice will follow shortly.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  payment_received: ({ order_number }) => ({
    subject: `${BRAND}: payment received for order ${order_number}`,
    text: [
      `We've received payment for order ${order_number}. Thank you.`,
      '',
      'Your order is now being prepared for dispatch.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // `tracking_url` is OPTIONAL: the office hand-delivers orders too, and a
  // letter reading "Track your parcel:" with nothing after it is worse than one
  // that never mentions tracking. The spread is what keeps the blank line out on
  // that path. Rendered against the template store's placeholder Proxy
  // (src/email/template-store.js) every field reads truthy, so the CRM's Letters
  // editor opens on the version WITH the line and `{{ tracking_url }}` in it.
  shipped: ({ order_number, tracking_url }) => ({
    subject: `${BRAND}: order ${order_number} has shipped`,
    text: [
      `Good news — order ${order_number} has shipped.`,
      '',
      ...(tracking_url ? [`Track your parcel: ${tracking_url}`, ''] : []),
      'Thank you for choosing us.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // The SET LETTER behind an overdue-sample reminder (W20-US-007). The client
  // asked for "a set letter, but the option to edit it", and this is the set
  // one: `email_templates` overrides it without a deploy
  // (src/email/template-store.js) and a staffer may rewrite any single send
  // before it goes (src/samples/sample-reminders.js). Nothing sends it on a
  // schedule — there is no scheduler, deliberately.
  //
  // Every field arrives pre-formatted: a template does no I/O and no date
  // arithmetic, so `due_back_at` is already a human date and `days_overdue`
  // already a number the caller derived. "Very politely", in her words — the
  // letter never accuses, because plenty of these are Atelier's own oversight.
  sample_loan_reminder: ({ holder_name, barcode, label, due_back_at, days_overdue }) => ({
    subject: `${BRAND}: a gentle reminder about sample ${barcode}`,
    text: [
      `Hello${holder_name ? ` ${holder_name}` : ''},`,
      '',
      `Our records show you still have a sample from us:`,
      '',
      `  ${label || 'Sample'} (${barcode})`,
      due_back_at ? `  Due back: ${due_back_at}` : '  No return date was agreed.',
      days_overdue ? `  ${days_overdue} day(s) past the agreed date.` : '',
      '',
      'When you have finished with it, could we please arrange its return? If it',
      'is already on its way back to us, thank you — please ignore this note.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // The acceptance letter (the office's "New account application acceptance
  // letter 2026"), sent ONCE, automatically, when a trade application is
  // approved — `PATCH /admin/users/:id { trade_approved: true }` flipping the
  // flag from false (src/routes/admin-users.js -> notifyTradeApproved). Store-
  // backed like sample_loan_reminder, so showroom hours change in the CRM
  // Letters screen rather than in a deploy. `name` arrives already resolved by
  // the caller (the login's name, else the form's signatory).
  trade_application_approved: ({ name }) => ({
    subject: `${BRAND}: your trade account has been approved`,
    text: [
      `Dear ${name},`,
      '',
      'Welcome to Atelier Textiles! We are delighted to confirm your application for a',
      'trading account with us has been approved on a cash account basis, and we look',
      'forward to working with you.',
      '',
      'We warmly welcome you into all of our showrooms;',
      '',
      'Atelier Textiles Auckland Showroom',
      '16 Yorks Street, Parnell, Auckland 1052',
      '+6493733866',
      'Opening hours 830am-5pm',
      '',
      'Atelier Textiles Wellington Showroom',
      'Wellington Design Library',
      '282 Thorndon Quay, Pipitea, Wellington 6011',
      '+6444712800',
      'Opening hours 9am-5pm',
      '',
      'Atelier Textiles Christchurch Showroom',
      '323 Madras Street, Christchurch Central 8013',
      '+6433791561',
      'Opening hours 830am – 5pm',
      '',
      "Samples are available on request, so please do get in touch and we'll always be",
      'happy to help.',
      '',
      "Should you have any questions about our brands or products, please don't hesitate",
      'to call us on 0800 ATELIER or email sales@atelier.co.nz',
      '',
      'We look forward to supporting your design journey.',
      '',
      'The Atelier Team',
    ].join('\n'),
  }),

  // Acknowledgement to whoever submitted the storefront contact form.
  contact_received: ({ name }) => ({
    subject: `${BRAND}: thank you for your enquiry`,
    text: [
      `Hello${name ? ` ${name}` : ''},`,
      '',
      'Thank you for contacting us. A member of our team will respond within',
      'one business day.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // The reset link, for a forgotten password or a back-office reset on the
  // account holder's behalf. The URL is the whole message: the token in it is
  // the only copy anywhere, and the expiry is stated so the reader acts on it.
  password_reset: ({ name, reset_url, expires_minutes }) => ({
    subject: `${BRAND}: reset your password`,
    text: [
      `Hello${name ? ` ${name}` : ''},`,
      '',
      'A password reset was requested for your Atelier Textiles account. Choose',
      'a new password here:',
      '',
      reset_url,
      '',
      `The link works once and expires in ${expires_minutes} minutes. If you did`,
      'not ask for this, you can ignore this email — your password has not',
      'changed.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // Alert to the back office that a new enquiry has landed, with the details
  // inline so staff can triage without opening the inbox.
  backoffice_new_contact: ({ name, email, phone, subject, message }) => ({
    subject: `New enquiry from ${name}${subject ? `: ${subject}` : ''}`,
    text: [
      'A new contact enquiry has been submitted.',
      '',
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone ?? '—'}`,
      `Subject: ${subject ?? '—'}`,
      '',
      'Message:',
      message,
      '',
      'View it in the back-office enquiries inbox.',
    ].join('\n'),
  }),

  // A trade client asked for a copy of one of their own invoices from the
  // account portal. The portal shows invoice HEADERS only — the D365 export
  // carries no lines and FR-8 forbids calling Xero, so there is no PDF to
  // serve and this is the workflow that replaces the missing download button.
  // The invoice was re-resolved through the client's own scoped query before
  // this send, so the number below is one they are entitled to.
  backoffice_invoice_copy_request: ({ invoice_number, invoice_date, company_name, requested_by }) => ({
    subject: `Invoice copy requested: ${invoice_number}`,
    text: [
      'A trade client has requested a copy of one of their invoices.',
      '',
      `Invoice: ${invoice_number}`,
      `Invoice date: ${invoice_date ?? '—'}`,
      `Account: ${company_name ?? '—'}`,
      `Requested by: ${requested_by}`,
      '',
      'Send them the copy from Xero.',
    ].join('\n'),
  }),

  // The client's acknowledgement for the same request, so the button visibly
  // does something rather than silently posting.
  invoice_copy_requested: ({ invoice_number }) => ({
    subject: `${BRAND}: we've received your request for invoice ${invoice_number}`,
    text: [
      `We have passed your request for a copy of invoice ${invoice_number} to our accounts team.`,
      '',
      'They will email the copy to you shortly.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // Alert to the back office that a trade application is waiting for review
  // (POST /auth/trade-application -> notifyTradeApplicationReceived). Enough
  // of the form to triage from the inbox; the full form is in the CRM's
  // Applicants tab, which `review_url` points at. The applicant gets no mail
  // here — the acceptance letter (trade_application_approved) is the ONE
  // notification, sent on approval.
  backoffice_new_trade_application: ({
    business_name,
    business_type,
    signatory_name,
    email,
    review_url,
  }) => ({
    subject: `New trade application to review: ${business_name}`,
    text: [
      'A new trade account application has been submitted and is awaiting review.',
      '',
      `Business: ${business_name}`,
      `Type: ${business_type ?? '—'}`,
      `Signatory: ${signatory_name ?? '—'}`,
      `Login email: ${email}`,
      '',
      `Review it in the CRM: ${review_url}`,
    ].join('\n'),
  }),

  // ---------------------------------------------------------------------------
  // Purchasing and reserves — the letters that leave the building (W13/W24).
  //
  // THESE ARE THE FIRST TEMPLATES ADDRESSED TO SOMEONE WHO IS NOT A CLIENT OR
  // THE OFFICE. Everything above goes to a person who asked Atelier for
  // something; a purchase order goes to a fabric house and a reserve request
  // asks a mill to hold stock, which is Atelier asking THEM. Two consequences
  // worth keeping in mind before editing:
  //   - the reader is a trade counterparty, so the register is businesslike and
  //     the reference numbers come first — they file by them;
  //   - there is no unsubscribe and no marketing content, ever. These are
  //     transactional letters about a live commercial document.
  //
  // Every list (`lines_text`) arrives PRE-FORMATTED from the notifier, the
  // `sample_request_received` precedent: a template does no arithmetic and no
  // currency formatting for a supplier, because a stored override cannot do
  // either and the two copies would drift.
  // ---------------------------------------------------------------------------

  // The purchase order itself, on `POST /admin/purchase-orders/:id/send`. The
  // house's own reference (`supplier_code`) is inside `lines_text` where it
  // exists: the number THEY quote back is the one they can act on.
  purchase_order_sent: ({
    po_number,
    supplier_name,
    incoterm,
    currency,
    expected_at,
    lines_text,
    total_text,
    notes,
  }) => ({
    subject: `Purchase order ${po_number} — ${BRAND}`,
    text: [
      `Dear ${supplier_name},`,
      '',
      `Please find our purchase order ${po_number} below.`,
      '',
      lines_text ?? '',
      '',
      ...(total_text ? [`Order total: ${total_text}`, ''] : []),
      ...(currency ? [`Currency: ${currency}`] : []),
      ...(incoterm ? [`Incoterm: ${incoterm}`] : []),
      ...(expected_at ? [`Required by: ${expected_at}`] : []),
      '',
      ...(notes ? ['Notes:', notes, ''] : []),
      `Please confirm receipt of this order, along with your expected`,
      `dispatch date. Quote ${po_number} on your invoice and packing list.`,
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // `close` is Atelier deciding it is finished with the order, INCLUDING short
  // — which is exactly why the house is told rather than left to wonder about
  // the balance. It never says "complete": a purchase order closed short is a
  // decision, not a delivery (src/purchasing/po-states.js).
  purchase_order_closed: ({ po_number, supplier_name, outstanding_text }) => ({
    subject: `Purchase order ${po_number} closed — ${BRAND}`,
    text: [
      `Dear ${supplier_name},`,
      '',
      `We are closing our purchase order ${po_number}.`,
      '',
      ...(outstanding_text
        ? [
            'Any balance still outstanding on this order is no longer required:',
            outstanding_text,
            '',
          ]
        : []),
      'Please do not ship any further goods against it. If anything is already',
      'in transit, let us know and we will take it up with you directly.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  purchase_order_cancelled: ({ po_number, supplier_name }) => ({
    subject: `Purchase order ${po_number} cancelled — ${BRAND}`,
    text: [
      `Dear ${supplier_name},`,
      '',
      `We are cancelling our purchase order ${po_number} in full.`,
      '',
      'Please do not ship any goods against it. If any part of this order has',
      'already been dispatched, please contact us before invoicing.',
      '',
      'With apologies for the inconvenience.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // The office's copy of what actually went to the house — a record of the
  // letter, not a nudge to do something. It carries `po_email` because the one
  // question asked afterwards is which address it went to.
  backoffice_purchase_order_sent: ({
    po_number,
    supplier_name,
    brand_name,
    po_email,
    line_count,
    qty_ordered,
    expected_at,
  }) => ({
    subject: `Purchase order sent: ${po_number}`,
    text: [
      `Purchase order ${po_number} has been sent to the house.`,
      '',
      `House: ${supplier_name ?? '—'}`,
      `Brand: ${brand_name ?? '—'}`,
      `Sent to: ${po_email ?? 'NO ADDRESS ON FILE — nothing was emailed'}`,
      `Lines: ${line_count}`,
      `Quantity ordered: ${qty_ordered}`,
      `Expected: ${expected_at ?? '—'}`,
      '',
      'Open it under Purchasing in the CRM.',
    ].join('\n'),
  }),

  // Goods booked in. The office alert exists for the DISCREPANCY: an over-receipt
  // is never clamped (src/purchasing/po-states.js), so the one that matters is
  // the line that arrived over or short, and `receipt_state` is what says which.
  backoffice_purchase_order_received: ({
    po_number,
    supplier_name,
    sku,
    product_name,
    qty_text,
    receipt_state,
    order_receipt_state,
    consignment_ref,
  }) => ({
    subject: `Goods received on ${po_number}: ${sku}`,
    text: [
      `A receipt has been booked against purchase order ${po_number}.`,
      '',
      `House: ${supplier_name ?? '—'}`,
      `Line: ${sku} — ${product_name ?? '—'}`,
      `Received: ${qty_text}`,
      `This line: ${receipt_state}`,
      `Whole order: ${order_receipt_state}`,
      `Consignment: ${consignment_ref ?? '—'}`,
      '',
      'Open it under Purchasing in the CRM.',
    ].join('\n'),
  }),

  // A reserve asks the house to HOLD stock it already has for a named client —
  // it is not an order, and the letter must not read like one or a house will
  // ship against it. `reserved_until` is the date the hold is wanted to, which
  // is the whole point of the document.
  supplier_reserve_request: ({ supplier_name, account_name, owner_name, lines_text }) => ({
    subject: `Reserve request — ${BRAND}`,
    text: [
      `Dear ${supplier_name},`,
      '',
      'We would like to place the following on reserve for one of our clients.',
      'This is a request to HOLD the stock — please do not ship against it.',
      '',
      lines_text ?? '',
      '',
      ...(account_name ? [`Our client reference: ${account_name}`, ''] : []),
      'Please confirm the hold with your reserve reference and the date you can',
      'hold it to, and we will come back to you with a firm order.',
      '',
      ...(owner_name ? [`Kind regards,`, owner_name, ''] : []),
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // A cutting is a physical sample the house posts — the CFA conversation the
  // houses still speak (src/reserves/reserve-line-states.js). A separate letter
  // from the reserve one because the ASK is different: send us cloth, versus
  // hold cloth. One letter doing both is how a house sends neither.
  supplier_cutting_request: ({ supplier_name, account_name, owner_name, lines_text }) => ({
    subject: `Cutting request — ${BRAND}`,
    text: [
      `Dear ${supplier_name},`,
      '',
      'Please could you send us cuttings of the following:',
      '',
      lines_text ?? '',
      '',
      ...(account_name ? [`Our client reference: ${account_name}`, ''] : []),
      'Please confirm what you are able to send and when we can expect it.',
      '',
      ...(owner_name ? [`Kind regards,`, owner_name, ''] : []),
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // Cancelling a reserve RELEASES the house's stock — it is the letter that
  // costs them money if it never arrives, because cloth stays held against a
  // client who walked away. Sent per line, since a cancellation is per line.
  supplier_reserve_cancelled: ({
    supplier_name,
    kind_label,
    lines_text,
    reserve_number,
    account_name,
  }) => ({
    subject: `Please release our ${kind_label ?? 'reserve'} — ${BRAND}`,
    text: [
      `Dear ${supplier_name},`,
      '',
      'We no longer need the following and would be grateful if you could',
      'release it back into your stock:',
      '',
      lines_text ?? '',
      '',
      ...(reserve_number ? [`Your reference: ${reserve_number}`] : []),
      ...(account_name ? [`Our client reference: ${account_name}`] : []),
      '',
      'With thanks for holding it for us.',
      '',
      `— ${BRAND}`,
    ].join('\n'),
  }),

  // The office's copy. `supplier_email` is the actionable half: a reserve line's
  // house is FREE TEXT typed on the docket, so it may match no supplier record
  // and no letter can be sent — in which case this alert is the only thing that
  // says the house was never actually asked.
  backoffice_reserve_request: ({
    kind_label,
    supplier_name,
    supplier_email,
    account_name,
    owner_name,
    lines_text,
  }) => ({
    subject: `${kind_label ?? 'Reserve'} request sent: ${supplier_name ?? 'unknown house'}`,
    text: [
      `A ${(kind_label ?? 'reserve').toLowerCase()} request has been raised.`,
      '',
      `House: ${supplier_name ?? '—'}`,
      `Sent to: ${supplier_email ?? 'NO SUPPLIER MATCH — nothing was emailed to the house'}`,
      `Account: ${account_name ?? '—'}`,
      `Raised by: ${owner_name ?? '—'}`,
      '',
      lines_text ?? '',
      '',
      'Open the docket under Reserves in the CRM.',
    ].join('\n'),
  }),
})

export const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES))

/**
 * Render a named template to an email body.
 *
 * @param {string} name  one of TEMPLATE_NAMES
 * @param {object} data  fields the template interpolates
 * @returns {{ subject: string, text: string }}
 */
export const renderTemplate = (name, data = {}) => {
  const template = TEMPLATES[name]
  if (!template) {
    throw new Error(`Unknown email template "${name}".`)
  }
  return template(data)
}
