/**
 * Perennials — two drops, one house, and two different answers to "which
 * sheets hold the colourways".
 *
 * The fabrics file splits its stock across `Fabrics` and `Trims ` (the trailing
 * space is the sheet's real name — a sheet is addressed by name, so it is
 * declared exactly as written), and the two are disjoint: 867 fabrics, 101
 * trims, nothing in both.
 *
 * The wallcoverings file is the opposite. Its four type sheets — Patterns &
 * Murals, Metallics, Performance, Textures — are all reprinted in `ALL SKUS`
 * with a `Type` column, and the counts add up exactly (41 + 23 + 75 + 81 =
 * 220), so `ALL SKUS` alone is the whole file and declaring the four as well
 * would emit every wallcovering twice.
 *
 * Both files carry conditions-of-sale, care, shipping and showroom sheets,
 * which hold no stock and are simply not declared.
 */

import { skip } from './rates.js'

const BRAND = 'Perennials'

/**
 * The date the fabrics file states in its own price column, "2026 Net
 * Price(effective 02/02/26)". It is read off the label rather than invented,
 * and the office's own Perennials rows already carry it.
 */
const EFFECTIVE = '02/02/2026'

/**
 * The trims are filed under the item number's PREFIX: the price list's four
 * Perennials trimming rows are `BC`, `FB`, `SC` and `TC`, where this sheet
 * writes `BC-01`, `BC-06` and so on for the colourways. The fabrics need no
 * such rule — `Quality` is already the design's code there.
 *
 * The letters are taken without requiring the hyphen after them, because one
 * row of the 101 is missing it (`BC483` where every other Big Cord is `BC-…`).
 */
const TRIM_CODE = /^([A-Za-z]+)/

const trimRate = (values) => {
  const parts = TRIM_CODE.exec(values.code)
  if (parts === null) throw new Error(`item number "${values.code}" carries no trim code`)
  return {
    code: parts[1],
    description: values.design,
    contents: values.contents,
    wholesale: values.wholesale,
  }
}

/**
 * The wallcoverings are priced twice — per yard and per roll — and the sheet's
 * own `Sold by the` cell says which of the two the office buys. 177 rows are
 * sold by the roll (and price only that way), 41 by the yard.
 */
const wallcoveringRate = (values) => {
  const soldBy = values.soldBy.toUpperCase()
  if (soldBy.startsWith('ROLL')) {
    return {
      code: values.code,
      description: values.design,
      productRange: values.collection,
      packType: 'p/roll',
      width: values.width,
      repeat: values.repeat,
      verticalRepeat: values.verticalRepeat,
      patternMatch: values.match,
      wholesale: values.wholesale,
    }
  }
  if (soldBy === 'YARD') {
    return {
      code: values.code,
      description: values.design,
      productRange: values.collection,
      packType: 'p/y',
      width: values.width,
      repeat: values.repeat,
      verticalRepeat: values.verticalRepeat,
      patternMatch: values.match,
      wholesale: values.perYard,
    }
  }
  return skip(`sold by "${values.soldBy}", which no template pack type covers`)
}

export const PERENNIALS_FABRICS = Object.freeze({
  prefix: 'Perennials Fabrics',
  supplier: 'Perennials',
  sheets: Object.freeze([
    Object.freeze({
      name: 'Fabrics',
      brand: BRAND,
      // `Quality` is the design's code and `Quality Description` its name; the
      // price list keys on the quality (1000 "Stripe Du Jour", 115 "Willow
      // Way"), so both are kept.
      columns: Object.freeze({
        designCode: 'Quality',
        design: 'Quality Description',
        colourCode: 'Item Number',
        colourName: 'Colorway',
      }),
    }),
    Object.freeze({
      name: 'Trims ',
      brand: BRAND,
      // The trims sheet names the design in `Quality` and prints no code for
      // it; `Description` here is the construction, not the design.
      columns: Object.freeze({
        design: 'Quality',
        colourCode: 'Item Number',
        colourName: 'Colorway',
      }),
    }),
  ]),
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'Fabrics',
      brand: BRAND,
      currency: 'US Dollar',
      itemType: 'Fabrics',
      packType: 'p/y',
      dateEffective: EFFECTIVE,
      // The discounted column beside it ("Net Price w/LIM-AV Discount") prices
      // limited availability stock and is not the list rate.
      columns: Object.freeze({
        code: 'Quality',
        description: 'Quality Description',
        wholesale: '2026 Net Price(effective 02/02/26)',
        contents: 'Description',
        width: 'Width',
      }),
    }),
    Object.freeze({
      name: 'Trims ',
      brand: BRAND,
      currency: 'US Dollar',
      itemType: 'Trimmings',
      packType: 'p/y',
      dateEffective: EFFECTIVE,
      columns: Object.freeze({
        code: 'Item Number',
        design: 'Quality',
        contents: 'Description',
        wholesale: 'Net Price',
      }),
      row: trimRate,
    }),
  ]),
})

export const PERENNIALS_WALLCOVERINGS = Object.freeze({
  prefix: 'Perennials Wallcoverings',
  supplier: 'Perennials',
  sheets: Object.freeze([
    Object.freeze({
      name: 'ALL SKUS',
      brand: BRAND,
      // `Collection` is a season ("2024 Summer"), not a code for the design.
      columns: Object.freeze({
        design: 'Design',
        colourCode: 'Item Number',
        colourName: 'Colorway',
      }),
    }),
  ]),
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'ALL SKUS',
      brand: BRAND,
      currency: 'US Dollar',
      itemType: 'Wallcovering',
      // The item number IS the code here: this sheet prints no code for the
      // design, and the price list carries no Perennials wallcovering row to
      // read a grain off, so the rate stays at the grain the file prices at.
      columns: Object.freeze({
        code: 'Item Number',
        design: 'Design',
        collection: 'Collection',
        soldBy: 'Sold by the',
        // `wholesale` is the roll price, which most of the sheet is sold by;
        // the mapper reaches for the yard price on the rows that are not.
        wholesale: 'Net Price per Roll',
        perYard: 'Net  Price per Yard',
        width: 'Width',
        repeat: 'Horizontal Repeat',
        verticalRepeat: 'Vertical Repeat',
        match: 'Match',
      }),
      row: wallcoveringRate,
    }),
  ]),
})
