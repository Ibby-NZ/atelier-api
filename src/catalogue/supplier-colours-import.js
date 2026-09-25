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
// ONE LANDING PATH. Every row is turned into the normalised colourway record
// `npm run import:colour` already takes — { supplier, brand, design,
// colour_code, colour_name, source_file/sheet/row } — and planned and written
// by src/seed/colourways-import.js, unchanged: a house is resolved by SLUG and
// an unknown one is REPORTED, never created; one product per (house, design),
// DO NOTHING on an existing product; one colourway per SKU
// (`<house slug>-<design>-<code>`), upserted; a zeroed stock row, DO NOTHING.
// A second reader here, a first-class import there — the rules cannot fork.
//
// The dry run also says how many of the designs it would land have a product
// price behind them (src/pricing/product-prices.js prices them), because that
// is the question the office is testing the import to answer.

import { openWorkbook, sharedStrings, sheetRows } from '../../scripts/lib/xlsx.js'
import { importColourways, prepareColourwayImport } from '../seed/colourways-import.js'
import { createProductPricer, nameKey } from '../pricing/product-prices.js'

export const COLOUR_HEADER = Object.freeze(['supplier', 'brand', 'product name', 'code', 'colour'])
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
    let rowsRead = 0
    for (const [line, cells] of sheetRows(zip, path, strings)) {
      if (header === null) {
        const labels = COLOUR_HEADER.map((_, at) => label(cells.get(at)))
        if (labels.join('|') !== COLOUR_HEADER.join('|')) break
        header = line
        continue
      }
      const [supplier, brand, design, code, colour] = COLOUR_HEADER.map((_, at) => cellText(cells, at))
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
          design_code: '',
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

/**
 * What applying the file would do. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {{ rows: object[], rows_read: number }} read
 */
export const planSupplierColours = async (db, read) => {
  // The same brand set the import plans against (archived houses included).
  const { rows: brands } = await db.query('SELECT id, name, slug, currency FROM brands')
  const plan = prepareColourwayImport(read.rows, brands)

  const skus = plan.colourways.map((colourway) => colourway.sku)
  const slugs = plan.products.map((product) => product.slug)
  const { rows: knownSkus } = await db.query('SELECT sku FROM colourways WHERE sku = ANY($1::text[])', [skus])
  const { rows: knownSlugs } = await db.query('SELECT slug FROM products WHERE slug = ANY($1::text[])', [slugs])
  const existingSkus = new Set(knownSkus.map((row) => row.sku))
  const existingSlugs = new Set(knownSlugs.map((row) => row.slug))

  // Which designs a product price stands behind: the price row's range must
  // price through THIS house (the pricer's own rule) and its description or
  // code must be the design's name.
  const pricer = createProductPricer(db)
  const { rows: priceRows } = await db.query(
    `SELECT DISTINCT range_name, lower(btrim(description)) AS description, lower(btrim(code)) AS code
       FROM product_prices
      WHERE last_import_id = (SELECT max(id) FROM product_price_imports)`
  )
  const priced = new Set()
  for (const row of priceRows) {
    const house = await pricer.houseFor(row.range_name)
    if (!house) continue
    for (const name of [row.description, row.code]) if (name) priced.add(`${house.id}\u0000${name}`)
  }

  const brandById = new Map(brands.map((brand) => [brand.id, brand]))
  const byHouse = new Map()
  const colourwaysByProduct = new Map()
  for (const colourway of plan.colourways) {
    colourwaysByProduct.set(colourway.productSlug, (colourwaysByProduct.get(colourway.productSlug) ?? 0) + 1)
  }
  let pricedProducts = 0
  for (const product of plan.products) {
    const hasPrice = priced.has(`${product.brand_id}\u0000${nameKey(product.name)}`)
    if (hasPrice) pricedProducts += 1
    const entry = byHouse.get(product.brand_id) ?? {
      house: { id: product.brand_id, name: brandById.get(product.brand_id)?.name ?? null },
      products: 0,
      products_new: 0,
      colourways: 0,
      priced: 0,
    }
    entry.products += 1
    if (!existingSlugs.has(product.slug)) entry.products_new += 1
    entry.colourways += colourwaysByProduct.get(product.slug) ?? 0
    if (hasPrice) entry.priced += 1
    byHouse.set(product.brand_id, entry)
  }

  const colourwaysNew = plan.colourways.filter((colourway) => !existingSkus.has(colourway.sku)).length
  return Object.freeze({
    rows_read: read.rows_read,
    products: plan.products.length,
    products_new: plan.products.filter((product) => !existingSlugs.has(product.slug)).length,
    products_priced: pricedProducts,
    colourways: plan.colourways.length,
    colourways_new: colourwaysNew,
    colourways_existing: plan.colourways.length - colourwaysNew,
    skipped: plan.skipped,
    duplicates: plan.duplicates,
    houses: Object.freeze(
      [...byHouse.values()].sort((left, right) => String(left.house.name).localeCompare(String(right.house.name)))
    ),
    unknown_brands: Object.freeze(plan.unknownBrands),
    skips: Object.freeze(plan.skips),
    conflicts: Object.freeze(plan.conflicts.slice(0, MAX_REPORTED)),
    conflict_count: plan.conflicts.length,
    // A sample of what would land, so a one-row test can be read off the report.
    sample: Object.freeze(
      plan.colourways.slice(0, 10).map((colourway) =>
        Object.freeze({ sku: colourway.sku, name: colourway.name, product: colourway.productSlug, is_new: !existingSkus.has(colourway.sku) })
      )
    ),
  })
}

/**
 * Apply the file: the existing colourway import, in its one transaction. The
 * plan is recomputed first so the response reports what was new BEFORE this
 * run wrote it.
 */
export const applySupplierColours = async (pool, read) => {
  const plan = await planSupplierColours(pool, read)
  const summary = await importColourways(pool, read.rows)
  return Object.freeze({ plan, summary })
}
