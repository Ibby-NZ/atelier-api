import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'

const SUPPLIER_TABLES = ['suppliers', 'supplier_aliases']

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite here.
const PREFIX = 'w3-schema-test'

// The vocabulary test/price-list-exposure.test.js refuses in any client-facing
// payload. `brands` is served to anonymous visitors, so no column of it may match.
const COST_VOCABULARY = /wholesale|landed|duty|freight|cost|margin|markup|discount|credit_limit|payment_terms/

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertSupplier = (pool, { name, slug, country = null, currency = null }) =>
  pool
    .query(
      `INSERT INTO suppliers (name, slug, country, currency)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, slug, country, currency]
    )
    .then(({ rows }) => rows[0].id)

const insertBrand = (pool, { slug, supplierId }) =>
  pool
    .query(
      `INSERT INTO brands (name, slug, currency, trade_only, supplier_id)
       VALUES ($1, $2, 'NZD', false, $3) RETURNING id`,
      [`${PREFIX} house`, slug, supplierId]
    )
    .then(({ rows }) => rows[0].id)

const insertPriceListItem = (pool, { supplier, code, supplierId }) =>
  pool
    .query(
      `INSERT INTO price_list_items
         (supplier, category, code, code_normalized, unit, wholesale_rate, currency, source_file, supplier_id)
       VALUES ($1, 'fabric', $2, $2, 'metre', 100.0000, 'EUR', $3, $4)
       RETURNING id`,
      [supplier, code, `${PREFIX}.csv`, supplierId]
    )
    .then(({ rows }) => rows[0].id)

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM price_list_items WHERE source_file = $1`, [`${PREFIX}.csv`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

describe('suppliers schema migration', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup(pool)
  })

  it('creates the suppliers and supplier_aliases tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [SUPPLIER_TABLES]
    )
    expect(rows.map((row) => row.table_name).sort()).toEqual([...SUPPLIER_TABLES].sort())
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('refuses a duplicate supplier name and a duplicate slug', async () => {
    await insertSupplier(pool, { name: `${PREFIX} Rubelli`, slug: `${PREFIX}-rubelli` })
    await expect(
      insertSupplier(pool, { name: `${PREFIX} Rubelli`, slug: `${PREFIX}-rubelli-two` })
    ).rejects.toThrow(/suppliers_name_key/)
    await expect(
      insertSupplier(pool, { name: `${PREFIX} Rubelli Two`, slug: `${PREFIX}-rubelli` })
    ).rejects.toThrow(/suppliers_slug_key/)
  })

  it('records the invoicing currency independently of the country', async () => {
    // Jim Thompson is Thailand and invoices USD. The column carries what they
    // bill in, never what the country would suggest.
    const id = await insertSupplier(pool, {
      name: `${PREFIX} Jim Thompson`,
      slug: `${PREFIX}-jim-thompson`,
      country: 'Thailand',
      currency: 'USD',
    })
    const { rows } = await pool.query(`SELECT country, currency FROM suppliers WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ country: 'Thailand', currency: 'USD' })
  })

  it('leaves currency nullable so a supplier with no invoice on file is not guessed', async () => {
    const id = await insertSupplier(pool, { name: `${PREFIX} New House`, slug: `${PREFIX}-new-house` })
    const { rows } = await pool.query(`SELECT currency FROM suppliers WHERE id = $1`, [id])
    expect(rows[0].currency).toBeNull()
  })

  it('rejects a discount_method outside averaged/per-brand', async () => {
    await expect(
      pool.query(
        `INSERT INTO suppliers (name, slug, discount_method)
         VALUES ($1, $2, 'summed')`,
        [`${PREFIX} Bad Method`, `${PREFIX}-bad-method`]
      )
    ).rejects.toThrow(/suppliers_discount_method_check/)
  })

  it('indexes live suppliers only', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'suppliers_archived_at_live_idx'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/WHERE \(archived_at IS NULL\)/)
  })

  it('keeps supplier aliases unique on lower(btrim(alias))', async () => {
    const id = await insertSupplier(pool, { name: `${PREFIX} JV`, slug: `${PREFIX}-jv` })
    const other = await insertSupplier(pool, { name: `${PREFIX} JWall`, slug: `${PREFIX}-jwall` })
    await pool.query(`INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, 'JV')`, [id])
    // Same alias, different case and padding, different supplier: one alias must
    // resolve to exactly one supplier or the backfill picks at random.
    await expect(
      pool.query(`INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, '  jv ')`, [other])
    ).rejects.toThrow(/supplier_aliases_alias_lower_unique/)
  })

  it('removes a supplier\'s aliases with it', async () => {
    const id = await insertSupplier(pool, { name: `${PREFIX} C&C`, slug: `${PREFIX}-cc` })
    await pool.query(`INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, 'C&C MILANO')`, [id])
    await pool.query(`DELETE FROM suppliers WHERE id = $1`, [id])
    const { rows } = await pool.query(`SELECT id FROM supplier_aliases WHERE supplier_id = $1`, [id])
    expect(rows).toEqual([])
  })

  it('refuses to delete a supplier a brand still points at', async () => {
    const id = await insertSupplier(pool, { name: `${PREFIX} Larsen`, slug: `${PREFIX}-larsen` })
    await insertBrand(pool, { slug: `${PREFIX}-larsen-house`, supplierId: id })
    await expect(pool.query(`DELETE FROM suppliers WHERE id = $1`, [id])).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('unlinks price-list items but keeps the row and its free-text supplier', async () => {
    const id = await insertSupplier(pool, { name: `${PREFIX} Larsen`, slug: `${PREFIX}-larsen` })
    const itemId = await insertPriceListItem(pool, {
      supplier: `${PREFIX} Larsen`,
      code: `${PREFIX}-0001`,
      supplierId: id,
    })
    await pool.query(`DELETE FROM suppliers WHERE id = $1`, [id])
    const { rows } = await pool.query(
      `SELECT supplier, supplier_id FROM price_list_items WHERE id = $1`,
      [itemId]
    )
    expect(rows[0]).toEqual({ supplier: `${PREFIX} Larsen`, supplier_id: null })
  })

  it('adds no cost-bearing column to brands', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'brands'`
    )
    const offending = rows.map((row) => row.column_name).filter((name) => COST_VOCABULARY.test(name))
    expect(offending).toEqual([])
  })
})
