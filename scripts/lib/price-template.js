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
 * v3 is the client's own correction of v2, and v2 is GONE rather than kept
 * beside it. v2 appended Supplier, Brand, Pattern Match and Duty Percent to
 * v1's fourteen; the client read it back and said the Brand column duplicates
 * Product Range, which their files have always filled with the house name
 * (measured: 19,447 of the 19,514 committed rows put the supplier's own house
 * in Product Range — the 67 exceptions are one Jannelli & Volpi range). So v3
 * folds the two into ONE column called Brand, renames Pack Type to Unit and
 * Repeat to Horizontal Repeat, and moves Pattern Match up beside the two
 * repeats it belongs with.
 *
 * v2 is removed, not superseded, because no row anywhere came in through it:
 * every row in the committed file and in the client's database is v1, and the
 * client rejected the layout before a supplier ever filled one in. Leaving it
 * registered would go on accepting the very shape this replaces. v1 stays
 * registered forever — 74 drops and 19.5k rows arrived through it.
 *
 * The version STRING still only ever means one header, which is why this is v3
 * and not a redefinition of v2: v2's header was published to the client, and a
 * version that changes shape makes `template_version` lie about the past.
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
//
// CATEGORIES carries NINE values, and the last five arrived together in
// migrations/1789651200000_category-vocabulary.js. The first four are the
// supplier rate sheet's vocabulary and describe what Atelier BUYS; Towels, Bed
// Linen, Throws/Blankets and Cushions are what Atelier SELLS and every one of
// them used to collapse to `accessory`. The five come from a curated sheet, not
// a guess — the 381 active, in-stock, current-version D365 stock items with
// their Item Type corrected by hand at Atelier — so this set is now the whole
// of what is on the shelf.
//
// THE SET IS STORED IN THREE TABLES (products.category, price_list_items.category
// and supplier_freight_rates.category) AND IN THIS FILE. Widening it is one
// migration touching all three CHECKs plus this line; the three definitions are
// compared to each other by test/suppliers-product-category.test.js, because a
// value added to one and not the others does not fail anywhere — it silently
// stops matching.
//
// `misc` is NOT a synonym for absent. NULL still means "nobody has looked at
// this row", which is the distinction the spreadsheet round trip is built on
// (src/products/product-sheet.js); `misc` means somebody looked and the
// vocabulary had no word for it.
export const CATEGORIES = new Set([
  'fabric',
  'wallpaper',
  'trimming',
  'accessory',
  'bed-linen',
  'towel',
  'cushion',
  'throw',
  'misc',
])
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
  // The five D365 sells under and the rate sheet never named. Every spelling
  // here is one Atelier's own corrected sheet uses, plus the singular/plural
  // pair the entries above already establish.
  ['towels', 'towel'],
  ['towel', 'towel'],
  ['bed linen', 'bed-linen'],
  ['bed-linen', 'bed-linen'],
  ['throws/blankets', 'throw'],
  ['throws', 'throw'],
  ['throw', 'throw'],
  ['blankets', 'throw'],
  ['cushions', 'cushion'],
  ['cushion', 'cushion'],
  // The seeded catalogue's own spelling (src/seed/data/realCatalogue.js `type`).
  ['cushion cover', 'cushion'],
  ['cushion covers', 'cushion'],
  ['miscellaneous', 'misc'],
  ['misc', 'misc'],
])

// DELIBERATELY UNMAPPED, and each for a reason rather than an oversight:
//
//   Bedding — the corpus's own evidence says it is ambiguous, not a synonym.
//     Atelier's corrected sheet moved three `Bedding` rows and split them: two
//     to Towels, one to Bed Linen. A map entry would assert the wrong one for
//     roughly two rows in three.
//   Leather, Rug/Carpet, Candles, Furniture, Samples and Displays,
//     "No Group Selected" — 296 rows across the whole 7,611-row ledger and NONE
//     of them active-and-in-stock, so nobody has yet said what they should be
//     called. They come through the workbooks blank, which is the correct
//     statement: a suggestion is a suggestion, and an unevidenced one is worse
//     than none because the office confirms it by doing nothing.
//
// Add one here only with a corrected sheet behind it — and note that a new
// TARGET value is also a migration, because assertStorable below refuses a map
// that reaches outside CATEGORIES.
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

