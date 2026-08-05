#!/usr/bin/env node
/**
 * Convert the per-brand supplier price-list templates (CSV/XLSX drops in
 * incoming/pricing-templates/) into the universal price-list file
 * src/seed/data/price-lists.json, consumed by `npm run import:pricing`.
 *
 * No dependencies — CSVs are sniffed as utf-8 or cp1252, XLSX is read straight
 * from the zip (sharedStrings + sheet1). Every template shares one 14-column
 * layout; this script normalises the messy bits (currency naming, item-type
 * casing, Excel serial dates, float noise) and fails loudly on anything it
 * cannot map, listing every offending file:line.
 *
 * Usage: node scripts/convert-price-lists.js [input-dir] [output-json]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname, basename, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openWorkbook, sharedStrings, sheetRows, excelDate } from './lib/xlsx.js'
import { decodeText, csvRows } from './lib/text.js'
import { parseNumber, round4, generalFormat, floatRepr, dumps } from './lib/python-format.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_IN = join(REPO, 'incoming', 'pricing-templates')
const DEFAULT_OUT = join(REPO, 'src', 'seed', 'data', 'price-lists.json')

const COLUMNS = 14

const EXPECTED_HEADER = [
  'date effective', 'product range', 'code', 'description', 'item type',
  'pack type', 'contents', 'width', 'repeat', 'vertical repeat',
  'duty rate', 'wholesale rate', 'currency', 'freight rate',
]

const CATEGORY_BY_ITEM_TYPE = new Map([
  ['fabrics', 'fabric'],
  ['w/p', 'wallpaper'],
  ['trimmings', 'trimming'],
  ['accessories', 'accessory'],
])
const CATEGORY_BY_FILE_TOKEN = new Map([
  ['FABRIC', 'fabric'],
  ['WPPR', 'wallpaper'],
  ['TRIMMING', 'trimming'],
])
const UNIT_BY_PACK = new Map([
  ['p/m', 'metre'],
  ['p/y', 'yard'],
  ['p/roll', 'roll'],
  ['p/p', 'piece'],
])
const CURRENCY_MAP = new Map([
  ['euro', 'EUR'],
  ['us dollar', 'USD'],
  ['pound sterling', 'GBP'],
])
const FREIGHT_CLASSES = new Set(['A', 'B', 'C', 'D', 'E'])
const DUTY_CLASSES = new Set(['A'])

// Filename prefixes whose plain title-casing would mangle the supplier name.
const SUPPLIER_OVERRIDES = new Map([
  ['JV', 'Jannelli Volpi'],
  ['JV DESIGN LICENSE', 'JV Design'],
  ['JWALL', 'JWall'],
  ['C&C MILANO', 'C&C Milano'],
])

const FILENAME_PATTERN = /^(.+?)(?:\s+(FABRIC|WPPR|TRIMMING))?\s+PL\b/
const INTEGER_PATTERN = /^[+-]?\d+$/

const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()

const parseFilename = (stem) => {
  const match = FILENAME_PATTERN.exec(stem)
  if (!match) throw new Error(`cannot derive supplier from filename "${stem}"`)
  const prefix = match[1].trim()
  const supplier = SUPPLIER_OVERRIDES.get(prefix)
    ?? prefix.split(/\s+/).filter(Boolean).map(capitalise).join(' ')
  return { supplier, fileCategory: CATEGORY_BY_FILE_TOKEN.get(match[2] ?? '') ?? null }
}

const xlsxRows = function* (path) {
  const zip = openWorkbook(readFileSync(path))
  const strings = sharedStrings(zip)
  for (const [lineNumber, cells] of sheetRows(zip, 'xl/worksheets/sheet1.xml', strings)) {
    let width = 0
    for (const index of cells.keys()) width = Math.max(width, index + 1)
    const row = []
    for (let index = 0; index < width; index += 1) row.push(cells.get(index) ?? '')
    yield [lineNumber, row]
  }
}

const rowsOf = (path, isXlsx) => (isXlsx ? xlsxRows(path) : csvRows(decodeText(readFileSync(path))))

const parseInteger = (text) => {
  const trimmed = text.trim()
  if (!INTEGER_PATTERN.test(trimmed)) throw new Error(`not an integer: "${text}"`)
  return Number(trimmed)
}

const isoDate = (year, month, day) => {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
    throw new Error('date out of range')
  }
  const at = new Date(Date.UTC(year, month - 1, day))
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    throw new Error('date out of range')
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const parseDate = (value, isXlsx) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isXlsx) return excelDate(parseNumber(trimmed))
  const parts = trimmed.split('/')
  if (parts.length !== 3) throw new Error(`not a d/m/Y date: "${value}"`)
  const [day, month, year] = parts.map(parseInteger)
  return isoDate(year, month, day)
}

/** Trim; collapse float noise like '256.60000000000002' to '256.6'. */
const cleanMeasure = (value) => {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return generalFormat(round4(parseNumber(trimmed)))
  } catch {
    return trimmed
  }
}

