// The one CSV writer in this API.
//
// It was written for the trade price-list download and lived inside
// `src/pricing/trade-price-lists.js`; the reporting exports need the same
// escaping, and a second copy is how the formula-injection guard below stops
// being applied everywhere. So it is a MOVE, not a rewrite: the guard, the
// RFC 4180 rules and the comments explaining them are unchanged, and
// `test/price-list-exposure.test.js` passes untouched as the proof of that.
//
// A caller owns its own header, its own row order and its own line ending.
// This module owns one cell and one row, which is the whole of the escaping.

// A spreadsheet treats a cell opening with any of these as a FORMULA, so a
// product name a staff member typed as "=cut to order" becomes live code in the
// client's Excel — and =HYPERLINK/=WEBSERVICE can exfiltrate the rest of the
// sheet. Every column below is staff-typed free text via PATCH /admin/products.
// Prefixing with an apostrophe is the standard neutralisation: Excel shows the
// text and evaluates nothing.
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r']

/**
 * One CSV cell: formula-neutralised, then quoted where RFC 4180 requires it.
 *
 * @param {unknown} value  null and undefined become an empty cell
 * @returns {string}
 */
export const csvCell = (value) => {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value)
  const guarded = FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix)) ? `'${text}` : text
  // RFC 4180: quote when the value carries a quote, comma or newline, and double
  // any embedded quote.
  return /["\n\r,]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

/**
 * One CSV row, without its line ending — the caller joins the rows, because the
 * terminator is a property of the file rather than of a row.
 *
 * @param {unknown[]} cells
 * @returns {string}
 */
export const csvRow = (cells) => cells.map(csvCell).join(',')
