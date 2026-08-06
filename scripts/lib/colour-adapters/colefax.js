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

/**
 * The rate side: one sheet, four houses, four SUPPLIERS.
 *
 * The price list files all four apart — 731 rows under "Colefax & Fowler", 351
 * under "Jane Churchill", 352 under "Larsen" and 308 under "Manuel Canovas",
 * every one of them keyed on the design code this sheet's stock number splits
 * into — so the rate's supplier is the house the letter names, exactly as the
 * brand is. Filing all four under the group would write 1,300 parallel rows
 * beside the office's own.
 *
 * `General-Prod-Type` is what says which of the three categories a row is:
 * `WPR` is a wallpaper and `TRM` a trimming; the other five values (`WVE`,
 * `PRT`, `EMB`, `VEL`, `SHV`) are all weaves, prints, embroideries, velvets and
 * sheers — fabric. The sheet states no unit, so the pack follows the category,
 * which is what the office's own rows for these four houses already say:
 * wallpaper by the roll, everything else by the metre.
 */
const CATEGORIES = Object.freeze({ WPR: 'Wallpaper', TRM: 'Trimmings' })

const colefaxRate = (values) => {
  const brand = HOUSES[values.brand.toUpperCase()]
  if (brand === undefined) {
    throw new Error(`brand letter "${values.brand}" is not one of `
      + `${Object.keys(HOUSES).join(', ')} — a fifth house needs naming here`)
  }
  const parts = STOCK_NUMBER.exec(values.code)
  if (parts === null) throw new Error(`stock number "${values.code}" carries no colour suffix`)
  const itemType = CATEGORIES[values.type.toUpperCase()] ?? 'Fabrics'
  return {
    supplier: brand,
    brand,
    code: parts[1],
    description: values.design,
    productRange: values.book,
    itemType,
    packType: itemType === 'Wallpaper' ? 'p/roll' : 'p/m',
    contents: values.contents,
    width: values.width,
    wholesale: values.wholesale,
  }
}

export const COLEFAX = Object.freeze({
  prefix: 'Colefax Group',
  supplier: 'Colefax & Fowler',
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'Export Prices',
      brand: 'Colefax & Fowler',
      // The column names the currency: "Distributors GBP (FF)".
      currency: 'Pound Sterling',
      columns: Object.freeze({
        brand: 'Brand',
        code: 'Stock-Number',
        design: 'Design',
        type: 'General-Prod-Type',
        book: 'Pattern-Book-Description',
        contents: 'Fibre Content',
        width: 'Width',
        wholesale: 'Distributors GBP (FF)',
      }),
      row: colefaxRate,
    }),
  ]),
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
