/**
 * Jean Monro Ltd — one workbook, three sheets, three houses.
 *
 * The distributor's own file, so the sheets are its three ranges and each is a
 * different house: JM is Jean Monro itself and NH is Nicky Haslam (the price
 * list carries the same `NH-…` codes under supplier "Nicky Haslam"). RSC is not
 * identified anywhere in this repo — no price list carries an `RSC-` code — so
 * the token the file prints is emitted verbatim and the import reports it as an
 * unknown house rather than this file guessing a name for it.
 *
 * The three headers disagree about what their columns MEAN, which is the whole
 * reason a column map is by label and never by index:
 *   JM   `name` is the design and `Colour` is the colour.
 *   NH   `name` is the colour and there is no design column at all.
 *   RSC  `name` is the colour and the design sits in an UNLABELLED column.
 * So only JM maps straight through; the other two derive their design, each
 * from a rule checked against the file's own unlabelled cells (below).
 */

import { skip } from './rates.js'

const SUPPLIER = 'Jean Monro'

/**
 * `NH-BALCONY-STRIPE-4` -> prefix, design, colour suffix.
 *
 * The sheet decomposes its own codes into three unlabelled columns for its
 * first 102 rows and leaves them blank for the 50 outdoor and wallpaper rows
 * that follow, so this reproduces the file's own split and extends it to the
 * rows the file stopped filling in. Verified over the whole sheet: 152 rows,
 * every code splits, and the derived design equals the file's own cell on every
 * row that carries one. `NHP-` is the wallpaper prefix and `NH-ZEPHYR` has no
 * colour suffix at all, hence both optional parts.
 */
const NH_CODE = /^(NHP?-)(.+?)(?:-\d+)?$/

const nhRecord = (values) => {
  const parts = NH_CODE.exec(values.colourCode)
  if (parts === null) throw new Error(`code "${values.colourCode}" is not an NH item code`)
  return {
    // The design reads as the supplier's token ("WINTER-WHEAT"), because that
    // is all the file holds — the price list spells the same design "BALCONY
    // STRIPE". Emitted verbatim rather than prettified: `${prefix}${token}` is
    // exactly the price list's code for the design.
    design: parts[2],
    designCode: `${parts[1]}${parts[2]}`,
    colourCode: values.colourCode,
    colourName: values.colourName,
  }
}

/**
 * RSC prints `DESCRIPTION` as "<design><separator><colour>" — with a comma, or
 * without one, or with trailing notes after the colour ("KANPUR, Archive, *cut
 * by repeat* NB 124cm…"). Cutting at the colour and trimming the separator
 * handles all three; verified over the whole sheet, where the design it derives
 * equals the file's own unlabelled design cell on all 87 rows.
 *
 * No `designCode`: RSC gives each colourway its own code and the sheet holds no
 * code for the design (OTTOLINE's six colours are RSC-1260…RSC-1265), so there
 * is nothing to derive one from that would not be a guess.
 */
const rscRecord = (values) => {
  const cut = values.colourName === ''
    ? -1
    : values.description.toLowerCase().indexOf(values.colourName.toLowerCase())
  const design = (cut > 0 ? values.description.slice(0, cut) : values.description)
    .replace(/[\s,]+$/, '').trim()
  if (design === '') throw new Error(`no design in description "${values.description}"`)
  return { design, colourCode: values.colourCode, colourName: values.colourName }
}

/**
 * The rate side of the same three sheets.
 *
 * The file prices every colourway row, in sterling, and states its own unit and
 * product type per row (`METRE`/`ROLL`, `FABRIC`/`WALLPAPER`), so nothing here
 * is derived from the filename or the house.
 *
 * The CODE each range is priced under is not the same choice on all three, and
 * the price list is what settles it: `Jean Monro` there holds 321 rows keyed
 * `JM-1409` — one per colourway, exactly the JM sheet's own CODE — while
 * `Nicky Haslam` holds 17 keyed `NH-AFTERALLTOO`, the design. So JM and RSC
 * price by the colourway's code and NH by the design's, which is also why NH's
 * 152 rows collapse to its handful of designs.
 */
