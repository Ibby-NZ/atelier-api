// The "Supplier Colours" workbook, uploaded from the CRM and landed as the
// catalogue's designs and colourways (25 Sep 2026: "the Supplier Colours 2026
// xlsx file, which contains all the colours and variations we have currently").
//
// The workbook is the supplier colour files already FLATTENED — one sheet,
// five columns, one row per colourway:
//
//   Supplier | Brand | Product Name | Code | Colour
//
// (50,575 rows across 37 brands in the 25 Sep 2026 file; a second "Notes"
// sheet says how each supplier's file was read and is not data.)
//
// UNDER THE PRODUCTS, NEVER AS PRODUCTS (28 Sep 2026). The catalogue is the
// product prices export, one product per row (product-price-catalogue.js); a
// colour row is attached as a colourway under the product its design code,
// colour code or design name names in its house, and a row no product names
// is reported. This upload creates no product and no house.

import { openWorkbook, sharedStrings, sheetRows } from '../../scripts/lib/xlsx.js'
import { applyColourAttach, planColourAttach } from './product-price-catalogue.js'

export const COLOUR_HEADER = Object.freeze(['supplier', 'brand', 'product name', 'code', 'colour'])
// Optional, beside the five: the supplier's code for the DESIGN (Fabricut's
// 32774, Colefax's F4613), which is what a product price's code usually is —
// `npm run convert:colour` writes it; a hand-made workbook may leave it out.
export const DESIGN_CODE_LABEL = 'design code'
export const MAX_REPORTED = 50
const MAX_SHEETS = 50
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

const refuse = (message, errors = []) =>
  Object.assign(new Error(message), {
    statusCode: 422,
    errors: errors.slice(0, MAX_REPORTED),
    error_count: errors.length,
  })

const label = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
const cellText = (cells, index) => String(cells.get(index) ?? '').trim()

// Sheet names in workbook order, for the `file:sheet:row` coordinate. A plain
// workbook's sheetN.xml follows that order; a name that cannot be read falls
// back to the part's own name, which still locates the row.
const sheetNames = (zip) => {
  try {
    const xml = zip.read('xl/workbook.xml').toString('utf8')
    return [...xml.matchAll(/<(?:\w+:)?sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => match[1])
  } catch {
    return []
  }
}

/**
 * The colourway rows of one uploaded workbook. The data sheet is found by its
 * HEADER (the five labels, in order), never by position — the file carries a
 * Notes sheet beside it. Throws a 422 carrying `errors` for a file that is not
 * the workbook or has a row with no supplier or no brand.
 *
 * @param {Buffer} buffer the .xlsx bytes
 * @param {string} [filename]
 * @returns {{ rows: object[], rows_read: number, sheet: string }}
 */
export const readSupplierColoursWorkbook = (buffer, filename = 'supplier-colours.xlsx') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw refuse('That file is empty.')
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw refuse('That is not an Excel workbook. Upload the Supplier Colours .xlsx.')
  }
  let zip
  let strings
  try {
    zip = openWorkbook(buffer)
    strings = sharedStrings(zip)
  } catch (error) {
    throw refuse(`That workbook could not be read (${error.message}).`)
  }
  const names = sheetNames(zip)

  for (let index = 1; index <= MAX_SHEETS; index += 1) {
    const path = `xl/worksheets/sheet${index}.xml`
    if (!zip.has(path)) break
    const sheet = names[index - 1] ?? `sheet${index}`
    const rows = []
    const errors = []
    let header = null
    let designCodeAt = null
    let rowsRead = 0
    for (const [line, cells] of sheetRows(zip, path, strings)) {
      if (header === null) {
        const labels = COLOUR_HEADER.map((_, at) => label(cells.get(at)))
        if (labels.join('|') !== COLOUR_HEADER.join('|')) break
        header = line
        designCodeAt = label(cells.get(COLOUR_HEADER.length)) === DESIGN_CODE_LABEL ? COLOUR_HEADER.length : null
        continue
      }
      const [supplier, brand, design, code, colour] = COLOUR_HEADER.map((_, at) => cellText(cells, at))
      const designCode = designCodeAt === null ? '' : cellText(cells, designCodeAt)
      // A trailing blank row is formatting, not a colourway.
      if (!supplier && !brand && !design && !code && !colour) continue
      rowsRead += 1
      if (!supplier || !brand) {
        errors.push(`row ${line}${design ? ` (${design})` : ''}: no ${supplier ? 'brand' : 'supplier'}`)
        continue
      }
      rows.push(
        Object.freeze({
          supplier,
          brand,
          design,
          design_code: designCode,
          colour_code: code,
          colour_name: colour,
          source_file: filename,
          source_sheet: sheet,
          source_row: line,
        })
      )
    }
    if (header === null) continue
    if (errors.length > 0) {
      throw refuse(`${errors.length} row${errors.length === 1 ? '' : 's'} could not be read. Nothing has been written.`, errors)
    }
    if (rows.length === 0) throw refuse('That workbook has the colour columns but no colour rows.')
    return Object.freeze({ rows: Object.freeze(rows), rows_read: rowsRead, sheet })
  }
  throw refuse(
    `No sheet in that workbook starts with the colour columns (${COLOUR_HEADER.map((word) => `"${word}"`).join(', ')}). ` +
      'Upload the Supplier Colours workbook, or put those five headings in row 1 of its first sheet.'
  )
}

