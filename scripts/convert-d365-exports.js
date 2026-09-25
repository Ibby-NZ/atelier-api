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
import { dumpsIndented } from './lib/python-format.js'
import { readD365Workbook } from './lib/d365-workbook.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'data-exports')
const DEFAULT_OUT = join(DEFAULT_IN, 'normalized')

const MAX_REPORTED_ERRORS = 50

// The per-file reading lives in lib/d365-workbook.js, shared with the API's
// house-pricing upload so both read an export by the same rule.
const convertFile = (path, errors) => {
  const { table, records } = readD365Workbook(readFileSync(path), basename(path), errors)
  return { table, records }
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
