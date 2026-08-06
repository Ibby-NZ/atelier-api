import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { updateUser, getUser } from '../src/users/admin-users.js'
import { DIRECTOR_BACKFILL_SQL } from '../migrations/1786680000000_reporting-finance-access.js'
import {
  PRODUCT_TYPES,
  ORDER_KINDS,
  ORDER_STATUSES,
  parseReportFilters,
} from '../src/reports/filters.js'
import { listRevenueLines, summariseRevenue } from '../src/reports/revenue-lines.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite
// here. These are plain INSERTs rather than /auth/register calls: register is
// rate-limited 10 per 15 min per IP and this file has no use for a session.
const PREFIX = 'w5-reporting-test'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertUser = (pool, { role, canViewFinance = false, tradeApproved = false }) =>
  pool
    .query(
      `INSERT INTO users (email, password_hash, name, role, trade_approved, can_view_finance)
       VALUES ($1, 'not-a-real-hash', $2, $3, $4, $5)
       RETURNING id`,
      [`${PREFIX}-${role}-${canViewFinance}@example.test`, `${PREFIX} ${role}`, role, tradeApproved, canViewFinance]
    )
    .then(({ rows }) => rows[0].id)

const financeFlagOf = (pool, id) =>
  pool
    .query('SELECT can_view_finance FROM users WHERE id = $1', [id])
    .then(({ rows }) => rows[0].can_view_finance)

const cleanup = (pool) => pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])

// The values a CHECK constraint accepts, read off its live definition — e.g.
// "CHECK ((kind = ANY (ARRAY['checkout'::text, ...])))".
const checkValues = (pool, constraint) =>
  pool
    .query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint]
    )
    .then(({ rows }) => {
      expect(rows).toHaveLength(1)
      return [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]).sort()
    })

describe('W5-US-002 — reporting index and finance access', () => {
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

  it('re-running the migrations is a no-op', async () => {
    const applied = await runMigrations(loadConfig().databaseUrl)
    expect(applied).toEqual([])
  })

  describe('the orders.created_at index', () => {
    it('exists, because the date range is every report’s primary scan', async () => {
      const { rows } = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'orders' AND indexname = 'orders_created_at_index'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('btree (created_at)')
    })

    // The two indexes that were already there are the account and lifecycle
    // access paths; neither helps a range predicate. Asserted so a future
    // "tidy-up" that drops one of the three has to say which.
    it('sits alongside the user_id and status indexes rather than replacing them', async () => {
      const { rows } = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'orders' ORDER BY indexname`
      )
      const names = rows.map((row) => row.indexname)
      expect(names).toContain('orders_user_id_index')
      expect(names).toContain('orders_status_index')
      expect(names).toContain('orders_created_at_index')
    })
  })

  describe('users.can_view_finance', () => {
    // Finance visibility fails CLOSED: a nullable column would turn "nobody has
    // decided yet" into a value every reader has to interpret.
    it('is a boolean, NOT NULL, defaulting to false', async () => {
      const { rows } = await pool.query(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'can_view_finance'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      })
    })

    it('defaults a new account to no finance visibility', async () => {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, 'not-a-real-hash', 'backoffice')
         RETURNING can_view_finance`,
        [`${PREFIX}-default@example.test`]
      )
      expect(rows[0].can_view_finance).toBe(false)
    })
  })

  describe('the director backfill', () => {
    // The migration's OWN exported statement, run against this suite's fixtures
    // — not a retyped copy that could drift from what actually ran.
    it('grants directors finance visibility and nobody else', async () => {
      const director = await insertUser(pool, { role: 'director' })
      const backoffice = await insertUser(pool, { role: 'backoffice' })
      const customer = await insertUser(pool, { role: 'customer' })

      await pool.query(DIRECTOR_BACKFILL_SQL)

      expect(await financeFlagOf(pool, director)).toBe(true)
      expect(await financeFlagOf(pool, backoffice)).toBe(false)
      expect(await financeFlagOf(pool, customer)).toBe(false)
    })

    it('is idempotent — a second run writes nothing', async () => {
      const director = await insertUser(pool, { role: 'director' })

      const first = await pool.query(DIRECTOR_BACKFILL_SQL)
      const second = await pool.query(DIRECTOR_BACKFILL_SQL)

      expect(first.rowCount).toBe(1)
      expect(second.rowCount).toBe(0)
      expect(await financeFlagOf(pool, director)).toBe(true)
    })
  })

  describe('the PATCH whitelist', () => {
    it('writes can_view_finance on a staff account', async () => {
      const id = await insertUser(pool, { role: 'backoffice' })

      const user = await updateUser(pool, id, { can_view_finance: true })

      expect(user.can_view_finance).toBe(true)
      expect(await financeFlagOf(pool, id)).toBe(true)
    })

    it('reads it back, so the office can see what it granted', async () => {
      const id = await insertUser(pool, { role: 'director', canViewFinance: true })

      expect(await getUser(pool, id)).toMatchObject({ can_view_finance: true })
    })

    // Same discipline as trade_approved: the flag only means anything on a staff
    // row, so a demotion revokes it rather than stranding a true nobody displays.
    it('clears it when the role moves off backoffice/director', async () => {
      const id = await insertUser(pool, { role: 'backoffice', canViewFinance: true })

      const user = await updateUser(pool, id, { role: 'customer' })

      expect(user.role).toBe('customer')
      expect(user.can_view_finance).toBe(false)
    })

    it('clears it on a move to trade as well as to customer', async () => {
      const id = await insertUser(pool, { role: 'director', canViewFinance: true })

      const user = await updateUser(pool, id, { role: 'trade' })

      expect(user.can_view_finance).toBe(false)
    })

    // The role is the stronger statement; the two together are a contradiction
    // rather than an instruction.
    it('makes an explicit can_view_finance: true lose against the same body’s role', async () => {
      const id = await insertUser(pool, { role: 'backoffice' })

      const user = await updateUser(pool, id, { role: 'customer', can_view_finance: true })

      expect(user.can_view_finance).toBe(false)
      expect(await financeFlagOf(pool, id)).toBe(false)
    })

    it('keeps it across a move between the two finance roles', async () => {
      const id = await insertUser(pool, { role: 'director', canViewFinance: true })

      const user = await updateUser(pool, id, { role: 'backoffice' })

      expect(user.role).toBe('backoffice')
      expect(user.can_view_finance).toBe(true)
    })

    it('leaves it alone when the body does not mention the role', async () => {
      const id = await insertUser(pool, { role: 'backoffice', canViewFinance: true })

      const user = await updateUser(pool, id, { name: `${PREFIX} renamed` })

      expect(user.can_view_finance).toBe(true)
    })
  })
})

