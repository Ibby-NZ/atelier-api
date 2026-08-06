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
 * (Madeaux lists a design's colours in one cell), or `skip(reason)` for a row it
 * deliberately declines. Anything it cannot map it throws, and the coordinates
 * are added here.
 *
 * A DECLINED row and a row that FAILED to map must never look the same, which
 * is why a decline states its reason: every large file mixes non-stock rows into
 * its stock sheets (sample books, cuttings, a translation dictionary, substrate
 * prices) and the summary has to be able to say which, and how many, rather than
 * reporting a number nobody can account for.
 */
import { normaliseLabel } from '../colour-sheet.js'

/** The fields a record carries. A mapper may set any of them. */
export const RECORD_FIELDS = Object.freeze([
  'brand', 'design', 'designCode', 'colourCode', 'colourName',
])

/** What a sheet must declare to go without a `row` mapper. */
export const REQUIRED_COLUMNS = Object.freeze(['design', 'colourCode', 'colourName'])

/** The two skips the reader owns, plus the bucket a reasonless decline lands in. */
export const BLANK_ROW = 'blank row'
export const REPEATED_HEADER = 'repeats the header'
export const UNSTATED = 'declined, no reason stated'

const SKIP = Symbol('colourway skip')

/**
 * What a mapper returns for a row it declines on purpose. The reason is what the
 * per-file summary counts by, so it names the KIND of row ("sample cutting"),
 * never this one row.
 */
export const skip = (reason) => {
  const stated = String(reason ?? '').trim()
  if (stated === '') throw new Error('a declined row must state a reason')
  return Object.freeze({ [SKIP]: stated })
}

/** The reason a mapper result declines the row, or null when it produced records. */
export const skipReason = (produced) =>
  (typeof produced === 'object' && produced !== null && SKIP in produced ? produced[SKIP] : null)

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

const asList = (produced) => {
  if (produced === null || produced === undefined) return []
  return Array.isArray(produced) ? produced : [produced]
}

/**
 * What every data row of one opened sheet came to: `{ rowNumber }` plus exactly
 * one of `record`, `skip` (the stated reason) or `error` (already carrying
 * `file:sheet:row`, the coordinate the price-list converter reports in — the row
 * is the position of the `<row>` element, not the spreadsheet's row label).
 *
 * A row that throws does NOT stop the read: an operator fixing a supplier file
 * needs every bad row in one list, not the first one over and over. Deciding
 * what to do with the list is the caller's — `sheetColourways` throws on it and
 * the converter collects it, aborts that file and writes nothing.
 */
export function* sheetReadings(sheet, spec, source = '') {
  const map = spec.row ?? asRecord
  const at = source === '' ? sheet.name : `${source}:${sheet.name}`
  for (const [rowNumber, cells] of sheet.rows) {
    if (isBlank(cells)) {
      yield { rowNumber, skip: BLANK_ROW }
      continue
    }
    const values = sheet.select(cells)
    if (repeatsHeader(values, spec.columns)) {
      yield { rowNumber, skip: REPEATED_HEADER }
      continue
    }
    let produced
    try {
      produced = map(values)
    } catch (error) {
      yield { rowNumber, error: `${at}:${rowNumber}: ${error.message}` }
      continue
    }
    const declined = skipReason(produced)
    if (declined !== null) {
      yield { rowNumber, skip: declined }
      continue
    }
    const records = asList(produced)
    // A mapper that declined by returning nothing rather than by `skip(reason)`.
    // It is counted, not silently absorbed, so the summary never reports rows
    // the file cannot account for.
    if (records.length === 0) {
      yield { rowNumber, skip: UNSTATED }
      continue
    }
    for (const record of records) yield { rowNumber, record: toColourway(spec, record) }
  }
}

/**
 * Colourway records for one opened sheet, with the row number each came from.
 *
 * The strict view: a row that could not be mapped throws here, so a caller that
 * only wants the records cannot walk past one.
 */
export function* sheetColourways(sheet, spec, source = '') {
  for (const reading of sheetReadings(sheet, spec, source)) {
    if (reading.error !== undefined) throw new Error(reading.error)
    if (reading.record !== undefined) yield [reading.rowNumber, reading.record]
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
