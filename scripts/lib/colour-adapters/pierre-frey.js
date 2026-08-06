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

import { skip } from './rates.js'

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

/**
 * The rate side: one sheet, five houses, five SUPPLIERS.
 *
 * The price list files each of them apart (1,536 rows under "Pierre Frey", 286
 * "Le Manach", 222 "Braquenie", 68 "Fadini Borghi", 64 "Boussac"), all keyed on
 * `Ref Pattern`, so the rate's supplier is the house — through a declared table,
 * because the office spells Braquenié without its accent. The Brand column
 * still carries the house as the file writes it; that is what the template's
 * two columns are for.
 *
 * `Unit` is French shorthand: `M` metre, `RL` rouleau, `UN` unité and `Pa`
 * panneau ("LE GRAND GENOIS - Panneau"). The last two are one pack: the file
 * prices several designs identically under both (BP348 at 589 under `UN` and
 * `Pa`), and the office's own Pierre Frey rows carry 84 pieces and no panels at
 * all.
 */
const SUPPLIERS = Object.freeze({
  'pierre frey': 'Pierre Frey',
  boussac: 'Boussac',
  braquenié: 'Braquenie',
  'fadini borghi': 'Fadini Borghi',
  'le manach': 'Le Manach',
})

const ITEM_TYPES = Object.freeze({ tissu: 'Fabrics', 'papier peint': 'Wallpaper' })
const PACKS = Object.freeze({ m: 'p/m', rl: 'p/roll', un: 'p/p', pa: 'p/p' })

const pierreFreyRate = (values) => {
  const itemType = ITEM_TYPES[values.type.toLowerCase()]
  if (itemType === undefined) {
    return skip(`product type "${values.type}", which no template item type covers`)
  }
  const packType = PACKS[values.unit.toLowerCase()]
  if (packType === undefined) {
    return skip(`sold by "${values.unit}", which no template pack type covers`)
  }
  const design = values.design.replace(DESIGN_TAIL, '')
  if (design === '') throw new Error(`pattern "${values.code}" names no design`)
  return {
    supplier: SUPPLIERS[values.brand.toLowerCase()],
    brand: values.brand,
    code: values.code,
    description: design,
    itemType,
    packType,
    contents: values.contents,
    width: values.width,
    repeat: values.repeat,
    verticalRepeat: values.verticalRepeat,
    wholesale: values.wholesale,
  }
}

export const PIERRE_FREY = Object.freeze({
  prefix: 'Pierre Frey',
  supplier: 'Pierre Frey',
  rateSheets: Object.freeze([
    Object.freeze({
      name: '2026-29-01-PF-FICHIER DETAILLE',
      brand: 'Pierre Frey',
      currency: 'Euro',
      columns: Object.freeze({
        code: 'Ref Pattern',
        design: 'Name',
        brand: 'Brand',
        type: 'Type of product',
        unit: 'Unit',
        wholesale: 'DISTRIBUTOR € EXW',
        contents: 'COMPOSITION FR',
        width: 'USABLEWIDTH (cm)',
        repeat: 'Pattern repeat H (cm)',
        verticalRepeat: 'Pattern repeat V (cm)',
      }),
      row: pierreFreyRate,
    }),
  ]),
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
