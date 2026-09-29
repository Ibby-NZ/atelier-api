/**
 * One Dynamics 365 worksheet export, read from its bytes into staging records.
 *
 * Lifted out of scripts/convert-d365-exports.js unchanged (it took a path and
 * this takes the bytes and the file's name) so the API can read an uploaded
 * export by exactly the rule the CLI converter does — the house-pricing import
 * (src/pricing/house-pricing-import.js) takes the "Active Tracking Options"
 * workbook straight from the CRM. Running the converter over the same file
 * before and after the lift produced a byte-identical tracking_options.json.
 *
 * The exports are D365 *dynamic* worksheets, which is what makes this reliable:
 *
 *   sheet.xml   holds `<entity>:<signature>:<logical_name>=<Display Name>&...`
 *   sheet2.xml  holds the data grid, column order matching that map
 *
 * So columns are identified by their D365 LOGICAL name, never by the display
 * name a user could rename in the view, and never by position.
 */
import { openWorkbook, sharedStrings, sheetRows, excelDate, excelTimestamp } from './xlsx.js'
import { parseNumber } from './python-format.js'
import {
  ENTITIES, IGNORED, SENSITIVE_PREFIXES, WILDCARD, NUM, DATE, DATETIME, BOOL,
} from './d365-entities.js'

const SCHEMA_SHEET = 'xl/worksheets/sheet.xml'
const DATA_SHEET = 'xl/worksheets/sheet2.xml'
const CHECKSUM_COLUMN = 1

// Filenames carry the export timestamp: "Customers 29-07-2026 9-50-28 AM.xlsx".
const EXPORTED_AT_PATTERN =
  /(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2})-(\d{2})-(\d{2})\s*(AM|PM)?/i

// D365 renders two-option fields by their label, and the consent fields use a
// label set whose polarity is the OPPOSITE of the word: the underlying attribute
// is `donotemail` / `donotsendmm`, so "Allow" and "Send" mean the do-not flag is
// FALSE. Staging keeps the source polarity — the columns are named `do_not_*` to
// match, and interpretation happens downstream. Getting this backwards would
// invert consent.
const BOOLEANS = new Map([
  ['yes', true], ['no', false], ['true', true], ['false', false], ['1', true], ['0', false],
  ['allow', false], ['do not allow', true],
  ['send', false], ['do not send', true],
])

const pad = (value, width = 2) => String(value).padStart(width, '0')

