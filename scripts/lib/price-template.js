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
 */
import { excelDate } from './xlsx.js'
import { parseNumber, round4, generalFormat, floatRepr } from './python-format.js'

const V1_HEADER = Object.freeze([
  'date effective', 'product range', 'code', 'description', 'item type',
  'pack type', 'contents', 'width', 'repeat', 'vertical repeat',
  'duty rate', 'wholesale rate', 'currency', 'freight rate',
])

const CATEGORY_BY_ITEM_TYPE = new Map([
  ['fabrics', 'fabric'],
  ['w/p', 'wallpaper'],
  ['trimmings', 'trimming'],
  ['accessories', 'accessory'],
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

const INTEGER_PATTERN = /^[+-]?\d+$/

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

/** Accepted templates, newest last — first exact header match wins. */
export const TEMPLATES = Object.freeze([
  Object.freeze({ version: 'v1', header: V1_HEADER, map: mapV1 }),
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
