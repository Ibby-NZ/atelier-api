// Stock levels from Dynamics' "Stock View" (28 Sep 2026), onto the catalogue
// the product prices built.
//
// The export is a narrow view of the D365 stock item (`fulmxero_item`): record
// id, name, item code, range, and the stock figures. Each item is matched, in
// its house (the pricer's `houseFor`, so a range lands where its prices do), to
//
//   1. a VARIATION whose SKU ends in the item's code — a colour the supplier
//      files named the same way Dynamics coded it, or a SKU Dynamics' own
//      catalogue carried before the price catalogue replaced it; or else
//   2. one PRODUCT the item names (its Dynamics product price list, its name,
//      its code, or the longest product description its name starts with) —
//      and, holding stock, it becomes a new variation of that product.
//
// A matched variation's on-hand figure becomes the file's "Stock On Hand";
// what the platform has reserved is its own and is never touched. An item
// matching several, or none, or no house, is reported with its figures and
// never written — the office's choice on 28 Sep ("apply only what matches and
// give me a list of the rest").

import { openWorkbook, sharedStrings, sheetRows } from '../../scripts/lib/xlsx.js'
import { d365WorkbookSchema } from '../../scripts/lib/d365-workbook.js'
import { parseNumber } from '../../scripts/lib/python-format.js'
import { createProductPricer, nameKey } from '../pricing/product-prices.js'
import { slugify } from '../seed/slugify.js'

export const STOCK_ENTITY = 'fulmxero_item'
const DATA_SHEET = 'xl/worksheets/sheet2.xml'
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_REPORTED = 1000

/** Logical name -> field. The first four are required. */
const COLUMNS = Object.freeze({
  fulmxero_itemid: 'guid',
  fulmxero_itemcode: 'item_code',
  fulmxero_trackingoption1id: 'range_name',
  fulmxero_totalstockonhand: 'on_hand',
  fulmxero_name: 'name',
})
const REQUIRED = Object.freeze(Object.keys(COLUMNS).slice(0, 4))

const UNIT_BY_PRODUCT_TYPE = Object.freeze({ fabric: 'metres', finished_good: 'units' })

export const OUTCOMES = Object.freeze({
  SET: 'set',
  CREATED: 'created',
  SEVERAL: 'several',
  NO_PRODUCT: 'no_product',
  NO_HOUSE: 'no_house',
  NEGATIVE: 'negative',
})

const refuse = (message, errors = []) =>
  Object.assign(new Error(message), { statusCode: 422, errors: errors.slice(0, 50), error_count: errors.length })

const text = (value) => String(value ?? '').trim()
const key = (value) => nameKey(value).replace(/\s+/g, ' ')
const slug = (value) => {
  try {
    return slugify(text(value)).toUpperCase()
  } catch {
    return ''
  }
}

/**
 * The rows of an uploaded Stock View. 422 carrying `errors` for a file that is
 * not one, or a row that cannot be read.
 *
 * @param {Buffer} buffer
 * @returns {{ rows: { guid: string, item_code: string, range_name: string, on_hand: number, name: string }[], rows_read: number }}
 */
export const readStockLevelsWorkbook = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw refuse('That file is empty.')
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw refuse('That is not an Excel workbook. Export the Stock View from Dynamics and upload the .xlsx as it arrives.')
  }
  let schema
  let zip
  let strings
  try {
    schema = d365WorkbookSchema(buffer)
    zip = openWorkbook(buffer)
    strings = sharedStrings(zip)
  } catch (error) {
    throw refuse(`That workbook is not a Dynamics export this screen can read (${error.message}).`)
  }
  if (schema.entity !== STOCK_ENTITY) {
    throw refuse(`That is a Dynamics "${schema.entity}" export, not the stock items. Export the Stock View.`)
  }
  const missing = REQUIRED.filter((column) => !schema.logicalNames.includes(column))
  if (missing.length > 0) throw refuse(`That export is missing ${missing.join(', ')}. Add them to the view and export again.`)

  const at = Object.fromEntries(Object.keys(COLUMNS).map((logical) => [COLUMNS[logical], schema.logicalNames.indexOf(logical)]))
  const errors = []
  const rows = []
  for (const [line, cells] of sheetRows(zip, DATA_SHEET, strings)) {
    if (line === 1) continue
    const cell = (field) => (at[field] < 0 ? '' : text(cells.get(at[field])))
    const guid = cell('guid').toLowerCase()
    if (!guid && !cell('item_code')) continue
    const where = `row ${line}${cell('item_code') ? ` (${cell('item_code')})` : ''}`
    if (!UUID.test(guid)) {
      errors.push(`${where}: no Dynamics record id`)
      continue
    }
    let onHand = 0
    if (cell('on_hand') !== '') {
      try {
        onHand = parseNumber(cell('on_hand'))
      } catch (error) {
        errors.push(`${where}: stock on hand: ${error.message}`)
        continue
      }
    }
    rows.push(Object.freeze({ guid, item_code: cell('item_code'), range_name: cell('range_name'), name: cell('name'), on_hand: onHand }))
  }
  if (errors.length > 0) throw refuse(`${errors.length} row${errors.length === 1 ? '' : 's'} could not be read. Nothing has been written.`, errors)
  if (rows.length === 0) throw refuse('That export has no stock items.')
  return Object.freeze({ rows: Object.freeze(rows), rows_read: rows.length })
}

