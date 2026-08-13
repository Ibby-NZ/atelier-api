// Self-service price-list import — the office's own way in, beside the CLI.
//
// > Liz: "So we're still going to be able to do our own price list and all that
// > sort of stuff. We don't have to come to you."
//
// Until now the only way a supplier's rates reached `price_list_items` was
// `npm run import:pricing` on a developer's laptop. This module is the same
// pipeline behind an HTTP request, and the word "same" is the whole design:
//
//   - The accepted layouts are `matchTemplate` from the converter's own
//     registry. THE HEADER ROW IS THE VERSION here exactly as it is there.
//   - The row mapping is the template's own `map` — `mapV1` / `mapV3`,
//     untouched. `src/seed/data/price-lists.json` is byte-pinned to those
//     mappers, so a second mapper written for the web path would be a second
//     definition of what a supplier's file means.
//   - The write is `upsertPriceListItems` from `src/seed/price-lists.js`, so the
//     `(supplier, category, code)` upsert, the `template_version` COALESCE and
//     the three drop-detection columns are one statement, not two.
//   - The rate moves are recorded by the W17 capture TRIGGER, declared here with
//     `source: 'import'` through `setChangeContext`. There is deliberately no
//     second history path: a writer that bypassed the ledger is precisely what
//     W17 exists to make impossible.
//
// THIS ADDS A SECOND DOOR; IT DOES NOT RETIRE THE FIRST. `npm run convert:pricing`
// and `npm run import:pricing` keep working, and the committed price-lists.json
// stays byte-pinned to them.
//
// THE THREE-STEP SHAPE IS `src/products/product-sheet.js`'s, restated for rates:
// parse (pure) → match against the ledger (reads only) → apply (one
// transaction). The dry run and the apply share ONE matcher, so the report the
// office reads and the write it authorises cannot be two different opinions.
//
// The one thing this path does NOT inherit from the CLI is the filename. The
// converter derives a supplier and a category token out of "BOUSSAC FABRIC PL
// 2026.csv", which `src/seed/CLAUDE.md` calls the most fragile input in the
// pipeline — a rename silently renamed a supplier. A request can simply say, so
// it does: `supplier` and `category` are stated by the caller and are FALLBACKS
// only, exactly as the filename was. A v3 file's own Supplier cell still wins.

import {
  matchTemplate,
  acceptedHeaders,
  CATEGORY_BY_ITEM_TYPE,
  CATEGORIES,
} from '../../scripts/lib/price-template.js'
import { worksheetGrid } from '../../scripts/lib/xlsx.js'
import { decodeText, csvRows } from '../lib/csv-text.js'
import { validatePriceListItems, upsertPriceListItems } from '../seed/price-lists.js'
import { setChangeContext, raisePriceHistoryError } from './price-history.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * How many row errors and how many previewed changes a response carries. The
 * true count always rides beside them: a supplier who broke sixty rows broke
 * them the same way sixty times, and a silent cap reads as "that was all".
 * Same rule, same reason, as the product sheet's own two caps.
 */
export const MAX_REPORTED_ERRORS = 50
export const MAX_REPORTED_CHANGES = 200

/** The four values a category cell may resolve to, for the CRM to state. */
export const IMPORT_CATEGORIES = Object.freeze([...CATEGORIES])

// A .xlsx is a zip and every zip starts "PK\x03\x04"; no text file this pipeline
// has ever seen starts with those bytes. Sniffed rather than read off the
// filename or the content-type, because both are the caller's account of what it
// sent — the same reason decodeText sniffs the encoding instead of trusting a
// declaration.
const isWorkbook = (bytes) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
  && bytes[2] === 0x03 && bytes[3] === 0x04

const fileRows = (bytes) => (isWorkbook(bytes)
  // A file saved by Excel on Windows is cp1252 and says so nowhere; decodeText
  // sniffs strict UTF-8 (BOM tolerated), then cp1252, then latin-1.
  ? worksheetGrid(bytes)
  : csvRows(decodeText(bytes)))

const isBlankRow = (row) => !row.some((cell) => String(cell).trim())

// Key COUNTS are compared too: a v3 row carries keys a v1 row does not, so
// comparing only the earlier row's keys would call the two identical and drop
// the richer one. Lifted from scripts/convert-price-lists.js, same rule.
const sameExceptSource = (left, right) =>
  Object.keys(left).length === Object.keys(right).length
  && Object.keys(left).every((key) => key === 'source_file' || left[key] === right[key])