/** The upload's report, from a colour-attach plan (product-price-catalogue.js). */
const report = async (db, read, plan) => {
  const skus = plan.colourways.map((colourway) => colourway.sku)
  const { rows: known } = await db.query('SELECT sku FROM colourways WHERE sku = ANY($1::text[])', [skus])
  const existing = new Set(known.map((row) => row.sku))
  const { rows: houses } = await db.query('SELECT id, name FROM brands')
  const houseName = new Map(houses.map((house) => [house.id, house.name]))
  const bySlug = new Map(plan.products.map((product) => [product.slug, product]))

  const byHouse = new Map()
  for (const product of plan.products) {
    const entry = byHouse.get(product.brand_id) ?? {
      house: { id: product.brand_id, name: houseName.get(product.brand_id) ?? null },
      products: 0,
      // Kept for the CRM's table: this upload never creates a product.
      products_new: 0,
      colourways: 0,
      priced: 0,
    }
    entry.products += 1
    if (product.trade_price_cents != null) entry.priced += 1
    byHouse.set(product.brand_id, entry)
  }
  for (const colourway of plan.colourways) byHouse.get(bySlug.get(colourway.productSlug).brand_id).colourways += 1

  const colourwaysNew = plan.colourways.filter((colourway) => !existing.has(colourway.sku)).length
  const skipped =
    plan.unknownBrands.reduce((total, entry) => total + entry.rows, 0) +
    plan.skips.reduce((total, entry) => total + entry.rows, 0)
  return Object.freeze({
    rows_read: read.rows_read,
    products: plan.products.length,
    products_new: 0,
    products_priced: plan.products.filter((product) => product.trade_price_cents != null).length,
    colourways: plan.colourways.length,
    colourways_new: colourwaysNew,
    colourways_existing: plan.colourways.length - colourwaysNew,
    rows_under_several_products: plan.rows_under_several_products,
    skipped,
    duplicates: plan.duplicates,
    houses: Object.freeze(
      [...byHouse.values()].sort((left, right) => String(left.house.name).localeCompare(String(right.house.name)))
    ),
    unknown_brands: plan.unknownBrands,
    skips: plan.skips,
    conflicts: Object.freeze(plan.conflicts.slice(0, MAX_REPORTED)),
    conflict_count: plan.conflicts.length,
    // A sample of what would land, so a one-row test can be read off the report.
    sample: Object.freeze(
      plan.colourways.slice(0, 10).map((colourway) =>
        Object.freeze({ sku: colourway.sku, name: colourway.name, product: colourway.productSlug, is_new: !existing.has(colourway.sku) })
      )
    ),
  })
}

/**
 * What applying the file would do. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {{ rows: object[], rows_read: number }} read
 */
export const planSupplierColours = async (db, read) => report(db, read, await planColourAttach(db, read.rows))

/**
 * Apply the file: every colour under the products it names, in one
 * transaction. The report is taken first so it says what was new BEFORE this
 * run wrote it.
 */
export const applySupplierColours = async (pool, read) => {
  const plan = await planSupplierColours(pool, read)
  const { plan: attached, stockRowsCreated } = await applyColourAttach(pool, read.rows)
  return Object.freeze({
    plan,
    summary: { colourways: attached.colourways.length, products: attached.products.length, inventoryCreated: stockRowsCreated },
  })
}
