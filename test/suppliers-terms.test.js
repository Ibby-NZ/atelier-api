import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  applyDiscountChain,
  chainMultiplier,
  resolveTermsChain,
} from '../src/suppliers/discount-chain.js'

const TERMS_TABLES = ['supplier_brand_terms', 'supplier_discount_tiers']

const PREFIX = 'w3-terms-test'

// The suppliers domain is the only place these tables may be named. Anything
// under src/catalogue/, src/account/ or src/pricing/ answers a client.
const TERMS_OWNERS = ['src/suppliers/', 'src/routes/admin-suppliers.js']

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertSupplier = (pool, suffix) =>
  pool
    .query(`INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`, [
      `${PREFIX} ${suffix}`,
      `${PREFIX}-${suffix}`,
    ])
    .then(({ rows }) => rows[0].id)

// trade_only = false, as every fixture here must set — the column is NOT NULL
// DEFAULT true and a closed house is invisible to an anonymous request.
const insertBrand = (pool, suffix, supplierId = null) =>
  pool
    .query(
      `INSERT INTO brands (name, slug, currency, trade_only, supplier_id)
       VALUES ($1, $2, 'NZD', false, $3) RETURNING id`,
      [`${PREFIX} ${suffix}`, `${PREFIX}-${suffix}`, supplierId]
    )
    .then(({ rows }) => rows[0].id)

const insertTerms = (pool, { supplierId, brandId, discount = null, chain = null, markup = null }) =>
  pool
    .query(
      `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount, discount_chain, markup)
       VALUES ($1, $2, $3, COALESCE($4::numeric(6,4)[], '{}'::numeric(6,4)[]), $5)
       RETURNING id`,
      [supplierId, brandId, discount, chain, markup]
    )
    .then(({ rows }) => rows[0].id)

const insertTier = (pool, { termsId, label, pct, isFallback = false }) =>
  pool.query(
    `INSERT INTO supplier_discount_tiers (supplier_brand_term_id, label, pct, is_fallback)
     VALUES ($1, $2, $3, $4)`,
    [termsId, label, pct, isFallback]
  )

// FK order: terms cascade from brands, brands RESTRICT-reference suppliers.
const cleanup = async (pool) => {
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

// Every .js under src/, so a future module cannot join the terms tables into a
// client-facing read model without this failing.
const sourceFiles = async (dir, found = []) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'data') continue // vendored snapshots, not house code
      await sourceFiles(full, found)
    } else if (entry.name.endsWith('.js')) {
      found.push(full)
    }
  }
  return found
}

