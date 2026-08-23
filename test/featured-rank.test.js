import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildCollectionRows } from '../src/seed/catalogue-data.js'
import { slugify } from '../src/seed/slugify.js'
import {
  FEATURED_BRANDS,
  FEATURED_COLLECTIONS,
  brandFeatureSql,
  collectionFeatureSql,
} from '../migrations/1786593600000_featured-rank.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite here.
const PREFIX = 'w7-featured-test'

// Two houses, one collection slug. That is the whole reason the seeding UPDATE
// joins through `brands`: `collections_brand_id_slug_unique` is per brand, so
// this pair is legal and a slug-only match would feature both.
const HOUSE_A = `${PREFIX}-house-a`
const HOUSE_B = `${PREFIX}-house-b`
const SHARED_SLUG = `${PREFIX}-shared`

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertBrand = (pool, slug) =>
  pool
    .query(
      `INSERT INTO brands (name, slug, currency, trade_only)
       VALUES ($1, $2, 'NZD', false) RETURNING id`,
      [`${slug} house`, slug]
    )
    .then(({ rows }) => rows[0].id)

const insertCollection = (pool, brandId, slug, rank) =>
  pool
    .query(
      `INSERT INTO collections (brand_id, name, slug, featured_rank)
       VALUES ($1, $2, $2, $3) RETURNING id, featured_rank`,
      [brandId, slug, rank ?? null]
    )
    .then(({ rows }) => rows[0])

const rankOf = (pool, table, slug, brandId) =>
  pool
    .query(
      brandId
        ? `SELECT featured_rank FROM ${table} WHERE slug = $1 AND brand_id = $2`
        : `SELECT featured_rank FROM ${table} WHERE slug = $1`,
      brandId ? [slug, brandId] : [slug]
    )
    .then(({ rows }) => (rows.length === 0 ? undefined : rows[0].featured_rank))

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM collections WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

