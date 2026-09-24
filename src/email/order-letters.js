// Letters the office sends about a sales order ON DEMAND, from the CRM order
// page's Emails panel (24 Sep 2026: "send order details to the customer or
// resend the order notification"). No status change behind either: the
// office presses a button, so — unlike the notify* triggers — the caller wants
// to know who it reached, and the route refuses up front when nothing can be
// delivered (503) rather than claim a send that went nowhere.
//
// Both go to exactly the people a status letter goes to — client, rep, the
// order's Emails list and the standing copy — through orderLetterRecipients,
// so the panel that lists those people is also the list of who a button mails.

import { orderLetterRecipients, statusLetterData, TRANSITION_TEMPLATES } from './notifications.js'

/** What the route's `letter` may be: the whole order, or where it stands now. */
export const ORDER_LETTERS = Object.freeze(['details', 'status'])

/**
 * The letter that says where an order stands NOW — what "Resend" sends. A
 * status an order MOVED to has its transition letter; `quote_requested` is the
 * status an order is created in, so its letter is the creation one: the
 * office's own sales order was confirmed to the client at creation, a
 * storefront request was acknowledged. Null for a status with no letter of its
 * own (the client's quote answer, the office's bookkeeping moves) — there is
 * nothing to re-send, and the route says so.
 *
 * @param {{ status: string, kind: string }} order
 * @returns {string|null}
 */
export const currentStatusTemplate = (order) =>
  order.status === 'quote_requested'
    ? order.kind === 'manual'
      ? 'order_confirmed'
      : 'request_received'
    : (TRANSITION_TEMPLATES[order.status] ?? null)

// $297.00 — the currency is named once, on the grand total.
const money = (cents) => `$${(Number(cents ?? 0) / 100).toFixed(2)}`

/**
 * One block per line: what it is, then quantity × price, then the cut note
 * where there is one.
 *
 * @param {Array<{ sku: string, product_name?: string|null, colourway_name?: string|null, qty: number|string, unit?: string|null, unit_price_cents: number|string, cut_requirements?: string|null }>} lines
 * @returns {string}
 */
export const orderLinesText = (lines = []) =>
  lines
    .map((line) => {
      const name = [line.product_name, line.colourway_name].filter(Boolean).join(' — ')
      const qty = Number(line.qty)
      const amount = Math.round(qty * Number(line.unit_price_cents))
      return [
        `- ${name || line.sku} (${line.sku})`,
        `    ${[qty, line.unit].filter(Boolean).join(' ')} at ${money(line.unit_price_cents)} = ${money(amount)}`,
        ...(line.cut_requirements ? [`    Cut: ${line.cut_requirements}`] : []),
      ].join('\n')
    })
    .join('\n')

/**
 * Subtotal down to the total the invoice will state, on the order's own GST
 * basis (the `gst` block the admin routes attach — src/orders/gst.js). The
 * discount is shown as the difference the stored total already carries, never
 * recomputed here, so the letter cannot disagree with the order.
 *
 * @param {{ subtotal_cents: number|string, shipping_cents: number|string, total_cents: number|string, discount_pct?: number|string|null, gst?: { basis: string, rate: number, gst_cents: number, total_incl_gst_cents: number } }} order
 * @returns {string}
 */
export const orderTotalsText = (order) => {
  const subtotal = Number(order.subtotal_cents ?? 0)
  const shipping = Number(order.shipping_cents ?? 0)
  const total = Number(order.total_cents ?? 0)
  const pct = Number(order.discount_pct ?? 0)
  const gst = order.gst ?? { basis: 'NoTax' }
  const rate = `GST (${Math.round(gst.rate * 100)}%)`
  return [
    `Subtotal: ${money(subtotal)}`,
    ...(pct > 0 ? [`Discount (${pct}%): -${money(subtotal + shipping - total)}`] : []),
    ...(shipping > 0 ? [`Freight: ${money(shipping)}`] : []),
    ...(gst.basis === 'Exclusive'
      ? [
          `Total excl. GST: ${money(total)}`,
          `${rate}: ${money(gst.gst_cents)}`,
          `Total incl. GST: ${money(gst.total_incl_gst_cents)} NZD`,
        ]
      : gst.basis === 'Inclusive'
        ? [`Total incl. GST: ${money(total)} NZD`, `${rate} included: ${money(gst.gst_cents)}`]
        : [`Total: ${money(total)} NZD`]),
  ].join('\n')
}

/**
 * The delivery block, one line per filled field; null when the order has no
 * address (collected, or not yet known) so the template drops the heading.
 *
 * @param {object|null} address `orders.shipping_address`
 * @returns {string|null}
 */
export const deliveryText = (address) => {
  if (!address) return null
  const lines = [
    address.name,
    address.line1,
    address.line2,
    [address.city, address.state, address.postal_code].filter(Boolean).join(' '),
    address.country,
    address.phone ? `Phone: ${address.phone}` : null,
    address.instructions,
  ].filter(Boolean)
  return lines.length ? lines.join('\n') : null
}

/**
 * The `order_details` letter's fields, every one pre-formatted.
 *
 * @param {object} order the admin order shape, with its `gst` block
 */
export const orderDetailsData = (order) => ({
  order_number: order.order_number,
  client_reference: order.client_reference ?? null,
  customer_po_number: order.customer_po_number ?? null,
  lines_text: orderLinesText(order.lines ?? []),
  totals_text: orderTotalsText(order),
  delivery_text: deliveryText(order.shipping_address),
})

/**
 * Send one on-demand letter about an order to everyone it names. Never throws
 * (mailer.send does not); resolves to who it reached and who it did not, so
 * the CRM can say so in words.
 *
 * @param {import('./mailer.js').Mailer} mailer
 * @param {{ query: Function }} db
 * @param {object} order the admin order shape (with `gst` for 'details')
 * @param {'details'|'status'} letter
 * @param {{ quote_url?: string|null }} [extra] spread into a status letter's
 *   data — the `quote_url` a re-sent quote carries (notifyOrderTransition's rule)
 * @returns {Promise<{ template: string, sent: string[], failed: string[] }>}
 */
export const sendOrderLetter = async (mailer, db, order, letter, extra = {}) => {
  const template = letter === 'details' ? 'order_details' : currentStatusTemplate(order)
  const data =
    letter === 'details' ? orderDetailsData(order) : { ...statusLetterData(order), ...extra }
  const sent = []
  const failed = []
  // In turn, not in parallel — the notifyOrderTransition rule.
  for (const to of await orderLetterRecipients(mailer, db, order)) {
    const { ok } = await mailer.send({ template, to, data })
    ;(ok ? sent : failed).push(to)
  }
  return { template, sent, failed }
}
