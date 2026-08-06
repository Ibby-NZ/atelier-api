/**
 * Jannelli & Volpi — ten sheets, eight houses, and no colour names anywhere.
 *
 * One layout repeated per house: `BRAND`, `COLLECTION`, `FAM`, `ITEM`, `DESIGN`
 * and `SALES UNIT` are spelt identically on all of them, so one column map
 * serves nine sheets (only the price column is renamed between them, and rates
 * are US-005's). `JV Contract` is declared and empty this year — its header is
 * there and its rows are not, which is worth reading rather than assuming.
 * `ACCESSORIES` is the tenth and is NOT declared: it is a different layout
 * (`ART`, `DESCRIPTION/USE AND CONSUMPTION`) holding thirteen display and
 * marketing items, no stock.
 *
 * **This file names no colours at all.** `ITEM` is the colourway's code and
 * `DESIGN` the design's name, and two items of one design differ by nothing the
 * file writes down (`6570` and `6571` are both "RIBBON GRASS"). The price list
 * agrees — it keys on the item and repeats the design as its description — so
 * the record carries the code with no colour name rather than inventing one.
 * `FAM` is the collection's code, not the design's, so there is no design code
 * to carry either.
 *
 * The eight houses are the file's own spellings. Two are the catalogue's houses
 * under other names and are mapped; the other six — Jannelli&Volpi itself,
 * Altagamma, Design Licence, JWall, CO.DE and JV Fabrics — have no catalogue
 * row at all, so they pass through raw for the import to report. Two of the six
 * are spelt two ways within this one file (`DESIGN LICENSE`/`DESIGN LICENCE`,
 * `ALTAGAMMA`/`ALTAGAMMA MODERN LIVING`); both spellings are emitted as they
 * are found, because choosing between them is naming a house.
 */
import { skip } from './records.js'

const HOUSES = Object.freeze({
  'armani casa': 'Armani Casa',
  // The catalogue's Missoni house; the price list files these codes under
  // supplier "Missoni", product range "MISSONI WALL COVERING".
  'missoni wallcoverings': 'Missoni Home',
})

/**
 * Sales units that mean a sample, not stock: 239 rows across the nine sheets.
 *
 * Every other unit is something sold by the roll, the metre or the panel. The
 * sample rows carry item codes and design names like any other row ("SAMPLE
 * BOOK", "MEMO SAMPLE", "SAMPLE CARD GA7 9700 w. 44 x h. 34"), so nothing but
 * the unit distinguishes them — and importing them would put a sample book in
 * the catalogue as a colourway.
 */
const SAMPLE_UNITS = Object.freeze(new Set([
  'swatch', 'book', 'sample', 'memo sample', 'full set sample',
  'binder', 'folder', 'catalogue', 'coupe vetrine', 'box', 'card',
]))

const volpiRecord = (values) => {
  if (SAMPLE_UNITS.has(values.unit.toLowerCase())) return skip('sample, sold by the unit')
  // The CO.DE sheet ends in 45 rows that price its substrates by the metre —
  // "BASIC", "ESSENTIAL METALLIC" — and they are the only rows in the file with
  // no item code at all. Nothing can be filed under a code that is not there.
  if (values.colourCode === '') return skip('substrate price, no item code')
  if (values.design === '') throw new Error(`item "${values.colourCode}" names no design`)
  return {
    brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
    design: values.design,
    colourCode: values.colourCode,
  }
}

const sheet = (name, brand) => Object.freeze({
  name,
  brand,
  columns: Object.freeze({
    brand: 'Brand',
    colourCode: 'Item',
    design: 'Design',
    unit: 'Sales Unit',
  }),
  row: volpiRecord,
})

export const JANNELLI_VOLPI = Object.freeze({
  prefix: 'JV_EXPORT',
  supplier: 'Jannelli Volpi',
  // The sheet's house is the one its rows carry; each row still overrides it,
  // because three of these sheets hold a second spelling of their own house.
  sheets: Object.freeze([
    sheet('JANNELLI&VOLPI', 'JANNELLI&VOLPI'),
    sheet('ALTAGAMMA MODERN LIVING', 'ALTAGAMMA MODERN LIVING'),
    sheet('JV Contract', 'JANNELLI&VOLPI'),
    sheet('DESIGN LICENCE', 'DESIGN LICENCE'),
    sheet('JWALL', 'JWALL'),
    sheet('ARMANI CASA', 'Armani Casa'),
    sheet('MISSONI', 'Missoni Home'),
    sheet('CO.DE', 'CO.DE'),
    sheet('JV FABRICS', 'JV FABRICS'),
  ]),
})
