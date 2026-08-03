import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runSeed } from '../src/seed/seed.js'

const SEEDED_TABLES = [
  'brands',
  'collections',
  'products',
  'colourways',
  'inventory',
  'shipping_rates',
]

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const rowCounts = async (pool) => {
  const counts = {}
  for (const table of SEEDED_TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
    counts[table] = rows[0].n
  }
  return counts
}

describe('catalogue seed import', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await runSeed(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('is idempotent: a second run leaves row counts identical', async () => {
    const before = await rowCounts(pool)
    await runSeed(pool)
    const after = await rowCounts(pool)
    expect(after).toEqual(before)
  })

  it('imports realCatalogue brands with supplier currency and international flag', async () => {
    const { rows } = await pool.query(
      `SELECT name, currency, is_international, story FROM brands WHERE slug = 'pierre-frey'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Pierre Frey')
    expect(rows[0].currency).toBe('EUR')
    expect(rows[0].is_international).toBe(true)
    expect(rows[0].story).toMatch(/Founded 1935/)
  })

  it('creates the Atelier house brand as domestic (is_international=false)', async () => {
    const { rows } = await pool.query(
      `SELECT currency, is_international FROM brands WHERE slug = 'atelier-textiles-nz'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].currency).toBe('NZD')
    expect(rows[0].is_international).toBe(false)
  })

  it('creates brands referenced only by designs, with currency from suppliers.js', async () => {
    const { rows } = await pool.query(
      `SELECT currency, is_international FROM brands WHERE slug = 'vervain'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].currency).toBe('USD')
    expect(rows[0].is_international).toBe(true)
  })

  it('gives non-Atelier finished goods no retail price, house goods an indicative one', async () => {
    const { rows: international } = await pool.query(
      `SELECT retail_price_cents FROM products WHERE slug = 'pierre-frey-atlas-cushion-cover'`
    )
    expect(international).toHaveLength(1)
    expect(international[0].retail_price_cents).toBeNull()

    const { rows: house } = await pool.query(
      `SELECT retail_price_cents, currency, product_type FROM products WHERE slug = 'plaid-classic-throw'`
    )
    expect(house).toHaveLength(1)
    expect(house[0].retail_price_cents).toBe(38900)
    expect(house[0].currency).toBe('NZD')
    expect(house[0].product_type).toBe('finished_good')
  })

  it('imports fabric designs with specs, price band, and colourway hex tones', async () => {
    const { rows: products } = await pool.query(
      `SELECT id, product_type, composition, width, application, price_band, retail_price_cents
       FROM products WHERE slug = 'pierre-frey-atlas'`
    )
    expect(products).toHaveLength(1)
    expect(products[0].product_type).toBe('fabric')
    expect(products[0].composition).toBe('48% Viscose / 33% Cotton / 19% Linen')
    expect(products[0].width).toBe('140cm')
    expect(products[0].application).toBe('Upholstery')
    expect(products[0].price_band).toBe('NZ$420 / m')
    expect(products[0].retail_price_cents).toBeNull()

    const { rows: colourways } = await pool.query(
      `SELECT name, hex_tones, product_id FROM colourways WHERE sku = 'PF-ATL-04'`
    )
    expect(colourways).toHaveLength(1)
    expect(colourways[0].name).toBe('Indigo')
    expect(colourways[0].hex_tones).toEqual(['#5C6B86', '#2C3A55'])
    expect(colourways[0].product_id).toBe(products[0].id)
  })

  it('creates one inventory row per colourway with stock from design status', async () => {
    const { rows: counts } = await pool.query(
      `SELECT (SELECT count(*)::int FROM colourways) AS colourways,
              (SELECT count(*)::int FROM inventory) AS inventory`
    )
    expect(counts[0].inventory).toBe(counts[0].colourways)

    // Larsen Wright is 'Low stock' — matches the 12 m on hand from the sales-order demo data.
    const { rows: low } = await pool.query(
      `SELECT i.qty_available, i.unit FROM inventory i
       JOIN colourways c ON c.id = i.colourway_id WHERE c.sku = 'LAR-WRT-03'`
    )
    expect(low).toHaveLength(1)
    expect(Number(low[0].qty_available)).toBe(12)
    expect(low[0].unit).toBe('metres')

    const { rows: goods } = await pool.query(
      `SELECT i.unit FROM inventory i
       JOIN colourways c ON c.id = i.colourway_id WHERE c.sku = 'ATL-1032'`
    )
    expect(goods).toHaveLength(1)
    expect(goods[0].unit).toBe('units')
  })

  it('links collections to their brand, with tile editorial and a de-prefixed display name', async () => {
    const { rows } = await pool.query(
      `SELECT co.name, co.description, co.image_url FROM collections co
       JOIN brands b ON b.id = co.brand_id
       WHERE b.slug = 'pierre-frey' AND co.slug = 'pierre-frey-cappuccino'`
    )
    expect(rows).toHaveLength(1)
    // The snapshot titles it "Pierre Frey | Cappuccino"; the slug keeps the full
    // title (upsert-key stability) while the display name drops the redundant
    // brand prefix — it only ever renders on the brand's own page.
    expect(rows[0].name).toBe('Cappuccino')
    expect(rows[0].description).toMatch(/natural tones/i)
    expect(rows[0].image_url).toMatch(/^https:\/\/www\.atelier\.co\.nz\//)

    // The plain prefix is only stripped when something word-like remains:
    // a tile labelled just "2024" would read as a mistake.
    const { rows: larsen } = await pool.query(
      `SELECT co.name FROM collections co
       JOIN brands b ON b.id = co.brand_id
       WHERE b.slug = 'larsen' AND co.slug = 'larsen-2024'`
    )
    expect(larsen[0].name).toBe('Larsen 2024')
  })

  it('seeds the verified house website', async () => {
    const { rows } = await pool.query(
      `SELECT website_url FROM brands WHERE slug = 'manuel-canovas'`
    )
    expect(rows[0].website_url).toBe('https://www.manuelcanovas.com/')
  })

  it('seed fills a blank brand website but never overwrites a staff-entered one', async () => {
    // Simulate a CRM edit between seeds, then re-run the seed.
    await pool.query(
      `UPDATE brands SET website_url = 'https://staff-entered.example.com'
       WHERE slug = 'pierre-frey'`
    )
    await runSeed(pool)
    const { rows } = await pool.query(
      `SELECT website_url FROM brands WHERE slug = 'pierre-frey'`
    )
    expect(rows[0].website_url).toBe('https://staff-entered.example.com')
  })

  it('seeds shipping rates: three zones with two tiers each (boundary 20)', async () => {
    const { rows } = await pool.query(
      `SELECT zone, count(*)::int AS tiers,
              array_agg(threshold_qty::int ORDER BY threshold_qty) AS thresholds
       FROM shipping_rates GROUP BY zone ORDER BY zone`
    )
    expect(rows.map((row) => row.zone)).toEqual(['Auckland', 'North Island', 'South Island'])
    for (const row of rows) {
      expect(row.tiers).toBe(2)
      expect(row.thresholds).toEqual([0, 20])
    }
  })
})