describe('featured_rank migration', () => {
  let pool
  let houseA
  let houseB

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup(pool)
    houseA = await insertBrand(pool, HOUSE_A)
    houseB = await insertBrand(pool, HOUSE_B)
  })

  it('adds a nullable integer featured_rank to brands and collections', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'featured_rank'
        ORDER BY table_name`
    )
    expect(rows).toEqual([
      { table_name: 'brands', data_type: 'integer', is_nullable: 'YES' },
      { table_name: 'collections', data_type: 'integer', is_nullable: 'YES' },
    ])
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('leaves a new row unfeatured — null means not featured', async () => {
    const collection = await insertCollection(pool, houseA, `${PREFIX}-plain`)
    expect(collection.featured_rank).toBeNull()
    expect(await rankOf(pool, 'brands', HOUSE_A)).toBeNull()
  })

  it('accepts a positive rank on both tables', async () => {
    await pool.query(`UPDATE brands SET featured_rank = 1 WHERE slug = $1`, [HOUSE_A])
    const collection = await insertCollection(pool, houseA, `${PREFIX}-ranked`, 4)
    expect(collection.featured_rank).toEqual(4)
    expect(await rankOf(pool, 'brands', HOUSE_A)).toEqual(1)
  })

  it('rejects a rank of zero or below on both tables', async () => {
    // Rank 0 would sort ahead of rank 1 while reading as "unset" — the ambiguity
    // NULL already covers, so the schema refuses it rather than the application.
    await expect(
      pool.query(`UPDATE brands SET featured_rank = 0 WHERE slug = $1`, [HOUSE_A])
    ).rejects.toThrow(/brands_featured_rank_check/)
    await expect(insertCollection(pool, houseA, `${PREFIX}-zero`, 0)).rejects.toThrow(
      /collections_featured_rank_check/
    )
    await expect(insertCollection(pool, houseA, `${PREFIX}-negative`, -1)).rejects.toThrow(
      /collections_featured_rank_check/
    )
  })

  it('allows two rows to share a rank — no unique index', async () => {
    // A partial unique index would turn every reorder step into a potential 409;
    // the read model's `name ASC, id ASC` tie-break is what makes ordering
    // deterministic instead.
    await insertCollection(pool, houseA, `${PREFIX}-tie-a`, 1)
    const second = await insertCollection(pool, houseB, `${PREFIX}-tie-b`, 1)
    expect(second.featured_rank).toEqual(1)
  })

  it('features only the intended house when two share a collection slug', async () => {
    await insertCollection(pool, houseA, SHARED_SLUG)
    await insertCollection(pool, houseB, SHARED_SLUG)

    await pool.query(
      collectionFeatureSql([{ brand_slug: HOUSE_A, slug: SHARED_SLUG, rank: 1 }])
    )

    expect(await rankOf(pool, 'collections', SHARED_SLUG, houseA)).toEqual(1)
    expect(await rankOf(pool, 'collections', SHARED_SLUG, houseB)).toBeNull()
  })

  it('leaves a slug it does not name alone, and matches nothing for an unknown one', async () => {
    await pool.query(brandFeatureSql([{ slug: HOUSE_A, rank: 2 }, { slug: `${PREFIX}-absent`, rank: 3 }]))
    expect(await rankOf(pool, 'brands', HOUSE_A)).toEqual(2)
    expect(await rankOf(pool, 'brands', HOUSE_B)).toBeNull()
    expect(await rankOf(pool, 'brands', `${PREFIX}-absent`)).toBeUndefined()
  })

  it('refuses to build a statement from a value it cannot vouch for', async () => {
    // Every seeded value is interpolated, not bound, so the guard is the only
    // thing between a typo (or anything worse) and the database.
    expect(() => brandFeatureSql([{ slug: "larsen'; DROP TABLE brands; --", rank: 1 }])).toThrow(
      /must be a slug/
    )
    expect(() => brandFeatureSql([{ slug: 'larsen', rank: 0 }])).toThrow(/positive integer/)
    expect(() => collectionFeatureSql([])).toThrow(/non-empty/)
  })

  it('seeds a contiguous, duplicate-free ordering', () => {
    const collectionRanks = FEATURED_COLLECTIONS.map((entry) => entry.rank)
    const brandRanks = FEATURED_BRANDS.map((entry) => entry.rank)
    expect(collectionRanks).toEqual(collectionRanks.map((_, index) => index + 1))
    expect(brandRanks).toEqual(brandRanks.map((_, index) => index + 1))

    const pairs = FEATURED_COLLECTIONS.map((entry) => `${entry.brand_slug}/${entry.slug}`)
    expect(new Set(pairs).size).toEqual(pairs.length)
    expect(new Set(FEATURED_BRANDS.map((entry) => entry.slug)).size).toEqual(FEATURED_BRANDS.length)
  })

  it('names collections and houses the catalogue actually holds', () => {
    // A typo in a seeded slug features nothing and says nothing — the UPDATE
    // simply matches no row. So the pairs are checked against the seed snapshot
    // the storefront's own hardcoded choice was picked from.
    const catalogue = buildCollectionRows().map(
      (row) => `${slugify(row.brand_name)}/${row.slug}`
    )
    for (const entry of FEATURED_COLLECTIONS) {
      expect(catalogue).toContain(`${entry.brand_slug}/${entry.slug}`)
    }

    const houses = new Set(FEATURED_COLLECTIONS.map((entry) => entry.brand_slug))
    for (const entry of FEATURED_BRANDS) {
      expect(houses).toContain(entry.slug)
    }
  })

  it('applied its ranks to whatever seeded rows this database holds', async () => {
    // Migrations run against an empty database in CI, so the backfill matched
    // nothing there — but a row can still EXIST by the time this suite runs:
    // the seed suite imports the real catalogue into the shared CI database and
    // leaves it, and a brand created AFTER the migration holds featured_rank
    // NULL through no fault of the backfill. So the skip condition is "no
    // rank", not "no row" — the `!== undefined` guard let that NULL through
    // and failed the first-ever CI run on a pristine database. On a seeded
    // dev database — the case the migration exists for — the ranks are
    // non-null and every one is still asserted.
    for (const entry of FEATURED_BRANDS) {
      const rank = await rankOf(pool, 'brands', entry.slug)
      if (rank != null) expect(rank).toEqual(entry.rank)
    }
    for (const entry of FEATURED_COLLECTIONS) {
      const { rows } = await pool.query(
        `SELECT c.featured_rank FROM collections c
           JOIN brands b ON b.id = c.brand_id
          WHERE b.slug = $1 AND c.slug = $2`,
        [entry.brand_slug, entry.slug]
      )
      if (rows[0]?.featured_rank != null) expect(rows[0].featured_rank).toEqual(entry.rank)
    }
  })
})
