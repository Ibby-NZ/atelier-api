/**
 * Import of the normalised colour-file output (scripts/convert-colour-files.js,
 * written to incoming/colour-files/normalized/colourways.json) into the live
 * catalogue: one product per (house, design), one colourway per row.
 *
 * Three postures, each copied from an existing importer rather than invented:
 *
 * - **Validation runs before any SQL**, like validateLegacyRecords and
 *   validatePriceListItems. A malformed batch must fail with a row coordinate,
 *   not halfway through a transaction.
 * - **The whole import is one transaction**, chunked `unnest` batches. Either the
 *   catalogue gains every colourway or it gains none: a half-imported house looks
 *   exactly like a house the supplier stopped carrying.
 * - **Re-running changes nothing.** Products are INSERT … DO NOTHING (this file
 *   knows only a design's name; every other column belongs to the seed or to
 *   staff), colourways upsert on the SKU exactly as the seed does, and inventory
 *   is DO NOTHING because it becomes live operational data after the first run.
 *
 * **The supplier colour code is never joined to `price_list_items.code`.** They
 * are different codes — the D365 item code's numeric part is the supplier's
 * colour code and does not match the price list's — so nothing here reads or
 * writes that table. The design code the file carries (what the supplier's own
 * price list keys on) has no column to land in and is deliberately dropped
 * rather than squeezed into one that means something else.
 */

import { slugify } from './slugify.js'

const CHUNK_SIZE = 1000

/**
 * Why a row was not imported. Each reason names a KIND of row, never one row —
 * same rule the converter's skip() follows, because "7,823 rows skipped" is a
 * number nobody can account for.
 */
export const UNKNOWN_BRAND = 'house not in the catalogue'
export const NO_DESIGN = 'no design name'
export const NO_COLOUR_CODE = 'no colour code'

const UNIT_BY_PRODUCT_TYPE = Object.freeze({ fabric: 'metres', finished_good: 'units' })

// Every product this importer CREATES is a fabric: products.product_type is
// CHECKed to fabric|finished_good, and a wallpaper or a trimming is nearer the
// first than the second (it is cut, priced and stocked by length). An existing
// product keeps whatever type it already has — the type is immutable, because
// the colourway's inventory unit was derived from it.
const IMPORTED_PRODUCT_TYPE = 'fabric'

/** A slug, or null where the text carries nothing sluggable ('-', '', ' '). */
const slugOrNull = (text) => {
  if (typeof text !== 'string' || text.trim() === '') return null
  const slug = slugify(text)
  return slug === '' ? null : slug
}

/** Where a row came from, as `file:sheet:row` — this pipeline's coordinate. */
export const rowSource = (row) => `${row.source_file}:${row.source_sheet}:${row.source_row}`

/**
 * The catalogue keys a row lands on.
 *
 * The product slug follows the seed's own fabric convention —
 * slugify(`${brand} ${design}`) — using the CATALOGUE's spelling of the house,
 * so a design the seed already holds is refreshed in place rather than
 * duplicated under the supplier's spelling.
 *
 * The SKU is the house, the design and the supplier's colour code. Nothing
 * shorter is unique: Madeaux and Maria Flora number colours per design ("01",
 * "102"), so a code alone repeats, and the office's own Brand-Product-Colour
 * generator lives in the CRM demo app and was deliberately never ported. Every
 * part is a slug, so the SKU is stable under the supplier's own re-casing —
 * Liberty writes the same colourway "Deco Scallop"/"Pewter" on one sheet and
 * "DECO SCALLOP"/"PEWTER" on the other.
 */
export const colourwayKeys = (brand, row) => {
  const design = slugOrNull(row.design)
  if (design === null) return { reason: NO_DESIGN }
  const colour = slugOrNull(row.colour_code)
  if (colour === null) return { reason: NO_COLOUR_CODE }
  return {
    productSlug: slugify(`${brand.name} ${row.design}`),
    sku: `${brand.slug}-${design}-${colour}`.toUpperCase(),
  }
}

/**
 * colourways.name is NOT NULL and 917 rows name no colour — all 4,917 Jannelli
 * & Volpi records carry an empty name (the file genuinely names none) and 299
 * Pierre Frey ones are a design whose SKU name IS the design. The supplier's own
 * colour code is what those colours are identified by on the supplier's own
 * document, so that is what the catalogue shows. Inventing "Colour 1" would be
 * worse: it reads as a name somebody chose.
 */
export const colourwayName = (row) =>
  (row.colour_name.trim() === '' ? row.colour_code.trim() : row.colour_name.trim())

const TEXT_FIELDS = Object.freeze([
  'supplier', 'brand', 'design', 'design_code', 'colour_code', 'colour_name',
  'source_file', 'source_sheet',
])
// design and colour_code may be present and empty — that is a row this importer
// DECLINES with a stated reason, not a malformed batch. A missing house or a
// missing coordinate is malformed: neither can be reported afterwards.
const REQUIRED_FIELDS = Object.freeze(['supplier', 'brand', 'source_file', 'source_sheet'])

