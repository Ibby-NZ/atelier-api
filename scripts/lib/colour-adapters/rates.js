/**
 * What a rate sheet declares, and what its rows come to.
 *
 * A rate sheet is declared beside the colourway sheets, in `adapter.rateSheets`,
 * and is read in its own pass. Most files price on the very sheet the
 * colourways come off, and that sheet is then declared TWICE — once for what a
 * colourway needs and once for what a rate needs. The duplication is deliberate:
 * the two outputs want different cells (a rate wants the unit, the width and the
 * composition; a colourway wants none of them), they are grained differently (a
 * rate is usually the design's and a colourway is always the colour's), and one
 * file — Jim Thompson — keeps its colour names and its prices on different
 * sheets entirely. Reading each declaration for what it is costs one more pass
 * over the rows and keeps either output from bending the other's shape.
 *
 * The reader owns the three verdicts a rate cell can produce, so no adapter has
 * to restate them:
 *   - the cell is empty, or the file writes `N/A`: the supplier states no rate.
 *   - the cell is zero: unpriced, the same reading `convert-price-lists.js`
 *     gives it. **Never defaulted to zero and never emitted** — a zero rate is
 *     price-on-application, and writing it into the ledger would make the office
 *     quote nothing for a fabric.
 *   - the cell is not a number at all: that is not a decline, it is a row this
 *     converter cannot map, so it throws with `file:sheet:row`. An adapter that
 *     KNOWS a legitimate non-numeric form (Madeaux states two rates in one cell
 *     for its grasscloth) declines it explicitly, with a reason, in its mapper.
 */
import { parseNumber } from '../python-format.js'
import { normaliseLabel } from '../colour-sheet.js'
import { BLANK_ROW, REPEATED_HEADER, UNSTATED, skip, skipReason } from './records.js'
import { CATEGORY_BY_ITEM_TYPE, UNIT_BY_PACK, CURRENCY_MAP } from '../price-template.js'

/** The fields a rate mapper may set. Everything else the sheet declares is its own. */
export const RATE_FIELDS = Object.freeze([
  'code', 'description', 'productRange', 'itemType', 'packType', 'contents',
  'width', 'repeat', 'verticalRepeat', 'patternMatch', 'wholesale', 'currency',
  'dateEffective', 'dutyRate', 'freightRate', 'dutyPercent', 'brand', 'supplier',
])

/** What a rate cannot be written without. */
const REQUIRED_FIELDS = Object.freeze(['code', 'itemType', 'packType', 'currency', 'supplier'])

/** The reader's own reasons for declining a row. */
export const NO_RATE = 'no rate stated'
export const ZERO_RATE = 'rate of zero, price on application'

/** What a supplier writes in a cell it is leaving empty. */
const UNSTATED_CELL = new Set(['', 'n/a', '-'])

/** A cell the file left unstated reads as nothing, not as the words "N/A". */
export const stated = (value) => (UNSTATED_CELL.has(String(value ?? '').trim().toLowerCase())
  ? ''
  : String(value ?? '').trim())

const isText = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * Validate one rate sheet's declaration, at import.
 *
 * The vocabularies are the shared ones in lib/price-template.js, so a constant
 * declared here can only be one a template CELL may legitimately say — which is
 * what stops an adapter inventing an item type or a pack the converter would
 * then fail on, thousands of rows in.
 */
export const assertRateSheet = (sheet, at) => {
  if (!isText(sheet?.name)) throw new Error(`${at}: every rate sheet needs a name`)
  const where = `${at}: rate sheet "${sheet.name}"`
  if (!isText(sheet.brand)) throw new Error(`${where} must name a brand`)
  if (sheet.supplier !== undefined && !isText(sheet.supplier)) {
    throw new Error(`${where}: supplier must be a non-empty string`)
  }
  if (!CURRENCY_MAP.has(String(sheet.currency).toLowerCase())) {
    throw new Error(`${where} declares currency "${sheet.currency}", `
      + `which no template cell may say`)
  }
  if (sheet.itemType !== undefined && !CATEGORY_BY_ITEM_TYPE.has(String(sheet.itemType).toLowerCase())) {
    throw new Error(`${where} declares item type "${sheet.itemType}", which maps to no category`)
  }
  if (sheet.packType !== undefined && !UNIT_BY_PACK.has(String(sheet.packType).toLowerCase())) {
    throw new Error(`${where} declares pack type "${sheet.packType}", which maps to no unit`)
  }
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
    if (earlier !== undefined) {
      throw new Error(`${where} columns "${earlier}" and "${field}" both declare "${normalised}"`)
    }
    byLabel.set(normalised, field)
  }
  // The rate is the one cell that can only come off the row.
  if (!entries.some(([field]) => field === 'wholesale')) {
    throw new Error(`${where} declares no "wholesale" column`)
  }
  if (sheet.row !== undefined) return sheet
  const foreign = entries.map(([field]) => field).filter((field) => !RATE_FIELDS.includes(field))
  if (foreign.length > 0) {
    throw new Error(`${where} has no row mapper, so column(s) `
      + `"${foreign.join('", "')}" name nothing a rate carries`)
  }
  return sheet
}

