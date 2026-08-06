/**
 * Colefax Group — one sheet, four houses, each named by a single letter.
 *
 * The `Brand` column holds `C`, `J`, `L` or `M` and nothing else across 9,065
 * rows. A letter is a code, not a spelling, so an unknown one cannot be passed
 * through raw the way an unmapped house name is: it would file a colourway
 * under a brand called "X". The mapping was measured rather than read off the
 * filename — for each letter, the file's own design names were looked up in
 * `src/seed/data/price-lists.json`: C matches "Colefax & Fowler" on 678 of its
 * 691 designs, J "Jane Churchill" on 332 of 338, L "Larsen" on 347 of 361 and M
 * "Manuel Canovas" on 278 of 288. No other supplier scores above 42.
 */

const HOUSES = Object.freeze({
  C: 'Colefax & Fowler',
  J: 'Jane Churchill',
  L: 'Larsen',
  M: 'Manuel Canovas',
})

/**
 * `F4613-01` / `01020/03` -> the design's code and the colour's suffix.
 *
 * The stock number is the SKU and the part before the last separator is what
 * the price list keys on: every one of the 9,065 stock numbers splits, and the
 * derived design code is in that house's own price list for 9,015 of them
 * (J0025 "Asta", L7681 "Limelight", 01286 "Pav de Bidaine"). The separator is a
 * hyphen on most rows and a slash on 1,750, hence both.
 */
const STOCK_NUMBER = /^(.+)[-/]([^-/]+)$/

const colefaxRecord = (values) => {
  const brand = HOUSES[values.brand.toUpperCase()]
  if (brand === undefined) {
    throw new Error(`brand letter "${values.brand}" is not one of `
      + `${Object.keys(HOUSES).join(', ')} — a fifth house needs naming here`)
  }
  const parts = STOCK_NUMBER.exec(values.colourCode)
  if (parts === null) throw new Error(`stock number "${values.colourCode}" carries no colour suffix`)
  return {
    brand,
    design: values.design,
    designCode: parts[1],
    colourCode: values.colourCode,
    colourName: values.colourName,
  }
}

export const COLEFAX = Object.freeze({
  prefix: 'Colefax Group',
  supplier: 'Colefax & Fowler',
  sheets: Object.freeze([
    Object.freeze({
      name: 'Export Prices',
      // The lead house. Every row overrides it from the Brand column.
      brand: 'Colefax & Fowler',
      columns: Object.freeze({
        brand: 'Brand',
        colourCode: 'Stock-Number',
        design: 'Design',
        colourName: 'Colourway',
      }),
      row: colefaxRecord,
    }),
  ]),
})