/**
 * The category a D365 item type means, or null where the vocabulary has no word
 * for it.
 *
 * One spelling of this lookup, shared by everything that derives a category
 * from an item type: the two category workbooks
 * (scripts/export-category-sheets.js), the supplier price-list template, and
 * the merged D365 read (src/legacy/legacy-read.js) that puts the category on
 * the CRM's stock rows. It was written out three times before; the whole reason
 * CATEGORY_BY_ITEM_TYPE lives in this module is that the pipelines must not
 * drift on what `W/P` means, and three copies of the lookup is the same drift
 * arriving one level up.
 *
 * NULL, not '', for "no word for it" — a caller writing a spreadsheet cell
 * spells its own blank.
 *
 * @param {unknown} itemType  the D365 `item_type` cell, in any case, or null
 * @returns {string|null} a member of CATEGORIES, or null
 */
export const categoryForItemType = (itemType) =>
  CATEGORY_BY_ITEM_TYPE.get(String(itemType ?? '').trim().toLowerCase()) ?? null

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

  // A v1 row emits NONE of the v3-only keys — not even as null. Every one of the
  // 19.5k records in the committed price-lists.json was written without them, so
  // adding `pattern_match: null` to each would turn the next regeneration into a
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

/**
 * v3: seventeen columns. Same fourteen meanings v1 carries, three of them
 * relabelled to what the office actually calls them, plus Pattern Match beside
 * the repeats and Supplier and Duty Percent at the end.
 *
 * Product Range -> Brand is a RENAME, not a new field. The cell has always held
 * the house; v2's separate Brand column was the duplicate, and it is gone.
 */
const V3_HEADER = Object.freeze([
  'date effective', 'brand', 'code', 'description', 'item type',
  'unit', 'contents', 'width', 'horizontal repeat', 'vertical repeat',
  'pattern match', 'duty rate', 'wholesale rate', 'currency', 'freight rate',
  'supplier', 'duty percent',
])

/**
 * Where each of v1's fourteen cells sits in a v3 row, in v1's own order.
 *
 * v3 inserts Pattern Match at index 10, so everything from Duty Rate on shifts
 * by one and `mapV1` — which reads by POSITION — can no longer be handed a v3
 * row directly the way it could a v2 one. Rebuilding a v1-shaped row here is
 * what keeps the shared columns mapped by mapV1 alone: re-listing them in a
 * second mapper is how the byte-pinned price-lists.json would rot.
 */
const V1_CELL_IN_V3 = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14])

/** Python's `round(x, 3)` — the scale of price_list_items.duty_percent. */
const round3 = (value) => Number(value.toFixed(3))

export const mapV3 = (row, context) => {
  const patternMatch = (row[10] ?? '').trim()
  const supplierCell = (row[15] ?? '').trim()
  const rawDutyPercent = (row[16] ?? '').trim()

  // The Supplier cell WINS over the filename — the filename was the most fragile
  // input in the pipeline (a rename or a new naming habit silently renamed a
  // supplier, and one file could only ever hold one). A blank cell still falls
  // back to it, so a per-supplier drop needs no new column filled in.
  const supplier = supplierCell || context.supplier
  if (!supplier) return failRow(context, 'empty supplier and none in the filename')

  // The Brand cell lands in `product_range`, the column v1's Product Range has
  // always written. The label is what the client corrected; the storage is 19.5k
  // rows deep and its name is internal, so renaming the column would buy a
  // migration, a byte-pin translation layer and nothing anybody can see.
  const item = mapV1(V1_CELL_IN_V3.map((index) => row[index] ?? ''), { ...context, supplier })
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
    pattern_match: patternMatch || null,
    duty_percent: dutyPercent,
    template_version: 'v3',
  }
}

/** Accepted templates, newest last — first exact header match wins. */
export const TEMPLATES = Object.freeze([
  Object.freeze({ version: 'v1', header: V1_HEADER, map: mapV1 }),
  Object.freeze({ version: 'v3', header: V3_HEADER, map: mapV3 }),
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
