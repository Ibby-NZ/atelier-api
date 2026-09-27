// The catalogue built from the product prices export (28 Sep 2026).
//
// The office: "all products from the product price import are unique, none are
// variations", and the supplier colours "sit under the products" — "variations
// are basically just options provided in the product page on the storefront".
// So:
//
//   PRODUCTS  one per product-price row, linked by `products.product_price_id`
//             (migration 1792185600000). A row already linked is never touched
//             here; its price reaches the product through product-price-sync.js.
//             New products are hidden from the website.
//   COLOURS   the Supplier Colours workbook attaches colourways UNDER those
//             products and never creates one. A colour no product names is
//             reported, not landed.
//
// Both resolve a house with the pricer's own `houseFor` (name, then slug), so a
// product sits under the same house its price comes through.

import { slugify } from '../seed/slugify.js'
import { colourwayName, upsertColourways, NO_COLOUR_CODE } from '../seed/colourways-import.js'
import { createProductPricer, nameKey } from '../pricing/product-prices.js'
import { categorySlugs } from './categories.js'
import { categoryForItemType } from '../../scripts/lib/price-template.js'

export const MAX_REPORTED = 50
export const NO_NAME = 'no description or code'
export const NO_PRODUCT = 'no product in its house has this design or code'

// Sold by the unit rather than cut from a length; everything else (fabric,
// wallpaper, trimming, leather) is stocked in metres like the colour import's.
const FINISHED_GOOD_CATEGORIES = new Set(['accessory', 'cushion', 'throw', 'towel', 'bed-linen'])

const key = (value) => nameKey(value).replace(/\s+/g, ' ')
const text = (value) => String(value ?? '').trim()

const tally = (map, reason, source) => {
  const entry = map.get(reason) ?? { reason, rows: 0, first: source }
  entry.rows += 1
  map.set(reason, entry)
}
const tallied = (map) =>
  [...map.values()].sort((a, b) => b.rows - a.rows).map((entry) => Object.freeze({ ...entry }))

// --- products -----------------------------------------------------------------

/**
 * Each row's product name. The description, as Dynamics names the product;
 * where two rows of one house share it (Jannelli & Volpi prices each colour of
 * a wallpaper as its own row: MADEIRA 7940, 7941 …) the code is added so the
 * two can be told apart, and a pair still equal after that is numbered in file
 * order.
 */
export const productNames = (rows) => {
  const named = rows.map((row) => {
    const description = text(row.description)
    const code = text(row.code)
    return { row, base: description || code, code }
  })
  const groups = (entries, name) => {
    const byKey = new Map()
    for (const entry of entries) {
      const k = `${entry.row.house.id}\u0000${key(name(entry))}`
      byKey.set(k, [...(byKey.get(k) ?? []), entry])
    }
    return byKey
  }
  for (const entries of groups(named, (entry) => entry.base).values()) {
    if (entries.length < 2) continue
    for (const entry of entries) {
      if (entry.code && key(entry.code) !== key(entry.base)) entry.base = `${entry.base} ${entry.code}`
    }
  }
  for (const entries of groups(named, (entry) => entry.base).values()) {
    if (entries.length < 2) continue
    entries.forEach((entry, index) => {
      entry.base = `${entry.base} (${index + 1})`
    })
  }
  return new Map(named.map((entry) => [entry.row.guid, entry.base]))
}

/**
 * What the export would add to the catalogue. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {object[]} priceRows the export's rows (guid, code, description,
 *   range_name, item_type, currency) — the file's, so a dry run can answer
 *   before any row is stored
 */
