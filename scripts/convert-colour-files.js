#!/usr/bin/env node
/**
 * Convert the supplier colour spreadsheets in incoming/colour-files/ into the
 * normalised colourway file incoming/colour-files/normalized/colourways.json.
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
 * Usage: node scripts/convert-colour-files.js [input-dir] [output-json]
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openColourWorkbook } from './lib/colour-sheet.js'
import { matchAdapter, registeredPrefixes } from './lib/colour-adapters/index.js'
import { readColourFile } from './lib/colour-adapters/reading.js'
import { colourwayRow, collectColourways, serialiseColourways, rowSource } from './lib/colour-adapters/output.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'colour-files')
const DEFAULT_OUT = join(DEFAULT_IN, 'normalized', 'colourways.json')

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

const sheetLine = (file, sheet) =>
  `${file}:${sheet.name}: header row ${sheet.headerRow}, ${sheet.rows} row(s) in, `
  + `${sheet.records} colourway(s) out${skipNote(sheet.skips)}`

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

const convert = (inputDir, outputPath) => {
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
  const declined = []
  const unknown = []
  const failed = []
  const rows = []

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
    try {
      const workbook = openColourWorkbook(readFileSync(join(inputDir, name)), basename(name))
      reading = readColourFile(workbook, adapter)
    } catch (error) {
      // The workbook itself would not open — not a row problem, but the same
      // verdict: this file yields nothing and the run writes nothing.
      failed.push({ name, errors: [`${name}: ${error.message}`] })
      continue
    }
    readings.push(reading)
    write(process.stdout, reading.sheets.map((sheet) => `  ${sheetLine(name, sheet)}`))
    // A file with any unmappable row contributes NO rows, whatever else it read.
    if (reading.errors.length > 0) {
      failed.push({ name, errors: [...reading.errors] })
      continue
    }
    for (const entry of reading.entries) rows.push(colourwayRow(name, adapter.supplier, entry))
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

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, serialiseColourways(records), 'utf8')
  process.stdout.write(`Wrote ${records.length} colourway(s) -> ${outputPath}\n`)
}

const [inputDir = DEFAULT_IN, outputPath = DEFAULT_OUT] = process.argv.slice(2)
try {
  convert(inputDir, outputPath)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
