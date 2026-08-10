#!/usr/bin/env node
/**
 * Convert the Dynamics 365 worksheet exports in incoming/data-exports/ into the
 * normalised JSON consumed by `npm run import:legacy`.
 *
 * Same shape and posture as convert-price-lists.js: no dependencies, XLSX read
 * straight from the zip, fails loudly (file:row list, writes nothing) on
 * anything it cannot map. See docs/d365-export-analysis.md for what the exports
 * contain.
 *
 * The exports are D365 *dynamic* worksheets, which is what makes this reliable:
 *
 *   sheet.xml   holds `<entity>:<signature>:<logical_name>=<Display Name>&...`
 *   sheet2.xml  holds the data grid, column order matching that map
 *
 * So columns are identified by their D365 LOGICAL name, never by the display
 * name a user could rename in the view, and never by position.
 *
 * Output is written next to the exports (incoming/ is gitignored) because the
 * account and sales-order data is client PII and must not land in
 * src/seed/data/.
 *
 * Usage: node scripts/convert-d365-exports.js [input-dir] [output-dir]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openWorkbook, sharedStrings, sheetRows, excelDate, excelTimestamp } from './lib/xlsx.js'
import { parseNumber, dumpsIndented } from './lib/python-format.js'
import {
  ENTITIES, IGNORED, SENSITIVE_PREFIXES, WILDCARD, NUM, DATE, DATETIME, BOOL,
} from './lib/d365-entities.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'data-exports')
const DEFAULT_OUT = join(DEFAULT_IN, 'normalized')

const SCHEMA_SHEET = 'xl/worksheets/sheet.xml'
const DATA_SHEET = 'xl/worksheets/sheet2.xml'
const CHECKSUM_COLUMN = 1
const MAX_REPORTED_ERRORS = 50

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

const exportedAt = (stem) => {
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

const convertFile = (path, errors) => {
  const name = basename(path)
  const zip = openWorkbook(readFileSync(path))
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
  return { table: definition.table, records }
}

const main = (inDir, outDir) => {
  const files = readdirSync(inDir)
    .filter((name) => name.endsWith('.xlsx') && !name.startsWith('~$'))
    .map((name) => join(inDir, name))
    .sort()
  if (files.length === 0) {
    process.stderr.write(`no .xlsx exports in ${inDir}\n`)
    process.exitCode = 1
    return
  }

  const errors = []
  const byTable = new Map()
  for (const path of files) {
    const name = basename(path)
    let converted
    try {
      converted = convertFile(path, errors)
    } catch (error) {
      errors.push(`${name}: ${error.message}`)
      continue
    }
    // A repeated export of the same view (e.g. the stray "Export.xlsx") would
    // otherwise double every row; dedupe on the D365 GUID, keeping the first.
    if (!byTable.has(converted.table)) byTable.set(converted.table, new Map())
    const bucket = byTable.get(converted.table)
    let duplicates = 0
    for (const record of converted.records) {
      const guid = record.get('guid')
      if (bucket.has(guid)) {
        duplicates += 1
        continue
      }
      bucket.set(guid, record)
    }
    const note = duplicates ? ` (${duplicates} duplicate rows skipped)` : ''
    process.stderr.write(`  ${name}: ${converted.records.length} rows -> ${converted.table}${note}\n`)
  }

  if (errors.length > 0) {
    process.stderr.write(`\n${errors.length} problem(s); nothing written:\n`)
    for (const line of errors.slice(0, MAX_REPORTED_ERRORS)) process.stderr.write(`  ${line}\n`)
    if (errors.length > MAX_REPORTED_ERRORS) {
      process.stderr.write(`  ... and ${errors.length - MAX_REPORTED_ERRORS} more\n`)
    }
    process.exitCode = 1
    return
  }

  mkdirSync(outDir, { recursive: true })
  for (const table of [...byTable.keys()].sort()) {
    const bucket = byTable.get(table)
    const target = join(outDir, `${table}.json`)
    writeFileSync(target, dumpsIndented([...bucket.values()], 0), 'utf8')
    process.stderr.write(`wrote ${relative(REPO, target)} (${bucket.size} records)\n`)
  }
}

const [inDir = DEFAULT_IN, outDir = DEFAULT_OUT] = process.argv.slice(2)
try {
  main(inDir, outDir)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
