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

import { csvDocument } from '../lib/csv-text.js'

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
