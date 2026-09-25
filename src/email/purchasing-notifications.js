// Purchase-order notifications — the letters the buying desk sends OUT (W13).
//
// These are the first notifications addressed to a counterparty rather than a
// client, and the difference sets every rule in this file:
//
//   - **The house is told what a PERSON did, never what arithmetic says.** The
//     letters hang off Send PO (`pending_payment`), `paid`, `cancelled` and a
//     `completed` that is SHORT — moves in `src/purchasing/po-states.js`
//     (24 Sep 2026) — and a Bulk order sends ONE letter for several purchase
//     orders. A booked receipt alerts the office only. The DERIVED
//     receipt state (`none|part|full|over`) mails nobody outside the office: it
//     changes whenever a receipt is keyed, and a house that got "your order is
//     now part-received" every time a roll was scanned would filter us.
//
//   - **A draft sends nothing, and nor does Ready to send.** `draft` is the
//     state a purchase order is created in and `ready_to_send` (25 Sep 2026)
//     only says it is finished; nothing has left the building in either. The
//     FIRST letter is `send`, which is exactly what that button means.
//
//   - **No address is not an error.** `po_email` is a snapshot taken at create
//     and it is nullable, so a house with nothing on file simply cannot be
//     emailed. The move still succeeds — refusing to mark a purchase order sent
//     because the office phones that house instead would make the status lie —
//     and the back-office copy says the letter went nowhere, which is the only
//     place that fact can usefully appear.
//
// **Every letter to the house also goes to the purchase order's Emails list**
// (`notify_emails`, the sales order's rule) — one letter each, each address
// once. Not the office copy: that stays the one configured address.
//
// Every helper here is a no-op when `mailer` is null and NEVER throws: a
// purchase order that moved must not un-move because a relay was down.
// `mailer.send` already swallows delivery failures; the guards below cover the
// rest (a missing address, an empty order).

import { uniqueEmails } from '../orders/notify-emails.js'

const noop = { ok: false }

/** Two decimals, or null — never `0` for "no price", which would read as free. */
const money = (value, currency) =>
  value === null || value === undefined ? null : `${Number(value).toFixed(2)}${currency ? ` ${currency}` : ''}`

/**
 * One numbered line for the house, richest-first: our SKU, then the cloth, then
 * the quantity and price, then THEIR code where the office has recorded it —
 * the house files by their own reference, so it goes at the end where it reads
 * as the answer to "which of ours is this".
 */