export const exportedAt = (stem) => {
  const match = EXPORTED_AT_PATTERN.exec(stem)
  if (!match) return null
  const [, day, month, year, rawHour, minute, second, meridiem] = match
  let hour = Number(rawHour) % 12
  if ((meridiem ?? '').toUpperCase() === 'PM') hour += 12
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`
}

/** Exact logical name wins; a dotted related-entity column falls back to `*.suffix`. */
const resolveColumn = (logical, columns) => {
  if (Object.hasOwn(columns, logical)) return columns[logical]
  const dot = logical.indexOf('.')
  if (dot === -1) return null
  const wildcard = WILDCARD + logical.slice(dot + 1)
  return Object.hasOwn(columns, wildcard) ? columns[wildcard] : null
}

/** The first cell of sheet.xml: '<entity>:<signature>:<logical>=<Display>&...'. */
const readSchemaMap = (zip, strings) => {
  for (const [, cells] of sheetRows(zip, SCHEMA_SHEET, strings)) {
    const header = cells.get(0)
    if (header !== undefined && header.includes(':')) {
      const first = header.indexOf(':')
      const second = header.indexOf(':', first + 1)
      if (second === -1) break
      const entity = header.slice(0, first)
      const logicalNames = header.slice(second + 1).split('&').map((pair) => pair.split('=')[0])
      return { entity, logicalNames }
    }
    break
  }
  throw new Error('no D365 schema map in sheet.xml — is this a dynamic worksheet export?')
}

/**
 * Which D365 entity an export is a view of, without reading its rows — so a
 * caller that wants one entity can say "that is the accounts export" before
 * the column check lists ninety columns the file was never meant to have.
 *
 * @param {Buffer} buffer the .xlsx bytes
 * @returns {string} the entity's logical name
 */
export const d365WorkbookEntity = (buffer) => d365WorkbookSchema(buffer).entity

/**
 * The export's entity and its columns' logical names, in file order — for a
 * reader of a narrow view that ENTITIES does not describe (the Stock View).
 *
 * @param {Buffer} buffer the .xlsx bytes
 * @returns {{ entity: string, logicalNames: string[] }}
 */
export const d365WorkbookSchema = (buffer) => {
  const zip = openWorkbook(buffer)
  return readSchemaMap(zip, sharedStrings(zip))
}

const coerce = (value, kind) => {
  if (kind === NUM) return parseNumber(value)
  if (kind === DATE) return excelDate(parseNumber(value))
  if (kind === DATETIME) return excelTimestamp(parseNumber(value))
  if (kind === BOOL) {
    const coerced = BOOLEANS.get(value.toLowerCase())
    if (coerced === undefined) throw new Error(`unmappable boolean "${value}"`)
    return coerced
  }
  return value
}

/**
 * Read one export. Throws on a file that is not a D365 dynamic worksheet, an
 * entity ENTITIES does not know, or a missing required column; a cell that
 * cannot be coerced is pushed onto `errors` as `<name>:<row>: <column>: <why>`
 * and the rest of the file is still read, so a caller can report every problem
 * at once.
 *
 * Records are Maps in the converter's key order — `source_file`,
 * `exported_at`, the mapped columns in file order, `row_checksum`, `raw` —
 * because the normalised JSON is written straight from them.
 *
 * @param {Buffer} buffer the .xlsx bytes
 * @param {string} name the file's name — the export stamp is read from it
 * @param {string[]} errors collects per-cell problems
 * @returns {{ entity: string, table: string, records: Map<string, unknown>[] }}
 */
export const readD365Workbook = (buffer, name, errors) => {
  const zip = openWorkbook(buffer)
  const strings = sharedStrings(zip)
  const { entity, logicalNames } = readSchemaMap(zip, strings)
  const definition = ENTITIES[entity]
  if (!definition) throw new Error(`unknown D365 entity "${entity}" — add it to ENTITIES`)

  const matched = new Set()
  for (const logical of logicalNames) {
    matched.add(logical)
    const dot = logical.indexOf('.')
    matched.add(WILDCARD + (dot === -1 ? '' : logical.slice(dot + 1)))
  }
  const missing = Object.keys(definition.columns).filter((key) => !matched.has(key))
  if (missing.length > 0) {
    throw new Error(`export is missing required column(s): ${missing.sort().join(', ')}`)
  }

  const stamp = exportedAt(name.replace(/\.xlsx$/i, ''))
  const records = []
  for (const [lineNumber, cells] of sheetRows(zip, DATA_SHEET, strings)) {
    if (lineNumber === 1) continue // header row of display names
    const record = new Map([['source_file', name], ['exported_at', stamp]])
    const raw = new Map()
    for (const [index, logical] of logicalNames.entries()) {
      const value = (cells.get(index) ?? '').trim()
      if (!value) continue
      if (IGNORED.has(logical) || SENSITIVE_PREFIXES.some((p) => logical.startsWith(p))) continue
      raw.set(logical, value)
      const target = resolveColumn(logical, definition.columns)
      if (!target) continue
      const [column, kind] = target
      try {
        record.set(column, coerce(value, kind))
      } catch (error) {
        errors.push(`${name}:${lineNumber}: ${column}: ${error.message}`)
      }
    }
    record.set('row_checksum', (cells.get(CHECKSUM_COLUMN) ?? '').trim() || null)
    record.set('raw', raw)
    if (!record.get('guid')) {
      errors.push(`${name}:${lineNumber}: missing record GUID`)
      continue
    }
    records.push(record)
  }
  return { entity, table: definition.table, records }
}