const invalid = (index, row, field, detail) => {
  const at = row && typeof row.source_file === 'string' ? ` (${rowSource(row)})` : ''
  return new Error(`colourway row ${index}${at}: invalid ${field} (${detail})`)
}

/**
 * Throws on the first malformed row. Returns the rows untouched so callers can
 * chain. Runs before a connection is taken, so a bad batch never reaches SQL.
 */
export const validateColourwayRows = (rows) => {
  if (!Array.isArray(rows)) throw new Error('colourway rows must be an array')
  rows.forEach((row, index) => {
    if (row === null || typeof row !== 'object') throw invalid(index, null, 'row', 'not an object')
    for (const field of TEXT_FIELDS) {
      if (typeof row[field] !== 'string') {
        throw invalid(index, row, field, `expected a string, got ${JSON.stringify(row[field])}`)
      }
    }
    for (const field of REQUIRED_FIELDS) {
      if (row[field].trim() === '') throw invalid(index, row, field, 'expected a non-empty string')
    }
    if (!Number.isInteger(row.source_row) || row.source_row < 1) {
      throw invalid(index, row, 'source_row', `expected a positive integer, got ${JSON.stringify(row.source_row)}`)
    }
  })
  return rows
}

/** Two spellings of one name: the supplier's own casing is not a second colour. */
const sameName = (a, b) =>
  a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ')

const note = (map, key, row) => {
  const entry = map.get(key)
  if (entry === undefined) map.set(key, { key, rows: 1, first: rowSource(row) })
  else entry.rows += 1
}

const declined = (map) => [...map.values()]
  .sort((a, b) => b.rows - a.rows)
  .map((entry) => Object.freeze({ reason: entry.key, rows: entry.rows, first: entry.first }))

/**
 * Turn normalised rows into the products and colourways they become. Pure — it
 * takes the catalogue's brands as data so the whole plan is testable without a
 * database, and so the report can be printed before anything is written.
 *
 * **A house is resolved by SLUG against `brands`, and an unresolved one is
 * REPORTED, never created.** Creating a house silently is the one outcome nobody
 * can undo: 15 of the corpus's 37 spellings have no catalogue row (Perennials,
 * Nicky Haslam, six Jannelli & Volpi houses, Le Manach, Fox Linton, and Jean
 * Monro's unidentified RSC sheet), and each is a naming decision the office
 * owes. Their rows stay in the normalised file and land on the next run once
 * somebody adds the house.
 *
 * One SKU is one colourway, so a repeated SKU collapses onto the first row.
 * Where the two rows name the colour the same thing (modulo the supplier's
 * casing) that is a repeat and is only counted; where they genuinely disagree it
 * is a CONFLICT, reported with both coordinates and both names, because the
 * catalogue can hold only one of them and nothing has ratified which.
 */
export const prepareColourwayImport = (rows, brands) => {
  const byKey = new Map(brands.map((brand) => [brand.slug, brand]))
  const products = new Map()
  const colourways = new Map()
  const unknownBrands = new Map()
  const declines = new Map()
  const conflicts = []
  let duplicates = 0

  for (const row of rows) {
    const brand = byKey.get(slugOrNull(row.brand) ?? '')
    if (brand === undefined) {
      note(unknownBrands, row.brand, row)
      continue
    }
    const keys = colourwayKeys(brand, row)
    if (keys.reason !== undefined) {
      note(declines, keys.reason, row)
      continue
    }
    if (!products.has(keys.productSlug)) {
      products.set(keys.productSlug, Object.freeze({
        slug: keys.productSlug,
        name: row.design.trim(),
        brand_id: brand.id,
        currency: brand.currency,
      }))
    }
    const name = colourwayName(row)
    const earlier = colourways.get(keys.sku)
    if (earlier !== undefined) {
      if (sameName(earlier.name, name)) duplicates += 1
      else conflicts.push(Object.freeze({ sku: keys.sku, kept: earlier, dropped: { name, source: rowSource(row) } }))
      continue
    }
    colourways.set(keys.sku, Object.freeze({
      sku: keys.sku,
      name,
      productSlug: keys.productSlug,
      source: rowSource(row),
    }))
  }

  const unknown = [...unknownBrands.values()]
    .sort((a, b) => b.rows - a.rows)
    .map((entry) => Object.freeze({ brand: entry.key, rows: entry.rows, first: entry.first }))
  const skips = declined(declines)
  const skipped = unknown.reduce((total, entry) => total + entry.rows, 0)
    + skips.reduce((total, entry) => total + entry.rows, 0)

  return Object.freeze({
    products: [...products.values()],
    colourways: [...colourways.values()],
    unknownBrands: unknown,
    skips,
    conflicts,
    duplicates,
    rows: rows.length,
    skipped,
  })
}

