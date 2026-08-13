/**
 * The rate output: the 2026 rates these colour files carry, written in the
 * UNIVERSAL PRICING TEMPLATE's own column order.
 *
 * The colour files are price lists — every one of the seventeen workbooks
 * prints a 2026 rate beside the colourway — and the office already has a
 * ratified shape for a supplier rate: the v3 template in lib/price-template.js,
 * which `npm run convert:pricing` reads. So this emits that template rather
 * than a shape of its own: a CSV whose header row IS the template's, which
 * means the rates land through the same vocabularies, the same code
 * normalisation and the same importer as every other supplier drop.
 *
 * `assertTemplateHeader` runs at module load and fails the converter if these
 * labels stop matching a registered template — the header row is what declares
 * the version (see price-template.js), so a drift here would otherwise surface
 * as "unexpected header" a whole pipeline away, in a file nobody edited.
 *
 * NOTHING IS INVENTED INTO A COLUMN THE FILE DOES NOT FILL. Duty Rate, Freight
 * Rate and Duty Percent are emitted EMPTY unless a supplier's own sheet states
 * them, and then verbatim: the broker's duty table (A10) and the freight class
 * table are still owed, and a placeholder written here would be indistinguishable
 * from a rate a supplier quoted.
 */
import { matchTemplate, CATEGORY_BY_ITEM_TYPE } from '../price-template.js'

/**
 * The template's columns as a supplier's own drop spells them, in order.
 *
 * v3's seventeen. `matchTemplate` lowercases and collapses whitespace before
 * comparing, so these are the human-readable spellings and the match is still
 * exact.
 */
export const RATE_HEADER = Object.freeze([
  'Date Effective', 'Brand', 'Code', 'Description', 'Item Type',
  'Unit', 'Contents', 'Width', 'Horizontal Repeat', 'Vertical Repeat',
  'Pattern Match', 'Duty Rate', 'Wholesale Rate', 'Currency', 'Freight Rate',
  'Supplier', 'Duty Percent',
])

/**
 * The rate field each column is written from, in the same order.
 *
 * The FIELD names are the adapters' and keep v1's vocabulary (`packType`,
 * `repeat`) — a sheet's column map is also its header-recognition rule, so
 * renaming a field there would change which header rows match. Only the
 * template's labels moved.
 *
 * `productRange` is no longer written to any column: v3 has one Brand column
 * and it holds the house. Seven adapters still read a book or collection name
 * into that field (S. Harris's "PARADIGM", Colefax's books) and it now goes
 * nowhere — the template has no column for a collection. Ask the client for one
 * before inventing it.
 */
const COLUMN_FIELDS = Object.freeze([
  'dateEffective', 'brand', 'code', 'description', 'itemType',
  'packType', 'contents', 'width', 'repeat', 'verticalRepeat',
  'patternMatch', 'dutyRate', 'wholesale', 'currency', 'freightRate',
  'supplier', 'dutyPercent',
])

/** The version this header declares, or a throw naming what it matched instead. */
export const assertTemplateHeader = (header = RATE_HEADER) => {
  const template = matchTemplate([...header])
  if (template === null) {
    throw new Error(`the rate header matches no registered price template: ${JSON.stringify(header)}`)
  }
  if (template.header.length !== COLUMN_FIELDS.length) {
    throw new Error(`the rate header declares ${header.length} columns `
      + `but ${COLUMN_FIELDS.length} fields are written`)
  }
  return template
}

export const RATE_TEMPLATE = assertTemplateHeader()

/** One rate, as the template's cells. Every cell is text; an absent one is ''. */
export const rateCells = (rate) => COLUMN_FIELDS.map((field) => String(rate[field] ?? ''))

/** Where a rate came from, as `file:sheet:row` — the same coordinate a colourway keeps. */
export const rateSource = (rate) => `${rate.sourceFile}:${rate.sourceSheet}:${rate.sourceRow}`

/**
 * The key `price_list_items` upserts on, computed the way the importer will:
 * supplier, the CATEGORY the item type maps to, and the code. Two rows sharing
 * it are the same ledger row, whatever else they say.
 */
export const rateKey = (rate) => JSON.stringify([
  rate.supplier,
  CATEGORY_BY_ITEM_TYPE.get(String(rate.itemType).toLowerCase()) ?? rate.itemType,
  rate.code,
])

/** What makes two rows under one key the same rate: the money and what it buys. */
const PRICED = Object.freeze([
  'wholesale', 'currency', 'packType', 'dateEffective',
  'dutyRate', 'freightRate', 'dutyPercent',
])

const pricedAlike = (left, right) => PRICED.every((field) => left[field] === right[field])