const formatSupplierLine = (line, index, currency) => {
  const label = [line.product_name, line.colourway_name].filter(Boolean).join(' / ')
  const price = money(line.unit_price, null)
  const cost = money(line.line_cost, null)
  return [
    `  ${index + 1}. ${line.sku}${label ? ` — ${label}` : ''}`,
    `     Quantity: ${line.qty_ordered}`,
    price ? `     Unit price: ${price}${currency ? ` ${currency}` : ''}` : null,
    cost ? `     Line total: ${cost}${currency ? ` ${currency}` : ''}` : null,
    line.supplier_code ? `     Your reference: ${line.supplier_code}` : null,
    line.is_sample ? '     (sample / cutting for our library)' : null,
    line.notes ? `     Note: ${line.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

const formatSupplierLines = (purchaseOrder) =>
  (purchaseOrder.lines ?? [])
    .map((line, index) => formatSupplierLine(line, index, purchaseOrder.currency))
    .join('\n')

// The house and the purchase order's Emails list, each address once. The house
// may have no address on file (a snapshot, nullable): the list still hears.
const houseRecipients = (purchaseOrder) =>
  uniqueEmails([purchaseOrder.po_email, ...(purchaseOrder.notify_emails ?? [])])

// One letter to each of them, in turn; resolves to who it reached. The same
// attachments ride on every copy (the purchase-order PDF, 25 Sep 2026).
const sendToHouse = async (mailer, recipients, template, data, attachments = []) => {
  const sent = []
  const failed = []
  for (const to of recipients) {
    const { ok } = await mailer.send({ template, to, data, attachments })
    ;(ok ? sent : failed).push(to)
  }
  return { ok: sent.length > 0, template, sent, failed }
}

/**
 * A PDF as the mailer attaches it. Null in, nothing out, so a letter whose PDF
 * could not be drawn still goes (the route never lets a render failure stop a
 * move).
 *
 * @param {{ filename: string, content: Buffer }|null} file
 */
export const pdfAttachments = (file) =>
  file?.content ? [{ filename: file.filename, content: file.content, contentType: 'application/pdf' }] : []

/** The purchase order itself, as the house receives it — Send PO's letter. */
export const purchaseOrderLetterData = (purchaseOrder, attachments = []) => ({
  po_number: purchaseOrder.po_number,
  supplier_name: purchaseOrder.supplier_name ?? 'Sir or Madam',
  incoterm: purchaseOrder.incoterm,
  currency: purchaseOrder.currency,
  expected_at: purchaseOrder.expected_at,
  lines_text: formatSupplierLines(purchaseOrder),
  total_text: money(purchaseOrder.total_cost, purchaseOrder.currency),
  notes: purchaseOrder.notes,
  attachment_name: attachments[0]?.filename ?? null,
})

/**
 * The lines still owed at the moment the order is closed — the balance the
 * house is being told to stop working on. Empty string when nothing is
 * outstanding, so the template can leave the paragraph out entirely rather than
 * print a heading over nothing.
 */
const formatOutstanding = (purchaseOrder) =>
  (purchaseOrder.lines ?? [])
    .filter((line) => line.qty_outstanding > 0)
    .map((line) => `  ${line.sku}: ${line.qty_outstanding} outstanding of ${line.qty_ordered}`)
    .join('\n')

/**
 * The office's copy of a purchase order that has just gone to a house.
 *
 * It is a RECORD, not a nudge: the person who pressed Send is looking at the
 * screen. Its value is the audit line — which address the letter actually went
 * to — and it is the only place a missing `po_email` is visible.
 */
const sendBackofficeCopy = (mailer, purchaseOrder) =>
  mailer.send({
    template: 'backoffice_purchase_order_sent',
    to: mailer.backofficeEmail,
    data: {
      po_number: purchaseOrder.po_number,
      supplier_name: purchaseOrder.supplier_name,
      brand_name: purchaseOrder.brand_name,
      po_email: purchaseOrder.po_email,
      line_count: purchaseOrder.line_count,
      qty_ordered: purchaseOrder.qty_ordered,
      expected_at: purchaseOrder.expected_at,
    },
  })

/**
 * `POST /admin/purchase-orders/:id/send` — the purchase order itself to the
 * house, plus the office's copy.
 *
 * **The caller must pass the FINANCE view** (`getPurchaseOrder(…, { finance:
 * true })`). A purchase order without prices is not a purchase order, and the
 * house set those prices in the first place — masking them from the party that
 * quoted them protects nobody. Finance masking exists so a staffer without cost
 * access does not READ costs on screen; this letter is composed by the server
 * and addressed to the house and the one configured back-office address, so it
 * is never shown to the staffer who triggered it.
 *
 * The purchase order's PDF (src/purchasing/po-pdf.js — the document the CRM
 * previewed before Send) rides on the letter as `attachments`, when the route
 * could draw it.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {object} purchaseOrder  the finance view of the order, lines included
 * @param {{ attachments?: object[] }} [options]
 */
export const notifyPurchaseOrderSent = async (mailer, purchaseOrder, { attachments = [] } = {}) => {
  if (!mailer || !purchaseOrder) {
    return noop
  }
  await sendToHouse(
    mailer,
    houseRecipients(purchaseOrder),
    'purchase_order_sent',
    purchaseOrderLetterData(purchaseOrder, attachments),
    attachments
  )
  await sendBackofficeCopy(mailer, purchaseOrder)
  return { ok: true }
}

/**
 * The house has been paid (24 Sep 2026) — so it can release the goods. To the
 * house and the Emails list; the office pressed the button (or Xero's bill
 * sync did, which does not come through here).
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {object} purchaseOrder
 */
export const notifyPurchaseOrderPaid = async (mailer, purchaseOrder) => {
  if (!mailer || !purchaseOrder) {
    return noop
  }
  return sendToHouse(mailer, houseRecipients(purchaseOrder), 'purchase_order_paid', {
    po_number: purchaseOrder.po_number,
    supplier_name: purchaseOrder.supplier_name ?? 'Sir or Madam',
    total_text: money(purchaseOrder.total_cost, purchaseOrder.currency),
  })
}

/**
 * ONE letter to a house covering several purchase orders — the Bulk orders
 * tab's Send (24 Sep 2026). Every line of every purchase order, under its own
 * PO number so the house can ship and invoice against each, to the house, to
 * every member's Emails list, and a copy to the office (the same letter: the
 * record of what went).
 *
 * The bulk order's PDF — every member under its own PO number, the document
 * the CRM previewed — rides on the letter as `attachments`.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ bulk_number: string }} bulk
 * @param {object[]} purchaseOrders the finance view of each member
 * @param {{ attachments?: object[] }} [options]
 */
export const notifyBulkOrderSent = async (mailer, bulk, purchaseOrders, { attachments = [] } = {}) => {
  if (!mailer || !bulk || purchaseOrders.length === 0) {
    return noop
  }
  const [first] = purchaseOrders
  const data = {
    bulk_number: bulk.bulk_number,
    supplier_name: first.supplier_name ?? 'Sir or Madam',
    po_numbers: purchaseOrders.map((po) => po.po_number).join(', '),
    orders_text: purchaseOrders
      .map((po) =>
        [
          `${po.po_number}${po.brand_name ? ` — ${po.brand_name}` : ''}`,
          formatSupplierLines(po),
          po.total_cost == null ? null : `  Total: ${money(po.total_cost, po.currency)}`,
        ]
          .filter(Boolean)
          .join('\n')
      )
      .join('\n\n'),
    incoterm: first.incoterm,
    currency: first.currency,
    attachment_name: attachments[0]?.filename ?? null,
  }
  const recipients = uniqueEmails(
    purchaseOrders.flatMap((po) => [po.po_email, ...(po.notify_emails ?? [])])
  )
  const result = await sendToHouse(mailer, recipients, 'purchase_order_bulk_sent', data, attachments)
  await mailer.send({ template: 'purchase_order_bulk_sent', to: mailer.backofficeEmail, data, attachments })
  return result
}

/**
 * `completed` and `cancelled` — both tell the house to stop, and they are NOT
 * the same letter. `completed` may be short by agreement and leaves delivered
 * goods bought; `cancelled` withdraws the order whole and releases every
 * allocation (src/purchasing/admin-purchase-orders.js). A house that cannot
 * tell which one it received will ship against the wrong one. A completed
 * order with nothing outstanding sends nothing: the house delivered it all,
 * and there is no balance to tell it to stop on.
 *
 * No back-office copy on either: unlike `send`, nothing here is at risk of
 * having silently gone nowhere that the order's own status does not already
 * record.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {object} purchaseOrder
 * @param {'completed'|'cancelled'} status
 */
export const notifyPurchaseOrderEnded = async (mailer, purchaseOrder, status) => {
  const template =
    status === 'completed'
      ? 'purchase_order_closed'
      : status === 'cancelled'
        ? 'purchase_order_cancelled'
        : null
  if (!mailer || !purchaseOrder || !template) {
    return noop
  }
  const outstanding = status === 'completed' ? formatOutstanding(purchaseOrder) : ''
  if (status === 'completed' && outstanding === '') {
    return noop
  }
  return sendToHouse(mailer, houseRecipients(purchaseOrder), template, {
    po_number: purchaseOrder.po_number,
    supplier_name: purchaseOrder.supplier_name ?? 'Sir or Madam',
    ...(status === 'completed' ? { outstanding_text: outstanding } : {}),
  })
}

/**
 * The letter for where a purchase order stands NOW — what the Emails panel's
 * "Resend" sends, and which of the functions above a move to it calls. Null
 * for a status the house hears nothing about.
 *
 * @param {{ status: string }} purchaseOrder
 * @returns {string|null}
 */
export const purchaseOrderStatusTemplate = (purchaseOrder) =>
  ({
    pending_payment: 'purchase_order_sent',
    paid: 'purchase_order_paid',
    completed: 'purchase_order_closed',
    cancelled: 'purchase_order_cancelled',
  })[purchaseOrder.status] ?? null

/**
 * The Emails panel's on-demand letters about a purchase order (24 Sep 2026:
 * "purchase orders should also have email function like sales order"):
 * `details` is the purchase order itself; `status` re-sends the letter for
 * where it stands. To the house and the Emails list. Resolves to who it
 * reached, so the route can say so.
 *
 * The purchase order's own letter (`purchase_order_sent`) carries its PDF, as
 * Send PO's does; `attachments` is ignored on every other letter.
 *
 * @param {import('./mailer.js').Mailer} mailer
 * @param {object} purchaseOrder the finance view, lines included
 * @param {'details'|'status'} letter
 * @param {{ attachments?: object[] }} [options]
 */
export const sendPurchaseOrderLetter = async (mailer, purchaseOrder, letter, { attachments = [] } = {}) => {
  const template = letter === 'details' ? 'purchase_order_sent' : purchaseOrderStatusTemplate(purchaseOrder)
  if (template === 'purchase_order_sent') {
    return sendToHouse(
      mailer,
      houseRecipients(purchaseOrder),
      template,
      purchaseOrderLetterData(purchaseOrder, attachments),
      attachments
    )
  }
  return sendToHouse(mailer, houseRecipients(purchaseOrder), template, {
    po_number: purchaseOrder.po_number,
    supplier_name: purchaseOrder.supplier_name ?? 'Sir or Madam',
    total_text: money(purchaseOrder.total_cost, purchaseOrder.currency),
    outstanding_text: formatOutstanding(purchaseOrder),
  })
}

/**
 * Goods booked in — BACK OFFICE ONLY, deliberately.
 *
 * The house knows what it shipped; what it does not know, and what this alert
 * is for, is the DISCREPANCY. An over-receipt is never clamped, so a line
 * reading `over` is a real conversation to have with the house, and a reversal
 * (a negative `qty`) is how a mis-key is corrected. Mailing the house on every
 * scan would bury both.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {object} purchaseOrder  the order AFTER the receipt, lines included
 * @param {{ purchase_order_line_id: number, qty: number, consignment_ref?: string|null }} receipt
 */
export const notifyPurchaseOrderReceipt = async (mailer, purchaseOrder, receipt) => {
  if (!mailer || !purchaseOrder || !receipt) {
    return noop
  }
  const line = (purchaseOrder.lines ?? []).find(
    (candidate) => candidate.id === receipt.purchase_order_line_id
  )
  await mailer.send({
    template: 'backoffice_purchase_order_received',
    to: mailer.backofficeEmail,
    data: {
      po_number: purchaseOrder.po_number,
      supplier_name: purchaseOrder.supplier_name,
      sku: line?.sku ?? '—',
      product_name: line?.product_name ?? null,
      // Signed on purpose: a reversal is a negative quantity and reads as one.
      qty_text: `${receipt.qty}${line ? ` (line now ${line.qty_received} of ${line.qty_ordered})` : ''}`,
      receipt_state: line?.receipt_state ?? '—',
      order_receipt_state: purchaseOrder.receipt_state ?? '—',
      consignment_ref: receipt.consignment_ref ?? null,
    },
  })
  return { ok: true }
}

/**
 * `POST /admin/purchase-orders/statement` — the office asking a house for ONE
 * invoice covering several purchase orders, with the statement attached as a
 * PDF, plus the office's copy (25 Sep 2026; it was
 * `POST /admin/supplier-invoices/statement`, a text letter).
 *
 * Unlike the moves above, THE LETTER IS THE ACT. There is no status change
 * standing on its own behind it, so this helper does not quietly no-op: the
 * caller (src/purchasing/invoice-statements.js) refuses a missing address with
 * a 422 and an unconfigured mailer with a 503 before anything reaches here, and
 * the guard below is the last line rather than the policy. It resolves to who
 * the letter reached, so the caller can answer 502 when nobody did.
 *
 * The costs go to the house unmasked, for the reason `notifyPurchaseOrderSent`
 * gives: the house quoted them.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ supplier_name: string, recipients: string[], lines_text: string,
 *           purchase_order_count: number, currency: string|null,
 *           total: number|null, staff_name?: string|null, notes?: string|null,
 *           attachment?: { filename: string, content: Buffer }|null }} statement
 * @returns {Promise<{ ok: boolean, sent: string[], failed: string[] }>}
 */
export const notifyConsolidatedInvoiceRequest = async (mailer, statement) => {
  const recipients = uniqueEmails(statement?.recipients ?? [])
  if (!mailer || recipients.length === 0) {
    return { ...noop, sent: [], failed: [] }
  }
  const attachments = pdfAttachments(statement.attachment)
  const total_text = money(statement.total, statement.currency)
  const result = await sendToHouse(
    mailer,
    recipients,
    'supplier_invoice_request',
    {
      supplier_name: statement.supplier_name ?? 'Sir or Madam',
      lines_text: statement.lines_text,
      purchase_order_count: statement.purchase_order_count,
      total_text,
      // Where the bill should come back to. The one configured office address,
      // so a house replying to the letter reaches the desk that keys it.
      reply_to: mailer.backofficeEmail,
      notes: statement.notes ?? null,
      attachment_name: attachments[0]?.filename ?? null,
    },
    attachments
  )
  await mailer.send({
    template: 'backoffice_supplier_invoice_request',
    to: mailer.backofficeEmail,
    attachments,
    data: {
      supplier_name: statement.supplier_name,
      // Every address it went to — the one question asked afterwards.
      po_email: result.sent.length > 0 ? result.sent.join(', ') : null,
      purchase_order_count: statement.purchase_order_count,
      lines_text: statement.lines_text,
      total_text,
      staff_name: statement.staff_name ?? null,
    },
  })
  return { ok: result.ok, sent: result.sent, failed: result.failed }
}
