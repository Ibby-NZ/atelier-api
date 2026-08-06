/**
 * The universal supplier price-list template registry.
 *
 * THE HEADER ROW IS THE VERSION. No version column, no preamble line, no marker
 * cell — a version cell can be misdeclared by deleting a column, whereas a
 * header mismatch fails loudly and writes nothing. Each entry pairs a header
 * with the mapper for rows under it; the first entry whose header matches
 * exactly wins, so v1 drops keep importing forever and a new template is one
 * more entry rather than a rewrite.
 *
 * `mapV1` is the converter's original `normaliseRow` moved here unchanged —
 * src/seed/data/price-lists.json is committed and byte-pinned, so any change to
 * what it emits (key order included) surfaces as an 8 MB diff.
 *
 * v2 is a strict SUPERSET of v1: the same fourteen columns, in the same order,
 * with Supplier, Brand, Pattern Match and Duty Percent appended. So `mapV2`
 * delegates the shared cells to `mapV1` and appends its own keys after them.
 */
import { excelDate } from './xlsx.js'
import { parseNumber, round4, generalFormat, floatRepr } from './python-format.js'

const V1_HEADER = Object.freeze([
  'date effective', 'product range', 'code', 'description', 'item type',
  'pack type', 'contents', 'width', 'repeat', 'vertical repeat',
  'duty rate', 'wholesale rate', 'currency', 'freight rate',
])

/**
 * The vocabularies below are the pipeline's single source of truth. The
 * importer's validator (src/seed/price-lists.js) and the back-office write
 * schema (src/routes/admin-price-lists.js) each kept a hand-copied duplicate,
 * and the copies drifted — three of them still said a freight class could only
 * be 'A'-'E' after the column CHECK had been widened.
 *
 * Two kinds, and keeping them apart is the whole point:
 *   - an INPUT map says what a template CELL may say and what it means. Adding
 *     an entry can only turn a cell that used to fail the entire run into one
 *     that maps; it cannot change what an already-mapped cell produces, so the
 *     byte-pinned price-lists.json is safe from it by construction.
 *   - a STORED set is what the database column will accept. Widening one of
 *     those is a migration.
 * `assertStorable` proves at module load that no input map reaches outside its
 * stored set, so an alias can never quietly widen storage.
 */

// Stored vocabularies — each mirrors a CHECK on price_list_items
// (migrations/1785110400000_price-list-items.js).
export const CATEGORIES = new Set(['fabric', 'wallpaper', 'trimming', 'accessory'])
export const UNITS = new Set(['metre', 'yard', 'roll', 'piece', 'hide', 'panel'])
// Adding a currency is FOUR edits in lockstep, each failing at a different layer
// when missed: (1) the DB CHECK on price_list_items.currency, in a migration;
// (2) CURRENCIES here, which the importer validates against; (3) CURRENCY_MAP
// below, or no template cell can name it; and (4) CURRENCY_ENUM in
// src/routes/admin-price-lists.js, the hand-entry schema — which now derives
// from CURRENCIES, so (2) and (4) are one edit rather than two that can drift.
export const CURRENCIES = new Set(['EUR', 'USD', 'GBP'])

