// The purchase-order PDF, and the statement that asks a house for ONE
// consolidated invoice covering several purchase orders.
//
// 25 SEP 2026: "Supplier invoice page and sections should be removed, ask for
// invoice should be merged with bulk purchase orders … generate statement
// creates a PDF and attaches that PDF and sends it as an email." The statement
// used to be a text letter sent from the supplier-invoice screens
// (`POST /admin/supplier-invoices/statement`); it now lives beside the bulk
// order it is asked alongside — `POST /admin/purchase-orders/statement` — and
// carries the statement as a PDF (src/purchasing/po-pdf.js). The preview the
// CRM shows first is `POST /admin/purchase-orders/pdf`, drawn by the same
// loader and the same renderer, so the preview and the letter cannot disagree
// about which orders are on it or what they cost.
//
// THE PROBLEM IT SOLVES. W13 groups purchase orders by BRAND and one supplier
// sells several houses, so there are always more purchase orders than invoices
// (`supplier-invoices.js` states this at length). The office's side of that is
// a statement: "these orders are with you — please bill them together, quoting
// our numbers".
//
// IT IS A LETTER, NOT A DOCUMENT OF RECORD, and nothing here writes an invoice.
// A supplier invoice is the HOUSE's paper: its number, its date and its total
// are facts only the house can state. What is recorded is that the office
// asked — one entry in `supplier_contact_log`, which is what the supplier
// list's "Last contact" column reads.
//
// EVERY REFUSAL RUNS BEFORE ANYTHING IS SENT, AND THE PREVIEW RUNS THEM TOO:
//   - an unknown purchase order                      → 404 naming it
//   - purchase orders for more than one house        → 422 naming them
//   - a cancelled one                                → 422 naming it
//   - a draft (not yet marked Ready to send)         → 422 naming it
//   - one a supplier invoice already covers          → 409 naming that bill
// A statement that went out missing an order the staffer ticked is worse than
// one that did not go at all, because nothing on screen says so — so it is
// refused WHOLE, never narrowed.
//
// THE LETTER AND ITS PDF CARRY COSTS AND ARE NOT FINANCE-MASKED, for the reason
// `notifyPurchaseOrderSent` already gives: the house quoted those prices. The
// RESPONSE that comes back to the screen carries no money at all. The PREVIEW
// is drawn with the caller's own grant: a login without it reads the
// quantities and is told the prices are withheld.

import { loadInvoiceStateByPurchaseOrderId } from './supplier-invoices.js'
import { listPurchaseOrders } from './admin-purchase-orders.js'
import { documentFilename, documentTotal, nzDate, renderPurchaseOrderPdf } from './po-pdf.js'
import { createContactLogEntry } from '../suppliers/supplier-contacts.js'
import { notifyConsolidatedInvoiceRequest } from '../email/purchasing-notifications.js'
import { uniqueEmails } from '../orders/notify-emails.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * How many purchase orders one PDF or statement may carry — a bulk order's own
 * ceiling (MAX_BULK_SIZE) and the list's page size, so the rows are one read.
 */
export const MAX_DOCUMENT_PURCHASE_ORDERS = 100

const loadSupplier = async (pool, supplierId) => {
  const { rows } = await pool.query(
    `SELECT id, name, po_email, currency FROM suppliers WHERE id = $1`,
    [supplierId]
  )
  return rows[0] ?? null
}

/**
 * The purchase orders a document is drawn from, oldest first (the order they
 * were raised in — the page and the letter read upward, as a bulk order does),
 * with the one supplier they share. Duplicates collapse: a tick list can send
 * one id twice, and a document naming one order twice reads as two.
 *
 * @param {import('pg').Pool} pool
 * @param {number[]} purchaseOrderIds
 * @param {{ finance: boolean }} options
 */