/** The identity mapper: the declared cells already ARE the rate's fields. */
const asRate = (values) => values

const repeatsHeader = (values, columns) => Object.entries(columns)
  .every(([field, label]) => normaliseLabel(values[field]) === normaliseLabel(label))

const isBlank = (cells) => !cells.some((cell) => String(cell).trim() !== '')

/**
 * One rate, with the sheet's declarations filled in behind the row's own.
 *
 * A multi-house drop overrides `brand` per row (Colefax's four, Pierre Frey's
 * five); everything else is usually the sheet's constant.
 *
 * `supplier` is the drop's, unless the row or the sheet names one. The price
 * list files a house that invoices Atelier directly as its OWN supplier even
 * when its colourways arrive inside a distributor's workbook — Nicky Haslam's
 * 17 rows sit under "Nicky Haslam", not under Jean Monro, who sends the file —
 * and the upsert key is `(supplier, category, code)`, so getting this wrong
 * writes a parallel ledger row rather than refreshing the office's own. A sheet
 * or a mapper only names a supplier through a DECLARED table of spellings the
 * committed price list evidences; an unmapped house falls back to the drop's
 * supplier rather than inventing a new one.
 */
const toRate = (spec, supplier, produced, source, sheetName, rowNumber) => {
  const rate = {
    sourceFile: source,
    sourceSheet: sheetName,
    sourceRow: rowNumber,
  }
  for (const field of RATE_FIELDS) rate[field] = stated(produced[field])
  rate.supplier = stated(produced.supplier ?? spec.supplier ?? supplier)
  rate.brand = stated(produced.brand ?? spec.brand)
  rate.currency = stated(produced.currency ?? spec.currency)
  rate.itemType = stated(produced.itemType ?? spec.itemType)
  rate.packType = stated(produced.packType ?? spec.packType)
  rate.dateEffective = stated(produced.dateEffective ?? spec.dateEffective)
  const missing = REQUIRED_FIELDS.filter((field) => rate[field] === '')
  if (missing.length > 0) throw new Error(`rate states no ${missing.join(', ')}`)
  return Object.freeze(rate)
}

/**
 * What every data row of one opened rate sheet came to: `{ rowNumber }` plus
 * exactly one of `rate`, `skip` (the stated reason) or `error` (already carrying
 * `file:sheet:row`). Nothing throws out of here — the converter collects the
 * errors, aborts that file and writes nothing, the same posture the colourway
 * reader has.
 */
export function* sheetRates(sheet, spec, source = '', supplier = '') {
  const map = spec.row ?? asRate
  const at = source === '' ? sheet.name : `${source}:${sheet.name}`
  for (const [rowNumber, cells] of sheet.rows) {
    if (isBlank(cells)) {
      yield { rowNumber, skip: BLANK_ROW }
      continue
    }
    const values = sheet.select(cells)
    if (repeatsHeader(values, spec.columns)) {
      yield { rowNumber, skip: REPEATED_HEADER }
      continue
    }
    let produced
    try {
      produced = map(values)
    } catch (error) {
      yield { rowNumber, error: `${at}:${rowNumber}: ${error.message}` }
      continue
    }
    const declined = skipReason(produced)
    if (declined !== null) {
      yield { rowNumber, skip: declined }
      continue
    }
    if (produced === null || produced === undefined) {
      yield { rowNumber, skip: UNSTATED }
      continue
    }
    const cell = stated(produced.wholesale)
    if (cell === '') {
      yield { rowNumber, skip: NO_RATE }
      continue
    }
    let amount
    try {
      // The cell is emitted verbatim; this only decides whether it is usable.
      amount = parseNumber(cell)
    } catch {
      yield { rowNumber, error: `${at}:${rowNumber}: unusable rate "${cell}"` }
      continue
    }
    if (amount === 0) {
      yield { rowNumber, skip: ZERO_RATE }
      continue
    }
    if (amount < 0) {
      yield { rowNumber, error: `${at}:${rowNumber}: negative rate "${cell}"` }
      continue
    }
    try {
      yield { rowNumber, rate: toRate(spec, supplier, produced, source, sheet.name, rowNumber) }
    } catch (error) {
      yield { rowNumber, error: `${at}:${rowNumber}: ${error.message}` }
    }
  }
}

/** A rate mapper declines a row the same way a colourway mapper does. */
export { skip }
