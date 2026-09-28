// Dynamics' Stock View onto the price catalogue (28 Sep 2026):
//   1. reading the export — the stock item entity, by logical name
//   2. matching — a variation by its code (hyphens or not), else one product
//      the item names; several, none, no house and negative are reported
//   3. applying — on hand set, reserved untouched, a new variation for a
//      stocked item under its product, a re-run changes nothing
//   4. the route is director-only
//
// Real Postgres, prefixed fixtures.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { applyStockLevels, planStockLevels, readStockLevelsWorkbook } from '../src/catalogue/stock-levels-import.js'
import { d365Workbook } from './helpers/d365-workbook-fixture.js'

const PREFIX = 'w-stock-levels-test'
const HOUSE = `${PREFIX} House`
const HOUSE_SLUG = `${PREFIX}-house`
const SKU = (rest) => `${HOUSE_SLUG}-${rest}`.toUpperCase()
const G = (n) => `00000000-0000-4000-9300-${String(n).padStart(12, '0')}`
const COLUMNS = [
  ['fulmxero_itemid', '(Do Not Modify) Item'],
  ['checksumLogicalName', '(Do Not Modify) Row Checksum'],
  ['modifiedon', '(Do Not Modify) Modified On'],
  ['fulmxero_supplierid', 'Supplier'],
  ['fulmxero_name', 'Name'],
  ['fulmxero_itemcode', 'Item Code'],
  ['fulmxero_trackingoption1id', 'Range'],
  ['fulmxero_openingunitsinstock', 'Opening Stock'],
  ['fulmxero_totalstockonhand', 'Stock On Hand'],
  ['fulmxero_totalstockavailable', 'Stock Available'],
]
const item = (n, name, code, onHand, range = HOUSE) => [G(n), 'c==', 46055.2, 'Supplier', name, code, range, 0, onHand, onHand]
const book = (rows) => d365Workbook(rows, { entity: 'fulmxero_item', columns: COLUMNS })

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

describe('reading the Stock View', () => {
  it('reads each item by its logical names, and refuses another export', () => {
    const read = readStockLevelsWorkbook(book([item(1, 'Acantha Stone', 'F4613-01 26CF', '12.5')]))
    expect(read.rows).toEqual([{ guid: G(1), item_code: 'F4613-01 26CF', range_name: HOUSE, name: 'Acantha Stone', on_hand: 12.5 }])
    let refusal
    try {
      readStockLevelsWorkbook(d365Workbook([[G(2), 'c==', 1, 'X']], { entity: 'atelier_productprices', columns: COLUMNS.slice(0, 4) }))
    } catch (error) {
      refusal = error
    }
    expect(refusal.statusCode).toBe(422)
    expect(refusal.message).toMatch(/not the stock items/)
  })
})

