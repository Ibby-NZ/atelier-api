// The product sheet — the export half of the category round trip.
//
// `products.category` (fabric | wallpaper | trimming | accessory) is the axis on
// which the catalogue and the supplier rate ledger become joinable, and it is
// nullable with no default: every product predates the column, so somebody has
// to look at each design and say what it is. That somebody is the office, not a
// developer, so the fill-in path is a spreadsheet: download a sheet per house,
// type into the Category column, upload it back (US-003/US-004).
//
// THE HEADER ROW IS A CONTRACT. The re-import matches on it, so a label here is
// not a caption — renaming one breaks every sheet already on somebody's desk.
//
//   Product ID  the server key. Present so a re-import matches on identity and
//               NEVER on row order: staff sort the sheet, delete rows they have
//               already done and paste blocks between files, none of which a
//               positional match survives. It is `products.id` rather than the
//               slug because the slug is immutable by policy while the id is
//               immutable by construction.
//   House       the maison, for the human. Not a key — a re-import reads the id.
//   Collection  blank where the product is uncollected, which is normal and is
//               in fact the seed's default (membership is staff-assigned).
//   Design      the product name.
//   Category    ALWAYS EMPTY. This is the column the office fills in; exporting
//               the stored value would make a re-import unable to tell "the
//               office confirmed this" from "the office did not touch the row",
//               and the counts US-004 reports depend on that distinction.
//
// The vocabulary is deliberately not printed in the file — a CSV has nowhere to
// put a note that Excel will not hand back as a data row. The CRM panel (US-005)
// states the four values, and US-003 reports an unknown one with its row number.

import { csvDocument, csvRows, decodeText } from '../lib/csv-text.js'
// products.category and price_list_items.category are ONE vocabulary — that is
// the whole point of the column — so the accepted set is imported from the
// pipeline's own registry rather than retyped here. src/ importing from
// scripts/ is deliberate and already load-bearing (src/seed/price-lists.js,
// src/routes/admin-price-lists.js): one package, plain relative specifier.
import { CATEGORIES } from '../../scripts/lib/price-template.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The house the office categorises first: Atelier's own workroom is the only
// `trade_only = false` maison and the only one with retail prices, so it is the
// one whose merchandising axis is load-bearing today. Any other house is one
// `?brand=` away — the sheet is per house because a designer works through one
// supplier's catalogue at a time, and a single 19k-row file is not fillable.
export const DEFAULT_BRAND_SLUG = 'atelier-textiles-nz'

/** The header row, in order. Asserted verbatim by test/product-sheet.test.js. */
export const PRODUCT_SHEET_HEADER = Object.freeze([
  'Product ID',
  'House',
  'Collection',
  'Design',
  'Category',
])

/**
 * One house's products, as sheet rows.
 *
 * Archived products are excluded: archiving is how a design leaves the
 * catalogue, and asking the office to categorise one is asking for work nothing
 * reads. Hidden products (`show_on_website = false`) ARE included — this is a
 * back-office sheet, and a design still being photographed is exactly the kind
 * nobody has categorised yet. The house itself is fetched whatever its archived
 * state, like every other by-slug admin read.
 *
 * @param {import('pg').Pool} pool
 * @param {string} brandSlug
 * @returns {Promise<{ brand: { id: number, slug: string, name: string }, rows: object[] }>}
 * @throws 404 when the slug names no house
 */
export const getProductSheet = async (pool, brandSlug) => {
  const { rows: brands } = await pool.query(
    'SELECT id, slug, name FROM brands WHERE slug = $1',
    [brandSlug]
  )
  if (brands.length === 0) {
    throw httpError(404, `No house with slug "${brandSlug}".`)
  }
  const brand = brands[0]

  // Ordered for the person filling it in, not for the importer — the key is what
  // the importer matches on. `p.id` breaks the tie so two designs sharing a name
  // still export in the same order every time.
  const { rows } = await pool.query(
    `SELECT p.id,
            p.name AS design,
            col.name AS collection
       FROM products p
       LEFT JOIN collections col ON col.id = p.collection_id
      WHERE p.brand_id = $1
        AND p.archived_at IS NULL
      ORDER BY p.name, p.id`,
    [brand.id]
  )

  return {
    brand: { id: brand.id, slug: brand.slug, name: brand.name },
    rows: rows.map((row) =>
      Object.freeze({
        id: row.id,
        house: brand.name,
        collection: row.collection,
        design: row.design,
      })
    ),
  }
}

/**
 * The sheet as CSV. A house with no products yields the header alone, which is
 * a legitimate empty sheet rather than an error — the office reads it as "this
 * house holds nothing", which is true.
 *
 * @param {{ rows: object[] }} sheet  from getProductSheet
 * @returns {string}
 */
export const toProductSheetCsv = ({ rows }) =>
  csvDocument([
    [...PRODUCT_SHEET_HEADER],
    // Category is emitted empty for every row — see the header contract above.
    ...rows.map((row) => [row.id, row.house, row.collection, row.design, '']),
  ])

