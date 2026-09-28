// The catalogue built from the product prices export (28 Sep 2026):
//   1. productNames — one product per row; a repeated name takes its code
//   2. createProductsFromPrices — hidden, linked, typed, re-run makes nothing
//   3. applyColourAttach — colours under the products, by design code, colour
//      code or design name; several products each get their own; a SKU the
//      catalogue holds moves with its stock
//
// Real Postgres, prefixed fixtures.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { applyProductSync } from '../src/pricing/product-price-sync.js'
import { ARCHIVE_OUTSIDE_PRICE_CATALOGUE } from '../migrations/1792272000000_archive-products-outside-price-catalogue.js'
import {
  applyColourAttach,
  createProductsFromPrices,
  planColourAttach,
  productNames,
  NO_PRODUCT,
} from '../src/catalogue/product-price-catalogue.js'

const PREFIX = 'w-price-catalogue-test'
const HOUSE = `${PREFIX} Volpi`
const HOUSE_SLUG = `${PREFIX}-volpi`
const GUID = (n) => `00000000-0000-4000-9100-${String(n).padStart(12, '0')}`

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

describe('productNames', () => {
  const house = { id: 1 }
  const row = (n, description, code) => ({ guid: GUID(n), description, code, house })

  it('keeps a unique description, adds the code to a repeated one, and numbers a pair still equal', () => {
    const names = productNames([
      row(1, 'ELLA STRIPE', 'ELLA STRIPE'),
      row(2, 'MADEIRA', '7940'),
      row(3, 'Madeira ', '7941'),
      row(4, 'AIDA', '8100'),
      row(5, 'AIDA', '8100'),
      row(6, null, 'F3202'),
      { ...row(7, 'MADEIRA', '7942'), house: { id: 2 } },
    ])
    expect([...names.values()]).toEqual([
      'ELLA STRIPE', 'MADEIRA 7940', 'Madeira 7941', 'AIDA 8100 (1)', 'AIDA 8100 (2)', 'F3202', 'MADEIRA',
    ])
  })
})