// Input vocabularies, keyed by the lowercased cell.
//
// Both the plural and the singular are accepted, plus "wallpaper" spelled out
// beside the "w/p" the current corpus uses. The 74 files on hand only ever say
// Fabrics / w/p / Trimmings / Accessories (in mixed case), so these aliases
// cannot change a single committed row — verified by regenerating
// price-lists.json and getting a byte-identical file. They exist for the drops
// that have not arrived yet: this template is meant to be universal going
// forward, and rejecting a supplier's file because it says "Fabric" rather than
// "Fabrics" would read as a bug in ours.
export const CATEGORY_BY_ITEM_TYPE = new Map([
  ['fabrics', 'fabric'],
  ['fabric', 'fabric'],
  ['w/p', 'wallpaper'],
  ['wallpaper', 'wallpaper'],
  ['wallpapers', 'wallpaper'],
  ['wall covering', 'wallpaper'],
  ['wallcovering', 'wallpaper'],
  ['trimmings', 'trimming'],
  ['trimming', 'trimming'],
  ['accessories', 'accessory'],
  ['accessory', 'accessory'],
])
// p/hide and p/panel have no template rows yet, but both units have been in the
// column CHECK since the table was created (platform decision 7), so accepting
// them stores nothing new — it only stops a hide or panel drop failing a run.
export const UNIT_BY_PACK = new Map([
  ['p/m', 'metre'],
  ['p/y', 'yard'],
  ['p/roll', 'roll'],
  ['p/p', 'piece'],
  ['p/hide', 'hide'],
  ['p/panel', 'panel'],
])
// The long names are what today's drops write. The ISO codes are INPUT ALIASES
// only — a supplier typing "EUR" is saying exactly what "Euro" says — and the
// stored set is deliberately NOT widened by them.
export const CURRENCY_MAP = new Map([
  ['euro', 'EUR'],
  ['us dollar', 'USD'],
  ['pound sterling', 'GBP'],
  ['eur', 'EUR'],
  ['usd', 'USD'],
  ['gbp', 'GBP'],
])

/**
 * Every value an input map produces must be one the database stores. Called at
 * module load, so a mistyped alias fails whichever process imported it at
 * startup rather than as a CHECK violation half way through a 2,000-row import.
 */
export const assertStorable = (map, stored, what) => {
  for (const value of map.values()) {
    if (!stored.has(value)) {
      throw new Error(`${what} maps onto "${value}", which is not a stored value`)
    }
  }
  return map
}

assertStorable(CATEGORY_BY_ITEM_TYPE, CATEGORIES, 'item type')
assertStorable(UNIT_BY_PACK, UNITS, 'pack type')
assertStorable(CURRENCY_MAP, CURRENCIES, 'currency')

/**
 * A duty or freight class is a single uppercase letter, stored raw and
 * uninterpreted — the broker's duty table (A10) and a freight class -> rate
 * table are both still owed. The sets this replaces ('A'-'E' for freight, 'A'
 * alone for duty) encoded a guess about a table nobody has, so the first 'F' a
 * supplier sent would have rejected the client's own file as if it were a bug
 * in ours. This is the shape both column CHECKs were widened to in
 * migrations/1786334400000_price-list-template-v2.js.
 */
export const CLASS_LETTER = /^[A-Z]$/
export const isClassLetter = (value) => typeof value === 'string' && CLASS_LETTER.test(value)

const INTEGER_PATTERN = /^[+-]?\d+$/

/** Report a row-level failure the way every mapper does: file:line, no row emitted. */
const failRow = (context, message) => {
  context.errors.push(`${context.source}:${context.lineNumber}: ${message}`)
  return null
}

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

