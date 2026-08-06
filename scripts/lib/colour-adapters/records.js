/**
 * What an adapter yields: colourway records, one or more per data row.
 *
 * The record is the primary output of the whole pipeline — brand, design,
 * supplier colour code, colour name — plus `designCode` where the supplier
 * prints a code for the design itself. That fifth field is not decoration: it
 * is the code the supplier's PRICE list keys on (Maria Flora's pattern number,
 * Perennials' quality), so keeping it is what lets a later story emit rates
 * without re-reading the file. It is NOT the colour code and the two must never
 * be joined to `price_list_items.code` — see CLAUDE.md.
 *
 * A sheet declares its columns and, where the layout needs it, a `row` mapper.
 * The mapper receives the selected cells and returns a record, an array of them
 * (Madeaux lists a design's colours in one cell), or nothing at all for a row it
 * deliberately declines. Anything it cannot map it throws, and the coordinates
 * are added here.
 */
import { normaliseLabel } from '../colour-sheet.js'

/** The fields a record carries. A mapper may set any of them. */
export const RECORD_FIELDS = Object.freeze([
  'brand', 'design', 'designCode', 'colourCode', 'colourName',
])

/** What a sheet must declare to go without a `row` mapper. */
export const REQUIRED_COLUMNS = Object.freeze(['design', 'colourCode', 'colourName'])

const text = (value) => String(value ?? '').trim()

const isBlank = (cells) => !cells.some((cell) => String(cell).trim() !== '')

/**
 * Normalise one mapper result into a frozen record.
 *
 * `brand` falls back to the sheet's declared house, so only a sheet whose file
 * carries a Brand column has to say anything about it per row.
 */
export const toColourway = (spec, produced) => Object.freeze({
  brand: text(produced.brand ?? spec.brand),
  design: text(produced.design),
  designCode: text(produced.designCode),
  colourCode: text(produced.colourCode),
  colourName: text(produced.colourName),
})

/**
 * A row that repeats the header, which several of these files carry mid-sheet:
  * Liberty repeats its header once in each of its two sheets and Madeaux
 * repeats its four times, under the section banners. `openSheet` matches the
 * FIRST header row, so every later copy arrives here as a data row whose cells
 * are its own column labels — recognising it costs nothing and is the same
 * declaration the header was found by.
 */
const repeatsHeader = (values, columns) => Object.entries(columns)
  .every(([field, label]) => normaliseLabel(values[field]) === normaliseLabel(label))

/** The identity mapper: the declared columns already ARE the record's fields. */
const asRecord = (values) => values

/**
 * Colourway records for one opened sheet, with the row number each came from.
 *
 * A mapper's own error is rethrown carrying `file:sheet:row`, the coordinate the
 * price-list converter reports in — the row is the position of the `<row>`
 * element, not the spreadsheet's row label.
 */
export function* sheetColourways(sheet, spec, source = '') {
  const map = spec.row ?? asRecord
  for (const [rowNumber, cells] of sheet.rows) {
    if (isBlank(cells)) continue
    const values = sheet.select(cells)
    if (repeatsHeader(values, spec.columns)) continue
    let produced
    try {
      produced = map(values)
    } catch (error) {
      throw new Error(`${source === '' ? '' : `${source}:`}${sheet.name}:${rowNumber}: ${error.message}`)
    }
    if (produced === null || produced === undefined) continue
    for (const record of Array.isArray(produced) ? produced : [produced]) {
      yield [rowNumber, toColourway(spec, record)]
    }
  }
}

/** Every colourway an adapter reads out of an open workbook. */
export function* colourways(workbook, adapter) {
  for (const spec of adapter.sheets) {
    const sheet = workbook.open(spec)
    for (const [rowNumber, record] of sheetColourways(sheet, spec, workbook.source)) {
      yield { sheet: sheet.name, rowNumber, record }
    }
  }
}
