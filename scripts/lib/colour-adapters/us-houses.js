/**
 * Clarence House, S. Harris, Stroheim, Trend and Vervain — five drops, one
 * layout.
 *
 * All five are Fabricut exports and identical to the cell: a
 * terms-and-conditions preamble, then `Pattern Only` and `All Colors`. The
 * preamble is why the header lands on row 98, 104, 106, 105 and 77
 * respectively, which is the corpus's sharpest argument for locating a header
 * by label — five files, one layout, five different header rows.
 *
 * **Only `All Colors` is declared.** `Pattern Only` is the same rows without
 * the fabric number and the colour name: it has no colour column at all, so it
 * holds designs, not colourways.
 *
 * Each file carries exactly one house in its `BRAND` column, spelt as the
 * export writes it (`S.HARRIS`, `CLARENCE`). The house still comes off the row
 * rather than the sheet: a Fabricut export that one day carries two houses must
 * file them apart, and an unmapped spelling has to reach the import as itself.
 */

import { skip } from './rates.js'

const HOUSES = Object.freeze({
  clarence: 'Clarence House',
  's.harris': 'S. Harris',
  stroheim: 'Stroheim',
  trend: 'Trend',
  vervain: 'Vervain',
})

/**
 * `6978401` -> the design's code and the colour's two-digit suffix.
 *
 * The price lists key on the design: Clarence House's 2,540 fabric numbers all
 * split, and 2,465 of the design codes are in its own price list (10644
 * "Fratello"). The other four score 3,432/3,870, 3,740/3,883, 5,917/6,039 and
 * 578/625 — the misses are 2026 designs the price list has not caught up with,
 * and no fabric number in any of the five fails to split.
 */
const FABRIC_NUMBER = /^(.*\d)(\d{2})$/

const usHouseRecord = (values) => {
  const parts = FABRIC_NUMBER.exec(values.colourCode)
  if (parts === null) throw new Error(`fabric number "${values.colourCode}" carries no colour suffix`)
  return {
    // An unmapped spelling passes through raw for the import to report. This
    // file must never invent a house.
    brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
    design: values.design,
    designCode: parts[1],
    colourCode: values.colourCode,
    colourName: values.colourName,
  }
}

const sheet = (brand) => Object.freeze({
  name: 'All Colors',
  brand,
  columns: Object.freeze({
    brand: 'Brand',
    colourCode: 'Fabric Number',
    design: 'Pattern Name',
    colourName: 'Color Name',
  }),
  row: usHouseRecord,
})

/**
 * The rate side of the same five files, which differ in three cells and nothing
 * else: the price column is spelt three ways ("US EXPORT NET PRICE", "US NET
 * EXPORT PRICE", "US WHOLESALE") and Trend abbreviates its two repeat columns.
 * Everything else is the one Fabricut layout again.
 *
 * The code is the DESIGN's, split off the fabric number the same way the
 * colourway is, because that is what the office's own rows for these houses are
 * keyed on. `PRODUCT CATEGORY` gives the item type and `UNIT OF MEASURE` the
 * pack, both stated per row.
 */
const ITEM_TYPES = Object.freeze({
  FAB: 'Fabrics', TRM: 'Trimmings', WC: 'Wallcovering', RUG: 'Accessories',
})

/**
 * `PANL2` and `PANL3` are two- and three-panel SETS, and the template's `panel`
 * would price one panel — a quantity the file does not state — so they are
 * declined rather than approximated. A plain `PANEL` is a panel. `SQFT` has no
 * template pack at all.
 */
const PACKS = Object.freeze({ YARD: 'p/y', EACH: 'p/p', PANEL: 'p/panel' })

const usHouseRate = (values) => {
  const parts = FABRIC_NUMBER.exec(values.code)
  if (parts === null) throw new Error(`fabric number "${values.code}" carries no colour suffix`)
  const itemType = ITEM_TYPES[values.type.toUpperCase()]
  if (itemType === undefined) {
    return skip(`product category "${values.type}", which no template item type covers`)
  }
  const packType = PACKS[values.unit.toUpperCase()]
  if (packType === undefined) {
    return skip(`sold by "${values.unit}", which no template pack type covers`)
  }
  return {
    brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
    code: parts[1],
    description: values.design,
    productRange: values.book,
    itemType,
    packType,
    contents: values.contents,
    width: values.width,
    repeat: values.repeat,
    verticalRepeat: values.verticalRepeat,
    wholesale: values.wholesale,
  }
}

const rateSheet = (brand, supplier, price, repeat, verticalRepeat) => Object.freeze({
  name: 'All Colors',
  brand,
  supplier,
  currency: 'US Dollar',
  columns: Object.freeze({
    brand: 'Brand',
    code: 'Fabric Number',
    design: 'Pattern Name',
    book: 'Book/Collection Name',
    type: 'Product Category',
    unit: 'Unit of Measure',
    contents: 'Contents',
    width: 'Material Width',
    repeat,
    verticalRepeat,
    wholesale: price,
  }),
  row: usHouseRate,
})

/**
 * `supplier` is the spelling the office's ledger already uses, which is not the
 * catalogue's for S. Harris: 899 rows sit under "S Harris", without the point.
 * The brand keeps the catalogue's spelling — the two columns are for exactly
 * this — and nothing here renames a house.
 */
const house = (prefix, brand, price, supplier = brand,
  repeat = 'Horizontal Repeat', verticalRepeat = 'Vertl Repeat Len2') => Object.freeze({
  prefix,
  supplier: brand,
  sheets: Object.freeze([sheet(brand)]),
  rateSheets: Object.freeze([rateSheet(brand, supplier, price, repeat, verticalRepeat)]),
})

export const CLARENCE_HOUSE = house('ClarenceHouse', 'Clarence House', 'US Export Net Price')
export const S_HARRIS = house('S Harris', 'S. Harris', 'US Export Net Price', 'S Harris')
export const STROHEIM = house('Stroheim', 'Stroheim', 'US Net Export Price')
export const TREND = house('Trend', 'Trend', 'US Wholesale', 'Trend', 'H. Repeat', 'V. Repeat')
export const VERVAIN = house('Vervain', 'Vervain', 'US Export Net Price')