describe('the catalogue from product prices', () => {
  let pool
  let houseId
  let importId

  const priceRow = (n, code, description, itemType = 'W/P') => ({
    guid: GUID(n), code, description, range_name: HOUSE, item_type: itemType, currency: 'EUR',
  })
  const ROWS = [
    priceRow(1, '7940', 'MADEIRA'),
    priceRow(2, '7941', 'MADEIRA'),
    priceRow(3, 'F4613', 'Acantha', 'Fabrics'),
    priceRow(4, 'TIR01', 'SWATCH HANGER', 'Accessories'),
    { ...priceRow(5, 'X1', 'Nowhere'), range_name: `${PREFIX} NO HOUSE` },
  ]
  const colour = (n, design, designCode, code, name) => ({
    supplier: 'Volpi', brand: HOUSE, design, design_code: designCode, colour_code: code, colour_name: name,
    source_file: 'colours.xlsx', source_sheet: 'Supplier Colours', source_row: n,
  })

  const cleanup = async () => {
    await pool.query(`DELETE FROM colourways WHERE sku LIKE $1`, [`${HOUSE_SLUG.toUpperCase()}-%`])
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-9100-%'`)
    await pool.query(`DELETE FROM product_price_imports WHERE filename = $1`, [`${PREFIX}.xlsx`])
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  }

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup()
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only) VALUES ($1, $2, 'EUR', true) RETURNING id`,
      [HOUSE, HOUSE_SLUG]
    )
    houseId = rows[0].id
    const { rows: imported } = await pool.query(
      `INSERT INTO product_price_imports (filename, rows_read, rows_new, rows_changed, rows_unchanged)
       VALUES ($1, 5, 5, 0, 0) RETURNING id`,
      [`${PREFIX}.xlsx`]
    )
    importId = imported[0].id
    for (const row of ROWS) {
      await pool.query(
        `INSERT INTO product_prices (guid, code, description, range_name, item_type, currency, wholesale_rate, first_import_id, last_import_id)
         VALUES ($1, $2, $3, $4, $5, $6, 10, $7, $7)`,
        [row.guid, row.code, row.description, row.range_name, row.item_type, row.currency, importId]
      )
    }
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  it('makes one hidden product per row with a house, linked to it, and a re-run makes none', async () => {
    const made = await createProductsFromPrices(pool, ROWS)
    expect(made).toMatchObject({
      products_created: 4,
      ranges_without_house: [{ range_name: `${PREFIX} NO HOUSE`, rows: 1 }],
    })
    const { rows } = await pool.query(
      `SELECT p.name, p.slug, p.product_type, p.category, p.currency, p.show_on_website, p.product_range, pp.code
         FROM products p JOIN product_prices pp ON pp.id = p.product_price_id
        WHERE p.brand_id = $1 ORDER BY pp.code`,
      [houseId]
    )
    expect(rows).toEqual([
      { name: 'MADEIRA 7940', slug: `${HOUSE_SLUG}-madeira-7940`, product_type: 'fabric', category: 'wallpaper', currency: 'EUR', show_on_website: false, product_range: HOUSE, code: '7940' },
      { name: 'MADEIRA 7941', slug: `${HOUSE_SLUG}-madeira-7941`, product_type: 'fabric', category: 'wallpaper', currency: 'EUR', show_on_website: false, product_range: HOUSE, code: '7941' },
      { name: 'Acantha', slug: `${HOUSE_SLUG}-acantha`, product_type: 'fabric', category: 'fabric', currency: 'EUR', show_on_website: false, product_range: HOUSE, code: 'F4613' },
      { name: 'SWATCH HANGER', slug: `${HOUSE_SLUG}-swatch-hanger`, product_type: 'finished_good', category: 'accessory', currency: 'EUR', show_on_website: false, product_range: HOUSE, code: 'TIR01' },
    ])
    expect(await createProductsFromPrices(pool, ROWS)).toMatchObject({ products_created: 0, products_existing: 4 })
  })

  it('gives each new product its own row\'s wholesale rate, even while its house cannot price it', async () => {
    // The fixture house has no markup, freight or clearance: every row is
    // unpriced, and the export's own figure still lands.
    const synced = await applyProductSync(pool, { sourceFile: `${PREFIX}.xlsx` })
    expect(synced.unpriced_count).toBeGreaterThanOrEqual(4)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM products WHERE brand_id = $1 AND wholesale_rate = 10 AND trade_price_cents IS NULL`,
      [houseId]
    )
    expect(rows[0].n).toBe(4)
  })

  it('archives what stands outside the price catalogue, frees its slug, and leaves the catalogue alone', async () => {
    // What the deploy's merge raised again: an unlinked product under a plain slug.
    const { rows: stray } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency) VALUES ($1, 'MADEIRA', $2, 'fabric', 'EUR') RETURNING id`,
      [houseId, `${HOUSE_SLUG}-madeira`]
    )
    const client = await pool.connect()
    try {
      // In a transaction rolled back after: the statement runs over the whole table.
      await client.query('BEGIN')
      await client.query(ARCHIVE_OUTSIDE_PRICE_CATALOGUE)
      const { rows } = await client.query(
        `SELECT slug, archived_at IS NOT NULL AS archived, product_price_id IS NOT NULL AS linked
           FROM products WHERE brand_id = $1 ORDER BY id`,
        [houseId]
      )
      expect(rows.filter((row) => row.linked).every((row) => !row.archived)).toBe(true)
      expect(rows.find((row) => !row.linked)).toEqual({ slug: `${HOUSE_SLUG}-madeira-archived-${stray[0].id}`, archived: true, linked: false })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    await pool.query('DELETE FROM products WHERE id = $1', [stray[0].id])
  })

  it('hangs each colour under the product it names, and never makes a product for one it does not', async () => {
    const rows = [
      colour(2, 'Acantha', 'F4613', 'F4613-01', 'Stone'),
      // Jannelli & Volpi: the colour code IS the product's code.
      colour(3, 'MADEIRA', '', '7940', ''),
      // A design named by two products goes under each, as its own colourway.
      colour(4, 'MADEIRA', '', '9999', 'Olive'),
      colour(5, 'GHOST', '', '01', 'Grey'),
      { ...colour(6, 'Acantha', 'F4613', '02', 'Sand'), brand: `${PREFIX} Nobody` },
    ]
    const plan = await planColourAttach(pool, rows)
    expect(plan.colourways.map((c) => [c.sku, c.name, c.productSlug])).toEqual([
      [`${HOUSE_SLUG}-ACANTHA-F4613-01`.toUpperCase(), 'Stone', `${HOUSE_SLUG}-acantha`],
      [`${HOUSE_SLUG}-MADEIRA-7940-7940`.toUpperCase(), '7940', `${HOUSE_SLUG}-madeira-7940`],
      [`${HOUSE_SLUG}-MADEIRA-7940-9999`.toUpperCase(), 'Olive', `${HOUSE_SLUG}-madeira-7940`],
      [`${HOUSE_SLUG}-MADEIRA-7941-9999`.toUpperCase(), 'Olive', `${HOUSE_SLUG}-madeira-7941`],
    ])
    expect(plan.rows_under_several_products).toBe(1)
    expect(plan.skips).toEqual([{ reason: NO_PRODUCT, rows: 1, first: 'colours.xlsx:Supplier Colours:5' }])
    expect(plan.unknownBrands).toEqual([{ brand: `${PREFIX} Nobody`, rows: 1, first: 'colours.xlsx:Supplier Colours:6' }])

    // A colourway the catalogue already holds under an old product moves onto
    // the new one, and its stock goes with it.
    const { rows: old } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, archived_at)
       VALUES ($1, 'Acantha', $2, 'fabric', 'EUR', now()) RETURNING id`,
      [houseId, `${HOUSE_SLUG}-acantha-archived-1`]
    )
    const { rows: held } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Stone', $2) RETURNING id`,
      [old[0].id, `${HOUSE_SLUG}-ACANTHA-F4613-01`.toUpperCase()]
    )
    await pool.query(`INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit) VALUES ($1, 12, 0, 'metres')`, [held[0].id])

    const { stockRowsCreated } = await applyColourAttach(pool, rows)
    expect(stockRowsCreated).toBe(3)
    const { rows: moved } = await pool.query(
      `SELECT p.slug, i.qty_available::float AS qty FROM colourways c
         JOIN products p ON p.id = c.product_id JOIN inventory i ON i.colourway_id = c.id WHERE c.id = $1`,
      [held[0].id]
    )
    expect(moved).toEqual([{ slug: `${HOUSE_SLUG}-acantha`, qty: 12 }])
    const { rows: count } = await pool.query(`SELECT count(*)::int AS n FROM products WHERE brand_id = $1`, [houseId])
    expect(count[0].n).toBe(5)
    expect((await applyColourAttach(pool, rows)).stockRowsCreated).toBe(0)
  })
})
