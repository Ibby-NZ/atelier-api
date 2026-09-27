#!/usr/bin/env node
/**
 * Convert the supplier colour spreadsheets in incoming/colour-files/ into the
 * normalised colourway file incoming/colour-files/normalized/colourways.json,
 * and the 2026 rates they carry into incoming/colour-files/normalized/rates.csv.
 * The colourways are also written as supplier-colours.xlsx beside the json: the
 * workbook the CRM's Supplier Colours upload takes, so a drop converted here can
 * be landed on a database this script cannot reach.
 *
 * Two outputs, because these files are price lists as well as colour lists.
 * The colourways are the primary output and their shape is this pipeline's own;
 * the rates are emitted in the office's UNIVERSAL PRICING TEMPLATE, header row
 * and all, so they go on through `npm run convert:pricing` and the same
 * vocabularies, code normalisation and importer as every other supplier drop
 * rather than through a second private path. See lib/colour-adapters/
 * rate-template.js.
 *
 * No dependencies — the workbooks are read straight from the zip by
 * lib/colour-sheet.js, which locates each sheet's header row by matching the
 * labels the adapter declares. lib/colour-adapters/ is the registry that says
 * which layout a filename is, lib/colour-adapters/reading.js reads one file
 * through it and lib/colour-adapters/output.js is the file that comes out.
 *
 * Same posture as the two converters beside it: FAIL LOUDLY AND WRITE NOTHING.
 * A row the adapter cannot map aborts that file — every one of its rows is
 * listed as `file:sheet:row` rather than only the first, because a supplier who
 * changed one thing usually changed several — and any aborted file at all means
 * the run writes no output. A half-written catalogue is worse than none: the
 * missing houses look exactly like houses the supplier stopped carrying.
 *
 * Output lands under incoming/ (gitignored) and NEVER in src/seed/data/, the
 * same rule the D365 exports follow: these are the client's own price and
 * catalogue files, not repo data. Nothing here writes to, moves or deletes a
 * supplier drop — only the normalized/ directory beside them.
 *
 * Usage: node scripts/convert-colour-files.js [input-dir] [output-json] [rates-csv]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openColourWorkbook } from './lib/colour-sheet.js'
import { matchAdapter, registeredPrefixes } from './lib/colour-adapters/index.js'
import { readColourFile, readRateFile } from './lib/colour-adapters/reading.js'
import {
  colourwayRow, collectColourways, serialiseColourways, rowSource, supplierColoursSheet,
} from './lib/colour-adapters/output.js'
import { buildWorkbook } from './lib/xlsx-write.js'
import { collectRates, serialiseRates, verifyRates } from './lib/colour-adapters/rate-template.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'colour-files')
const DEFAULT_OUT = join(DEFAULT_IN, 'normalized', 'colourways.json')
const DEFAULT_RATES = join(DEFAULT_IN, 'normalized', 'rates.csv')

// Enough to see the shape of what broke without burying the summary. The count
// is always reported in full.
const MAX_REPORTED = 50

const write = (stream, lines) => {
  for (const line of lines) stream.write(`${line}\n`)
}

const capped = (lines, indent) => {
  const shown = lines.slice(0, MAX_REPORTED).map((line) => `${indent}${line}`)
  return lines.length > MAX_REPORTED
    ? [...shown, `${indent}... and ${lines.length - MAX_REPORTED} more`]
    : shown
}

/** "587 sample cutting, 3 header translation" — what a sheet declined, by kind. */
const skipNote = (skips) => (skips.length === 0
  ? ''
  : `, ${skips.reduce((total, [, count]) => total + count, 0)} skipped (`
    + `${skips.map(([reason, count]) => `${count} ${reason}`).join(', ')})`)

const sheetLine = (file, sheet, of = 'colourway') =>
  `${file}:${sheet.name}: header row ${sheet.headerRow}, ${sheet.rows} row(s) in, `
  + `${sheet.records} ${of}(s) out${skipNote(sheet.skips)}`