const indexBy = (map, k, value) => map.set(k, [...(map.get(k) ?? []), value])

/**
 * What the file would do. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {object[]} rows the file's rows
 */
export const planStockLevels = async (db, rows) => {
  const pricer = createProductPricer(db)
  const { rows: products } = await db.query(
    `SELECT p.id, p.brand_id, p.name, p.product_type, pp.code, pp.description
       FROM products p JOIN product_prices pp ON pp.id = p.product_price_id
      WHERE p.archived_at IS NULL`
  )
  const { rows: variations } = await db.query(
    `SELECT c.id, c.sku, c.product_id, p.brand_id, i.qty_available
       FROM colourways c
       JOIN products p ON p.id = c.product_id AND p.archived_at IS NULL AND p.product_price_id IS NOT NULL
       LEFT JOIN inventory i ON i.colourway_id = c.id
      WHERE c.archived_at IS NULL`
  )
  const { rows: legacy } = await db.query(
    `SELECT guid::text AS guid, product_price_list FROM legacy_stock_items WHERE guid = ANY($1::uuid[])`,
    [rows.map((row) => row.guid)]
  )
  const { rows: allSkus } = await db.query(`SELECT sku FROM colourways`)
  const taken = new Set(allSkus.map((row) => row.sku))
  const priceList = new Map(legacy.map((row) => [row.guid, row.product_price_list]))

  // A variation under every hyphen-bounded tail of its SKU, so an item code
  // finds "…-F4098-001" as well as "…-AIRPLBLMO".
  // Then, where the code's punctuation differs (Dynamics' F4098-001 against
  // the supplier file's F4098001), the same tails with the hyphens taken out.
  const bySuffix = new Map()
  const bySquashed = new Map()
  for (const variation of variations) {
    const parts = variation.sku.split('-')
    for (let i = 1; i < parts.length; i += 1) {
      indexBy(bySuffix, `${variation.brand_id}\u0000${parts.slice(i).join('-')}`, variation)
      indexBy(bySquashed, `${variation.brand_id}\u0000${parts.slice(i).join('')}`, variation)
    }
  }
  const byName = new Map()
  for (const product of products) {
    for (const name of new Set([product.code, product.description, product.name].filter(Boolean).map(key))) {
      indexBy(byName, `${product.brand_id}\u0000${name}`, product)
    }
  }
  const productsByHouse = new Map()
  for (const product of products) indexBy(productsByHouse, product.brand_id, product)

  const outcomes = []
  const created = new Set()
  for (const row of rows) {
    const outcome = (kind, extra = {}) => outcomes.push(Object.freeze({ kind, ...row, ...extra }))
    if (row.on_hand < 0) {
      outcome(OUTCOMES.NEGATIVE)
      continue
    }
    const house = await pricer.houseFor(row.range_name)
    if (!house) {
      outcome(OUTCOMES.NO_HOUSE)
      continue
    }
    const token = row.item_code.split(/\s+/)[0]
    const code = slug(token)
    const found = code
      ? (bySuffix.get(`${house.id}\u0000${code}`) ?? bySquashed.get(`${house.id}\u0000${code.replaceAll('-', '')}`) ?? null)
      : null
    if (found?.length === 1) {
      const [variation] = found
      outcome(OUTCOMES.SET, { colourway_id: variation.id, sku: variation.sku, from: variation.qty_available == null ? null : Number(variation.qty_available) })
      continue
    }
    if (found?.length > 1) {
      outcome(OUTCOMES.SEVERAL, { candidates: found.slice(0, 5).map((variation) => variation.sku) })
      continue
    }
    let named =
      [priceList.get(row.guid), row.name, token]
        .map((name) => (text(name) ? byName.get(`${house.id}\u0000${key(name)}`) : null))
        .find(Boolean) ?? null
    if (!named) {
      // The longest product description the item's name starts with.
      const name = key(row.name)
      const best = (productsByHouse.get(house.id) ?? [])
        .filter((product) => product.description && name.startsWith(`${key(product.description)} `))
        .sort((a, b) => b.description.length - a.description.length)[0]
      if (best) named = [best]
    }
    if (named?.length > 1) {
      outcome(OUTCOMES.SEVERAL, { candidates: named.slice(0, 5).map((product) => product.name) })
      continue
    }
    if (!named || !code || row.on_hand === 0) {
      // No product; or a product but nothing to put under it (no stock, no code).
      outcome(OUTCOMES.NO_PRODUCT, named ? { product: named[0].name } : {})
      continue
    }
    const [product] = named
    const sku = `${house.slug}-${slugify(product.name)}-${code}`.toUpperCase()
    if (taken.has(sku) || created.has(sku)) {
      outcome(OUTCOMES.SEVERAL, { candidates: [sku] })
      continue
    }
    created.add(sku)
    outcome(OUTCOMES.CREATED, { product_id: product.id, product: product.name, sku, unit: UNIT_BY_PRODUCT_TYPE[product.product_type] ?? 'metres' })
  }

  // Two items claiming one variation cannot both be its stock: which one is,
  // is the office's call, so both are reported rather than one written.
  const claims = new Map()
  for (const entry of outcomes) if (entry.kind === OUTCOMES.SET) claims.set(entry.colourway_id, (claims.get(entry.colourway_id) ?? 0) + 1)
  for (const [index, entry] of outcomes.entries()) {
    if (entry.kind === OUTCOMES.SET && claims.get(entry.colourway_id) > 1) {
      outcomes[index] = Object.freeze({ ...entry, kind: OUTCOMES.SEVERAL, candidates: [`${entry.sku} (claimed by ${claims.get(entry.colourway_id)} items)`] })
    }
  }

  const of = (kind) => outcomes.filter((entry) => entry.kind === kind)
  // Only stocked items are worth a line in the worklist; the rest are counted.
  const worklist = outcomes
    .filter((entry) => ![OUTCOMES.SET, OUTCOMES.CREATED].includes(entry.kind) && entry.on_hand !== 0)
    .map(({ kind, range_name, item_code, name, on_hand, candidates, product }) =>
      Object.freeze({ kind, range_name, item_code, name, on_hand, ...(candidates ? { candidates } : {}), ...(product ? { product } : {}) })
    )
  const set = of(OUTCOMES.SET)
  return Object.freeze({
    rows_read: rows.length,
    stocked: rows.filter((row) => row.on_hand > 0).length,
    set: set.length,
    set_changed: set.filter((entry) => entry.from !== entry.on_hand).length,
    set_stocked: set.filter((entry) => entry.on_hand > 0).length,
    created: of(OUTCOMES.CREATED).length,
    several: of(OUTCOMES.SEVERAL).filter((entry) => entry.on_hand !== 0).length,
    no_product: of(OUTCOMES.NO_PRODUCT).filter((entry) => entry.on_hand !== 0).length,
    no_house: of(OUTCOMES.NO_HOUSE).filter((entry) => entry.on_hand !== 0).length,
    negative: of(OUTCOMES.NEGATIVE).length,
    units_applied: Math.round([...set, ...of(OUTCOMES.CREATED)].reduce((sum, entry) => sum + entry.on_hand, 0) * 100) / 100,
    units_not_applied: Math.round(worklist.reduce((sum, entry) => sum + entry.on_hand, 0) * 100) / 100,
    worklist: Object.freeze(worklist.slice(0, MAX_REPORTED)),
    // For apply; not serialised by the route.
    writes: Object.freeze({ set: Object.freeze(set), created: Object.freeze(of(OUTCOMES.CREATED)) }),
  })
}