export const planPriceCatalogue = async (db, priceRows) => {
  const pricer = createProductPricer(db)
  const { rows: linked } = await db.query(
    `SELECT pp.guid::text AS guid FROM products p JOIN product_prices pp ON pp.id = p.product_price_id`
  )
  const linkedGuids = new Set(linked.map((row) => row.guid))
  const { rows: slugRows } = await db.query(`SELECT slug FROM products`)
  const taken = new Set(slugRows.map((row) => row.slug))
  const vocabulary = await categorySlugs(db)

  const housed = []
  const noHouse = new Map()
  const skips = new Map()
  for (const row of priceRows) {
    if (!text(row.description) && !text(row.code)) {
      tally(skips, NO_NAME, row.guid)
      continue
    }
    const house = await pricer.houseFor(row.range_name)
    if (!house) {
      noHouse.set(row.range_name, (noHouse.get(row.range_name) ?? 0) + 1)
      continue
    }
    housed.push({ ...row, house })
  }

  const names = productNames(housed)
  const create = []
  for (const row of housed) {
    if (linkedGuids.has(row.guid)) continue
    const name = names.get(row.guid)
    const base = slugify(`${row.house.name} ${name}`)
    let slug = base
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`
    taken.add(slug)
    const category = categoryForItemType(row.item_type)
    const known = category && vocabulary.has(category) ? category : null
    create.push(
      Object.freeze({
        guid: row.guid,
        name,
        slug,
        brand_id: row.house.id,
        house: row.house.name,
        category: known,
        product_type: FINISHED_GOOD_CATEGORIES.has(known) ? 'finished_good' : 'fabric',
        currency: row.currency ?? 'NZD',
      })
    )
  }

  return Object.freeze({
    rows: priceRows.length,
    products_new: create.length,
    products_existing: housed.length - create.length,
    ranges_without_house: Object.freeze(
      [...noHouse].map(([range_name, rows]) => Object.freeze({ range_name, rows }))
    ),
    skips: Object.freeze(tallied(skips)),
    sample: Object.freeze(create.slice(0, MAX_REPORTED).map(({ name, slug, house }) => ({ name, slug, house }))),
    // For apply; not serialised by a route.
    create: Object.freeze(create),
  })
}

/** A plan as a route sends it: the counts and samples, not the write list. */
export const omitWrites = (plan) => Object.fromEntries(Object.entries(plan).filter(([field]) => field !== 'create'))

const CHUNK = 1000

/**
 * Create the products the export names and the catalogue does not yet hold, in
 * one transaction. Hidden from the website; priced afterwards by
 * `applyProductSync`, which follows the link.
 *
 * @param {import('pg').Pool} pool
 * @param {object[]} priceRows the rows just imported
 */
export const createProductsFromPrices = async (pool, priceRows) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('product_price_catalogue'))`)
    const plan = await planPriceCatalogue(client, priceRows)
    for (let at = 0; at < plan.create.length; at += CHUNK) {
      const chunk = plan.create.slice(at, at + CHUNK)
      const column = (field) => chunk.map((product) => product[field])
      await client.query(
        `INSERT INTO products
           (brand_id, name, slug, product_type, currency, category, product_range, product_price_id, show_on_website)
         SELECT c.brand_id, c.name, c.slug, c.product_type, c.currency, c.category, b.name, pp.id, false
           FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::uuid[])
             WITH ORDINALITY AS c(brand_id, name, slug, product_type, currency, category, guid, at)
           JOIN brands b ON b.id = c.brand_id
           JOIN product_prices pp ON pp.guid = c.guid
          ORDER BY c.at`,
        [
          column('brand_id'),
          column('name'),
          column('slug'),
          column('product_type'),
          column('currency'),
          column('category'),
          column('guid'),
        ]
      )
    }
    await client.query('COMMIT')
    return Object.freeze({ ...omitWrites(plan), products_created: plan.create.length })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // surface the original failure
    }
    throw error
  } finally {
    client.release()
  }
}

// --- colours ------------------------------------------------------------------

/**
 * Which products each colour row sits under. Reads only.
 *
 * A colour is matched inside its house, first rule that finds anything:
 *   1. the supplier's design code is a product's code (Colefax F4613, Fabricut
 *      32774 — what most rows carry);
 *   2. the colour code IS a product's code (Jannelli & Volpi prices each colour
 *      as a row of its own: the colour 7940 is the product MADEIRA 7940);
 *   3. the design name is a product's description or code.
 * A rule naming several products puts the colour under each (the office, 28
 * Sep 2026: "add them as separate, we will deal with them later"). The SKU is
 * the house, the PRODUCT's name and the colour code, so each copy is its own.
 *
 * @param {{ query: Function }} db
 * @param {object[]} rows the workbook's colour rows
 */