const UNITS = Object.freeze({ metre: 'p/m', roll: 'p/roll' })
const TYPES = Object.freeze({ fabric: 'Fabrics', wallpaper: 'Wallpaper' })

const monroRate = (describe) => (values) => {
  const packType = UNITS[values.unit.toLowerCase()]
  if (packType === undefined) {
    return skip(`sold by "${values.unit}", which no template pack type covers`)
  }
  const itemType = TYPES[values.type.toLowerCase()]
  if (itemType === undefined) {
    return skip(`product type "${values.type}", which no template item type covers`)
  }
  const [code, description] = describe(values)
  return {
    code,
    description,
    itemType,
    packType,
    contents: values.contents,
    width: values.width,
    repeat: values.repeat,
    verticalRepeat: values.verticalRepeat,
    wholesale: values.wholesale,
  }
}

const rateSheet = (name, brand, supplier, describe) => Object.freeze({
  name,
  brand,
  supplier,
  currency: 'Pound Sterling',
  columns: Object.freeze({
    code: 'CODE',
    description: 'DESCRIPTION',
    wholesale: 'PRICE 2026',
    unit: 'UNIT OF MEASURE',
    type: 'TYPE',
    contents: 'COMPOSITION',
    width: 'WIDTH CM',
    repeat: 'HORI REPEAT CM',
    verticalRepeat: 'VERT REPEAT CM',
  }),
  row: monroRate(describe),
})

/** JM and RSC price the colourway, so the row's own code and description stand. */
const perColourway = (values) => [values.code, values.description]

/**
 * NH prices the DESIGN, so the rate carries the code the NH sheet decomposes —
 * and its description has to be the design's too. Taking the row's own
 * description would give the colour ("New-mown Green"), which differs on every
 * one of a design's rows and would turn one rate into six conflicting ones.
 */
const perDesign = (values) => {
  const parts = NH_CODE.exec(values.code)
  if (parts === null) throw new Error(`code "${values.code}" is not an NH item code`)
  return [`${parts[1]}${parts[2]}`, parts[2]]
}

export const JEAN_MONRO = Object.freeze({
  prefix: 'Jean Monro',
  supplier: SUPPLIER,
  rateSheets: Object.freeze([
    rateSheet('JM', 'Jean Monro', SUPPLIER, perColourway),
    // The price list files this house as its own supplier; the distributor's
    // name would write a second ledger row beside the office's seventeen.
    rateSheet('NH', 'Nicky Haslam', 'Nicky Haslam', perDesign),
    // RSC is unidentified and no price list carries an RSC code, so there is no
    // supplier to file it under but the distributor who sends the workbook.
    rateSheet('RSC', 'RSC', SUPPLIER, perColourway),
  ]),
  sheets: Object.freeze([
    Object.freeze({
      name: 'JM',
      brand: 'Jean Monro',
      columns: Object.freeze({
        colourCode: 'CODE',
        design: 'name',
        colourName: 'Colour',
      }),
    }),
    Object.freeze({
      name: 'NH',
      brand: 'Nicky Haslam',
      // `DESCRIPTION` is the colour on this sheet and is filled on every row,
      // where `name` (the same value) is blank for the last fifty.
      columns: Object.freeze({ colourCode: 'CODE', colourName: 'DESCRIPTION' }),
      row: nhRecord,
    }),
    Object.freeze({
      name: 'RSC',
      // The house behind this range is unidentified; see the header comment.
      brand: 'RSC',
      columns: Object.freeze({
        colourCode: 'CODE',
        description: 'DESCRIPTION',
        colourName: 'name',
      }),
      row: rscRecord,
    }),
  ]),
})
