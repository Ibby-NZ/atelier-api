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

  shipped: ({ order_number }) => ({
    subject: `${BRAND}: order ${order_number} has shipped`,
    text: [
      `Good news — order ${order_number} has shipped.`,
      '',
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