/**
 * The download filename. Built from the brand SLUG, which is `[a-z0-9-]` by
 * construction (slugs are server-generated and immutable), so nothing a staff
 * member typed — least of all a CR or a quote — can reach the
 * Content-Disposition header. The house NAME, which is free text, never does.
 *
 * @param {string} brandSlug
 * @returns {string}
 */
export const productSheetFilename = (brandSlug) => `atelier-product-sheet-${brandSlug}.csv`

// ---------------------------------------------------------------------------
// The import half: reading a filled-in sheet back.
//
// The file the office posts back is read by the module that wrote it, so the
// header contract above is the parser's only anchor and the Category column the
// export left empty is the one column anybody fills in.
//
// THIS HALF WRITES NOTHING. It parses, matches every row against the catalogue
// and reports — US-004 applies what it returns. Everything a row can get wrong
// is reported with that row's own line number, because staff work in Excel and
// a line number is how a person finds a row again. Nothing is guessed: an id
// that matches no product is reported, never resolved through the House or
// Design cells beside it (those are for the human, and staff edit them).
//
// The upload is deliberately NOT brand-scoped. `Product ID` is `products.id`,
// which is unique across the catalogue, so a sheet identifies its own rows
// whichever house they came from — and a scope would only add a way for a
// legitimate file to be refused.
// ---------------------------------------------------------------------------

/**
 * The four values `products.category` accepts, in the CHECK's own order.
 * Re-exported so the CRM panel can state them: a CSV has nowhere to put a note
 * Excel will not hand back as a data row, so the file itself cannot.
 */
export const PRODUCT_CATEGORIES = Object.freeze([...CATEGORIES])

/** Columns are found by LABEL, so reordering the contract cannot mis-read a cell. */
const COLUMN = Object.freeze({
  id: PRODUCT_SHEET_HEADER.indexOf('Product ID'),
  design: PRODUCT_SHEET_HEADER.indexOf('Design'),
  category: PRODUCT_SHEET_HEADER.indexOf('Category'),
})

// `products.id` is int4. A typed-in digit string past the ceiling would reach
// the `int[]` cast and surface as a 500 from Postgres, so it is refused here as
// what it is: not a Product ID.
const MAX_PRODUCT_ID = 2147483647

/**
 * How many row errors a response carries. The count is always reported in full
 * beside them — a staff member who broke sixty rows broke them the same way
 * three times over, and a response listing all of them is unreadable.
 */
export const MAX_REPORTED_ERRORS = 50

/** How many pending changes the validation report previews, likewise counted in full. */
export const MAX_REPORTED_CHANGES = 200

// Written as a code point on purpose: a literal U+FEFF in source is invisible.
const BOM = String.fromCharCode(0xfeff)

// Excel writes trailing blank cells and a hand-edited header line often ends in
// a stray comma; a blank cell declares no column, so counting one would fail a
// real sheet over a keystroke. Same rule, for the same reason, as
// scripts/lib/price-template.js's own header normalisation.
const normaliseHeaderRow = (fields) => {
  const cells = fields.map((cell) => cell.trim())
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
  // decodeText strips a UTF-8 BOM; one only reaches here when the file failed
  // the strict UTF-8 decode and fell through to a byte-per-character one.
  if (cells.length > 0 && cells[0].startsWith(BOM)) cells[0] = cells[0].slice(BOM.length)
  return cells
}

const isBlankLine = (fields) => fields.length === 1 && fields[0].trim() === ''

/**
 * Parse a posted sheet. Pure: no database, no writes.
 *
 * A structural failure — not a file, empty, or a header this API never wrote —
 * throws 400, because there is nothing to report per row. Everything else is a
 * row error carrying its line number, and the caller decides what to do with
 * the set (US-004 refuses to apply a sheet with any).
 *
 * @param {Buffer} bytes  the raw upload, encoding unknown
 * @returns {{ rows: number, skipped: number, repeats: number,
 *             entries: { row: number, id: number, design: string, category: string }[],
 *             errors: { row: number, message: string }[] }}
 */
