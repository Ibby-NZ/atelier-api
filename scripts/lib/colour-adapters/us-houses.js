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

const house = (prefix, brand) => Object.freeze({
  prefix,
  supplier: brand,
  sheets: Object.freeze([sheet(brand)]),
})

export const CLARENCE_HOUSE = house('ClarenceHouse', 'Clarence House')
export const S_HARRIS = house('S Harris', 'S. Harris')
export const STROHEIM = house('Stroheim', 'Stroheim')
export const TREND = house('Trend', 'Trend')
export const VERVAIN = house('Vervain', 'Vervain')