export const mapV1 = (row, context) => {
  const { lineNumber, source, supplier, fileCategory, isXlsx, errors, skipped } = context
  const fail = (message) => {
    errors.push(`${source}:${lineNumber}: ${message}`)
    return null
  }

  const cells = []
  for (let index = 0; index < V1_HEADER.length; index += 1) cells.push((row[index] ?? '').trim())
  const [rawDate, productRange, code, description, itemType, pack, contents,
    width, repeat, verticalRepeat, rawDuty, wholesale, currency, rawFreight] = cells

  const category = CATEGORY_BY_ITEM_TYPE.get(itemType.toLowerCase()) ?? fileCategory
  if (!category) return fail(`unmappable item type "${itemType}"`)
  const unit = UNIT_BY_PACK.get(pack.toLowerCase())
  if (!unit) return fail(`unmappable pack type "${pack}"`)
  const isoCurrency = CURRENCY_MAP.get(currency.toLowerCase().split(/\s+/).filter(Boolean).join(' '))
  if (!isoCurrency) return fail(`unmappable currency "${currency}"`)
  const freight = rawFreight.toUpperCase() || null
  if (freight && !isClassLetter(freight)) return fail(`unknown freight class "${freight}"`)
  const duty = rawDuty.toUpperCase() || null
  if (duty && !isClassLetter(duty)) return fail(`unknown duty class "${duty}"`)
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

  // A v1 row emits NONE of the v2-only keys — not even as null. Every one of the
  // 19.5k records in the committed price-lists.json was written without them, so
  // adding `brand_name: null` to each would turn the next regeneration into a
  // total 8 MB diff for no information. An absent key and an explicit null mean
  // the same thing to the importer, which binds NULL either way (the single
  // exception is template_version, whose NOT NULL DEFAULT a bound NULL would
  // defeat — hence the COALESCE there). Do not "tidy" these into explicit nulls.
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

const V2_HEADER = Object.freeze([
  ...V1_HEADER, 'supplier', 'brand', 'pattern match', 'duty percent',
])

/** Python's `round(x, 3)` — the scale of price_list_items.duty_percent. */
const round3 = (value) => Number(value.toFixed(3))

export const mapV2 = (row, context) => {
  const cells = []
  for (let index = V1_HEADER.length; index < V2_HEADER.length; index += 1) {
    cells.push((row[index] ?? '').trim())
  }
  const [supplierCell, brand, patternMatch, rawDutyPercent] = cells

  // The Supplier cell WINS over the filename — the filename was the most fragile
  // input in the pipeline (a rename or a new naming habit silently renamed a
  // supplier, and one file could only ever hold one). A blank cell still falls
  // back to it, so a per-supplier drop needs no new column filled in.
  const supplier = supplierCell || context.supplier
  if (!supplier) return failRow(context, 'empty supplier and none in the filename')

  const item = mapV1(row, { ...context, supplier })
  if (item === null) return null

  let dutyPercent = null
  if (rawDutyPercent) {
    try {
      // Rounded to the column's own scale so the JSON says exactly what the
      // database will hold. No range check: nobody has stated a legitimate one,
      // and a guessed range is the mistake the old freight-class set already was.
      dutyPercent = round3(parseNumber(rawDutyPercent))
    } catch {
      return failRow(context, `non-numeric duty percent "${rawDutyPercent}"`)
    }
  }

  // Appended after v1's keys, never interleaved: v1's key order is byte-pinned.
  // template_version is the converter's verdict — which header row this file
  // declared — written down, never a cell read from the file.
  return {
    ...item,
    brand_name: brand || null,
    pattern_match: patternMatch || null,
    duty_percent: dutyPercent,
    template_version: 'v2',
  }
}

/** Accepted templates, newest last — first exact header match wins. */
export const TEMPLATES = Object.freeze([
  Object.freeze({ version: 'v1', header: V1_HEADER, map: mapV1 }),
  Object.freeze({ version: 'v2', header: V2_HEADER, map: mapV2 }),
])

const normaliseLabel = (cell) => String(cell).toLowerCase().split(/\s+/).filter(Boolean).join(' ')

/**
 * Lowercase each label and collapse its whitespace, then drop trailing empty
 * cells: a blank cell declares no column — both Excel and CSV exports emit them
 * — so counting one would fail a file over a stray comma. A named extra column
 * still changes the length and must fail, or a template could be mistaken for
 * a longer one that happens to share its first cells.
 */
export const normaliseHeader = (row) => {
  const labels = row.map(normaliseLabel)
  let width = labels.length
  while (width > 0 && labels[width - 1] === '') width -= 1
  return labels.slice(0, width)
}

/** The template this header row declares, or null. Exact on length and labels. */
export const matchTemplate = (row) => {
  const labels = normaliseHeader(row)
  return TEMPLATES.find((template) => template.header.length === labels.length
    && template.header.every((label, index) => label === labels[index])) ?? null
}

/** Every accepted header, so a mismatch says what the file should have looked like. */
export const acceptedHeaders = () =>
  TEMPLATES.map((template) => `${template.version} ${JSON.stringify(template.header)}`)
