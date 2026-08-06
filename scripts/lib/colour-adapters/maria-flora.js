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

export const MARIA_FLORA = Object.freeze({
  prefix: 'Maria Flora',
  supplier: 'Maria Flora',
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
