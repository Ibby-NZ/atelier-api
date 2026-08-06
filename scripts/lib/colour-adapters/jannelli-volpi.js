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

/**
 * The rate side: the same nine sheets, eight houses, six SUPPLIERS.
 *
 * The price list files most of these houses apart — 2,516 rows under "Jannelli
 * Volpi", 447 "Altagamma", 361 "JV Design", 323 "Missoni", 209 "JWall", 504
 * "Armani Casa" — all keyed on the item code this file calls `ITEM`, so the
 * rate's supplier comes off the row through a declared table of the office's own
 * spellings. CO.DE and JV Fabrics have no supplier row of their own; they fall
 * back to the drop's, which is where the ledger already holds the JV Fabrics
 * codes (`F7300`).
 *
 * `SALES UNIT` gives the pack and is the only cell that separates stock from
 * sample. Three units are stock — 2,628 rolls, 1,269 murals and 995 linear
 * metres — and the murals are pieces, which is what the office's own 1,163
 * `piece` rows under Jannelli Volpi already say. Everything else (a book, a
 * hanger, a catalogue, a shop display) is declined by name, so the summary says
 * how many of each rather than reporting one number nobody can account for.
 *
 * Two sheets quote a PUBLIC price where the other seven quote the dealer's, and
 * neither carries a dealer column at all — see the rate sheets below.
 */
const SUPPLIERS = Object.freeze({
  'jannelli&volpi': 'Jannelli Volpi',
  altagamma: 'Altagamma',
  'altagamma modern living': 'Altagamma',
  'design licence': 'JV Design',
  'design license': 'JV Design',
  jwall: 'JWall',
  'armani casa': 'Armani Casa',
  'missoni wallcoverings': 'Missoni',
})

const PACKS = Object.freeze({ roll: 'p/roll', 'linear meter': 'p/m' })

/** A mural or a panel is sold as one piece, whatever its dimensions. */
const AS_PIECE = /^(mural|panel)\b/

const volpiRate = (spec) => (values) => {
  const unit = values.unit.toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  const packType = AS_PIECE.test(unit) ? 'p/p' : PACKS[unit]
  if (packType === undefined) {
    return skip(`sold by "${values.unit.split(/\s+/)[0]}", which no template pack type covers`)
  }
  if (values.colourCode === '') return skip('substrate price, no item code')
  return {
    supplier: SUPPLIERS[values.brand.toLowerCase()],
    brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
    code: values.colourCode,
    description: values.design,
    productRange: values.collection,
    itemType: spec.itemType,
    packType,
    contents: values.contents,
    width: values.width,
    repeat: values.repeat,
    patternMatch: values.match,
    wholesale: values.wholesale,
  }
}

/** The label the seven dealer sheets share; the date in it is the file's own. */
const DEALER_PRICE = 'DEALER PRICE 1 JUN 2026'
const EFFECTIVE = '01/06/2026'

const rateSheet = (name, brand, price = DEALER_PRICE, itemType = 'Wallcovering') => {
  const spec = {
    name,
    brand,
    itemType,
    currency: 'Euro',
    dateEffective: EFFECTIVE,
    columns: Object.freeze({
      brand: 'Brand',
      colourCode: 'Item',
      design: 'Design',
      collection: 'Collection',
      unit: 'Sales Unit',
      wholesale: price,
      contents: 'Composition/Support',
      width: 'Width/mt',
      repeat: 'Pattern repeat cm',
      match: 'Match',
    }),
  }
  return Object.freeze({ ...spec, row: volpiRate(spec) })
}

export const JANNELLI_VOLPI = Object.freeze({
  prefix: 'JV_EXPORT',
  supplier: 'Jannelli Volpi',
  // CO.DE and JV FABRICS state a PUBLIC price and no dealer one, so that is what
  // is emitted and the summary says so: a public price read as a dealer price
  // would overstate what Atelier pays, and inventing a discount off it would be
  // worse. Confirm both with the supplier before importing them.
  rateSheets: Object.freeze([
    rateSheet('JANNELLI&VOLPI', 'JANNELLI&VOLPI'),
    rateSheet('ALTAGAMMA MODERN LIVING', 'ALTAGAMMA MODERN LIVING'),
    rateSheet('JV Contract', 'JANNELLI&VOLPI'),
    rateSheet('DESIGN LICENCE', 'DESIGN LICENCE'),
    rateSheet('JWALL', 'JWALL'),
    rateSheet('ARMANI CASA', 'Armani Casa'),
    rateSheet('MISSONI', 'Missoni Home'),
    rateSheet('CO.DE', 'CO.DE', 'PUBLIC PRICE (VAT EXCLUDED) PER ROLL/ LMT/NR 1 JUN 2026'),
    rateSheet('JV FABRICS', 'JV FABRICS',
      'PUBLIC PRICE (VAT EXCLUDED) PER LINEAR METER 1 JUN 2026', 'Fabrics'),
  ]),
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
