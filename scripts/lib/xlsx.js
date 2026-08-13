/**
 * The sliver of xlsx a worksheet export needs: the shared-string table, the
 * cell grid of a named sheet, and the two Excel-serial date conversions.
 *
 * Cells are keyed by zero-based column index derived from the `r` reference
 * ("C7" -> 2), never by position in the row, because a run of empty cells is
 * simply omitted from the XML.
 */
import { openZip } from './zip.js'
import { elements, attribute, joinTagText, decodeXmlText, namespacePrefix } from './xml.js'

const SHARED_STRINGS = 'xl/sharedStrings.xml'

// Excel's day 1 is 1900-01-01 and it wrongly counts 1900 as a leap year, which
// makes 1899-12-30 the epoch that reproduces its arithmetic.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86400000

export const openWorkbook = (buffer) => openZip(buffer)

/** The shared-string table, one entry per `<si>`, rich-text runs concatenated. */
export const sharedStrings = (zip) => {
  if (!zip.has(SHARED_STRINGS)) return []
  const xml = zip.read(SHARED_STRINGS).toString('utf8')
  const prefix = namespacePrefix(xml)
  const strings = []
  for (const item of elements(xml, `${prefix}si`)) {
    strings.push(joinTagText(xml, `${prefix}t`, item.from, item.to))
  }
  return strings
}

const columnIndex = (reference) => {
  let column = 0
  for (const char of reference ?? '') {
    const code = char.toUpperCase().charCodeAt(0)
    if (code < 65 || code > 90) break
    column = column * 26 + code - 64
  }
  return column - 1
}

const cellValue = (xml, cell, strings, prefix) => {
  const kind = attribute(cell.head, 't')
  if (kind === 'inlineStr') return joinTagText(xml, `${prefix}t`, cell.from, cell.to)
  let raw = ''
  for (const value of elements(xml, `${prefix}v`, cell.from, cell.to)) {
    raw = decodeXmlText(xml.slice(value.from, value.to))
    break
  }
  if (kind === 's' && raw !== '') return strings[Number(raw)]
  return raw
}

/**
 * Yield `[rowNumber, Map(columnIndex -> text)]` for a sheet. `rowNumber` counts
 * `<row>` elements from 1 — it is a position in the file, not the spreadsheet
 * row label, which is what makes it a stable coordinate for error messages.
 */
export function* sheetRows(zip, path, strings) {
  const xml = zip.read(path).toString('utf8')
  const prefix = namespacePrefix(xml)
  let rowNumber = 0
  for (const row of elements(xml, `${prefix}row`)) {
    rowNumber += 1
    const cells = new Map()
    for (const cell of elements(xml, `${prefix}c`, row.from, row.to)) {
      cells.set(columnIndex(attribute(cell.head, 'r')), cellValue(xml, cell, strings, prefix))
    }
    yield [rowNumber, cells]
  }
}

/** The first worksheet a price-list drop is written to. */
export const FIRST_WORKSHEET = 'xl/worksheets/sheet1.xml'

/**
 * A whole worksheet as dense row ARRAYS: `[rowNumber, cells[]]`, the shape a
 * CSV reader yields, so a caller can read a workbook and a CSV through one loop.
 * A run of empty cells is omitted from the XML, so the row is rebuilt up to its
 * own widest column and the gaps become ''.
 *
 * Lifted out of scripts/convert-price-lists.js unchanged (it took a path and
 * this takes the bytes) so the API's upload route reads a workbook by exactly
 * the rule the CLI converter does. The byte-identity gate on
 * src/seed/data/price-lists.json is the proof that lifting it changed nothing.
 */
export function* worksheetGrid(buffer, path = FIRST_WORKSHEET) {
  const zip = openWorkbook(buffer)
  const strings = sharedStrings(zip)
  for (const [rowNumber, cells] of sheetRows(zip, path, strings)) {
    let width = 0
    for (const index of cells.keys()) width = Math.max(width, index + 1)
    const row = []
    for (let index = 0; index < width; index += 1) row.push(cells.get(index) ?? '')
    yield [rowNumber, row]
  }
}

const pad = (value, width = 2) => String(value).padStart(width, '0')

const isoDate = (ms) => {
  const at = new Date(ms)
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

const isoTime = (ms) => {
  const at = new Date(ms)
  return `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
}

/** Excel serial -> `YYYY-MM-DD`, discarding any time component. */
export const excelDate = (serial) => isoDate(EXCEL_EPOCH_MS + Math.trunc(serial) * MS_PER_DAY)

/**
 * Excel serial -> `YYYY-MM-DD HH:MM:SS`, seconds truncated.
 *
 * Deliberately naive: the serial was rendered in the exporting user's local
 * time, so stamping it UTC would shift every timestamp by the NZ offset.
 */
export const excelTimestamp = (serial) => {
  const wholeDays = Math.trunc(serial)
  const secondsFloat = (serial - wholeDays) * 86400
  let seconds = Math.trunc(secondsFloat)
  // A fraction that rounds up to a whole microsecond carries into the second,
  // matching how Python's timedelta normalises before the microseconds are cut.
  if (Math.round((secondsFloat - seconds) * 1e6) >= 1e6) seconds += 1
  const ms = EXCEL_EPOCH_MS + wholeDays * MS_PER_DAY + seconds * 1000
  return `${isoDate(ms)} ${isoTime(ms)}`
}
