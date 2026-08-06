/**
 * C & C Milano — one house, one sheet, and three rows of dictionary above the
 * data.
 *
 * The header is Italian (`Tipo/type`, `Modello`, `Bar1`, `Col-1`) and rows 2 to
 * 4 translate it into English, French and German rather than holding stock:
 * each prints the product type it describes in the type cell ("1 - Tessuti /
 * Fabrics") where a data row prints the bare number. Matching the header by
 * label finds row 1, so the three arrive here as data rows and are declined by
 * that difference.
 *
 * Type `0` is the fourth thing the sheet holds: 587 `Camp. <design>` rows, the
 * priced sample cuttings, which carry no colour at all. Types 1, 2 and 3 are
 * the fabrics, wallpapers and trimmings — 1,686 colourways, of which 1,682 are
 * the whole of what the price list carries under "C&C Milano". That is how the
 * item number was identified as the colour code; it is not a join, and none may
 * be made (see CLAUDE.md).
 *
 * This is also the workbook whose writer emits `<x:workbook>` and an absolute
 * unnumbered sheet target — handled once in lib/colour-sheet.js, not here.
 */
import { skip } from './records.js'

const ccMilanoRecord = (values) => {
  // A dictionary row: the type cell spells the type out instead of numbering it.
  if (!/^\d+$/.test(values.type)) return skip('header translation')
  // Sample cuttings, priced but not stock, and the only rows with no colour.
  if (values.type === '0') return skip('sample cutting')
  if (values.design === '' || values.colourCode === '') {
    throw new Error(`type ${values.type} row has no design or item number`)
  }
  return {
    design: values.design,
    colourCode: values.colourCode,
    colourName: values.colourName,
  }
}

/**
 * The rate side of the same sheet. The type cell that tells a fabric from a
 * wallpaper from a trimming also gives the pack, because this file states no
 * unit and the office's own 1,682 C&C Milano rows are unanimous: every fabric
 * and every trimming by the metre, every wallpaper by the roll.
 *
 * The item number is the code the price list keys on — those 1,682 rows are
 * these item numbers — so the rate is the colourway's here, not the design's.
 */
const ITEM_TYPES = Object.freeze({ 1: 'Fabrics', 2: 'Wallpaper', 3: 'Trimmings' })
const PACKS = Object.freeze({ 1: 'p/m', 2: 'p/roll', 3: 'p/m' })

const ccMilanoRate = (values) => {
  if (!/^\d+$/.test(values.type)) return skip('header translation')
  if (values.type === '0') return skip('sample cutting')
  const itemType = ITEM_TYPES[values.type]
  if (itemType === undefined) {
    return skip(`product type "${values.type}", which no template item type covers`)
  }
  return {
    code: values.code,
    description: values.design,
    itemType,
    packType: PACKS[values.type],
    contents: values.contents,
    width: values.width,
    repeat: values.repeat,
    verticalRepeat: values.verticalRepeat,
    wholesale: values.wholesale,
  }
}

export const CC_MILANO = Object.freeze({
  prefix: 'C&C Milano',
  supplier: 'C&C Milano',
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'Listino',
      brand: 'C & C Milano',
      currency: 'Euro',
      // `Prezzo` is the price, `Altezza` the height (width), `RapOrdito` the
      // warp repeat and `RapTrama` the weft one — the dictionary rows are what
      // say so.
      columns: Object.freeze({
        type: 'Tipo/type',
        code: 'Bar1',
        design: 'Modello',
        wholesale: 'Prezzo',
        contents: 'Composizione',
        width: 'Altezza',
        verticalRepeat: 'RapOrdito',
        repeat: 'RapTrama',
      }),
      row: ccMilanoRate,
    }),
  ]),
  sheets: Object.freeze([
    Object.freeze({
      name: 'Listino',
      // The catalogue spells the house with spaces around the ampersand; the
      // price list files the supplier without them.
      brand: 'C & C Milano',
      // `Modello` is the design, `Bar1` the item number and `Col-1` the colour
      // — the dictionary rows are what say so.
      columns: Object.freeze({
        type: 'Tipo/type',
        design: 'Modello',
        colourCode: 'Bar1',
        colourName: 'Col-1',
      }),
      row: ccMilanoRecord,
    }),
  ]),
})
