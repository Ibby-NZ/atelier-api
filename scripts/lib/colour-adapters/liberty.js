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

import { normaliseLabel } from '../colour-sheet.js'
import { skip } from './rates.js'

const COLUMNS = Object.freeze({
  design: 'Fabric Name',
  colourName: 'Colour',
  colourCode: 'Code',
})

const sheet = (name) => Object.freeze({ name, brand: 'Liberty London', columns: COLUMNS })

/**
 * `08322201L` -> `08322201`, the code the price list keys on.
 *
 * Liberty's 184 rows there are eight-digit numbers (`03591103`, `06532101`) and
 * every code in this workbook is those digits plus the colour's letter, so the
 * rate is the design's and the letter is the colourway's.
 */
const DESIGN_NUMBER = /^(\d+)[A-Za-z]*$/

/**
 * Wallpaper is told from fabric by the substrate, not by a type column, because
 * only one of the two sheets HAS a type column. In "Sheet1", which has both,
 * `FABRIC TYPE` reads `NON-WOVEN` on all 151 rows `TYPE` calls `WALLPAPER` and
 * on no other row — so the substrate decides it on "Sheet1 (2)" as well, where
 * `TYPE` is simply absent.
 */
const WALLPAPER_SUBSTRATE = 'non-woven'

const libertyRate = (values) => {
  // Both sheets are SECTIONED. Each section opens with a banner row of hyphens
  // ("OUTDOOR", "WALLPAPER") and then a header row of its own — and the
  // wallpaper section's header is not the sheet's: it renames two columns
  // (`WALLPAPER NAME`, `PAPER TYPE`) and inserts `ROLL DIMENSIONS` after the
  // width, so every cell from there on is shifted by one. That is why this rate
  // declares nothing past the width; the four cells before it are in the same
  // place under both headers, and a composition read at the wrong index would
  // be a repeat measurement filed as a fibre content.
  if (values.code === '-') return skip('section banner')
  if (normaliseLabel(values.code) === normaliseLabel(COLUMNS.colourCode)) {
    return skip("a section's own header row")
  }
  const parts = DESIGN_NUMBER.exec(values.code)
  if (parts === null) throw new Error(`code "${values.code}" is not a Liberty design number`)
  const wallpaper = values.substrate.toLowerCase() === WALLPAPER_SUBSTRATE
  return {
    code: parts[1],
    description: values.design,
    productRange: values.collection,
    itemType: wallpaper ? 'Wallpaper' : 'Fabrics',
    packType: wallpaper ? 'p/roll' : 'p/m',
    width: values.width,
    wholesale: values.wholesale,
  }
}

/**
 * ONLY "Sheet1" is a rate sheet, and the price list is what settles it.
 *
 * The two sheets price differently — "PRICE £ EX VAT" against "DISTRIBUTOR
 * PRICE" — which US-002 left open. 119 designs appear in both and 90 of them
 * carry a different number under each label, so one of the two is not what
 * Atelier pays. `src/seed/data/price-lists.json` decides it: of those 119, the
 * office's own Liberty rows agree with DISTRIBUTOR PRICE on all 119 and with
 * PRICE £ EX VAT on the 29 where the two columns happen to coincide.
 *
 * The cost is stated rather than hidden: 19 designs appear only in "Sheet1 (2)"
 * and this file quotes no distributor price for them, so they get no rate.
 * Emitting their ex-VAT price instead would put a different price basis into
 * the ledger under the same column as everything else.
 */
const rateSheet = Object.freeze({
  name: 'Sheet1',
  brand: 'Liberty London',
  currency: 'Pound Sterling',
  columns: Object.freeze({
    code: 'Code',
    design: 'Fabric Name',
    collection: 'Collection',
    substrate: 'Fabric Type',
    wholesale: 'DISTRIBUTOR PRICE',
    width: 'WIDTH cm / inch',
  }),
  row: libertyRate,
})

export const LIBERTY = Object.freeze({
  prefix: 'Liberty',
  supplier: 'Liberty',
  // The house is "Liberty London" in the catalogue; "Liberty" is the supplier
  // the price list files it under.
  sheets: Object.freeze([sheet('Sheet1 (2)'), sheet('Sheet1')]),
  rateSheets: Object.freeze([rateSheet]),
})
