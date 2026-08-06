import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite here.
const PREFIX = 'w3-category-test'

const CATEGORIES = ['fabric', 'wallpaper', 'trimming', 'accessory']

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

// pg_get_constraintdef renders an IN list as
// CHECK ((category = ANY (ARRAY['fabric'::text, ...]))), so the vocabulary is
// read back out of the definition rather than re-typed into the assertion.
const vocabularyOf = (definition) =>
  [...definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1])

const constraintDefinition = (pool, name) =>
  pool
    .query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])
    .then(({ rows }) => rows[0]?.def ?? null)

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
    await expect(
      insertProduct(pool, brandId, { slug: 'bad', category: 'curtain' })
    ).rejects.toThrow(/products_category_check/)
  })

  it('shares its vocabulary with price_list_items.category exactly', async () => {
    // The two sides are only joinable while the sets are identical, and a drift
    // would not fail anywhere — it would just stop matching. So the assertion
    // compares the two live CHECK definitions to each other, not to a literal.
    const [product, priceList] = await Promise.all([
      constraintDefinition(pool, 'products_category_check'),
      constraintDefinition(pool, 'price_list_items_category_check'),
    ])
    expect(product).not.toBeNull()
    expect(priceList).not.toBeNull()

    const productVocabulary = vocabularyOf(product).sort()
    expect(productVocabulary).toEqual([...CATEGORIES].sort())
    expect(productVocabulary).toEqual(vocabularyOf(priceList).sort())
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