const loadDocumentRows = async (pool, purchaseOrderIds, { finance }) => {
  const ids = [...new Set(purchaseOrderIds)]
  if (ids.length === 0 || ids.length > MAX_DOCUMENT_PURCHASE_ORDERS) {
    throw httpError(
      422,
      `A purchase-order document carries between 1 and ${MAX_DOCUMENT_PURCHASE_ORDERS} purchase orders.`
    )
  }
  const { purchase_orders } = await listPurchaseOrders(pool, {
    ids,
    limit: MAX_DOCUMENT_PURCHASE_ORDERS,
    finance,
  })
  const found = new Set(purchase_orders.map((po) => po.id))
  const missing = ids.find((id) => !found.has(id))
  if (missing !== undefined) {
    throw httpError(404, `Purchase order ${missing} not found.`)
  }
  const purchaseOrders = [...purchase_orders].sort((a, b) => a.id - b.id)
  const suppliers = [...new Set(purchaseOrders.map((po) => po.supplier_id))]
  if (suppliers.length !== 1 || suppliers[0] == null) {
    throw httpError(
      422,
      'A purchase-order document is addressed to ONE supplier — ' +
        purchaseOrders.map((po) => `${po.po_number} is ${po.supplier_name ?? 'unaddressed'}`).join(', ') +
        '.'
    )
  }
  const supplier = await loadSupplier(pool, suppliers[0])
  if (!supplier) {
    throw httpError(404, `Supplier ${suppliers[0]} not found.`)
  }
  return { supplier, purchaseOrders }
}

/**
 * Every reason a statement must not go out (or be previewed as one), checked
 * before anything is sent. Throws the first it finds, naming the purchase
 * order — an id is not something the person on the screen can act on.
 */
const refuseUnstatable = async (pool, purchaseOrders) => {
  for (const po of purchaseOrders) {
    if (po.status === 'cancelled') {
      throw httpError(
        422,
        `${po.po_number} is cancelled — a house will not bill for an order Atelier withdrew.`
      )
    }
    if (po.status === 'draft') {
      throw httpError(
        422,
        `${po.po_number} is still a draft — mark it Ready to send before asking the house to invoice it.`
      )
    }
  }
  const invoiceState = await loadInvoiceStateByPurchaseOrderId(
    pool,
    purchaseOrders.map((po) => po.id),
    false
  )
  for (const po of purchaseOrders) {
    const invoice = invoiceState.get(po.id)
    if (invoice) {
      throw httpError(
        409,
        `${po.po_number} is already covered by invoice ${invoice.invoice_number}. ` +
          'Take it off the statement.'
      )
    }
  }
}

/**
 * Who the documents about these purchase orders go to: each one's PO email (the
 * snapshot, correctable on the order) and its Emails list, each address once —
 * the bulk letter's rule. The supplier record's own PO email stands in only
 * when not one of the orders names anybody.
 *
 * @param {{ po_email?: string|null }} supplier
 * @param {object[]} purchaseOrders
 * @returns {string[]}
 */
export const documentRecipients = (supplier, purchaseOrders) => {
  const named = uniqueEmails(purchaseOrders.flatMap((po) => [po.po_email, ...(po.notify_emails ?? [])]))
  return named.length > 0 ? named : uniqueEmails([supplier?.po_email])
}

/**
 * The PDF for some purchase orders of one supplier: `order` is the purchase
 * order itself (what Send PO and a bulk order attach), `statement` the request
 * for one invoice (what the statement attaches, after its refusals).
 *
 * @param {import('pg').Pool} pool
 * @param {{ purchaseOrderIds: number[], document?: 'order'|'statement', finance?: boolean,
 *           replyTo?: string|null }} input
 * @returns {Promise<{ pdf: Buffer, filename: string, supplier: object, purchaseOrders: object[],
 *                     recipients: string[] }>}
 */
export const buildPurchaseOrderDocument = async (pool, input) => {
  const { purchaseOrderIds, document = 'order', finance = false, replyTo = null } = input
  const { supplier, purchaseOrders } = await loadDocumentRows(pool, purchaseOrderIds, { finance })
  if (document === 'statement') {
    await refuseUnstatable(pool, purchaseOrders)
  }
  const recipients = documentRecipients(supplier, purchaseOrders)
  // A purchase order's supplier name is the snapshot on its paper.
  const supplierName = purchaseOrders[0].supplier_name ?? supplier.name
  const bulkNumbers = [...new Set(purchaseOrders.map((po) => po.bulk_order?.bulk_number ?? null))]
  // Several members of one bulk order, and nothing else, are that bulk order's
  // paper; one purchase order is always its own, whichever bulk it went in.
  const reference =
    document === 'order' && purchaseOrders.length > 1 && bulkNumbers.length === 1 ? bulkNumbers[0] : null
  const issuedAt = new Date()
  const pdf = await renderPurchaseOrderPdf({
    document,
    purchaseOrders,
    supplierName,
    recipients,
    reference,
    replyTo,
    issuedAt,
  })
  return {
    pdf,
    filename: documentFilename({ document, purchaseOrders, reference, supplierName, issuedAt }),
    supplier,
    purchaseOrders,
    recipients,
  }
}

