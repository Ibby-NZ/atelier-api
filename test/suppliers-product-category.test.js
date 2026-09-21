import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
// The stored vocabulary itself, never a hand-typed copy. This suite exists to
// prove the three CHECKs agree; a fourth copy of the list here would be one more
// thing that can drift from them, and the day it did the failure would read as
// a schema bug rather than as a stale test.
import { CATEGORIES } from '../scripts/lib/price-template.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite here.
const PREFIX = 'w3-category-test'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertBrand = (pool) =>
  pool
    .query(
      `INSERT INTO brands (name, slug, currency, trade_only)
       VALUES ($1, $2, 'NZD', false) RETURNING id`,
      [`${PREFIX} house`, `${PREFIX}-house`]
    )
    .then(({ rows }) => rows[0].id)

const insertProduct = (pool, brandId, { slug, productType = 'fabric', category }) =>
  pool
    .query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, category)
       VALUES ($1, $2, $2, $3, 'NZD', $4) RETURNING id, category`,
      [brandId, `${PREFIX}-${slug}`, productType, category ?? null]
    )
    .then(({ rows }) => rows[0])

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

describe('products.category migration', () => {
  let pool
  let brandId

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    brandId = await insertBrand(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
  })

  it('adds a nullable text category to products', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'category'`
    )
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }])
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('leaves an existing product uncategorised rather than guessing one', async () => {
    // Nullable is the whole point: every product predating this column is
    // uncategorised, not a fabric by default.
    const row = await insertProduct(pool, brandId, { slug: 'unset' })
    expect(row.category).toBeNull()
  })

  it('accepts each of the four categories', async () => {
    for (const category of CATEGORIES) {
      const row = await insertProduct(pool, brandId, { slug: category, category })
      expect(row.category).toEqual(category)
    }
  })

  it('rejects a category outside the vocabulary', async () => {
    // The refusal moved from a CHECK to a foreign key in migration
    // 1791379200000 — same refusal, one list instead of three.
    await expect(
      insertProduct(pool, brandId, { slug: 'bad', category: 'curtain' })
    ).rejects.toThrow(/products_category_fkey/)
  })

  it('shares one vocabulary with price_list_items and supplier_freight_rates', async () => {
    // This used to compare three CHECK definitions to EACH OTHER, because a
    // value in one and not the others did not fail anywhere — it silently
    // stopped matching. Migration 1791379200000 makes that unconstructable:
    // all three columns reference the same table, so "identical sets" is no
    // longer a property to test but the shape of the schema. What is left to
    // prove is that all three really do point at it.
    const { rows } = await pool.query(
      `SELECT conrelid::regclass::text AS table_name
         FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'product_categories'::regclass
        ORDER BY 1`
    )
    expect(rows.map((row) => row.table_name)).toEqual([
      'price_list_items',
      'products',
      'supplier_freight_rates',
    ])
  })

  it('still holds the nine the pipeline registry names', async () => {
    // The registry (scripts/lib/price-template.js) seeds the price templates and
    // the import mapping, so a word in it that is not a row here would import
    // rows nothing can carry.
    const { rows } = await pool.query(
      `SELECT slug FROM product_categories WHERE slug = ANY($1::text[]) ORDER BY slug`,
      [[...CATEGORIES]]
    )
    expect(rows.map((row) => row.slug)).toEqual([...CATEGORIES].sort())
  })

  it('is independent of product_type — a finished good may be a wallpaper', async () => {
    // product_type drives the colourway's inventory unit (metres vs units);
    // category is the merchandising axis the rate ledger files by. Conflating
    // them is the trap this column has to survive.
    const row = await insertProduct(pool, brandId, {
      slug: 'wallpaper-roll',
      productType: 'finished_good',
      category: 'wallpaper',
    })
    const { rows } = await pool.query(
      `SELECT product_type, category FROM products WHERE id = $1`,
      [row.id]
    )
    expect(rows[0]).toEqual({ product_type: 'finished_good', category: 'wallpaper' })
  })
})