/**
 * Parse an uploaded price list. Pure: no database, no writes.
 *
 * A structural failure — not a file, empty, or a header no registered template
 * declares — throws 400, because there is nothing to report per row. Everything
 * else is a row-level verdict carrying that row's own line number, which is how
 * a person finds the row again in Excel.
 *
 * @param {Buffer} bytes the raw upload, encoding and format unknown
 * @param {{ filename: string, supplier?: string|null, category?: string|null }} options
 * @returns {{ template_version: string, file: string, rows: number, items: object[],
 *             rowOf: Map<object, number>, skipped: {row:number,message:string}[],
 *             duplicates: number, unmappable_categories: {row:number,value:string}[],
 *             errors: {row:number,message:string}[] }}
 *   `rowOf` maps each mapped item back to the line it came off — kept beside the
 *   items rather than ON them, so nothing an item carries into the upsert has to
 *   be stripped back out first.
 */
export const parsePriceListFile = (bytes, { filename, supplier = null, category = null } = {}) => {
  if (!Buffer.isBuffer(bytes)) {
    throw httpError(400, 'Post the price list as the raw file, with the file\'s own content type.')
  }
  if (bytes.length === 0) {
    throw httpError(400, 'The file is empty.')
  }

  // A file-level fact, resolved once: a workbook stores a date as an Excel
  // serial (45870) where a CSV writes "12/08/2026", and the mappers read the
  // two differently.
  const isXlsx = isWorkbook(bytes)
  const rows = fileRows(bytes)[Symbol.iterator]()
  const first = rows.next()
  if (first.done) {
    throw httpError(400, 'The file is empty.')
  }

  // THE HEADER ROW IS THE VERSION — no version cell, no preamble line. A version
  // cell can be misdeclared by deleting a column; a header mismatch cannot.
  const [headerLine, header] = first.value
  const template = matchTemplate(header)
  if (template === null) {
    throw httpError(
      400,
      `Unexpected header row on line ${headerLine}: ${JSON.stringify(header)}. `
      + `Accepted: ${acceptedHeaders().join(' | ')}.`
    )
  }
  // Only a template with its own Supplier column can survive a caller that did
  // not name one. A v1 drop has nowhere else to get it from, so this is a 400
  // rather than a per-row error: every row would carry it.
  if (!supplier && !template.header.includes('supplier')) {
    throw httpError(
      400,
      `This file is the ${template.version} layout, which has no Supplier column, `
      + 'so the import has to be told which supplier it is for.'
    )
  }

  // Both registered templates carry Item Type; read its position off the matched
  // header rather than a constant, so a future layout that moves it cannot make
  // this check quietly read the wrong cell.
  const itemTypeAt = template.header.indexOf('item type')

  const items = new Map()
  const errors = []
  const skipped = []
  const unmappableCategories = []
  let read = 0
  let duplicates = 0

  for (const [lineNumber, row] of rows) {
    // A wholly blank line is what Excel and a hand edit both leave behind. It is
    // not a row anybody typed, so it is neither counted nor reported.
    if (isBlankRow(row)) continue
    read += 1

    // US-004 — AN UNMAPPABLE CATEGORY IS REPORTED WITH ITS ROW, NEVER ABSORBED.
    //
    // This runs BEFORE the mapper and skips it, for a reason worth stating:
    // `mapV1` resolves `CATEGORY_BY_ITEM_TYPE.get(cell) ?? fileCategory`, so
    // with a stated fallback category a cell saying "Leather" would import
    // silently AS a fabric. The fallback is for a BLANK cell — a file that did
    // not say — and never for a cell that said something this catalogue has no
    // word for.
    //
    // Live today: 112 D365 price rows and 958 stock rows say Leather, Samples
    // and Displays, Throws/Blankets, Towels, Cushions, Bedding, Candles,
    // Furniture, Rug/Carpet or "No Group Selected". Whether the four-value
    // vocabulary should grow a fifth word is the CLIENT'S decision, not this
    // importer's, so the rows are named and handed back rather than widened
    // into or dropped.
    const stated = String(row[itemTypeAt] ?? '').trim()
    if (stated !== '' && !CATEGORY_BY_ITEM_TYPE.has(stated.toLowerCase())) {
      unmappableCategories.push({ row: lineNumber, value: stated })
      errors.push({
        row: lineNumber,
        message: `${filename}:${lineNumber}: "${stated}" is not one of the categories this `
          + `catalogue holds (${IMPORT_CATEGORIES.join(', ')}). Nothing has been guessed for it — `
          + 'tell us which of the four it belongs under, or that the list needs a new one.',
      })
      continue
    }

    // The mapper reports through the two arrays it is handed. Fresh ones per
    // row, so a message is attributable to a line without parsing its own text
    // back out.
    const rowErrors = []
    const rowSkips = []
    const item = template.map(row, {
      lineNumber,
      source: filename,
      supplier,
      fileCategory: category,
      isXlsx,
      errors: rowErrors,
      skipped: rowSkips,
    })
    for (const message of rowErrors) errors.push({ row: lineNumber, message })
    // An unpriced row (wholesale rate 0 — price on application) is a legitimate
    // omission, not a failure: writing it would make the office quote nothing
    // for a fabric. Counted and listed, never fatal.
    for (const message of rowSkips) skipped.push({ row: lineNumber, message })
    if (item === null) continue

    // `(supplier, category, code)` is the ledger's key, and `validatePriceListItems`
    // rejects a batch carrying it twice — so a file that repeats a code has to be
    // resolved here or a legitimate drop 500s at the INSERT. Exact repeats
    // collapse keep-first (a supplier reprinting a code identically is making one
    // statement); a repeat that DISAGREES is an error naming both rows, because
    // nothing here may choose between two prices for one code.
    const key = JSON.stringify([item.supplier, item.category, item.code])
    const seen = items.get(key)
    if (seen === undefined) {
      items.set(key, { row: lineNumber, item })
      continue
    }
    if (sameExceptSource(seen.item, item)) {
      duplicates += 1
      continue
    }
    errors.push({
      row: lineNumber,
      message: `${filename}:${lineNumber}: ${item.supplier} ${item.category} ${item.code} is `
        + `stated differently here and on row ${seen.row}. One code is one rate.`,
    })
  }

  errors.sort((left, right) => left.row - right.row)

  return Object.freeze({
    template_version: template.version,
    file: filename,
    rows: read,
    items: [...items.values()].map((entry) => entry.item),
    rowOf: new Map([...items.values()].map((entry) => [entry.item, entry.row])),
    skipped,
    duplicates,
    unmappable_categories: unmappableCategories,
    errors,
  })
}

