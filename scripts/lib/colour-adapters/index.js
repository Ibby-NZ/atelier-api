/**
 * The colour-file adapter registry, keyed by FILENAME PREFIX.
 *
 * Per-supplier adapters, not one universal parser: eighteen files, eighteen
 * layouts — several carry more than one brand, one spans ten sheets, headers
 * sit on different rows, and one is a PDF with no extraction path at all. Each
 * entry declares the sheets to read and, per sheet, the column map;
 * lib/colour-sheet.js finds the header row by matching those labels, so the map
 * and the recognition rule are the same declaration and cannot disagree.
 *
 * An entry may instead declare itself `unsupported` with a reason. That is NOT
 * the same as an unknown file: a declared refusal is a decision someone made
 * and recorded, while an unknown filename is a file nobody has looked at yet
 * and must fail the run. Neither is ever silently skipped.
 *
 * `assertRegistry` runs at import over every entry, so a malformed adapter
 * stops the converter starting rather than surfacing as a mis-mapped column
 * several thousand rows into a file.
 */
import { normaliseLabel } from '../colour-sheet.js'
import { RECORD_FIELDS, REQUIRED_COLUMNS } from './records.js'
import { assertRateSheet } from './rates.js'
import { CC_MILANO } from './cc-milano.js'
import { COLEFAX } from './colefax.js'
import { DE_LE_CUONA } from './de-le-cuona.js'
import { FINE } from './fine.js'
import { JANNELLI_VOLPI } from './jannelli-volpi.js'
import { JEAN_MONRO } from './jean-monro.js'
import { JIM_THOMPSON, JIM_THOMPSON_SS26 } from './jim-thompson.js'
import { LIBERTY } from './liberty.js'
import { MADEAUX } from './madeaux.js'
import { MARIA_FLORA } from './maria-flora.js'
import { PERENNIALS_FABRICS, PERENNIALS_WALLCOVERINGS } from './perennials.js'
import { PIERRE_FREY } from './pierre-frey.js'
import { CLARENCE_HOUSE, S_HARRIS, STROHEIM, TREND, VERVAIN } from './us-houses.js'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const assertSheet = (sheet, at) => {
  if (!isText(sheet?.name)) throw new Error(`${at}: every sheet needs a name`)
  const where = `${at}: sheet "${sheet.name}"`
  // Every sheet names the house it holds, even the one file whose rows carry a
  // Brand column — that column is the row's override, not a reason to leave the
  // sheet's own house unstated.
  if (!isText(sheet.brand)) throw new Error(`${where} must name a brand`)
  if (sheet.row !== undefined && typeof sheet.row !== 'function') {
    throw new Error(`${where}: row must be a function`)
  }
  const entries = Object.entries(sheet.columns ?? {})
  if (entries.length === 0) throw new Error(`${where} declares no columns`)
  const byLabel = new Map()
  for (const [field, label] of entries) {
    if (!isText(label)) throw new Error(`${where} column "${field}" has an empty label`)
    const normalised = normaliseLabel(label)
    const earlier = byLabel.get(normalised)
    // Two fields onto one label is a typo far more often than an intention, and
    // it is invisible afterwards: both fields simply carry the same cell.
    if (earlier !== undefined) {
      throw new Error(`${where} columns "${earlier}" and "${field}" `
        + `both declare "${normalised}"`)
    }
    byLabel.set(normalised, field)
  }
  // Without a `row` mapper the selected cells ARE the record, so the columns
  // have to be the record's own fields and the three a colourway cannot be
  // named without must all be there. A sheet WITH a mapper may select anything
  // it likes (Jean Monro's RSC reads a description it never emits).
  if (sheet.row !== undefined) return
  const fields = entries.map(([field]) => field)
  const foreign = fields.filter((field) => !RECORD_FIELDS.includes(field))
  if (foreign.length > 0) {
    throw new Error(`${where} has no row mapper, so column(s) `
      + `"${foreign.join('", "')}" name nothing a record carries`)
  }
  const missing = REQUIRED_COLUMNS.filter((field) => !fields.includes(field))
  if (missing.length > 0) {
    throw new Error(`${where} has no row mapper and declares no "${missing.join('", "')}"`)
  }
}

