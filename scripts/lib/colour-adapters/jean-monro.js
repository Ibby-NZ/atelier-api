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

export const JEAN_MONRO = Object.freeze({
  prefix: 'Jean Monro',
  supplier: SUPPLIER,
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