// src/reports/filters.js is unit-tested purely in test/report-filters.test.js.
// The one thing that file CANNOT prove is that its enum copies still describe
// the database: a boundary copy exists so an unknown value is a 400 instead of a
// 500, and the cost of one is that the two can drift silently.
describe('W5-US-003 — the report filter vocabularies against the schema', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('accepts exactly the product types products_product_type_check allows', async () => {
    expect(await checkValues(pool, 'products_product_type_check')).toEqual([...PRODUCT_TYPES].sort())
  })

  it('accepts exactly the kinds orders_kind_check allows', async () => {
    expect(await checkValues(pool, 'orders_kind_check')).toEqual([...ORDER_KINDS].sort())
  })

  it('accepts exactly the statuses orders_status_check allows', async () => {
    expect(await checkValues(pool, 'orders_status_check')).toEqual([...ORDER_STATUSES].sort())
  })
})

// src/reports/revenue-lines.js builds SQL from frozen declarations, so its TEXT
// is unit-tested in test/report-filters.test.js. What only Postgres can answer
// is whether the CTE runs and whether the population it describes is the one
// that comes back — which needs orders, lines and a catalogue behind them.
describe('W5-US-004 — the revenue scope against real orders', () => {
  let pool
  let fixture

  // Namespaced like every other suite here. Order numbers carry their own prefix
  // because orders are cleaned up BEFORE the brands they hang off:
  // order_lines.colourway_id is the schema's one RESTRICT edge, so a brand
  // cascade cannot get past it and the cleanup itself would raise 23503.
  const ORDER_PREFIX = 'W5-REPORTING-TEST'

  const cleanReports = async (db) => {
    await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${ORDER_PREFIX}-%`])
    await db.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  }

  // Two houses, one collection, one design each, and six orders spanning every
  // status the population has an opinion about.
  const insertFixture = async (db) => {
    const brand = async (slug, name) => {
      const { rows } = await db.query(
        `INSERT INTO brands (name, slug, currency, is_international, trade_only)
         VALUES ($1, $2, 'NZD', false, false) RETURNING id`,
        [name, slug]
      )
      return rows[0].id
    }
    const product = async (brandId, slug, name, collectionId = null) => {
      const { rows } = await db.query(
        `INSERT INTO products (brand_id, collection_id, name, slug, product_type, currency, show_on_website)
         VALUES ($1, $2, $3, $4, 'fabric', 'NZD', true) RETURNING id`,
        [brandId, collectionId, name, slug]
      )
      return rows[0].id
    }
    const colourway = async (productId, sku) => {
      const { rows } = await db.query(
        `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ivory', $2) RETURNING id`,
        [productId, sku]
      )
      return rows[0].id
    }
    const order = async (suffix, kind, status, createdAt, { archived = false } = {}) => {
      const { rows } = await db.query(
        `INSERT INTO orders (order_number, kind, status, guest_email, created_at, archived_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
         RETURNING id`,
        [
          `${ORDER_PREFIX}-${suffix}`,
          kind,
          status,
          `${PREFIX}@example.test`,
          createdAt,
          archived ? new Date() : null,
        ]
      )
      return rows[0].id
    }
    const line = (orderId, colourwayId, qty, unitPriceCents) =>
      db.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [orderId, colourwayId, qty, unitPriceCents]
      )

    const houseId = await brand(`${PREFIX}-house`, `${PREFIX} House`)
    const otherId = await brand(`${PREFIX}-other`, `${PREFIX} Other`)
    const { rows: collectionRows } = await db.query(
      `INSERT INTO collections (brand_id, name, slug) VALUES ($1, 'Season', $2) RETURNING id`,
      [houseId, `${PREFIX}-season`]
    )
    const collectionId = collectionRows[0].id

    const designId = await product(houseId, `${PREFIX}-design`, `${PREFIX} Design`, collectionId)
    const looseId = await product(houseId, `${PREFIX}-loose`, `${PREFIX} Loose`)
    const otherDesignId = await product(otherId, `${PREFIX}-other-design`, `${PREFIX} Other Design`)

    const design = await colourway(designId, `${PREFIX}-SKU-1`)
    const loose = await colourway(looseId, `${PREFIX}-SKU-2`)
    const otherColourway = await colourway(otherDesignId, `${PREFIX}-SKU-3`)

    // A card checkout: paid, priced, in the default population.
    const paid = await order('CHK', 'checkout', 'paid', '2026-03-15 12:00:00')
    await line(paid, design, '2.00', 10000)

    // A fabric request the office cut and shipped. Request-kind lines are created
    // at unit_price_cents = 0 and nothing ever fills them in.
    const shipped = await order('SHP', 'order_request', 'shipped', '2026-03-16 23:30:00')
    await line(shipped, loose, '3.00', 0)

    // Neither of these is a sale under the default population.
    const requested = await order('REQ', 'order_request', 'requested', '2026-03-17 12:00:00')
    await line(requested, design, '5.00', 0)
    const declined = await order('DEC', 'order_request', 'declined', '2026-03-17 12:00:00')
    await line(declined, design, '9.00', 0)

    // Paid, but the back office took it out of its own lists.
    const archived = await order('ARC', 'checkout', 'paid', '2026-03-15 12:00:00', {
      archived: true,
    })
    await line(archived, design, '7.00', 10000)

    // Another house, so the brand filter has something to exclude.
    const otherPaid = await order('OTH', 'checkout', 'paid', '2026-03-15 12:00:00')
    await line(otherPaid, otherColourway, '4.00', 25000)

    return Object.freeze({ houseId, otherId, collectionId, design, loose })
  }

  // Every assertion scopes itself to the fixture houses: this database carries
  // the seeded catalogue and whatever the other suites left behind, and an
  // unscoped population would count all of it.
  const HOUSES = Object.freeze([`${PREFIX}-house`, `${PREFIX}-other`])
  const scoped = (query = {}) => parseReportFilters({ brand: HOUSES, ...query })
  const numbersOf = (lines) => lines.map((line) => line.order_number).sort()

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanReports(pool)
    fixture = await insertFixture(pool)
  })

  afterAll(async () => {
    await cleanReports(pool)
    await pool.end()
  })

  describe('the default population', () => {
    it('is paid and shipped orders of every kind', async () => {
      const lines = await listRevenueLines(pool, scoped())

      expect(numbersOf(lines)).toEqual([
        `${ORDER_PREFIX}-CHK`,
        `${ORDER_PREFIX}-OTH`,
        `${ORDER_PREFIX}-SHP`,
      ])
    })

    // Archiving an order takes it out of the back office's own lists; it must
    // not keep contributing to revenue.
    it('excludes an archived order even though it is paid', async () => {
      const lines = await listRevenueLines(pool, scoped())

      expect(numbersOf(lines)).not.toContain(`${ORDER_PREFIX}-ARC`)
    })

    // Overridable, and by replacement: intersecting with the default would
    // answer status=requested with zero rows, which reads as "no trade".
    it('is replaced, not narrowed, by a status filter', async () => {
      const lines = await listRevenueLines(pool, scoped({ status: 'requested' }))

      expect(numbersOf(lines)).toEqual([`${ORDER_PREFIX}-REQ`])
    })

    it('still excludes the archived order under an explicit status filter', async () => {
      const lines = await listRevenueLines(pool, scoped({ status: 'paid' }))

      expect(numbersOf(lines)).toEqual([`${ORDER_PREFIX}-CHK`, `${ORDER_PREFIX}-OTH`])
    })
  })

  describe('a line in the scope', () => {
    it('carries its order, its design and its house', async () => {
      const lines = await listRevenueLines(pool, scoped({ brand: `${PREFIX}-house` }))
      const line = lines.find((row) => row.order_number === `${ORDER_PREFIX}-CHK`)

      expect(line).toMatchObject({
        source: 'live',
        kind: 'checkout',
        status: 'paid',
        sku: `${PREFIX}-SKU-1`,
        product_slug: `${PREFIX}-design`,
        product_type: 'fabric',
        brand_id: fixture.houseId,
        brand_slug: `${PREFIX}-house`,
        collection_slug: `${PREFIX}-season`,
        qty: 2,
        unit_price_cents: 10000,
        line_value_cents: 20000,
        unpriced: false,
      })
    })

    // The criterion this story exists for: a request line is IN the population
    // and contributes metreage at nothing. Dropped, it would understate what was
    // cut; counted as money, it would understate the average price.
    it('contributes a request-kind line’s quantity at zero value, flagged unpriced', async () => {
      const lines = await listRevenueLines(pool, scoped())
      const line = lines.find((row) => row.order_number === `${ORDER_PREFIX}-SHP`)

      expect(line).toMatchObject({
        kind: 'order_request',
        qty: 3,
        unit_price_cents: 0,
        line_value_cents: 0,
        unpriced: true,
      })
    })

    it('reads a product with no collection as uncollected rather than dropping it', async () => {
      const lines = await listRevenueLines(pool, scoped())
      const line = lines.find((row) => row.order_number === `${ORDER_PREFIX}-SHP`)

      expect(line.collection_slug).toBeNull()
    })
  })

  describe('the filters, applied to the population', () => {
    it('narrows to one house', async () => {
      const lines = await listRevenueLines(pool, scoped({ brand: `${PREFIX}-other` }))

      expect(numbersOf(lines)).toEqual([`${ORDER_PREFIX}-OTH`])
    })

    it('narrows to a collection, which excludes the uncollected designs', async () => {
      const lines = await listRevenueLines(pool, scoped({ collection: `${PREFIX}-season` }))

      expect(numbersOf(lines)).toEqual([`${ORDER_PREFIX}-CHK`])
    })

    it('narrows by kind', async () => {
      const lines = await listRevenueLines(pool, scoped({ kind: 'order_request' }))

      expect(numbersOf(lines)).toEqual([`${ORDER_PREFIX}-SHP`])
    })

    // `to` is exclusive on the NEXT day, so an order placed at 23:30 on the last
    // day of the range is in it. `<= to::date` would drop the whole day.
    it('includes the last day of the range, not the morning of it', async () => {
      const lines = await listRevenueLines(
        pool,
        scoped({ from: '2026-03-15', to: '2026-03-16' })
      )

      expect(numbersOf(lines)).toEqual([
        `${ORDER_PREFIX}-CHK`,
        `${ORDER_PREFIX}-OTH`,
        `${ORDER_PREFIX}-SHP`,
      ])
    })

    it('excludes what falls outside the range', async () => {
      const lines = await listRevenueLines(pool, scoped({ from: '2026-03-16', to: '2026-03-16' }))

      expect(numbersOf(lines)).toEqual([`${ORDER_PREFIX}-SHP`])
    })
  })

  describe('the population summarised', () => {
    it('totals the quantity, the value and the lines carrying no price', async () => {
      const summary = await summariseRevenue(pool, scoped())

      expect(summary).toEqual({
        lines: 3,
        qty: 9, // 2 + 3 + 4
        value_cents: 120000, // 20000 + 0 + 100000
        unpriced_lines: 1,
      })
    })

    it('answers an empty population with zeroes rather than nulls', async () => {
      const summary = await summariseRevenue(pool, scoped({ from: '2027-01-01' }))

      expect(summary).toEqual({ lines: 0, qty: 0, value_cents: 0, unpriced_lines: 0 })
    })
  })
})