/** Validate one entry's shape. Throws with the offending prefix named. */
export const assertAdapter = (adapter) => {
  if (!isText(adapter?.prefix)) throw new Error('adapter: prefix must be a non-empty string')
  const at = `adapter "${adapter.prefix}"`
  if (adapter.unsupported !== undefined) {
    if (!isText(adapter.unsupported)) throw new Error(`${at}: unsupported must state a reason`)
    if (adapter.sheets !== undefined) throw new Error(`${at}: unsupported and sheets are exclusive`)
    if (adapter.rateSheets !== undefined) {
      throw new Error(`${at}: unsupported and rateSheets are exclusive`)
    }
    return adapter
  }
  if (!isText(adapter.supplier)) throw new Error(`${at}: supplier must be a non-empty string`)
  if (!Array.isArray(adapter.sheets) || adapter.sheets.length === 0) {
    throw new Error(`${at}: sheets must be a non-empty array`)
  }
  for (const sheet of adapter.sheets) assertSheet(sheet, at)
  // The rate sheets are declared apart from the colourway ones and validated
  // against the price template's own vocabularies — see rates.js.
  if (adapter.rateSheets !== undefined) {
    if (!Array.isArray(adapter.rateSheets) || adapter.rateSheets.length === 0) {
      throw new Error(`${at}: rateSheets must be a non-empty array`)
    }
    for (const sheet of adapter.rateSheets) assertRateSheet(sheet, at)
  }
  return adapter
}

/**
 * A filename or prefix as `selectAdapter` compares it: case-insensitively, and
 * with an apostrophe and an underscore read as the same character. A Google
 * Drive zip download writes every apostrophe in a filename as "_", so the drop
 * the client names "… SS'26.xlsx" arrives as "… SS_26.xlsx" (Sep 2026); without
 * this it matched the annual Jim Thompson entry instead and aborted the run.
 */
const matchKey = (name) => String(name).toLowerCase().replaceAll("'", '_')

/**
 * Validate the whole registry. Prefixes are unique by `matchKey`, because that
 * is how `matchAdapter` compares them — two entries differing only in case
 * would make which one wins depend on array order.
 */
export const assertRegistry = (adapters) => {
  const seen = new Set()
  for (const adapter of adapters) {
    assertAdapter(adapter)
    const prefix = matchKey(adapter.prefix)
    if (seen.has(prefix)) throw new Error(`adapter prefix "${adapter.prefix}" is registered twice`)
    seen.add(prefix)
  }
  return adapters
}

// One module per layout family, and every one of the nineteen drops is claimed
// by exactly one entry: the eighteen workbooks by an adapter and the de Le
// Cuona PDF by a declared refusal. A drop nothing claims stays an unknown file
// and the converter says so and exits non-zero — never a silent skip.
export const ADAPTERS = assertRegistry(Object.freeze([
  CC_MILANO,
  CLARENCE_HOUSE,
  COLEFAX,
  DE_LE_CUONA,
  FINE,
  JANNELLI_VOLPI,
  JEAN_MONRO,
  JIM_THOMPSON,
  JIM_THOMPSON_SS26,
  LIBERTY,
  MADEAUX,
  MARIA_FLORA,
  PERENNIALS_FABRICS,
  PERENNIALS_WALLCOVERINGS,
  PIERRE_FREY,
  S_HARRIS,
  STROHEIM,
  TREND,
  VERVAIN,
]))

/**
 * The adapter in `adapters` claiming `filename`, or null.
 *
 * The LONGEST matching prefix wins, so a supplier whose seasonal drop needs its
 * own layout (`Jim Thompson … 2026` and `Jim Thompson … 2026 - SS'26`) can have
 * both entries without the shorter one shadowing the longer. Pure, and taking
 * the registry as an argument, so the rule is testable while ADAPTERS is still
 * being filled in.
 */
export const selectAdapter = (adapters, filename) => {
  const name = matchKey(filename)
  let best = null
  for (const adapter of adapters) {
    const prefix = matchKey(adapter.prefix)
    if (!name.startsWith(prefix)) continue
    if (best === null || prefix.length > best.prefix.length) best = adapter
  }
  return best
}

/** The registered adapter for a filename, or null when none is registered. */
export const matchAdapter = (filename) => selectAdapter(ADAPTERS, filename)

/** Every registered prefix, so a file nothing matched can say what does match. */
export const registeredPrefixes = () => ADAPTERS.map((adapter) => adapter.prefix)