/** One line per order in the letter: ours, the house, when, and what we costed it at. */
const formatStatementLine = (po) => {
  const cost =
    po.total_cost == null
      ? 'not priced'
      : `${Number(po.total_cost).toFixed(2)}${po.currency ? ` ${po.currency}` : ''}`
  const raised = nzDate(po.created_at)
  return `  ${po.po_number} — ${po.brand_name}${raised ? ` — raised ${raised}` : ''} — ${cost}`
}

/**
 * Ask one house for a single invoice covering the purchase orders named, with
 * the statement attached as a PDF.
 *
 * The mailer is REQUIRED and must deliver, unlike on the purchase-order moves.
 * There, the letter hangs off a status change that stands on its own and a null
 * mailer is a no-op; here the letter IS the act, so an unconfigured relay is a
 * 503 that says so rather than a 200 over nothing sent.
 *
 * @param {import('pg').Pool} pool
 * @param {import('../email/mailer.js').Mailer|null} mailer
 * @param {{ purchaseOrderIds: number[], notes?: string|null, user: object }} input
 * @returns {Promise<{ statement: object }>}
 */
export const requestConsolidatedInvoice = async (pool, mailer, input) => {
  const { purchaseOrderIds, notes = null, user } = input

  // The letter always carries prices — the house quoted them.
  const { supplier, purchaseOrders, recipients, pdf, filename } = await buildPurchaseOrderDocument(pool, {
    purchaseOrderIds,
    document: 'statement',
    finance: true,
    replyTo: mailer?.backofficeEmail ?? null,
  })
  const supplierName = purchaseOrders[0].supplier_name ?? supplier.name

  if (recipients.length === 0) {
    throw httpError(
      422,
      `There is no purchase-order address on file for ${supplierName}, so there is nowhere to ` +
        'send the statement. Add one on the supplier record or on the purchase orders.'
    )
  }
  if (!mailer?.delivers) {
    throw httpError(
      503,
      'Email is not configured on this server (SMTP_HOST is unset), so the statement cannot be sent.'
    )
  }

  const { total, currency } = documentTotal(purchaseOrders)
  const { sent, failed } = await notifyConsolidatedInvoiceRequest(mailer, {
    supplier_name: supplierName,
    recipients,
    lines_text: purchaseOrders.map(formatStatementLine).join('\n'),
    purchase_order_count: purchaseOrders.length,
    currency,
    total,
    staff_name: user?.name ?? user?.email ?? null,
    notes,
    attachment: { filename, content: pdf },
  })
  if (sent.length === 0) {
    throw httpError(502, `The statement could not be sent to ${failed.join(', ')}.`)
  }

  // The office asked a house something, which is exactly what the contact log
  // is for — and it is what the supplier list's "Last contact" column reads.
  // `user` is the SESSION, never the body: who chased a house is not something
  // the caller gets to state.
  const contact_log_entry = await createContactLogEntry(
    pool,
    supplier.id,
    {
      method: 'email',
      note: `Sent a statement asking for one invoice covering ${purchaseOrders.length} purchase order${
        purchaseOrders.length === 1 ? '' : 's'
      }: ${purchaseOrders.map((po) => po.po_number).join(', ')}.`,
    },
    user
  )

  return {
    statement: {
      supplier_id: supplier.id,
      supplier_name: supplierName,
      sent,
      failed,
      filename,
      // No money on the way back: this payload is read by whichever staffer
      // pressed the button, and that reader may have no finance grant. How many
      // orders went on the letter is the only figure a screen needs.
      purchase_order_count: purchaseOrders.length,
      purchase_orders: purchaseOrders.map((po) => ({
        id: po.id,
        po_number: po.po_number,
        brand_name: po.brand_name,
        status: po.status,
      })),
      contact_log_entry,
    },
  }
}
