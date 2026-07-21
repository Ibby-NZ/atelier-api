import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'

const CATALOGUE_TABLES = ['brands', 'collections', 'products', 'colourways', 'inventory']

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

describe('catalogue schema migration', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('creates all five catalogue tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [CATALOGUE_TABLES]
    )
    expect(rows.map((row) => row.table_name).sort()).toEqual([...CATALOGUE_TABLES].sort())
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('rejects a product_type outside fabric/finished_good', async () => {
    await expect(
      pool.query(
        `INSERT INTO brands (name, slug, currency) VALUES ('Check Brand', 'check-brand', 'NZD')
         RETURNING id`
      ).then(({ rows }) =>
        pool.query(
          `INSERT INTO products (brand_id, name, slug, product_type, currency)
           VALUES ($1, 'Bad Type', 'bad-type', 'sofa', 'NZD')`,
          [rows[0].id]
        )
      )
    ).rejects.toThrow(/products_product_type_check/)
    await pool.query(`DELETE FROM brands WHERE slug = 'check-brand'`)
  })
})
