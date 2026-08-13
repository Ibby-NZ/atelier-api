import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { LEGACY_TABLES } from '../src/seed/legacy-import.js'

const SAMPLE_TABLES = ['showrooms', 'samples']

const SAMPLE_STATUSES = ['in_library', 'out', 'missing', 'retired']

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite here.
const PREFIX = 'w4-schema-test'

// Written by the staging migration and never imported, so it is absent from the
// import column map. Declared rather than tolerated: the point of the comparison
// below is that a NEW column fails it.
const STAGED_BUT_NOT_IMPORTED = Object.freeze({
  legacy_sales_orders: ['owning_business_unit'],
})

// node-pg-migrate's own bookkeeping column, on every staging table.
const IMPORT_STAMP = 'imported_at'

// Samples are physical objects, not stock. These are the columns the order state
// machine's reservation arithmetic owns; a second writer breaks it silently.
const STOCK_QUANTITY_COLUMNS = /qty_available|qty_reserved/
// A sample read model may say the word "inventory" in prose; it may not put the
// table in a SQL position.
const INVENTORY_IN_SQL = /(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

/** Every source file this workstream owns, so the scans below cannot pass vacuously. */
const sampleSourceFiles = () => {
  const files = readdirSync('migrations')
    .filter((name) => name.includes('samples'))
    .map((name) => join('migrations', name))
  if (existsSync('src/samples')) {
    files.push(
      ...readdirSync('src/samples', { recursive: true })
        .map((name) => join('src/samples', name))
        .filter((path) => path.endsWith('.js'))
    )
  }
  // Every samples route file, not just `admin-samples.js`: W20-US-004/US-007
  // put the loan queue and its reminders in `admin-sample-loans.js`, and a
  // hard-coded single filename would have left that outside the net.
  files.push(
    ...readdirSync('src/routes')
      .filter((name) => /^admin-sample.*\.js$/.test(name))
      .map((name) => join('src/routes', name))
  )
  return files
}

const insertShowroom = (pool, name) =>
  pool
    .query(`INSERT INTO showrooms (name) VALUES ($1) RETURNING id`, [name])
    .then(({ rows }) => rows[0].id)

const insertSupplier = (pool, { name, slug }) =>
  pool
    .query(`INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`, [name, slug])
    .then(({ rows }) => rows[0].id)

const insertColourway = async (pool, { slug, sku }) => {
  const brand = await pool.query(
    `INSERT INTO brands (name, slug, currency, trade_only)
     VALUES ($1, $2, 'NZD', false) RETURNING id`,
    [`${PREFIX} house`, slug]
  )
  const product = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency)
     VALUES ($1, $2, $3, 'fabric', 'NZD') RETURNING id`,
    [brand.rows[0].id, `${PREFIX} design`, `${slug}-design`]
  )
  const colourway = await pool.query(
    `INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3) RETURNING id`,
    [product.rows[0].id, `${PREFIX} colour`, sku]
  )
  return colourway.rows[0].id
}

const insertSample = (pool, { barcode, colourwayId = null, supplierId = null, showroomId = null }) =>
  pool
    .query(
      `INSERT INTO samples (barcode, colourway_id, supplier_id, showroom_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [barcode, colourwayId, supplierId, showroomId]
    )
    .then(({ rows }) => rows[0].id)

