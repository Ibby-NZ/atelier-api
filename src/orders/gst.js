// GST on a sales order, derived — never stored — from the order's total and the
// same `XERO_LINE_AMOUNT_TYPES` setting that decides how the invoice is pushed
// to Xero (src/config.js). The order record holds no tax column: every price in
// the catalogue is a GST-EXCLUSIVE trade figure by convention and the invoice
// adds the tax, so storing a second copy of what is a function of the total
// would only let the two drift. One function, one rate, and the CRM prints
// whatever this returns (Userback 8367857).
//
// `basis` is the Xero LineAmountTypes value:
//   Exclusive — totals are ex-GST; GST is added on top.
//   Inclusive — totals already include GST; the GST share is 3/23 of the total.
//   NoTax     — no GST (an export sale); the figure is zero.
// Anything else is a configuration error and throws at the first order read,
// not silently as a wrong figure on an invoice.

export const GST_RATE = 0.15

const BASES = Object.freeze({
  Exclusive: (total) => Math.round(total * GST_RATE),
  Inclusive: (total) => Math.round((total * GST_RATE) / (1 + GST_RATE)),
  NoTax: () => 0,
})

/**
 * @param {number|string|null} totalCents — `orders.total_cents` (pg numeric string is fine)
 * @param {'Exclusive'|'Inclusive'|'NoTax'} basis
 * @returns {{ basis: string, rate: number, gst_cents: number, total_incl_gst_cents: number }}
 */
export const gstFigures = (totalCents, basis) => {
  const gstOf = BASES[basis]
  if (!gstOf) {
    throw new Error(`gstFigures: unknown basis ${JSON.stringify(basis)}`)
  }
  const total = Number(totalCents) || 0
  const gst = gstOf(total)
  return Object.freeze({
    basis,
    rate: GST_RATE,
    gst_cents: gst,
    total_incl_gst_cents: basis === 'Inclusive' ? total : total + gst,
  })
}

/** The order shape the admin routes answer with, plus its `gst` block. */
export const withGst = (order, basis) =>
  order && typeof order === 'object' && 'total_cents' in order
    ? { ...order, gst: gstFigures(order.total_cents, basis) }
    : order
