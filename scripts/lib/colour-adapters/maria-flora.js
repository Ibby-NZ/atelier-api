/**
 * Maria Flora — one sheet, and TWO houses in it.
 *
 * The filename says so ("Maria Flora - Filippo Uecher …") and the sheet carries
 * a `Brand` column: 1,088 rows read "Mariaflora" and 353 "Filippo Uecher". Both
 * are houses Atelier represents, so the brand has to come off the row; a single
 * declared house would file a third of the file under the wrong maison.
 *
 * The spelling does not match the catalogue's, which is the ordinary case
 * (CLAUDE.md: "Colefax & Fowler" vs "Colefax and Fowler"), so the one house the
 * file spells differently is mapped by a declared alias. An unlisted spelling
 * passes through raw and the import reports it — inventing a house here is the
 * one thing that must not happen.
 */

import { skip } from './rates.js'

const HOUSES = Object.freeze({ mariaflora: 'Maria Flora' })

/**
 * `Item Number (pattern + Color)` holds the PATTERN only — the colour is in its
 * own cell — so it is the design's code, which is what the price list keys on
 * (Maria Flora's rows there are pattern numbers: 10303 CARMEN, 10305 TOSCA).
 * The colour code stays the colour's own, unjoined: composing a colourway code
 * out of the two would be inventing a separator the supplier never wrote.
 */
const mariaFloraRecord = (values) => ({
  brand: HOUSES[values.brand.toLowerCase()] ?? values.brand,
  design: values.design,
  designCode: values.designCode,
  colourCode: values.colourCode,
  colourName: values.colourName,
})

/**
 * The rate side: one sheet, two houses, and the two are separate SUPPLIERS.
 *
 * The price list files them apart — 125 rows under "Maria Flora" and 63 under
 * "Filippo Uecher", both keyed on the pattern number this sheet calls `Item
 * Number` — so the rate takes its supplier from the same declared alias the
 * brand comes from. A spelling the table does not carry falls back to the
 * drop's supplier rather than opening a supplier of its own.
 *
 * `Collection` is what says whether a row is a fabric: the sheet holds
 * wallcoverings (81 rows), trims (44), rugs (30) and throws (16) beside its
 * 1,270 fabrics, and nothing else in the row distinguishes them.
 */
const SUPPLIERS = Object.freeze({ mariaflora: 'Maria Flora', 'filippo uecher': 'Filippo Uecher' })

const ITEM_TYPES = Object.freeze({
  wallcoverings: 'Wallpaper',
  trims: 'Trimmings',
  rugs: 'Accessories',
  throws: 'Accessories',
})

/** `sqm` is a square metre, which the template has no pack type for. */
const PACKS = Object.freeze({ m: 'p/m', pc: 'p/p' })

const mariaFloraRate = (values) => {
  const packType = PACKS[values.unit.toLowerCase()]
  if (packType === undefined) {
    return skip(`sold by "${values.unit}", which no template pack type covers`)
  }
  const house = values.brand.toLowerCase()
  return {
    supplier: SUPPLIERS[house] ?? undefined,
    brand: HOUSES[house] ?? values.brand,
    code: values.code,
    description: values.design,
    productRange: values.collection,
    itemType: ITEM_TYPES[values.collection.toLowerCase()] ?? 'Fabrics',
    packType,
    contents: values.contents,
    width: values.width,
    repeat: values.repeat,
    verticalRepeat: values.verticalRepeat,
    wholesale: values.wholesale,
  }
}

export const MARIA_FLORA = Object.freeze({
  prefix: 'Maria Flora',
  supplier: 'Maria Flora',
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'Foglio1',
      brand: 'Maria Flora',
      currency: 'Euro',
      columns: Object.freeze({
        code: 'Item Number (pattern + Color)',
        design: 'Product Name',
        brand: 'Brand',
        collection: 'Collection',
        unit: 'Unit of Measure',
        wholesale: 'Price',
        contents: 'Composition',
        width: 'Width (cm)',
        repeat: 'Horizontal Repeat (cm)',
        verticalRepeat: 'Vertical Repeat (cm)',
      }),
      row: mariaFloraRate,
    }),
  ]),
  sheets: Object.freeze([
    Object.freeze({
      name: 'Foglio1',
      brand: 'Maria Flora',
      columns: Object.freeze({
        design: 'Product Name',
        designCode: 'Item Number (pattern + Color)',
        colourCode: 'Color Code',
        colourName: 'Color (if applicable)',
        brand: 'Brand',
      }),
      row: mariaFloraRecord,
    }),
  ]),
})