// pg hands a `numeric` back as a STRING, and `Number(null)` is 0 — so a rate is
// coerced explicitly and a null stays null rather than becoming a free price cut.
const toRate = (value) => (value == null ? null : Number(value))

/**
 * Match a parsed file against the rate ledger. Reads only.
 *
 * `db` is a pool or an open client, so the apply step runs this identical read
 * inside its own transaction — the `matchProductSheet` shape. There is no `FOR
 * UPDATE` here and there is deliberately none in the apply either: the upsert
 * that follows takes its own locks on exactly these rows, and a report that
 * locked 19,500 rows to answer a question would stall the back office.
 *
 * @param {{ query: Function }} db
 * @param {ReturnType<typeof parsePriceListFile>} parsed
 */
const matchPriceListFile = async (db, parsed) => {
  const changes = []
  let created = 0
  let unchanged = 0

  if (parsed.items.length > 0) {
    // Joined through unnest rather than a giant IN list: a real drop is
    // thousands of rows, and this hits the (supplier, category, code) unique
    // index the upsert conflicts on.
    const { rows } = await db.query(
      `SELECT p.supplier, p.category, p.code, p.wholesale_rate, p.currency
         FROM price_list_items p
         JOIN unnest($1::text[], $2::text[], $3::text[]) AS k(supplier, category, code)
           ON p.supplier = k.supplier AND p.category = k.category AND p.code = k.code`,
      [
        parsed.items.map((item) => item.supplier),
        parsed.items.map((item) => item.category),
        parsed.items.map((item) => item.code),
      ]
    )
    const held = new Map(
      rows.map((row) => [JSON.stringify([row.supplier, row.category, row.code]), row])
    )

    for (const item of parsed.items) {
      const existing = held.get(JSON.stringify([item.supplier, item.category, item.code]))
      if (existing === undefined) {
        created += 1
        continue
      }
      const from = toRate(existing.wholesale_rate)
      if (from === item.wholesale_rate && existing.currency === item.currency) {
        unchanged += 1
        continue
      }
      changes.push({
        row: parsed.rowOf.get(item),
        supplier: item.supplier,
        category: item.category,
        code: item.code,
        from,
        from_currency: existing.currency,
        to: item.wholesale_rate,
        to_currency: item.currency,
      })
    }
  }

  return Object.freeze({
    summary: Object.freeze({
      file: parsed.file,
      template_version: parsed.template_version,
      // rows === imported + skipped + duplicates + failed, always. The only
      // guarantee a summary has of being trustworthy is that it accounts for
      // every line of the file.
      rows: parsed.rows,
      imported: parsed.items.length,
      skipped: parsed.skipped.length,
      duplicates: parsed.duplicates,
      failed: parsed.errors.length,
      // What the write would do, of the rows that mapped.
      created,
      changed: changes.length,
      unchanged,
    }),
    changes,
    skipped: parsed.skipped,
    unmappable_categories: parsed.unmappable_categories,
    errors: parsed.errors,
  })
}