const cleanup = async (pool) => {
  // Samples first: colourway_id is RESTRICT, so a brand cascade cannot get past
  // it and the cleanup itself would 23503.
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM showrooms WHERE name LIKE $1`, [`${PREFIX}-%`])
}

describe('samples register schema migration', () => {
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

  it('creates the showrooms and samples tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [SAMPLE_TABLES]
    )
    expect(rows.map((row) => row.table_name).sort()).toEqual([...SAMPLE_TABLES].sort())
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('refuses a duplicate barcode', async () => {
    await insertSample(pool, { barcode: `${PREFIX}-0001` })
    await expect(insertSample(pool, { barcode: `${PREFIX}-0001` })).rejects.toThrow(
      /samples_barcode_key/
    )
  })

  it('requires a barcode', async () => {
    // A nullable barcode would let the unique index tolerate any number of
    // unlabelled samples, which turns the by-barcode lookup into a guess.
    await expect(
      pool.query(`INSERT INTO samples (barcode) VALUES (NULL)`)
    ).rejects.toMatchObject({ code: '23502' })
  })

  it('registers a sample with no catalogue colourway', async () => {
    // Samples on the shelves predate the catalogue and come from houses Atelier
    // does not stock; `label` is what identifies those.
    const id = await pool
      .query(
        `INSERT INTO samples (barcode, label) VALUES ($1, $2) RETURNING id`,
        [`${PREFIX}-unmatched`, 'Unnamed hanger, top shelf']
      )
      .then(({ rows }) => rows[0].id)
    const { rows } = await pool.query(`SELECT colourway_id, label FROM samples WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ colourway_id: null, label: 'Unnamed hanger, top shelf' })
  })

  it('refuses to delete a colourway a sample still points at', async () => {
    const colourwayId = await insertColourway(pool, {
      slug: `${PREFIX}-restrict`,
      sku: `${PREFIX}-SKU-1`,
    })
    await insertSample(pool, { barcode: `${PREFIX}-0002`, colourwayId })
    await expect(
      pool.query(`DELETE FROM colourways WHERE id = $1`, [colourwayId])
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('unlinks the supplier but keeps the sample', async () => {
    const supplierId = await insertSupplier(pool, {
      name: `${PREFIX} Rubelli`,
      slug: `${PREFIX}-rubelli`,
    })
    const id = await insertSample(pool, { barcode: `${PREFIX}-0003`, supplierId })
    await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId])
    const { rows } = await pool.query(`SELECT barcode, supplier_id FROM samples WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ barcode: `${PREFIX}-0003`, supplier_id: null })
  })

  it('unlinks the showroom but keeps the sample', async () => {
    const showroomId = await insertShowroom(pool, `${PREFIX}-ponsonby`)
    const id = await insertSample(pool, { barcode: `${PREFIX}-0004`, showroomId })
    await pool.query(`DELETE FROM showrooms WHERE id = $1`, [showroomId])
    const { rows } = await pool.query(`SELECT barcode, showroom_id FROM samples WHERE id = $1`, [id])
    expect(rows[0]).toEqual({ barcode: `${PREFIX}-0004`, showroom_id: null })
  })

  it('accepts every declared status and nothing else', async () => {
    for (const status of SAMPLE_STATUSES) {
      await pool.query(`INSERT INTO samples (barcode, status) VALUES ($1, $2)`, [
        `${PREFIX}-${status}`,
        status,
      ])
    }
    const { rows } = await pool.query(
      `SELECT status FROM samples WHERE barcode LIKE $1 ORDER BY status`,
      [`${PREFIX}-%`]
    )
    expect(rows.map((row) => row.status)).toEqual([...SAMPLE_STATUSES].sort())
    await expect(
      pool.query(`INSERT INTO samples (barcode, status) VALUES ($1, 'on_loan')`, [
        `${PREFIX}-bad-status`,
      ])
    ).rejects.toThrow(/samples_status_check/)
  })

  it('defaults a new sample to in_library', async () => {
    const id = await insertSample(pool, { barcode: `${PREFIX}-0005` })
    const { rows } = await pool.query(`SELECT status FROM samples WHERE id = $1`, [id])
    expect(rows[0].status).toBe('in_library')
  })

  it('indexes live samples and showrooms only', async () => {
    const { rows } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [['samples_archived_at_live_idx', 'showrooms_archived_at_live_idx']]
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.indexdef).toMatch(/WHERE \(archived_at IS NULL\)/)
  })

  it('adds no column to any legacy_ table', async () => {
    // The legacy import upserts every mapped column to EXCLUDED, so state stored
    // on a staging row is destroyed by the next `npm run import:legacy`. The
    // import column map is the declaration of what those tables hold; anything
    // live and absent from it is a column somebody added.
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'legacy\\_%'`
    )
    const live = new Map()
    for (const row of rows) {
      if (!live.has(row.table_name)) live.set(row.table_name, [])
      live.get(row.table_name).push(row.column_name)
    }
    // A map that found no staging tables would pass every check below vacuously.
    expect(live.size).toBe(Object.keys(LEGACY_TABLES).length)

    const unexpected = []
    for (const spec of Object.values(LEGACY_TABLES)) {
      const declared = new Set([
        ...Object.keys(spec.columns),
        IMPORT_STAMP,
        ...(STAGED_BUT_NOT_IMPORTED[spec.table] ?? []),
      ])
      for (const column of live.get(spec.table) ?? []) {
        if (!declared.has(column)) unexpected.push(`${spec.table}.${column}`)
      }
    }
    expect(unexpected).toEqual([])
  })

  it('carries no comments column, on either table', async () => {
    // `legacy_cuttings.comments` is the back office's scratchpad and holds third
    // parties' names, emails, phones and home addresses. Nothing here is a place
    // to copy it into.
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name = 'comments'`,
      [SAMPLE_TABLES]
    )
    expect(rows).toEqual([])
  })

  it('keeps samples out of stock arithmetic', async () => {
    const files = sampleSourceFiles()
    // A scan that matched no files would pass every assertion below vacuously.
    expect(files.length).toBeGreaterThan(0)
    const offending = files.filter((path) => {
      const source = readFileSync(path, 'utf8')
      return STOCK_QUANTITY_COLUMNS.test(source) || INVENTORY_IN_SQL.test(source)
    })
    expect(offending).toEqual([])
  })

  it('gives the samples tables no quantity columns of their own', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [SAMPLE_TABLES]
    )
    const offending = rows
      .filter((row) => STOCK_QUANTITY_COLUMNS.test(row.column_name))
      .map((row) => `${row.table_name}.${row.column_name}`)
    expect(offending).toEqual([])
  })
})
