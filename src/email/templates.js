// Transactional email templates (US-015, FR-8). Each template is a pure function
// of its data returning { subject, text } — no I/O, no side effects — so they
// unit-test without a transport. The mailer renders one of these and hands the
// result to the transport.
//
// Templates (one per order-lifecycle moment):
//   request_received        -> customer, after an order/backorder request (US-012)
//   backoffice_new_request  -> staff, same moment (a new request needs verifying)
//   checkout_receipt        -> customer, after a paid Stripe checkout (US-011)
//   order_confirmed         -> customer, when staff confirm + attach a Xero ref (US-014)
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