describe('supplier brand terms migration', () => {
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

  it('creates the supplier_brand_terms and supplier_discount_tiers tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [TERMS_TABLES]
    )
    expect(rows.map((row) => row.table_name).sort()).toEqual([...TERMS_TABLES].sort())
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('holds one set of terms per brand', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'jv-fabrics', supplierId)
    await insertTerms(pool, { supplierId, brandId, discount: 0.5 })
    await expect(
      insertTerms(pool, { supplierId, brandId, discount: 0.4 })
    ).rejects.toThrow(/supplier_brand_terms_brand_id_key/)
  })

  it('stores a discount chain as the sequence it is', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'jv-fabrics', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId, chain: [0.4, 0.4] })
    const { rows } = await pool.query(
      `SELECT discount, discount_chain FROM supplier_brand_terms WHERE id = $1`,
      [termsId]
    )
    // pg parses numeric[] into JS numbers, but a SCALAR numeric back into a
    // string — so a chain and a flat rate arrive as different types from the
    // same column family. The module coerces either.
    expect(rows[0].discount_chain).toEqual([0.4, 0.4])

    const sisterId = await insertBrand(pool, 'jwall', supplierId)
    const sisterTerms = await insertTerms(pool, {
      supplierId,
      brandId: sisterId,
      discount: 0.5,
    })
    const { rows: flat } = await pool.query(
      `SELECT discount FROM supplier_brand_terms WHERE id = $1`,
      [sisterTerms]
    )
    expect(flat[0].discount).toBe('0.5000')
  })

  it('evaluates a {0.4, 0.4} chain to x0.36, not -80%', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'jv-fabrics', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId, chain: [0.4, 0.4] })
    const { rows } = await pool.query(
      `SELECT discount_chain FROM supplier_brand_terms WHERE id = $1`,
      [termsId]
    )

    const chain = rows[0].discount_chain
    expect(chainMultiplier(chain)).toBeCloseTo(0.36, 10)
    // 100 list becomes 36, and emphatically not the 20 a summed 0.8 would give.
    expect(applyDiscountChain(100, chain)).toBeCloseTo(36, 10)
    expect(applyDiscountChain(100, chain)).not.toBeCloseTo(20, 6)
  })

  it('treats an absent or empty chain as x1', () => {
    expect(chainMultiplier()).toBe(1)
    expect(chainMultiplier([])).toBe(1)
    expect(applyDiscountChain('187.76', [])).toBeCloseTo(187.76, 10)
  })

  it('refuses a chain rate that is not a fraction below 1', () => {
    expect(() => chainMultiplier([0.4, 1])).toThrow(/rate 1 is not a fraction below 1/)
    expect(() => chainMultiplier([-0.1])).toThrow(/rate 0 is not a fraction below 1/)
    expect(() => chainMultiplier(['not a rate'])).toThrow(/rate 0 is not a fraction below 1/)
  })

  it('refuses a NULL inside a chain, which would null the whole net rate', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'jv-fabrics', supplierId)
    await expect(
      pool.query(
        `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount_chain)
         VALUES ($1, $2, ARRAY[0.4, NULL]::numeric(6,4)[])`,
        [supplierId, brandId]
      )
    ).rejects.toThrow(/supplier_brand_terms_chain_not_null_check/)
  })

  it('refuses a flat discount and a chain on the same row', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'jv-fabrics', supplierId)
    await expect(
      insertTerms(pool, { supplierId, brandId, discount: 0.5, chain: [0.4, 0.4] })
    ).rejects.toThrow(/supplier_brand_terms_discount_shape_check/)
  })

  it('refuses a discount of 1 and a markup of 0', async () => {
    const supplierId = await insertSupplier(pool, 'fabricut')
    const brandId = await insertBrand(pool, 'vervain', supplierId)
    await expect(insertTerms(pool, { supplierId, brandId, discount: 1 })).rejects.toThrow(
      /supplier_brand_terms_discount_range_check/
    )
    await expect(insertTerms(pool, { supplierId, brandId, markup: 0 })).rejects.toThrow(
      /supplier_brand_terms_markup_check/
    )
  })

  it('records a per-brand retail markup', async () => {
    const supplierId = await insertSupplier(pool, 'fabricut')
    const brandId = await insertBrand(pool, 's-harris', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId, markup: 2.3 })
    const { rows } = await pool.query(`SELECT markup FROM supplier_brand_terms WHERE id = $1`, [
      termsId,
    ])
    expect(Number(rows[0].markup)).toBeCloseTo(2.3, 4)
  })

  it('keeps tier labels unique per brand, case- and whitespace-insensitively', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'janelli-volpi', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId })
    await insertTier(pool, { termsId, label: 'Wallpapers by the metre', pct: 0.4 })
    await expect(
      insertTier(pool, { termsId, label: '  wallpapers by the metre ', pct: 0.45 })
    ).rejects.toThrow(/supplier_discount_tiers_label_unique/)
  })

  it('allows one fallback tier per brand and no more', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'janelli-volpi', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId })
    await insertTier(pool, { termsId, label: 'All other collections', pct: 0.5, isFallback: true })
    await expect(
      insertTier(pool, { termsId, label: 'Everything else', pct: 0.45, isFallback: true })
    ).rejects.toThrow(/supplier_discount_tiers_fallback_unique/)
  })

  it('refuses a tier pct outside a fraction below 1', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'janelli-volpi', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId })
    await expect(
      insertTier(pool, { termsId, label: 'Impossible', pct: 1 })
    ).rejects.toThrow(/supplier_discount_tiers_pct_check/)
  })

  it('resolves tiers by category label and falls back to the flagged tier', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'janelli-volpi', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId })
    await insertTier(pool, { termsId, label: 'Wallpapers by the metre', pct: 0.4 })
    await insertTier(pool, { termsId, label: 'All other collections', pct: 0.5, isFallback: true })

    const { rows: termsRows } = await pool.query(
      `SELECT discount, discount_chain FROM supplier_brand_terms WHERE id = $1`,
      [termsId]
    )
    const { rows: tiers } = await pool.query(
      `SELECT label, pct, is_fallback FROM supplier_discount_tiers
       WHERE supplier_brand_term_id = $1 ORDER BY label`,
      [termsId]
    )

    const matched = resolveTermsChain(termsRows[0], tiers, 'wallpapers by the metre')
    expect(matched.source).toBe('tier')
    expect(applyDiscountChain(100, matched.chain)).toBeCloseTo(60, 10)

    const unmatched = resolveTermsChain(termsRows[0], tiers, 'trimming')
    expect(unmatched.label).toBe('All other collections')
    expect(applyDiscountChain(100, unmatched.chain)).toBeCloseTo(50, 10)
  })

  it('prefers a chain over tiers and tiers over the flat rate', () => {
    const tiers = [{ label: 'All other collections', pct: 0.5, is_fallback: true }]
    expect(resolveTermsChain({ discount_chain: [0.4, 0.4] }, tiers, 'fabric').source).toBe('chain')
    expect(resolveTermsChain({ discount: 0.3, discount_chain: [] }, tiers, 'fabric').source).toBe(
      'tier'
    )
    expect(resolveTermsChain({ discount: 0.3, discount_chain: [] }, [], 'fabric').source).toBe(
      'flat'
    )
    expect(resolveTermsChain({ discount: null, discount_chain: [] }, [], 'fabric').chain).toEqual([])
  })

  it('removes a brand\'s terms and their tiers with the brand', async () => {
    const supplierId = await insertSupplier(pool, 'jv')
    const brandId = await insertBrand(pool, 'janelli-volpi', supplierId)
    const termsId = await insertTerms(pool, { supplierId, brandId })
    await insertTier(pool, { termsId, label: 'All other collections', pct: 0.5, isFallback: true })

    await pool.query(`DELETE FROM brands WHERE id = $1`, [brandId])

    const { rows: terms } = await pool.query(
      `SELECT id FROM supplier_brand_terms WHERE id = $1`,
      [termsId]
    )
    const { rows: tiers } = await pool.query(
      `SELECT id FROM supplier_discount_tiers WHERE supplier_brand_term_id = $1`,
      [termsId]
    )
    expect(terms).toEqual([])
    expect(tiers).toEqual([])
  })

  it('adds no cost-bearing column to brands', async () => {
    // The terms live on their own tables precisely so brands stays clean; this
    // is the schema-layer half of test/price-list-exposure.test.js.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'brands'`
    )
    const offending = rows
      .map((row) => row.column_name)
      .filter((name) => /discount|markup|margin|cost|wholesale/.test(name))
    expect(offending).toEqual([])
  })

  it('is named by no module outside the suppliers domain', async () => {
    const files = await sourceFiles('src')
    const mentions = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      if (TERMS_TABLES.some((table) => source.includes(table))) {
        mentions.push(file.split(path.sep).join('/'))
      }
    }
    const strays = mentions.filter(
      (file) => !TERMS_OWNERS.some((owner) => file.startsWith(owner))
    )
    expect(strays).toEqual([])
  })
})
