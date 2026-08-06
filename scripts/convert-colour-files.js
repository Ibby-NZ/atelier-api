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
 * This is the harness driver. Turning the rows into normalised colourway
 * records and writing them lands in a later story (see ralph/w8-colour-files);
 * today the script proves every file is accounted for and every declared header
 * is found, and writes nothing.
 *
 * Usage: node scripts/convert-colour-files.js [input-dir]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openColourWorkbook } from './lib/colour-sheet.js'
import { matchAdapter, registeredPrefixes } from './lib/colour-adapters/index.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'colour-files')

const isBlank = (cells) => !cells.some((cell) => String(cell).trim() !== '')

/** One reading per declared sheet: where its header was, and how many rows follow. */
const readSheets = (path, adapter) => {
  const workbook = openColourWorkbook(readFileSync(path), basename(path))
  return adapter.sheets.map((spec) => {
    const sheet = workbook.open(spec)
    let rows = 0
    for (const [, cells] of sheet.rows) {
      if (!isBlank(cells)) rows += 1
    }
    return { sheet: sheet.name, headerRow: sheet.headerRow, rows }
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
      readings.push(`${name}:${reading.sheet}: header row ${reading.headerRow}, `
        + `${reading.rows} data row(s)`)
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

  process.stdout.write(`Read ${names.length} file(s) from ${inputDir}\n`)
}

const [inputDir = DEFAULT_IN] = process.argv.slice(2)
try {
  convert(inputDir)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