/**
 * US-002 — THE DRY RUN. Reports exactly what would change and WRITES NOTHING.
 *
 * @param {{ query: Function }} db
 * @param {Buffer} bytes
 * @param {object} options see parsePriceListFile
 * @throws 400 when the file is not a price list at all
 */
export const validatePriceListFile = async (db, bytes, options) =>
  matchPriceListFile(db, parsePriceListFile(bytes, options))

const INSERT_IMPORT_SQL = `
  INSERT INTO price_list_imports (
    imported_by_user_id, filename, template_version,
    rows_read, rows_imported, rows_skipped, rows_duplicate)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  RETURNING id, imported_by_user_id, filename, template_version,
            rows_read, rows_imported, rows_skipped, rows_duplicate, created_at`

/**
 * US-003 — THE APPLY. One transaction: either every rate in the file lands and
 * the import is logged, or neither happens. A half-applied price list is worse
 * than a refused one, because the office cannot tell which half by looking at
 * the file.
 *
 * A file with ANY row error is refused whole, reported exactly as the dry run
 * reports it, `applied: 0`. That is what makes "an unmappable category is never
 * dropped" literally true: there is no partial landing for it to be dropped from.
 *
 * Re-applying the same file is idempotent where it matters — every row upserts
 * to the value it already holds, the capture trigger's WHEN clause does not
 * fire, and no history is written. `last_seen_in_import` does move, which is the
 * point of drop detection, and a second `price_list_imports` row is written,
 * because a second import genuinely happened.
 *
 * @param {import('pg').Pool} pool
 * @param {Buffer} bytes
 * @param {object} options see parsePriceListFile, plus `user`
 */
export const applyPriceListFile = async (pool, bytes, { user = null, ...options } = {}) => {
  // Parsed before a connection is taken: a file that is not a price list at all
  // is a 400 and has no business holding one open.
  const parsed = parsePriceListFile(bytes, options)

  // The importer's own field-level gate, on the same items the CLI would hand
  // it. A malformed batch is a 422 rather than an opaque CHECK violation, and it
  // runs before the transaction for the same reason the parse does.
  if (parsed.errors.length === 0) {
    try {
      validatePriceListItems(parsed.items)
    } catch (error) {
      throw httpError(422, `${parsed.file}: ${error.message}`)
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const report = await matchPriceListFile(client, parsed)

    if (report.errors.length > 0) {
      await client.query('ROLLBACK')
      return Object.freeze({ ...report, applied: 0, import: null })
    }

    // What lets the write happen at all: the capture trigger REFUSES a rate
    // change that declares no source. `source: 'import'` and no reason, so the
    // trigger builds one per row out of that row's own source_file and
    // date_effective — "BOUSSAC PL 2026.xlsx said so (effective 2026-08-01)".
    // The user id is what the CLI cannot supply and this path can: the office
    // running its own imports is the whole reason W18 exists.
    await setChangeContext(client, { source: 'import', userId: user?.id ?? null })
    await upsertPriceListItems(client, parsed.items)

    // Same transaction as the rates, so the log cannot claim an import that
    // rolled back — and `created_at` is now(), which is transaction-start, so it
    // equals every history row's changed_at exactly. That equality is how a
    // history screen attributes a rate move to this import without a second
    // foreign key.
    const { rows } = await client.query(INSERT_IMPORT_SQL, [
      user?.id ?? null,
      parsed.file,
      parsed.template_version,
      parsed.rows,
      parsed.items.length,
      parsed.skipped.length,
      parsed.duplicates,
    ])

    await client.query('COMMIT')
    return Object.freeze({ ...report, applied: parsed.items.length, import: rows[0] })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Surface the original failure, not the rollback's; pg discards the
      // released connection either way. The importPriceLists posture.
    }
    // An undeclared-source refusal or a missing manual reason is ours and is a
    // 422, mapped once here rather than in the route.
    raisePriceHistoryError(error)
    throw error
  } finally {
    client.release()
  }
}

/** How many imports the history screen lists. Nothing pages it today. */
export const IMPORT_HISTORY_LIMIT = 100

/**
 * Every applied import, newest first — who, when, which file, how it accounted
 * for itself. The CRM's import history screen.
 *
 * @param {import('pg').Pool} pool
 */
export const listPriceListImports = async (pool) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.filename, i.template_version,
            i.rows_read, i.rows_imported, i.rows_skipped, i.rows_duplicate,
            i.created_at, i.imported_by_user_id,
            u.name AS imported_by_name
       FROM price_list_imports i
       LEFT JOIN users u ON u.id = i.imported_by_user_id
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT ${IMPORT_HISTORY_LIMIT}`
  )
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })))
}
