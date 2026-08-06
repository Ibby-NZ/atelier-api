#!/usr/bin/env node
/**
 * Read the supplier colour spreadsheets in incoming/colour-files/ through their
 * declared adapters and report what each one yields.
 *
 * No dependencies — the workbooks are read straight from the zip by
 * lib/colour-sheet.js, which locates each sheet's header row by matching the
 * labels the adapter declares. lib/colour-adapters/ is the registry that says
 * which layout a filename is.
 *
 * This is the harness driver. Writing the normalised records out, and the
 * per-file summary that goes with a write, land in a later story (see
 * ralph/w8-colour-files); today the script proves every file is accounted for,
 * every declared header is found and every declared row maps, and it writes
 * nothing.
 *
 * Usage: node scripts/convert-colour-files.js [input-dir]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openColourWorkbook } from './lib/colour-sheet.js'
import { matchAdapter, registeredPrefixes } from './lib/colour-adapters/index.js'
import { sheetColourways } from './lib/colour-adapters/records.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'colour-files')

/**
 * One reading per declared sheet: where its header was, how many rows yielded
 * and how many colourways they came to.
 *
 * The two counts differ on purpose. Madeaux prints one row per design and names
 * its colours inside a cell, so a row there is worth several colourways; a
 * banner or a repeated header is worth none and is not counted as a row.
 */
const readSheets = (path, adapter) => {
  const workbook = openColourWorkbook(readFileSync(path), basename(path))
  return adapter.sheets.map((spec) => {
    const sheet = workbook.open(spec)
    let records = 0
    let rows = 0
    let previous = 0
    for (const [rowNumber] of sheetColourways(sheet, spec, workbook.source)) {
      records += 1
      if (rowNumber !== previous) rows += 1
      previous = rowNumber
    }
    return { sheet: sheet.name, headerRow: sheet.headerRow, rows, records }
  })
}

const convert = (inputDir) => {
  const names = readdirSync(inputDir)
    // macOS writes .DS_Store into every folder it opens; it is not a supplier drop.
    .filter((name) => !name.startsWith('.'))
    .sort()
  if (names.length === 0) throw new Error(`no colour files found in ${inputDir}`)

  const readings = []
  const declined = []
  const unknown = []
  let colourways = 0

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
    for (const reading of readSheets(join(inputDir, name), adapter)) {
      colourways += reading.records
      readings.push(`${name}:${reading.sheet}: header row ${reading.headerRow}, `
        + `${reading.rows} row(s) -> ${reading.records} colourway(s)`)
    }
  }

  for (const reading of readings) process.stdout.write(`  ${reading}\n`)
  if (declined.length > 0) {
    process.stdout.write(`Unsupported by declaration, ${declined.length} file(s):\n`)
    for (const entry of declined) process.stdout.write(`  ${entry}\n`)
  }

  // An unknown file is the one thing that must fail the run: a drop nobody has
  // mapped looks exactly like a drop that imported cleanly if it is only skipped.
  if (unknown.length > 0) {
    process.stderr.write(`${unknown.length} unsupported file(s) — no adapter is registered for:\n`)
    for (const name of unknown) process.stderr.write(`  ${name}\n`)
    const prefixes = registeredPrefixes()
    process.stderr.write(`Registered prefixes: ${prefixes.length > 0 ? prefixes.join(', ') : '(none)'}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`Read ${names.length} file(s) from ${inputDir}, `
    + `${colourways} colourway(s)\n`)
}

const [inputDir = DEFAULT_IN] = process.argv.slice(2)
try {
  convert(inputDir)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
