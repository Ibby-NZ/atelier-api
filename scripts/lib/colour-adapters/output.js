/**
 * The normalised colourway file: what a record looks like once it is written
 * down, and what happens when two files say the same thing.
 *
 * Keys are snake_case, like every other normalised file this repo writes, and
 * each row keeps the coordinate it came from (`source_file`/`source_sheet`/
 * `source_row`). Provenance is the one thing that cannot be recovered later —
 * a row that turns out to be wrong is a row somebody has to find in a supplier's
 * spreadsheet.
 *
 * Serialisation is plain `JSON.stringify`, NOT lib/python-format.js. That module
 * exists to reproduce the bytes a Python converter once wrote for the committed
 * price-lists.json; this file has no such history and is gitignored, so there is
 * nothing to pin.
 */

/** The record's own fields, in the order they are written. */
const IDENTITY = Object.freeze([
  'supplier', 'brand', 'design', 'design_code', 'colour_code', 'colour_name',
])

/** One entry of a file reading, as the normalised file spells it. */
export const colourwayRow = (file, supplier, { sheet, rowNumber, record }) => Object.freeze({
  supplier,
  brand: record.brand,
  design: record.design,
  design_code: record.designCode,
  colour_code: record.colourCode,
  colour_name: record.colourName,
  source_file: file,
  source_sheet: sheet,
  source_row: rowNumber,
})

const keyOf = (row, fields) => JSON.stringify(fields.map((field) => row[field]))

/** Where a row came from, as `file:sheet:row`. */
export const rowSource = (row) => `${row.source_file}:${row.source_sheet}:${row.source_row}`

/**
 * Collect the rows of every file into the one output, keeping the first of any
 * exact repeat.
 *
 * Two DIFFERENT rules, deliberately, because the corpus has both:
 *
 * - An EXACT repeat — every field but the coordinate equal — is dropped and
 *   counted. 1,159 of 47,082 rows are one: Liberty's two sheets overlap without
 *   either containing the other, Jim Thompson's spring drop is a strict subset
 *   of its annual one, and Maria Flora reprints 73 of its own rows. Keeping them
 *   would put the same colourway in the catalogue several times over.
 * - A CLASH — the same house, design and colour code carrying a different name —
 *   is reported and BOTH rows are kept. There are seven, all of them the
 *   supplier's own inconsistency (Madeaux reprints a design in a second section
 *   as "Bluegrass" for "Blue Grass"; Maria Flora writes one colour "Lino" and
 *   again "Linen"). Dropping one would mean choosing, on a key nothing has
 *   ratified — the colourway SKU's shape is the import's decision, not this
 *   file's — so the run says which rows disagree and lets a person settle it.
 */
export const collectColourways = (rows) => {
  const seen = new Map()
  const identities = new Map()
  const records = []
  const clashes = []
  let duplicates = 0
  for (const row of rows) {
    const exact = keyOf(row, IDENTITY)
    if (seen.has(exact)) {
      duplicates += 1
      continue
    }
    seen.set(exact, row)
    const identity = keyOf(row, ['brand', 'design', 'colour_code'])
    const earlier = identities.get(identity)
    if (earlier === undefined) identities.set(identity, row)
    else clashes.push({ row, earlier })
    records.push(row)
  }
  return Object.freeze({ records, duplicates, clashes })
}

/** The normalised file: one record per line, so a diff reads row by row. */
export const serialiseColourways = (records) => (records.length === 0
  ? '[]\n'
  : `[\n${records.map((record) => JSON.stringify(record)).join(',\n')}\n]\n`)

/**
 * The same records as the CRM's Supplier Colours upload takes them: one sheet,
 * the five headings `src/catalogue/supplier-colours-import.js` finds it by, one
 * row per colourway. That upload lands rows through the same importer as
 * `npm run import:colour`, so this is how a converted drop reaches a database
 * the converter cannot connect to (production). The coordinates and the design
 * code do not survive the trip — the upload has no column for either.
 */
export const SUPPLIER_COLOURS_HEADER = Object.freeze([
  'Supplier', 'Brand', 'Product Name', 'Code', 'Colour',
])

export const supplierColoursSheet = (records) => Object.freeze({
  name: 'Supplier Colours',
  rows: [
    SUPPLIER_COLOURS_HEADER,
    ...records.map((row) => [row.supplier, row.brand, row.design, row.colour_code, row.colour_name]),
  ],
})