export const planColourAttach = async (db, rows) => {
  const pricer = createProductPricer(db)
  const { rows: products } = await db.query(
    `SELECT p.id, p.name, p.slug, p.brand_id, p.product_type, p.trade_price_cents, pp.code, pp.description
       FROM products p JOIN product_prices pp ON pp.id = p.product_price_id
      WHERE p.archived_at IS NULL
      ORDER BY p.id`
  )
  const byCode = new Map()
  const byDescription = new Map()
  const index = (map, house, name, product) => {
    if (!text(name)) return
    const k = `${house}\u0000${key(name)}`
    map.set(k, [...(map.get(k) ?? []), product])
  }
  for (const product of products) {
    index(byCode, product.brand_id, product.code, product)
    index(byDescription, product.brand_id, product.description, product)
  }
  const find = (house, name, ...maps) => {
    if (!text(name)) return null
    for (const map of maps) {
      const found = map.get(`${house}\u0000${key(name)}`)
      if (found) return found
    }
    return null
  }

  const colourways = new Map()
  const touched = new Map()
  const unknown = new Map()
  const skips = new Map()
  const conflicts = []
  let duplicates = 0
  let multiple = 0
  for (const row of rows) {
    const source = `${row.source_file}:${row.source_sheet}:${row.source_row}`
    const house = await pricer.houseFor(row.brand)
    if (!house) {
      const entry = unknown.get(row.brand) ?? { brand: row.brand, rows: 0, first: source }
      entry.rows += 1
      unknown.set(row.brand, entry)
      continue
    }
    const colour = slugify(text(row.colour_code))
    if (!colour) {
      tally(skips, NO_COLOUR_CODE, source)
      continue
    }
    const targets =
      find(house.id, row.design_code, byCode) ??
      find(house.id, row.colour_code, byCode) ??
      find(house.id, row.design, byDescription, byCode)
    if (!targets) {
      tally(skips, NO_PRODUCT, source)
      continue
    }
    if (targets.length > 1) multiple += 1
    const name = colourwayName(row)
    for (const product of targets) {
      const sku = `${house.slug}-${slugify(product.name)}-${colour}`.toUpperCase()
      const earlier = colourways.get(sku)
      if (earlier) {
        if (key(earlier.name) === key(name)) duplicates += 1
        else conflicts.push(Object.freeze({ sku, kept: earlier, dropped: { name, source } }))
        continue
      }
      colourways.set(sku, Object.freeze({ sku, name, productSlug: product.slug, source }))
      touched.set(product.slug, product)
    }
  }

  return Object.freeze({
    rows: rows.length,
    products: Object.freeze([...touched.values()]),
    colourways: Object.freeze([...colourways.values()]),
    rows_under_several_products: multiple,
    unknownBrands: Object.freeze([...unknown.values()].sort((a, b) => b.rows - a.rows)),
    skips: Object.freeze(tallied(skips)),
    conflicts: Object.freeze(conflicts),
    duplicates,
  })
}

/**
 * Attach the colours in one transaction. A SKU the catalogue already holds is
 * moved onto its product (with its stock and its order history), exactly as
 * the colour import upserts; stock is a zeroed row, DO NOTHING.
 */
export const applyColourAttach = async (pool, rows) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const plan = await planColourAttach(client, rows)
    const bySlug = new Map(plan.products.map((product) => [product.slug, product]))
    const stockRowsCreated = await upsertColourways(client, plan.colourways, bySlug)
    await client.query('COMMIT')
    return Object.freeze({ plan, stockRowsCreated })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // surface the original failure
    }
    throw error
  } finally {
    client.release()
  }
}
