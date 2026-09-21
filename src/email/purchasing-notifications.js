// Purchase-order notifications — the letters the buying desk sends OUT (W13).
//
// These are the first notifications addressed to a counterparty rather than a
// client, and the difference sets every rule in this file:
//
//   - **The house is told what a PERSON did, never what arithmetic says.** The
//     letters hang off `send`, `close` and `cancel` — the three moves in
//     `src/purchasing/po-states.js` — and off a booked receipt. The DERIVED
//     receipt state (`none|part|full|over`) mails nobody outside the office: it
//     changes whenever a receipt is keyed, and a house that got "your order is
//     now part-received" every time a roll was scanned would filter us.
//
//   - **A draft sends nothing.** `draft` is the state a purchase order is
//     created in and nothing has left the building yet; the person looking at
//     the screen typed it. The FIRST letter is `send`, which is exactly what
//     that button means.
//
//   - **No address is not an error.** `po_email` is a snapshot taken at create
//     and it is nullable, so a house with nothing on file simply cannot be
//     emailed. The move still succeeds — refusing to mark a purchase order sent
//     because the office phones that house instead would make the status lie —
//     and the back-office copy says the letter went nowhere, which is the only
//     place that fact can usefully appear.
//
// Every helper here is a no-op when `mailer` is null and NEVER throws: a
// purchase order that moved must not un-move because a relay was down.
// `mailer.send` already swallows delivery failures; the guards below cover the
// rest (a missing address, an empty order).

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
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {object} purchaseOrder  the finance view of the order, lines included
 */
export const notifyPurchaseOrderSent = async (mailer, purchaseOrder) => {
  if (!mailer || !purchaseOrder) {
    return noop
  }
  if (purchaseOrder.po_email) {
    await mailer.send({
      template: 'purchase_order_sent',
      to: purchaseOrder.po_email,
      data: {
        po_number: purchaseOrder.po_number,
        supplier_name: purchaseOrder.supplier_name ?? 'Sir or Madam',
        incoterm: purchaseOrder.incoterm,
        currency: purchaseOrder.currency,
        expected_at: purchaseOrder.expected_at,
        lines_text: formatSupplierLines(purchaseOrder),
        total_text: money(purchaseOrder.total_cost, purchaseOrder.currency),
        notes: purchaseOrder.notes,
      },
    })
  }
  await sendBackofficeCopy(mailer, purchaseOrder)
  return { ok: true }
}

/**
 * `close` and `cancel` — both tell the house to stop, and they are NOT the same
 * letter. `close` may be short by agreement and leaves delivered goods bought;
 * `cancel` withdraws the order whole and releases every allocation
 * (src/purchasing/admin-purchase-orders.js). A house that cannot tell which one
 * it received will ship against the wrong one.
 *
 * No back-office copy on either: unlike `send`, nothing here is at risk of
 * having silently gone nowhere that the order's own status does not already
 * record.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {object} purchaseOrder
 * @param {'closed'|'cancelled'} status
 */
export const notifyPurchaseOrderEnded = async (mailer, purchaseOrder, status) => {
  const template =
    status === 'closed'
      ? 'purchase_order_closed'
      : status === 'cancelled'
        ? 'purchase_order_cancelled'
        : null
  if (!mailer || !purchaseOrder || !template || !purchaseOrder.po_email) {
    return noop
  }
  await mailer.send({
    template,
    to: purchaseOrder.po_email,
    data: {
      po_number: purchaseOrder.po_number,
      supplier_name: purchaseOrder.supplier_name ?? 'Sir or Madam',
      ...(status === 'closed' ? { outstanding_text: formatOutstanding(purchaseOrder) } : {}),
    },
  })
  return { ok: true }
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
 * `POST /admin/supplier-invoices/statement` — the office asking a house for ONE
 * invoice covering several purchase orders, plus the office's copy.
 *
 * Unlike the moves above, THE LETTER IS THE ACT. There is no status change
 * standing on its own behind it, so this helper does not quietly no-op: the
 * caller (src/purchasing/invoice-statements.js) refuses a missing address with
 * a 422 and an unconfigured mailer with a 503 before anything reaches here, and
 * the guard below is the last line rather than the policy.
 *
 * The costs go to the house unmasked, for the reason `notifyPurchaseOrderSent`
 * gives: the house quoted them.
 *
 * @param {import('./mailer.js').Mailer|null} mailer
 * @param {{ supplier_name: string, po_email: string|null, lines_text: string,
 *           purchase_order_count: number, currency: string|null,
 *           total: number|null, staff_name?: string|null, notes?: string|null }} statement
 */
export const notifyConsolidatedInvoiceRequest = async (mailer, statement) => {
  if (!mailer || !statement?.po_email) {
    return noop
  }
  const total_text = money(statement.total, statement.currency)
  await mailer.send({
    template: 'supplier_invoice_request',
    to: statement.po_email,
    data: {
      supplier_name: statement.supplier_name ?? 'Sir or Madam',
      lines_text: statement.lines_text,
      purchase_order_count: statement.purchase_order_count,
      total_text,
      // Where the bill should come back to. The one configured office address,
      // so a house replying to the letter reaches the desk that keys it.
      reply_to: mailer.backofficeEmail,
      notes: statement.notes ?? null,
    },
  })
  await mailer.send({
    template: 'backoffice_supplier_invoice_request',
    to: mailer.backofficeEmail,
    data: {
      supplier_name: statement.supplier_name,
      po_email: statement.po_email,
      purchase_order_count: statement.purchase_order_count,
      lines_text: statement.lines_text,
      total_text,
      staff_name: statement.staff_name ?? null,
    },
  })
  return { ok: true }
}