const chunks = function* (items) {
  for (let offset = 0; offset < items.length; offset += CHUNK_SIZE) {
    yield items.slice(offset, offset + CHUNK_SIZE)
  }
}

/**
 * DO NOTHING, not DO UPDATE: this file knows a design's name and nothing else,
 * so every other column — composition, width, the trade price, whether the
 * design is published — belongs to the seed or to a person in the CRM. Writing
 * EXCLUDED over them would replace a catalogue entry with a thinner one, and
 * re-capitalise a house-styled name into the supplier's ALL CAPS. The select-back
 * is what an INSERT … DO NOTHING costs: it returns no row for a slug that was
 * already there.
 */
const upsertProducts = async (client, products) => {
  for (const chunk of chunks(products)) {
    await client.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, product_range)
       SELECT p.brand_id, p.name, p.slug, $5::text, p.currency, b.name
       FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])
         AS p(brand_id, name, slug, currency)
       JOIN brands b ON b.id = p.brand_id
       ON CONFLICT (slug) DO NOTHING`,
      [
        chunk.map((product) => product.brand_id),
        chunk.map((product) => product.name),
        chunk.map((product) => product.slug),
        chunk.map((product) => product.currency),
        IMPORTED_PRODUCT_TYPE,
      ]
    )
  }
  const byslug = new Map()
  for (const chunk of chunks(products)) {
    const { rows } = await client.query(
      'SELECT id, slug, product_type FROM products WHERE slug = ANY($1::text[])',
      [chunk.map((product) => product.slug)]
    )
    for (const row of rows) byslug.set(row.slug, row)
  }
  return byslug
}

const requireProduct = (byslug, slug) => {
  const product = byslug.get(slug)
  if (product === undefined) throw new Error(`colourway import: product "${slug}" missing after upsert`)
  return product
}

const unitFor = (product) => {
  const unit = UNIT_BY_PRODUCT_TYPE[product.product_type]
  if (unit === undefined) {
    throw new Error(`colourway import: product "${product.slug}" has unknown product_type "${product.product_type}"`)
  }
  return unit
}

/**
 * The colourway upsert matches the seed's exactly, minus the two columns this
 * file cannot speak for: hex_tones and image_url stay whatever they are, so an
 * import never blanks a swatch somebody uploaded.
 *
 * Inventory is INSERT … DO NOTHING at zero, like the seed and like the admin
 * colourway create: stock is live operational data from the first run on.
 */
const upsertColourways = async (client, colourways, products) => {
  let inventory = 0
  for (const chunk of chunks(colourways)) {
    const productRows = chunk.map((colourway) => requireProduct(products, colourway.productSlug))
    const { rows } = await client.query(
      `INSERT INTO colourways (product_id, name, sku)
       SELECT c.product_id, c.name, c.sku
       FROM unnest($1::int[], $2::text[], $3::text[]) AS c(product_id, name, sku)
       ON CONFLICT (sku) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         name = EXCLUDED.name
       RETURNING id, sku`,
      [
        productRows.map((product) => product.id),
        chunk.map((colourway) => colourway.name),
        chunk.map((colourway) => colourway.sku),
      ]
    )
    const idBySku = new Map(rows.map((row) => [row.sku, row.id]))
    const { rowCount } = await client.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       SELECT i.colourway_id, 0, 0, i.unit
       FROM unnest($1::int[], $2::text[]) AS i(colourway_id, unit)
       ON CONFLICT (colourway_id) DO NOTHING`,
      [
        chunk.map((colourway) => idBySku.get(colourway.sku)),
        productRows.map(unitFor),
      ]
    )
    inventory += rowCount
  }
  return inventory
}

/**
 * Validates, plans, then writes in one transaction. Returns a frozen summary
 * carrying everything the run has to be able to account for: rows in equals
 * colourways out plus skips plus the repeats collapsed onto an earlier row.
 */
export const importColourways = async (pool, rows) => {
  validateColourwayRows(rows)
  const client = await pool.connect()
  let plan
  let inventoryCreated = 0
  try {
    await client.query('BEGIN')
    const { rows: brands } = await client.query('SELECT id, name, slug, currency FROM brands')
    plan = prepareColourwayImport(rows, brands)
    const products = await upsertProducts(client, plan.products)
    inventoryCreated = await upsertColourways(client, plan.colourways, products)
    await client.query('COMMIT')
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Surface the original failure, not the rollback's; pg discards the
      // released connection either way.
    }
    throw error
  } finally {
    client.release()
  }
  return Object.freeze({
    rows: plan.rows,
    products: plan.products.length,
    colourways: plan.colourways.length,
    // Rows the second run does NOT create: stock is DO NOTHING, so this is 0 on
    // every re-import and is how the summary shows that.
    inventoryCreated,
    brands: new Set(plan.products.map((product) => product.brand_id)).size,
    skipped: plan.skipped,
    duplicates: plan.duplicates,
    unknownBrands: plan.unknownBrands,
    skips: plan.skips,
    conflicts: plan.conflicts,
  })
}
