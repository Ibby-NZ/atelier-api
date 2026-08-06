/**
 * Madeaux — a DESIGN-level list whose colourways are prose.
 *
 * Every other file in this corpus prints one row per colourway. Madeaux prints
 * one row per design and names that design's colours inside the composition
 * cell: "100% Linen\nColours: 01 Stone, 02 Straw, 03 Marine". So one row yields
 * three records, and the mapper returns an array.
 *
 * The sheet is also sectioned — FABRICS, TRIMMINGS, WALLPAPERS, GRASSCLOTH
 * WALLPAPERS — with a banner, a repeated header row and a few free-text notes
 * between the sections. The repeated headers the shared reader recognises on
 * its own; the banners and notes are what the blank-`Colours` rule below is
 * for. Over the whole file: 193 rows -> 452 colourways, 43 rows declined, none
 * unparseable.
 */
import { skip } from './records.js'
import { normaliseLabel } from '../colour-sheet.js'

/** The one label every section of this sheet spells the same way. */
const DESIGN_LABEL = 'Design Name'

/**
 * `01 Stone` in a comma- or newline-separated list.
 *
 * The name must START WITH A LETTER, which is what keeps the same tokeniser
 * usable on the `Colours` cell: that column holds ranges ("01 - 03", "01 - 05\n
 * 07 - 10") for a fabric and an actual colour ("01 Charcoal") for a trimming,
 * and a range must not be read as a colour called "- 03".
 */
const COLOUR = /(?:^|[,\n])\s*(\d{2})\s+([A-Za-z][^,\n]*)/g

/** Anything after a "Colours:" lead-in, or the whole cell when there is none. */
const colourList = (cell) => {
  const leadIn = /colours?\s*:/i.exec(cell)
  const body = leadIn === null ? cell : cell.slice(leadIn.index + leadIn[0].length)
  return [...body.matchAll(COLOUR)].map((match) => [match[1], match[2].trim()])
}

/**
 * The design name, which several cells hang an annotation under: "AVIARY\n
 * *MATCHING FABRIC\nAVAILABLE TO ORDER". The first non-empty line is the name.
 */
const designName = (cell) => cell.split('\n').map((line) => line.trim()).find(Boolean) ?? ''

const madeauxRecords = (values) => {
  // A banner ("WALLPAPERS"), a note ("LEAD TIME 3 WEEKS FROM ORDER") and the
  // merged banner-and-header row above the trimmings all leave `Colours` empty,
  // and no data row in the file does. Declining them is not the same as failing
  // to map one: a row that should have yielded and did not throws, below.
  if (values.colours === '') return skip('section banner or note')
  const design = designName(values.design)
  if (design === '') throw new Error('row names colours but no design')
  // Most sections list the colours against the composition; the trimmings put
  // them in the `Colours` cell instead.
  const found = colourList(values.composition)
  const colours = found.length > 0 ? found : colourList(values.colours)
  if (colours.length === 0) {
    throw new Error(`no colours in "${values.composition}" or "${values.colours}"`)
  }
  return colours.map(([colourCode, colourName]) => ({ design, colourCode, colourName }))
}

/**
 * The rate side of the same sheet, which is where its sections start to matter.
 *
 * The price list keys Madeaux on the DESIGN NAME (`ALLEGRIA`, `AUDREY SILK`),
 * which is exactly what this sheet is a list of, so one row is one rate — the
 * only file in the corpus where the colourway grain and the rate grain differ
 * by construction rather than by collapse.
 *
 * What the sections change is the price's UNIT, and the sheet says so in its own
 * section headers: `Export/m` over the fabrics and the trimmings, `Export/ Roll`
 * over the wallpapers. The column map cannot see a mid-sheet header, so the row
 * has to tell them apart, and its composition cell does: `Non-Woven Paper` and
 * `Grasscloth` are the wallpapers, a composition that names no colours at all is
 * a trimming (the three of them put their colour in the `Colours` cell instead),
 * and everything else is fabric. Checked against the office's own Madeaux rows,
 * which agree on the category for every design they carry.
 */
const madeauxRate = (values) => {
  // Each section reprints the header with its own price label ("Export/ Roll",
  // "Export"), so the shared repeated-header rule — every declared cell equal to
  // its own label — does not recognise it. `Design Name` is the label that does
  // not change between the sections.
  if (normaliseLabel(values.design) === normaliseLabel(DESIGN_LABEL)) {
    return skip("a section's own header row")
  }
  if (values.colours === '') return skip('section banner or note')
  const design = designName(values.design)
  if (design === '') throw new Error('row names colours but no design')
  // The grasscloth section states two rates in one cell ("£35/m\n£350/roll").
  // Declining is the only honest reading: picking one would be choosing what
  // the office buys by, and neither is written in a cell of its own.
  if (/£/.test(values.wholesale)) return skip('two rates stated in one cell')
  const composition = values.composition.toLowerCase()
  const wallpaper = composition.includes('paper') || composition.includes('grasscloth')
  const trimming = !wallpaper && colourList(values.composition).length === 0
  return {
    code: design,
    description: design,
    itemType: wallpaper ? 'Wallpaper' : (trimming ? 'Trimmings' : 'Fabrics'),
    packType: wallpaper ? 'p/roll' : 'p/m',
    contents: values.composition.split('\n')[0],
    width: values.width,
    verticalRepeat: values.repeat,
    wholesale: values.wholesale,
  }
}

export const MADEAUX = Object.freeze({
  prefix: 'Madeaux',
  supplier: 'Madeaux',
  rateSheets: Object.freeze([
    Object.freeze({
      name: 'UK Export',
      brand: 'Madeaux',
      currency: 'Pound Sterling',
      // "Export/m" is the rate for a UK export customer, which is what Atelier
      // is; "Trade/m Ex VAT" is the UK trade price and is not read.
      columns: Object.freeze({
        design: DESIGN_LABEL,
        colours: 'Colours',
        composition: 'Composition & Colours',
        wholesale: 'Export/m',
        width: 'Width CM',
        repeat: 'Repeat CM',
      }),
      row: madeauxRate,
    }),
  ]),
  sheets: Object.freeze([
    Object.freeze({
      name: 'UK Export',
      brand: 'Madeaux',
      columns: Object.freeze({
        design: DESIGN_LABEL,
        colours: 'Colours',
        composition: 'Composition & Colours',
      }),
      row: madeauxRecords,
    }),
  ]),
})
