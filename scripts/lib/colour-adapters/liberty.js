/**
 * Liberty — one house, one layout, TWO sheets that overlap without either
 * containing the other.
 *
 * "Sheet1 (2)" holds 558 rows and "Sheet1" 721, and 54 codes appear only in the
 * first while 217 appear only in the second — so reading whichever looks like
 * the main one silently drops between 50 and 200 colourways. Both are declared
 * and the overlap is reconciled downstream, where a duplicate is visible.
 *
 * The two differ only in what they call the price column ("PRICE £ EX VAT" vs
 * "DISTRIBUTOR PRICE") and in "Sheet1" carrying an extra `TYPE` column; the
 * four columns a colourway needs are spelt identically in both, so one column
 * map serves them. Each sheet also repeats its header once, mid-sheet — the
 * shared reader recognises that.
 */

const COLUMNS = Object.freeze({
  design: 'Fabric Name',
  colourName: 'Colour',
  colourCode: 'Code',
})

const sheet = (name) => Object.freeze({ name, brand: 'Liberty London', columns: COLUMNS })

export const LIBERTY = Object.freeze({
  prefix: 'Liberty',
  supplier: 'Liberty',
  // The house is "Liberty London" in the catalogue; "Liberty" is the supplier
  // the price list files it under.
  sheets: Object.freeze([sheet('Sheet1 (2)'), sheet('Sheet1')]),
})
