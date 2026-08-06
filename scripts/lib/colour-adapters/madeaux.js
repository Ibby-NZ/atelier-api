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
  if (values.colours === '') return []
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

export const MADEAUX = Object.freeze({
  prefix: 'Madeaux',
  supplier: 'Madeaux',
  sheets: Object.freeze([
    Object.freeze({
      name: 'UK Export',
      brand: 'Madeaux',
      columns: Object.freeze({
        design: 'Design Name',
        colours: 'Colours',
        composition: 'Composition & Colours',
      }),
      row: madeauxRecords,
    }),
  ]),
})