/** Every skip reason across the run, in first-seen order, with its total. */
const totalSkips = (readings) => {
  const totals = new Map()
  for (const reading of readings) {
    for (const sheet of reading.sheets) {
      for (const [reason, count] of sheet.skips) totals.set(reason, (totals.get(reason) ?? 0) + count)
    }
  }
  return [...totals]
}

const sum = (readings, of) => readings.reduce((total, reading) =>
  total + reading.sheets.reduce((inner, sheet) => inner + sheet[of], 0), 0)

const convert = (inputDir, outputPath, ratesPath) => {
  const names = readdirSync(inputDir, { withFileTypes: true })
    // A drop is a FILE. The default output goes to normalized/ inside this very
    // directory, so a second run would otherwise meet its own output directory
    // and report it as a file nobody has mapped.
    .filter((entry) => entry.isFile())
    // macOS writes .DS_Store into every folder it opens; it is not a supplier drop.
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
  if (names.length === 0) throw new Error(`no colour files found in ${inputDir}`)

  const readings = []
  const rateReadings = []
  const declined = []
  const unknown = []
  const failed = []
  const rows = []
  const rates = []

  for (const name of names) {
    const adapter = matchAdapter(name)
    if (adapter === null) {
      unknown.push(name)
      continue
    }
    if (adapter.unsupported !== undefined) {
      declined.push(`${name}: ${adapter.unsupported}`)
      continue
    }
    let reading
    let rateReading
    try {
      const workbook = openColourWorkbook(readFileSync(join(inputDir, name)), basename(name))
      reading = readColourFile(workbook, adapter)
      // The rate sheets are read in a pass of their own: most files price on
      // the sheet the colourways come off, but they want different cells and
      // Jim Thompson keeps the two on different sheets entirely.
      rateReading = readRateFile(workbook, adapter)
    } catch (error) {
      // The workbook itself would not open — not a row problem, but the same
      // verdict: this file yields nothing and the run writes nothing.
      failed.push({ name, errors: [`${name}: ${error.message}`] })
      continue
    }
    readings.push(reading)
    rateReadings.push(rateReading)
    write(process.stdout, reading.sheets.map((sheet) => `  ${sheetLine(name, sheet)}`))
    write(process.stdout, rateReading.sheets.map((sheet) => `  ${sheetLine(name, sheet, 'rate')}`))
    // A file with any unmappable row contributes NO rows, whatever else it read.
    const errors = [...reading.errors, ...rateReading.errors]
    if (errors.length > 0) {
      failed.push({ name, errors })
      continue
    }
    for (const entry of reading.entries) rows.push(colourwayRow(name, adapter.supplier, entry))
    rates.push(...rateReading.entries)
  }

  if (declined.length > 0) {
    process.stdout.write(`Unsupported by declaration, ${declined.length} file(s):\n`)
    write(process.stdout, declined.map((entry) => `  ${entry}`))
  }

  // An unknown file is the one thing that must fail the run on its own: a drop
  // nobody has mapped looks exactly like a drop that imported cleanly if it is
  // only skipped.
  if (unknown.length > 0) {
    process.stderr.write(`${unknown.length} unsupported file(s) — no adapter is registered for:\n`)
    write(process.stderr, unknown.map((name) => `  ${name}`))
    const prefixes = registeredPrefixes()
    process.stderr.write(`Registered prefixes: ${prefixes.length > 0 ? prefixes.join(', ') : '(none)'}\n`)
  }

  if (failed.length > 0) {
    const total = failed.reduce((count, file) => count + file.errors.length, 0)
    process.stderr.write(`${failed.length} file(s) aborted, ${total} unmappable row(s) `
      + `— nothing written:\n`)
    for (const file of failed) {
      process.stderr.write(`  ${file.name}: ${file.errors.length} unmappable row(s)\n`)
      write(process.stderr, capped(file.errors, '    '))
    }
  }

  if (unknown.length > 0 || failed.length > 0) {
    process.exitCode = 1
    return
  }

  const { records, duplicates, clashes } = collectColourways(rows)

  const skips = totalSkips(readings)
  const skipped = skips.reduce((total, [, count]) => total + count, 0)
  process.stdout.write(`${names.length} file(s) in ${inputDir}: ${readings.length} read, `
    + `${declined.length} unsupported by declaration\n`)
  process.stdout.write(`${sum(readings, 'rows')} row(s) in, ${sum(readings, 'records')} colourway(s) out, `
    + `${skipped} row(s) skipped, ${duplicates} exact duplicate(s) dropped\n`)
  write(process.stdout, skips.map(([reason, count]) => `  skipped ${count}: ${reason}`))

  // Not an error and not a duplicate: the supplier's own two spellings of one
  // colour. Both rows are kept, because choosing between them is naming a
  // colourway, and the import is where that decision belongs.
  if (clashes.length > 0) {
    process.stdout.write(`${clashes.length} colour code(s) carry more than one name, both kept:\n`)
    write(process.stdout, capped(clashes.map(({ row, earlier }) =>
      `${rowSource(row)}: ${row.brand} ${row.design} ${row.colour_code} `
      + `"${row.colour_name}" vs "${earlier.colour_name}" at ${rowSource(earlier)}`), '  '))
  }

  // The rates, in the pricing template's own shape. Everything above decided
  // whether the run may write at all; this only has to say what came of them.
  const rated = collectRates(rates)
  const rateSkips = totalSkips(rateReadings)
  const rateSkipped = rateSkips.reduce((total, [, count]) => total + count, 0)
  process.stdout.write(`${sum(rateReadings, 'rows')} priced row(s) in, `
    + `${rated.records.length} rate(s) out, ${rateSkipped} row(s) skipped, `
    + `${rated.duplicates} exact duplicate(s) and ${rated.collapsed} repeat(s) of a design's `
    + `rate dropped\n`)
  write(process.stdout, rateSkips.map(([reason, count]) => `  skipped ${count}: ${reason}`))

  // A code the file prices two ways gets NO rate: the ledger holds one row per
  // (supplier, category, code) and nothing here may pick between two.
  if (rated.conflicts.length > 0) {
    process.stdout.write(`${rated.conflicts.length} code(s) priced more than one way, `
      + `no rate written for them:\n`)
    write(process.stdout, capped(rated.conflicts, '  '))
  }

  // Proof rather than construction: every emitted row is run through the price
  // template's own mapper, so a cell the office's converter would refuse fails
  // here instead of in their hands.
  const refused = verifyRates(rated.records)
  if (refused.length > 0) {
    process.stderr.write(`${refused.length} rate(s) the price template refuses `
      + `— nothing written:\n`)
    write(process.stderr, capped(refused, '  '))
    process.exitCode = 1
    return
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, serialiseColourways(records), 'utf8')
  process.stdout.write(`Wrote ${records.length} colourway(s) -> ${outputPath}\n`)
  const uploadPath = join(dirname(outputPath), 'supplier-colours.xlsx')
  writeFileSync(uploadPath, buildWorkbook([supplierColoursSheet(records)]))
  process.stdout.write(`Wrote the Supplier Colours upload -> ${uploadPath}\n`)
  mkdirSync(dirname(ratesPath), { recursive: true })
  writeFileSync(ratesPath, serialiseRates(rated.records), 'utf8')
  process.stdout.write(`Wrote ${rated.records.length} rate(s) -> ${ratesPath}\n`)
}

const [inputDir = DEFAULT_IN, outputPath = DEFAULT_OUT, ratesPath = DEFAULT_RATES] =
  process.argv.slice(2)
try {
  convert(inputDir, outputPath, ratesPath)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