describe('the Stock View onto the catalogue', () => {
  let pool
  let houseId
  const ids = {}

  const cleanup = async () => {
    await pool.query(`DELETE FROM colourways WHERE sku LIKE $1`, [`${HOUSE_SLUG.toUpperCase()}-%`])
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-9400-%'`)
    await pool.query(`DELETE FROM product_price_imports WHERE filename = $1`, [`${PREFIX}.xlsx`])
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  }

  const product = async (n, code, description) => {
    const { rows: price } = await pool.query(
      `INSERT INTO product_prices (guid, code, description, range_name, currency, wholesale_rate, first_import_id, last_import_id)
       VALUES ($1, $2, $3, $4, 'NZD', 10, $5, $5) RETURNING id`,
      [`00000000-0000-4000-9400-${String(n).padStart(12, '0')}`, code, description, HOUSE, ids.import]
    )
    const { rows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, product_price_id)
       VALUES ($1, $2, $3, 'fabric', 'NZD', $4) RETURNING id`,
      [houseId, description, `${HOUSE_SLUG}-${description.toLowerCase().replace(/\s+/g, '-')}`, price[0].id]
    )
    return rows[0].id
  }
  const variation = async (productId, sku, qty, reserved = 0) => {
    const { rows } = await pool.query(`INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $2) RETURNING id`, [productId, sku])
    await pool.query(`INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit) VALUES ($1, $2, $3, 'metres')`, [rows[0].id, qty, reserved])
    return rows[0].id
  }
  const stock = async (sku) =>
    (await pool.query(
      `SELECT i.qty_available::float AS qty, i.qty_reserved::float AS reserved, p.name AS product
         FROM colourways c JOIN inventory i ON i.colourway_id = c.id JOIN products p ON p.id = c.product_id WHERE c.sku = $1`,
      [sku]
    )).rows[0]

  const FILE = () => [
    item(1, 'Acantha Stone', 'F4613-01 26CF', '12.5'),
    // The supplier file coded it without the hyphen.
    item(2, 'Domaine Royal Printemps', 'F4098-001 26PF', '1.5'),
    // No variation carries its code; its name starts with a product's description.
    item(3, 'Madeira Olive large', 'MAD-OLIVE', '4'),
    // A code two variations end in.
    item(4, 'Twin', '02', '3'),
    item(5, 'Nothing like it', 'ZZZ1', '7'),
    item(6, 'Elsewhere', 'X1', '9', `${PREFIX} No House`),
    item(7, 'Minus', 'NEG1', '-2'),
    item(8, 'Unstocked, unmatched', 'ZZZ2', '0'),
    // Two items claiming one variation: neither is written.
    item(9, 'Domaine Royal Printemps (again)', 'F4098001 26PF', '5'),
  ]

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup()
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only) VALUES ($1, $2, 'NZD', true) RETURNING id`,
      [HOUSE, HOUSE_SLUG]
    )
    houseId = rows[0].id
    ids.import = (await pool.query(
      `INSERT INTO product_price_imports (filename, rows_read, rows_new, rows_changed, rows_unchanged) VALUES ($1, 3, 3, 0, 0) RETURNING id`,
      [`${PREFIX}.xlsx`]
    )).rows[0].id
    const acantha = await product(1, 'F4613', 'Acantha')
    const domaine = await product(2, 'F4098', 'Domaine Royal')
    await product(3, 'MAD', 'Madeira')
    await variation(acantha, SKU('ACANTHA-F4613-01'), 0, 2)
    await variation(domaine, SKU('DOMAINE-ROYAL-F4098001'), 0)
    await variation(acantha, SKU('ACANTHA-02'), 0)
    await variation(domaine, SKU('DOMAINE-ROYAL-02'), 0)
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  it('plans without writing: sets the variations it finds, a new one where only the product is named, and lists the rest', async () => {
    const plan = await planStockLevels(pool, readStockLevelsWorkbook(book(FILE())).rows)
    expect(plan).toMatchObject({ rows_read: 9, set: 1, created: 1, several: 3, no_product: 1, no_house: 1, negative: 1 })
    expect(plan.worklist.map((entry) => [entry.kind, entry.item_code])).toEqual([
      ['several', 'F4098-001 26PF'], ['several', '02'], ['no_product', 'ZZZ1'], ['no_house', 'X1'], ['negative', 'NEG1'], ['several', 'F4098001 26PF'],
    ])
    expect(await stock(SKU('ACANTHA-F4613-01'))).toMatchObject({ qty: 0 })
  })

  it('applies on hand, never touches what is reserved, and a re-run changes nothing', async () => {
    const rows = readStockLevelsWorkbook(book(FILE())).rows
    const applied = await applyStockLevels(pool, rows)
    expect(applied).toMatchObject({ applied: true, set: 1, created: 1 })
    expect(await stock(SKU('ACANTHA-F4613-01'))).toEqual({ qty: 12.5, reserved: 2, product: 'Acantha' })
    // Claimed twice, so left as it was.
    expect(await stock(SKU('DOMAINE-ROYAL-F4098001'))).toMatchObject({ qty: 0 })
    expect(await stock(SKU('MADEIRA-MAD-OLIVE'))).toEqual({ qty: 4, reserved: 0, product: 'Madeira' })
    const again = await applyStockLevels(pool, rows)
    expect(again).toMatchObject({ set: 2, set_changed: 0, created: 0 })
  })

  it('is director-only', async () => {
    const app = buildApp({ pool, cookieSecret: 'test-cookie-secret-0123456789abcdef0123456789abcdef', logger: false })
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/inventory/stock-levels/validate',
      headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      payload: book(FILE()),
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
