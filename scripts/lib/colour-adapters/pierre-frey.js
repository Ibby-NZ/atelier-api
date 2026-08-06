/**
 * Pierre Frey — one sheet, five houses, and a colour name that has to be cut
 * out of the SKU's.
 *
 * The `Brand` column names all five (Pierre Frey 4,648 rows, Braquenié 531, Le
 * Manach 485, Fadini Borghi 193, Boussac 141) and spells four of them exactly
 * as the catalogue does, accent included, so nothing is mapped here — the fifth,
 * Le Manach, is a house the catalogue has no row for and passes through raw for
 * the import to report, which is what an unmapped spelling must do anyway.
 *
 * `Ref Pattern` is the design's code and is what the price list keys on
 * (`B063A` "LES BLEUETS - percale", `F0556` "CROISE COLLOBRIERES"); `Ref SKU
 * available` is the colourway's. The file names no colour on its own, only
 * `Name SKU available` — the design and the colour run together in one cell.
 */

/** A design cell often ends in the separator it would have joined a variant on. */
const DESIGN_TAIL = /[\s-]+$/

/**
 * The colour out of `LE GRAND CORAIL BLEU BLC 04`, given `LE GRAND CORAIL`.
 *
 * 5,680 of the 5,998 SKU names start with their own design name and give the
 * colour up by subtraction; 299 of those ARE the design name, so the supplier
 * named no colour and the record carries none. The remaining 318 abbreviate the
 * design instead of repeating it ("GR CORAIL RAY 2CH BLEU BL 4" for "LE GRAND
 * CORAIL - Rayure 2 chemins"), and no rule here can undo the supplier's own
 * shorthand — so the SKU name is emitted whole rather than cut at a guess.
 */
const colourFrom = (design, skuName) => (
  skuName.toUpperCase().startsWith(design.toUpperCase())
    ? skuName.slice(design.length).trim()
    : skuName
)

const pierreFreyRecord = (values) => {
  const design = values.design.replace(DESIGN_TAIL, '')
  if (design === '') throw new Error(`SKU "${values.colourCode}" names no design`)
  if (values.colourCode === '') throw new Error(`design "${design}" has no SKU reference`)
  return {
    brand: values.brand,
    design,
    designCode: values.designCode,
    colourCode: values.colourCode,
    colourName: colourFrom(design, values.skuName),
  }
}

export const PIERRE_FREY = Object.freeze({
  prefix: 'Pierre Frey',
  supplier: 'Pierre Frey',
  sheets: Object.freeze([
    Object.freeze({
      // The sheet is named for the day the export ran.
      name: '2026-29-01-PF-FICHIER DETAILLE',
      brand: 'Pierre Frey',
      columns: Object.freeze({
        designCode: 'Ref Pattern',
        design: 'Name',
        colourCode: 'Ref SKU available',
        skuName: 'Name SKU available',
        brand: 'Brand',
      }),
      row: pierreFreyRecord,
    }),
  ]),
})