export const parseProductSheet = (bytes) => {
  if (!Buffer.isBuffer(bytes)) {
    throw httpError(400, 'Post the sheet as the raw file, with content-type text/csv.')
  }

  // A file saved by Excel on Windows is cp1252 and says so nowhere; decodeText
  // sniffs strict UTF-8 (BOM tolerated) first, then cp1252, then latin-1.
  const rows = [...csvRows(decodeText(bytes))]
  if (rows.length === 0) {
    throw httpError(400, 'The file is empty.')
  }

  const header = normaliseHeaderRow(rows[0][1])
  if (
    header.length !== PRODUCT_SHEET_HEADER.length ||
    header.some((cell, at) => cell !== PRODUCT_SHEET_HEADER[at])
  ) {
    throw httpError(
      400,
      `Unexpected header row [${header.join(', ')}] — expected ` +
        `[${PRODUCT_SHEET_HEADER.join(', ')}]. Download the sheet again and fill in that copy.`
    )
  }

  const errors = []
  const fail = (row, message) => errors.push({ row, message })
  // Keyed by Product ID, so the file's row ORDER never decides anything.
  const entries = new Map()
  let read = 0
  let skipped = 0
  let repeats = 0

  for (const [row, fields] of rows.slice(1)) {
    // A blank line is what Excel and a hand edit both leave behind; it is not a
    // row anybody typed, so it is not counted and not reported.
    if (isBlankLine(fields)) continue
    read += 1

    if (fields.length !== PRODUCT_SHEET_HEADER.length) {
      fail(row, `${fields.length} columns, expected ${PRODUCT_SHEET_HEADER.length}.`)
      continue
    }

    const rawId = fields[COLUMN.id].trim()
    if (!/^\d+$/.test(rawId) || Number(rawId) > MAX_PRODUCT_ID) {
      fail(row, `"${rawId}" is not a Product ID. Leave that column as the sheet exported it.`)
      continue
    }
    const id = Number(rawId)
    const design = fields[COLUMN.design].trim()

    // An EMPTY Category is a row nobody touched, which is exactly why the export
    // leaves the column blank: it is what makes "confirmed this" and "did not
    // get to this" two different states rather than one.
    const stated = fields[COLUMN.category].trim()
    if (stated === '') {
      skipped += 1
      continue
    }

    // Lower-cased before matching: the stored vocabulary is lower case and
    // "Fabric" can only mean `fabric`, so refusing it would be pedantry.
    const category = stated.toLowerCase()
    if (!CATEGORIES.has(category)) {
      fail(row, `"${stated}" is not a category. Use one of: ${PRODUCT_CATEGORIES.join(', ')}.`)
      continue
    }

    const seen = entries.get(id)
    if (seen === undefined) {
      entries.set(id, { row, id, design, category })
      continue
    }
    // Staff paste blocks between files, so the same product can legitimately
    // appear twice. Saying the same thing twice collapses; saying two different
    // things is ambiguous and nothing here may choose between them.
    if (seen.category === category) {
      repeats += 1
      continue
    }
    fail(row, `Product ID ${id} is "${category}" here and "${seen.category}" on row ${seen.row}.`)
  }

  return Object.freeze({
    rows: read,
    skipped,
    repeats,
    entries: [...entries.values()],
    errors,
  })
}

const describeRow = (entry) => (entry.design === '' ? '' : ` (${entry.design})`)

/**
 * Parse a posted sheet and match every stated category against the catalogue.
 * Reads only — the counts it returns are what US-004 applies and reports back.
 *
 * When there are no errors the whole file is accounted for:
 * `rows === skipped + repeats + unchanged + changed`.
 *
 * @param {import('pg').Pool} pool
 * @param {Buffer} bytes
 * @returns {Promise<{ summary: object, changes: object[], updates: object[], errors: object[] }>}
 * @throws 400 when the file is not a product sheet at all
 */
export const validateProductSheet = async (pool, bytes) => {
  const parsed = parseProductSheet(bytes)
  const errors = [...parsed.errors]
  const changes = []
  const updates = []
  let unchanged = 0

  if (parsed.entries.length > 0) {
    const { rows } = await pool.query(
      'SELECT id, name, category, archived_at FROM products WHERE id = ANY($1::int[])',
      [parsed.entries.map((entry) => entry.id)]
    )
    const products = new Map(rows.map((row) => [row.id, row]))

    for (const entry of parsed.entries) {
      const product = products.get(entry.id)
      // Reported, never guessed — the Design cell goes into the message only so
      // the person can find the row, and is never used to resolve it.
      if (product === undefined) {
        errors.push({
          row: entry.row,
          message: `No product with ID ${entry.id}${describeRow(entry)}.`,
        })
        continue
      }
      // Archiving is how a design leaves the catalogue, so the export omits
      // archived products and a category typed against one is work nothing
      // reads. Refused rather than absorbed: the office asked for something.
      if (product.archived_at !== null) {
        errors.push({
          row: entry.row,
          message: `Product ID ${entry.id} (${product.name}) is archived and is not on the sheet.`,
        })
        continue
      }
      if (product.category === entry.category) {
        unchanged += 1
        continue
      }
      updates.push({ id: entry.id, category: entry.category })
      // The design name comes from the DATABASE, not from the file: the file's
      // copy is a snapshot the office may have edited, and this line is the
      // preview of what the write will actually touch.
      changes.push({
        row: entry.row,
        id: entry.id,
        design: product.name,
        from: product.category,
        to: entry.category,
      })
    }
  }

  errors.sort((left, right) => left.row - right.row)

  return Object.freeze({
    summary: Object.freeze({
      rows: parsed.rows,
      skipped: parsed.skipped,
      repeats: parsed.repeats,
      unchanged,
      changed: changes.length,
    }),
    changes,
    updates,
    errors,
  })
}