const normaliseRow = (row, context) => {
  const { lineNumber, source, supplier, fileCategory, isXlsx, errors, skipped } = context
  const fail = (message) => {
    errors.push(`${source}:${lineNumber}: ${message}`)
    return null
  }

  const cells = []
  for (let index = 0; index < COLUMNS; index += 1) cells.push((row[index] ?? '').trim())
  const [rawDate, productRange, code, description, itemType, pack, contents,
    width, repeat, verticalRepeat, rawDuty, wholesale, currency, rawFreight] = cells

  const category = CATEGORY_BY_ITEM_TYPE.get(itemType.toLowerCase()) ?? fileCategory
  if (!category) return fail(`unmappable item type "${itemType}"`)
  const unit = UNIT_BY_PACK.get(pack.toLowerCase())
  if (!unit) return fail(`unmappable pack type "${pack}"`)
  const isoCurrency = CURRENCY_MAP.get(currency.toLowerCase().split(/\s+/).filter(Boolean).join(' '))
  if (!isoCurrency) return fail(`unmappable currency "${currency}"`)
  const freight = rawFreight.toUpperCase() || null
  if (freight && !FREIGHT_CLASSES.has(freight)) return fail(`unknown freight class "${freight}"`)
  const duty = rawDuty.toUpperCase() || null
  if (duty && !DUTY_CLASSES.has(duty)) return fail(`unknown duty class "${duty}"`)
  if (!code) return fail('empty code')
  // Platform decision 6 (15 Jul): standardise supplier codes to the uniform
  // format on import; keep the raw code so mismatches stay traceable.
  const codeNormalized = code.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!codeNormalized) return fail(`code "${code}" normalises to nothing`)

  let rate
  try {
    // No comma handling on purpose: "65,50" is ambiguous (EU decimal vs thousands),
    // and no current template uses commas — fail loudly so a human decides.
    rate = round4(parseNumber(wholesale))
  } catch {
    return fail(`non-numeric wholesale rate "${wholesale}"`)
  }
  if (rate === 0) {
    // Unpriced rows (price on application / not yet priced) carry nothing usable.
    skipped.push(`${source}:${lineNumber}: ${code} "${description}" has no wholesale rate`)
    return null
  }
  if (rate < 0) return fail(`negative wholesale rate ${floatRepr(rate)}`)

  let effective
  try {
    effective = parseDate(rawDate, isXlsx)
  } catch {
    return fail(`bad date "${rawDate}"`)
  }

  return {
    supplier,
    product_range: productRange || null,
    category,
    code,
    code_normalized: codeNormalized,
    description: description || null,
    contents: contents || null,
    unit,
    width: cleanMeasure(width),
    repeat: cleanMeasure(repeat),
    vertical_repeat: cleanMeasure(verticalRepeat),
    duty_class: duty,
    wholesale_rate: rate,
    currency: isoCurrency,
    freight_class: freight,
    date_effective: effective,
    source_file: source,
  }
}

const sameExceptSource = (left, right) =>
  Object.keys(left).every((key) => key === 'source_file' || left[key] === right[key])

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
    const normalisedHeader = header.slice(0, COLUMNS)
      .map((cell) => cell.toLowerCase().split(/\s+/).filter(Boolean).join(' '))
    const headerMatches = normalisedHeader.length === EXPECTED_HEADER.length
      && normalisedHeader.every((cell, index) => cell === EXPECTED_HEADER[index])
    if (!headerMatches) {
      errors.push(`${name}:${headerLine}: unexpected header ${JSON.stringify(header)}`)
      continue
    }

    for (const [lineNumber, row] of rows) {
      if (!row.some((cell) => String(cell).trim())) continue
      const item = normaliseRow(row, {
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
