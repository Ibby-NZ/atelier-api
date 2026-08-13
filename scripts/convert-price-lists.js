#!/usr/bin/env node
/**
 * Convert the per-brand supplier price-list templates (CSV/XLSX drops in
 * incoming/pricing-templates/) into the universal price-list file
 * src/seed/data/price-lists.json, consumed by `npm run import:pricing`.
 *
 * No dependencies — CSVs are sniffed as utf-8 or cp1252, XLSX is read straight
 * from the zip (sharedStrings + sheet1). The accepted layouts and their row
 * mappers live in lib/price-template.js — the header row is what says which one
 * a file is. This script owns the file walk, the filename's supplier fallback
 * (v2 files name their own supplier per row) and the dedupe, and fails loudly on
 * anything it cannot map, listing every offending file:line.
 *
 * Usage: node scripts/convert-price-lists.js [input-dir] [output-json]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname, basename, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { worksheetGrid } from './lib/xlsx.js'
import { decodeText, csvRows } from './lib/text.js'
import { dumps } from './lib/python-format.js'
import {
  matchTemplate, acceptedHeaders, assertStorable, CATEGORIES,
} from './lib/price-template.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'pricing-templates')
const DEFAULT_OUT = join(REPO, 'src', 'seed', 'data', 'price-lists.json')

// The filename's own category token, for a v1 drop whose Item Type cell is
// blank. It is checked against the shared stored vocabulary because a typo here
// would sail past mapV1's fallback (which trusts fileCategory) and surface only
// as a CHECK violation at import time, a whole pipeline away from the mistake.
const CATEGORY_BY_FILE_TOKEN = assertStorable(new Map([
  ['FABRIC', 'fabric'],
  ['WPPR', 'wallpaper'],
  ['TRIMMING', 'trimming'],
]), CATEGORIES, 'file-token category')

// Filename prefixes whose plain title-casing would mangle the supplier name.
const SUPPLIER_OVERRIDES = new Map([
  ['JV', 'Jannelli Volpi'],
  ['JV DESIGN LICENSE', 'JV Design'],
  ['JWALL', 'JWall'],
  ['C&C MILANO', 'C&C Milano'],
])

const FILENAME_PATTERN = /^(.+?)(?:\s+(FABRIC|WPPR|TRIMMING))?\s+PL\b/

const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

/**
 * The supplier and category the FILENAME declares, or nulls when it declares
 * neither. A v2 file carries its own Supplier column, so an unrecognised name is
 * only fatal for a template that has nowhere else to get the name from.
 */
const parseFilename = (stem) => {
  const match = FILENAME_PATTERN.exec(stem)
  if (!match) return { supplier: null, fileCategory: null }
  const prefix = match[1].trim()
  const supplier = SUPPLIER_OVERRIDES.get(prefix)
    ?? prefix.split(/\s+/).filter(Boolean).map(capitalise).join(' ')
  return { supplier, fileCategory: CATEGORY_BY_FILE_TOKEN.get(match[2] ?? '') ?? null }
}

// `worksheetGrid` is this function's own body, moved into lib/xlsx.js so the
// API's upload route reads a workbook by the same rule (src/pricing/price-list-import.js).
const rowsOf = (path, isXlsx) => (isXlsx
  ? worksheetGrid(readFileSync(path))
  : csvRows(decodeText(readFileSync(path))))

// Key counts are compared too: a v2 row carries keys a v1 row does not, so
// comparing only the earlier row's keys would call the two identical and drop
// the richer one. A genuine clash must surface as a conflict, not a silent keep-first.
const sameExceptSource = (left, right) =>
  Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every((key) => key === 'source_file' || left[key] === right[key])

const compareKeys = (left, right) => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

const convert = (inputDir, outputPath) => {
  const files = readdirSync(inputDir)
    .filter((name) => ['.csv', '.xlsx'].includes(extname(name).toLowerCase()))
    .map((name) => join(inputDir, name))
    .sort()
  if (files.length === 0) throw new Error(`no price-list files found in ${inputDir}`)

  const items = new Map()
  const errors = []
  const skipped = []
  let duplicatesDropped = 0

  for (const path of files) {
    const name = basename(path)
    const isXlsx = extname(path).toLowerCase() === '.xlsx'
    const { supplier, fileCategory } = parseFilename(name.slice(0, name.length - extname(name).length))
    const rows = rowsOf(path, isXlsx)[Symbol.iterator]()

    const first = rows.next()
    if (first.done) continue
    const [headerLine, header] = first.value
    // The header row IS the version — nothing else in the file declares it.
    const template = matchTemplate(header)
    if (template === null) {
      errors.push(
        `${name}:${headerLine}: unexpected header ${JSON.stringify(header)}`
        + `; accepted: ${acceptedHeaders().join(' | ')}`,
      )
      continue
    }
    // Only a template declaring its own Supplier column can survive a filename
    // this script cannot read a supplier out of.
    if (supplier === null && !template.header.includes('supplier')) {
      errors.push(`${name}:${headerLine}: cannot derive supplier from the filename`
        + `, and ${template.version} has no Supplier column`)
      continue
    }

    for (const [lineNumber, row] of rows) {
      if (!row.some((cell) => String(cell).trim())) continue
      const item = template.map(row, {
        lineNumber, source: name, supplier, fileCategory, isXlsx, errors, skipped,
      })
      if (item === null) continue
      const key = [item.supplier, item.category, item.code]
      const lookup = JSON.stringify(key)
      const existing = items.get(lookup)
      if (existing === undefined) {
        items.set(lookup, { key, item })
      } else if (sameExceptSource(existing.item, item)) {
        duplicatesDropped += 1
      } else {
        errors.push(
          `${name}:${lineNumber}: key (${key.map((part) => `'${part}'`).join(', ')}) `
          + `conflicts with earlier row from ${existing.item.source_file}`,
        )
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`${errors.length} error(s) — nothing written:\n`)
    for (const error of errors) process.stderr.write(`  ${error}\n`)
    process.exitCode = 1
    return
  }

  const ordered = [...items.values()].sort((a, b) => compareKeys(a.key, b.key)).map((e) => e.item)
  writeFileSync(outputPath, `[\n${ordered.map(dumps).join(',\n')}\n]\n`, 'utf8')

  if (skipped.length > 0) {
    process.stderr.write(`Skipped ${skipped.length} unpriced row(s):\n`)
    for (const entry of skipped) process.stderr.write(`  ${entry}\n`)
  }

  const suppliers = new Set(ordered.map((item) => item.supplier))
  process.stdout.write(
    `Wrote ${ordered.length} items from ${files.length} files `
    + `(${suppliers.size} suppliers, ${duplicatesDropped} exact duplicate rows dropped) -> ${outputPath}\n`,
  )
}

const [inputDir = DEFAULT_IN, outputPath = DEFAULT_OUT] = process.argv.slice(2)
try {
  convert(inputDir, outputPath)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