/** A plan as the route sends it. */
export const omitStockWrites = (plan) => Object.fromEntries(Object.entries(plan).filter(([field]) => field !== 'writes'))

/**
 * Apply the file in one transaction: the new variations with their stock, then
 * every matched variation's on-hand figure. Re-plans inside the transaction.
 */
export const applyStockLevels = async (pool, rows) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('stock_levels_import'))`)
    const plan = await planStockLevels(client, rows)
    const { created, set } = plan.writes
    if (created.length > 0) {
      const { rows: made } = await client.query(
        `INSERT INTO colourways (product_id, name, sku)
         SELECT c.product_id, c.name, c.sku FROM unnest($1::int[], $2::text[], $3::text[]) AS c(product_id, name, sku)
         RETURNING id, sku`,
        [created.map((entry) => entry.product_id), created.map((entry) => entry.name || entry.item_code), created.map((entry) => entry.sku)]
      )
      const idBySku = new Map(made.map((row) => [row.sku, row.id]))
      await client.query(
        `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
         SELECT i.id, i.qty, 0, i.unit FROM unnest($1::int[], $2::numeric[], $3::text[]) AS i(id, qty, unit)`,
        [created.map((entry) => idBySku.get(entry.sku)), created.map((entry) => entry.on_hand), created.map((entry) => entry.unit)]
      )
    }
    if (set.length > 0) {
      // A variation with no stock row yet gets one, in its product's unit.
      await client.query(
        `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
         SELECT s.id, s.qty, 0, CASE p.product_type WHEN 'finished_good' THEN 'units' ELSE 'metres' END
           FROM unnest($1::int[], $2::numeric[]) AS s(id, qty)
           JOIN colourways c ON c.id = s.id JOIN products p ON p.id = c.product_id
         ON CONFLICT (colourway_id) DO UPDATE SET qty_available = EXCLUDED.qty_available
          WHERE inventory.qty_available IS DISTINCT FROM EXCLUDED.qty_available`,
        [set.map((entry) => entry.colourway_id), set.map((entry) => entry.on_hand)]
      )
    }
    await client.query('COMMIT')
    return Object.freeze({ ...omitStockWrites(plan), applied: true })
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
