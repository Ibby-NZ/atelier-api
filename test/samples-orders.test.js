import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { LEGACY_TABLES } from '../src/seed/legacy-import.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other
// suite here.
const PREFIX = 'w4-orders-test'

const ORDER_STATUSES = [
  'requested',
  'ordered',
  'in_transit',
  'received',
  'displayed',
  'cancelled',
]

// One stamp per state, so "when did it move" survives the next move. A single
// status_changed_at would be overwritten and lose every earlier transition.
const TRANSITION_STAMPS = ORDER_STATUSES.map((status) => `${status}_at`)

// Written by the staging migration and never imported, so it is absent from the
// import column map — declared rather than tolerated, because the point of the
// comparison is that a NEW column fails it.
const STAGED_BUT_NOT_IMPORTED = Object.freeze({
  legacy_sales_orders: ['owning_business_unit'],
})

const IMPORT_STAMP = 'imported_at'

// The columns the order state machine's reservation arithmetic owns. A sample
// order is a request for a physical object, never a quantity.
const STOCK_QUANTITY_COLUMNS = /qty_available|qty_reserved/

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

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

const insertOrder = (pool, { showroomId, colourwayId = null, supplierId = null, label = null }) =>
  pool
    .query(
      `INSERT INTO sample_orders (showroom_id, colourway_id, supplier_id, label)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [showroomId, colourwayId, supplierId, label]
    )
    .then(({ rows }) => rows[0].id)

/** Advance an order, stamping the column that belongs to the new state. */
const advance = (pool, id, status) =>
  pool.query(
    `UPDATE sample_orders SET status = $2, ${status}_at = now(), updated_at = now() WHERE id = $1`,
    [id, status]
  )

const cleanup = async (pool) => {
  // Orders first: showroom_id and colourway_id are both RESTRICT, so neither a
  // showroom delete nor a brand cascade can get past one and the cleanup itself
  // would 23503.
  await pool.query(
    `DELETE FROM sample_orders WHERE showroom_id IN (SELECT id FROM showrooms WHERE name LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM showrooms WHERE name LIKE $1`, [`${PREFIX}-%`])
}

describe('sample orders schema migration', () => {
  let pool
  let showroomId

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
    showroomId = await insertShowroom(pool, `${PREFIX}-ponsonby`)
  })

  it('creates the sample_orders table', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'sample_orders'`
    )
    expect(rows).toHaveLength(1)
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('accepts every declared status and nothing else', async () => {
    for (const status of ORDER_STATUSES) {
      await pool.query(
        `INSERT INTO sample_orders (showroom_id, label, status) VALUES ($1, $2, $3)`,
        [showroomId, `${PREFIX}-${status}`, status]
      )
    }
    const { rows } = await pool.query(
      `SELECT status FROM sample_orders WHERE showroom_id = $1 ORDER BY status`,
      [showroomId]
    )
    expect(rows.map((row) => row.status)).toEqual([...ORDER_STATUSES].sort())
    // Free text would make the CRM's status tabs a guess.
    await expect(
      pool.query(`INSERT INTO sample_orders (showroom_id, status) VALUES ($1, 'dispatched')`, [
        showroomId,
      ])
    ).rejects.toThrow(/sample_orders_status_check/)
  })

  it('defaults a new order to requested and stamps requested_at', async () => {
    const id = await insertOrder(pool, { showroomId })
    const { rows } = await pool.query(
      `SELECT status, requested_at IS NOT NULL AS raised FROM sample_orders WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({ status: 'requested', raised: true })
  })

  it('gives every transition its own timestamp column', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_orders'
         AND column_name = ANY($1)`,
      [TRANSITION_STAMPS]
    )
    expect(rows.map((row) => row.column_name).sort()).toEqual([...TRANSITION_STAMPS].sort())
  })

  it('leaves the later stamps null until the order reaches them', async () => {
    // A NULL stamp reads as "has not been there" without consulting status.
    const id = await insertOrder(pool, { showroomId })
    const { rows } = await pool.query(
      `SELECT ordered_at, in_transit_at, received_at, displayed_at, cancelled_at
       FROM sample_orders WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({
      ordered_at: null,
      in_transit_at: null,
      received_at: null,
      displayed_at: null,
      cancelled_at: null,
    })
  })

  it('keeps every earlier stamp as the order advances', async () => {
    // This is what the six columns buy: a showroom chasing a house asks "when
    // was it ordered", not "when did it last move".
    const id = await insertOrder(pool, { showroomId, label: `${PREFIX} Atlas hanger` })
    for (const status of ['ordered', 'in_transit', 'received', 'displayed']) {
      await advance(pool, id, status)
    }
    const { rows } = await pool.query(
      `SELECT status,
              requested_at IS NOT NULL AS requested,
              ordered_at IS NOT NULL AS ordered,
              in_transit_at IS NOT NULL AS in_transit,
              received_at IS NOT NULL AS received,
              displayed_at IS NOT NULL AS displayed,
              cancelled_at IS NULL AS never_cancelled,
              requested_at <= ordered_at AND ordered_at <= displayed_at AS in_order
       FROM sample_orders WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({
      status: 'displayed',
      requested: true,
      ordered: true,
      in_transit: true,
      received: true,
      displayed: true,
      never_cancelled: true,
      in_order: true,
    })
  })

  it('records a cancellation on its own stamp, leaving the rest as they were', async () => {
    const id = await insertOrder(pool, { showroomId })
    await advance(pool, id, 'ordered')
    await advance(pool, id, 'cancelled')
    const { rows } = await pool.query(
      `SELECT status, ordered_at IS NOT NULL AS ordered, cancelled_at IS NOT NULL AS cancelled,
              in_transit_at, received_at, displayed_at
       FROM sample_orders WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({
      status: 'cancelled',
      ordered: true,
      cancelled: true,
      in_transit_at: null,
      received_at: null,
      displayed_at: null,
    })
  })

  it('requires a showroom', async () => {
    // An order with no destination is a request nobody can fulfil.
    await expect(
      pool.query(`INSERT INTO sample_orders (showroom_id) VALUES (NULL)`)
    ).rejects.toMatchObject({ code: '23502' })
  })

  it('refuses to delete a showroom that has orders', async () => {
    await insertOrder(pool, { showroomId })
    await expect(
      pool.query(`DELETE FROM showrooms WHERE id = $1`, [showroomId])
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('refuses to delete a colourway an order still points at', async () => {
    const colourwayId = await insertColourway(pool, {
      slug: `${PREFIX}-restrict`,
      sku: `${PREFIX}-SKU-1`,
    })
    await insertOrder(pool, { showroomId, colourwayId })
    await expect(
      pool.query(`DELETE FROM colourways WHERE id = $1`, [colourwayId])
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('records an order for material the catalogue does not hold', async () => {
    // Often the reason it is being ordered; `label` identifies those.
    const id = await insertOrder(pool, { showroomId, label: 'New Pierre Frey book, spring drop' })
    const { rows } = await pool.query(`SELECT colourway_id, label FROM sample_orders WHERE id = $1`, [
      id,
    ])
    expect(rows[0]).toEqual({ colourway_id: null, label: 'New Pierre Frey book, spring drop' })
  })

  it('unlinks the supplier but keeps the order', async () => {
    const supplierId = await insertSupplier(pool, {
      name: `${PREFIX} Rubelli`,
      slug: `${PREFIX}-rubelli`,
    })
    const id = await insertOrder(pool, { showroomId, supplierId, label: `${PREFIX} memo` })
    await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId])
    const { rows } = await pool.query(`SELECT label, supplier_id FROM sample_orders WHERE id = $1`, [
      id,
    ])
    expect(rows[0]).toEqual({ label: `${PREFIX} memo`, supplier_id: null })
  })

  it('indexes live orders only', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'sample_orders_archived_at_live_idx'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/WHERE \(archived_at IS NULL\)/)
  })

  it('carries no comments column', async () => {
    // `legacy_cuttings.comments` holds third parties' names, emails, phones and
    // home addresses. Nothing here is a place to copy it into.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_orders'
         AND column_name = 'comments'`
    )
    expect(rows).toEqual([])
  })

  it('gives sample_orders no quantity columns', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_orders'`
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows.map((row) => row.column_name).filter((name) => STOCK_QUANTITY_COLUMNS.test(name))
    ).toEqual([])
  })

  it('adds no column to any legacy_ table', async () => {
    // The legacy import upserts every mapped column to EXCLUDED, so state
    // stored on a staging row is destroyed by the next `npm run import:legacy`.
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
})