/** How a conflicting rate reads in the report: the money and what it buys. */
const priceOf = (rate) => `${rate.wholesale} ${rate.currency} per ${rate.packType}`
  + `${rate.dateEffective === '' ? '' : ` from ${rate.dateEffective}`}`

/**
 * Collect every file's rates into the one output, one row per ledger key.
 *
 * A rate is usually the DESIGN's while the sheet that carries it prints one row
 * per colourway, so most of a design's rows repeat their rate. Three outcomes,
 * and the difference between the last two is the whole point:
 *
 * - An EXACT repeat — every emitted cell equal — is dropped and counted.
 * - A row whose key and whose MONEY match an earlier one, differing only in a
 *   cell that belongs to the colourway rather than the design (its collection,
 *   its composition), COLLAPSES onto the first and is counted. It has to: the
 *   ledger holds one row per key, so emitting both would only make
 *   `convert-price-lists.js` refuse the file over a difference nobody cares
 *   about.
 * - A key whose rows do NOT agree on the money is CONFLICTED, and **none of its
 *   rows is written**. `(supplier, category, code)` is the ledger's ratified
 *   upsert key, so the file is stating two rates for one row: Pierre Frey
 *   prices twenty-five designs both by the metre and by the piece at one
 *   amount, and nothing here can say which the office buys by. Keeping the
 *   first would decide it silently and keeping both would make the pricing
 *   converter refuse the whole file, so the run reports every coordinate and
 *   writes no rate for that code — the same posture as a row whose rate cell is
 *   empty, one level up.
 */
export const collectRates = (rates) => {
  const seen = new Set()
  const byKey = new Map()
  let duplicates = 0
  let collapsed = 0
  for (const rate of rates) {
    const cells = JSON.stringify(rateCells(rate))
    if (seen.has(cells)) {
      duplicates += 1
      continue
    }
    seen.add(cells)
    const key = rateKey(rate)
    const group = byKey.get(key)
    if (group === undefined) {
      byKey.set(key, [rate])
      continue
    }
    if (pricedAlike(group[0], rate)) {
      collapsed += 1
      continue
    }
    group.push(rate)
  }

  const records = []
  const conflicts = []
  for (const group of byKey.values()) {
    if (group.length === 1) {
      records.push(group[0])
      continue
    }
    conflicts.push(`${group[0].supplier} ${group[0].code}: `
      + group.map((rate) => `${priceOf(rate)} at ${rateSource(rate)}`).join(' vs '))
  }
  return Object.freeze({ records, duplicates, collapsed, conflicts })
}

/**
 * Prove every emitted row maps through the template it claims to be in.
 *
 * The converter would otherwise be asserting the shape by construction, and the
 * cost of being wrong is a file the office drops into `incoming/pricing-templates/`
 * and watches fail. Running the template's own mapper over the finished cells
 * catches an unmappable item type, an unknown pack, a currency the vocabulary
 * does not carry, a code that normalises to nothing and a rate that is not a
 * number — all of it in this run, naming `file:sheet:row`.
 */
export const verifyRates = (rates, template = RATE_TEMPLATE) => {
  const errors = []
  const skipped = []
  for (const rate of rates) {
    const source = rateSource(rate)
    const before = errors.length
    const item = template.map(rateCells(rate), {
      lineNumber: rate.sourceRow,
      source: `${rate.sourceFile}:${rate.sourceSheet}`,
      supplier: rate.supplier,
      fileCategory: null,
      isXlsx: false,
      errors,
      skipped,
    })
    // The template mapper skips a row it reads as unpriced. Nothing should
    // reach here that the reader did not already find a usable rate on, so a
    // skip means the two disagree — which is a fault in this converter, not a
    // property of the supplier's file.
    if (item === null && errors.length === before) {
      errors.push(`${source}: the price template declines this rate: `
        + `${skipped[skipped.length - 1] ?? 'no reason given'}`)
    }
  }
  return errors
}

const NEEDS_QUOTES = /[",\r\n]/

/** RFC 4180: quote a cell that carries a comma, a quote or a newline; double its quotes. */
const csvCell = (value) => (NEEDS_QUOTES.test(value) ? `"${value.replaceAll('"', '""')}"` : value)

/**
 * The rate file: the template's header row, then one row per rate.
 *
 * Cells are quoted but NOT formula-neutralised, unlike the CSV the trade portal
 * exports. That file is a document a person opens in Excel; this one is a
 * converter's input, and prefixing an apostrophe onto a code beginning `-` or
 * `+` would make the apostrophe part of the code the importer stores.
 */
export const serialiseRates = (rates) => [RATE_HEADER, ...rates.map(rateCells)]
  .map((cells) => cells.map(csvCell).join(','))
  .join('\r\n') + '\r\n'
