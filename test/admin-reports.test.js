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
import { loadReportAccess } from '../src/reports/access.js'
import {
  productPerformanceReport,
  PRODUCT_PERFORMANCE_COLUMNS,
  PRODUCT_PERFORMANCE_TITLE,
  COVERAGE_NOTE,
} from '../src/reports/product-performance.js'
import { MAX_ROW_LIMIT } from '../src/reports/limits.js'
import { STOCK_COLUMNS, STOCK_TITLE } from '../src/reports/stock.js'
import {
  NOT_INVOICED_COLUMNS,
  NOT_INVOICED_TITLE,
  INVOICEABLE_KINDS,
} from '../src/reports/not-invoiced.js'
import { buildApp } from '../src/app.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite
// here. Most are plain INSERTs rather than /auth/register calls: register is
// rate-limited 10 per 15 min per IP, so the one suite below that needs a session
// registers its two logins once and keeps them.
const PREFIX = 'w5-reporting-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'

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

// The order fixture the revenue scope and every report built on it are measured
// against. Module-scoped because W5-US-004 and W5-US-005 both need exactly this
// population — a second copy is how the two would start disagreeing about what
// the numbers below mean.
//
// Order numbers carry their own prefix because orders are cleaned up BEFORE the
// brands they hang off: order_lines.colourway_id is the schema's one RESTRICT
// edge, so a brand cascade cannot get past it and the cleanup itself would raise
// 23503.
const ORDER_PREFIX = 'W5-REPORTING-TEST'

const cleanReports = async (db) => {
  await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${ORDER_PREFIX}-%`])
  await db.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

// Two houses, one collection, three designs, and six orders spanning every
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

// Every assertion scopes itself to the fixture houses: this database carries the
// seeded catalogue and whatever the other suites left behind, and an unscoped
// population would count all of it.
const HOUSES = Object.freeze([`${PREFIX}-house`, `${PREFIX}-other`])
const scoped = (query = {}) => parseReportFilters({ brand: HOUSES, ...query })

// src/reports/revenue-lines.js builds SQL from frozen declarations, so its TEXT
// is unit-tested in test/report-filters.test.js. What only Postgres can answer
// is whether the CTE runs and whether the population it describes is the one
// that comes back — which needs orders, lines and a catalogue behind them.
describe('W5-US-004 — the revenue scope against real orders', () => {
  let pool
  let fixture

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

// The first report served over HTTP. What the pure suite cannot answer is
// whether the grouping is the one the office asked for, whether the totals cover
// the population rather than the page, and whether the route refuses the callers
// it must — all of which need real orders and a real session behind them.
describe('W5-US-005 — product performance by house and design', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const PATH = '/admin/reports/product-performance'
  // Every request scopes itself to the fixture houses, for the same reason the
  // scope suite above does: this database also carries the seeded catalogue.
  const SCOPE_QUERY = HOUSES.map((slug) => `brand=${slug}`).join('&')

  const get = (query = '', cookie = backofficeCookie) =>
    app.inject({
      method: 'GET',
      url: `${PATH}?${SCOPE_QUERY}${query}`,
      headers: cookie ? { cookie } : {},
    })

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }

  const designRow = (rows, design) => rows.find((row) => row.product_name === design)

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanReports(pool)
    await cleanup(pool)

    // Registered once. The limiter store is per app instance, so this fresh
    // buildApp has a fresh bucket — but a per-test registration would still
    // exhaust it and yield a 429 with no cookie.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-boss@example.test`, password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-boss@example.test`,
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-shopper@example.test`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)

    await insertFixture(pool)
  })

  afterAll(async () => {
    await cleanReports(pool)
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  describe('access', () => {
    it('refuses an anonymous caller with 401', async () => {
      expect((await get('', null)).statusCode).toBe(401)
    })

    it('refuses a customer with 403', async () => {
      expect((await get('', customerCookie)).statusCode).toBe(403)
    })

    it('serves a back-office caller', async () => {
      expect((await get()).statusCode).toBe(200)
    })

    // A report is an unbounded aggregate over the order ledger, which is why it
    // opts into the limiter the other admin routes leave off. The header is what
    // @fastify/rate-limit puts on a metered route and nothing else does.
    it('is rate-limited, unlike the other back-office routes', async () => {
      const report = await get()
      const brands = await app.inject({
        method: 'GET',
        url: '/admin/brands',
        headers: { cookie: backofficeCookie },
      })

      expect(report.headers['x-ratelimit-limit']).toBeDefined()
      expect(brands.headers['x-ratelimit-limit']).toBeUndefined()
    })
  })

  describe('the table', () => {
    it('groups by house and design, summing quantity and qty x unit_price_cents', async () => {
      const { rows } = (await get()).json()

      expect(rows).toEqual([
        {
          brand_name: `${PREFIX} Other`,
          product_name: `${PREFIX} Other Design`,
          product_type: 'fabric',
          currency: 'NZD',
          orders: 1,
          qty: 4,
          value_cents: 100000,
          unpriced_lines: 0,
        },
        {
          brand_name: `${PREFIX} House`,
          product_name: `${PREFIX} Design`,
          product_type: 'fabric',
          currency: 'NZD',
          orders: 1,
          qty: 2,
          value_cents: 20000,
          unpriced_lines: 0,
        },
        {
          brand_name: `${PREFIX} House`,
          product_name: `${PREFIX} Loose`,
          product_type: 'fabric',
          currency: 'NZD',
          orders: 1,
          qty: 3,
          value_cents: 0,
          unpriced_lines: 1,
        },
      ])
    })

    // The report is about which designs sell, so the ranking IS the report.
    it('ranks by sales value, best first', async () => {
      const { rows } = (await get()).json()

      expect(rows.map((row) => row.value_cents)).toEqual([100000, 20000, 0])
    })

    // A request-kind line is in the population at zero value: dropped it would
    // understate the metreage cut, counted as money it would understate the
    // average price. The count is what lets a reader tell the two apart.
    it('shows a request-kind design at nil value, flagged by its unpriced count', async () => {
      const { rows } = (await get()).json()

      expect(designRow(rows, `${PREFIX} Loose`)).toMatchObject({
        qty: 3,
        value_cents: 0,
        unpriced_lines: 1,
      })
    })

    it('excludes the archived order the scope already refuses', async () => {
      const { rows } = (await get()).json()

      // 2 m paid plus 7 m archived would read as 9 m and NZ$900 if it leaked.
      expect(designRow(rows, `${PREFIX} Design`)).toMatchObject({ qty: 2, value_cents: 20000 })
    })
  })

  describe('the totals row', () => {
    it('totals the orders and the money across the whole population', async () => {
      const { totals } = (await get()).json()

      expect(totals).toMatchObject({
        brand_name: 'All houses',
        product_name: 'All designs',
        currency: 'NZD',
        orders: 3,
        value_cents: 120000,
        unpriced_lines: 1,
      })
    })

    // A fabric is metres and a finished good is units, so one number adding the
    // two is a figure with no unit.
    it('carries no quantity, because metres and units do not add', async () => {
      const { totals } = (await get()).json()

      expect(Object.hasOwn(totals, 'qty')).toBe(false)
    })

    // The failure this guards is silent: a total that only added the visible
    // page agrees with the rows on screen and is wrong.
    it('covers the population rather than the page when the table is cut short', async () => {
      const body = (await get('&limit=1')).json()

      expect(body.rows).toHaveLength(1)
      expect(body.meta.truncated).toBe(true)
      expect(body.meta.rows_total).toBe(3)
      expect(body.totals).toMatchObject({ orders: 3, value_cents: 120000 })
    })

    it('reports a full table as not truncated', async () => {
      const { meta } = (await get()).json()

      expect(meta).toMatchObject({ truncated: false, rows_total: 3, houses: 2, designs: 3 })
    })
  })

  // The envelope the CRM's buildReport cell pipeline consumes: labelled columns,
  // rows keyed by column key in column order, and a totals row of the same shape.
  describe('the envelope', () => {
    it('names itself and carries its declared columns', async () => {
      const body = (await get()).json()

      expect(body.report).toBe('product-performance')
      expect(body.title).toBe(PRODUCT_PERFORMANCE_TITLE)
      expect(body.columns).toEqual([...PRODUCT_PERFORMANCE_COLUMNS])
    })

    it('keys every row by column key, in column order', async () => {
      const body = (await get()).json()
      const keys = body.columns.map((column) => column.key)

      for (const row of body.rows) {
        expect(Object.keys(row)).toEqual(keys)
      }
    })

    // A sell value is money and is not a cost — the distinction access.js draws,
    // and the one the CRM's own policy already applies to its sell "Value"
    // columns. So this report loses nothing to a staff login without finance
    // visibility, and masking still runs over it.
    it('masks nothing for a staff login with no finance grant', async () => {
      const body = (await get()).json()

      expect(body.meta.masked_columns).toEqual([])
      expect(body.columns.map((column) => column.label)).toContain('Sales')
    })
  })

  describe('the coverage the payload states', () => {
    it('reports the window the figures actually came from', async () => {
      const { rows } = await pool.query(
        `SELECT MIN(created_at) AS first, MAX(created_at) AS last
           FROM orders
          WHERE order_number IN ($1, $2, $3)`,
        [`${ORDER_PREFIX}-CHK`, `${ORDER_PREFIX}-SHP`, `${ORDER_PREFIX}-OTH`]
      )
      const { meta } = (await get()).json()

      expect(meta.coverage.from).toBe(rows[0].first.toISOString())
      expect(meta.coverage.to).toBe(rows[0].last.toISOString())
      expect(meta.coverage.source).toBe('live platform orders')
    })

    it('echoes the range that was asked for, distinct from the one it found', async () => {
      const { meta } = (await get('&from=2026-03-01&to=2026-03-31')).json()

      expect(meta.coverage.requested_from).toBe('2026-03-01')
      expect(meta.coverage.requested_to).toBe('2026-03-31')
      expect(meta.coverage.from.startsWith('2026-03')).toBe(true)
    })

    // The criterion this story exists for: nothing in here is historic, because
    // no D365 export carries a line item at all.
    it('says the historic Dynamics sales are header-only and excluded', async () => {
      const { meta } = (await get()).json()

      expect(meta.coverage.historic_sales).toBe('header-only, not included')
      expect(meta.coverage.note).toBe(COVERAGE_NOTE)
      expect(COVERAGE_NOTE).toMatch(/header-only/)
    })
  })

  describe('the filters', () => {
    it('narrows to one house', async () => {
      const body = (
        await app.inject({
          method: 'GET',
          url: `${PATH}?brand=${PREFIX}-other`,
          headers: { cookie: backofficeCookie },
        })
      ).json()

      expect(body.rows.map((row) => row.product_name)).toEqual([`${PREFIX} Other Design`])
    })

    it('replaces the default population with a status filter', async () => {
      const { rows } = (await get('&status=requested')).json()

      expect(rows.map((row) => row.qty)).toEqual([5])
    })

    // filters.js throws a 400 naming the filter, which Fastify serialises — the
    // route needs no try/catch.
    it('answers an unusable filter value with a 400 naming the filter', async () => {
      const response = await get('&from=not-a-date')

      expect(response.statusCode).toBe(400)
      expect(response.json().message).toMatch(/"from"/)
    })

    it('ignores a filter name it does not know', async () => {
      const response = await get('&salesperson=rebecca')

      expect(response.statusCode).toBe(200)
      expect(response.json().rows).toHaveLength(3)
    })

    // A silent clamp would report a page size nobody asked for.
    it('refuses a limit past the maximum rather than clamping it', async () => {
      expect((await get(`&limit=${MAX_ROW_LIMIT + 1}`)).statusCode).toBe(400)
    })
  })

  // The module behind the route. These three go through the pool because no
  // querystring can reach them: an export asks for every row (US-006), and a
  // second currency cannot be bought through checkout today.
  describe('the report module', () => {
    it('takes limit: null for every row, which is what the export will pass', async () => {
      const report = await productPerformanceReport(pool, scoped(), { limit: null })

      expect(report.rows).toHaveLength(3)
      expect(report.meta.row_limit).toBeNull()
      expect(report.meta.truncated).toBe(false)
    })

    it('answers an empty population with no rows and no coverage window', async () => {
      const report = await productPerformanceReport(pool, scoped({ from: '2027-01-01' }))

      expect(report.rows).toEqual([])
      expect(report.meta.coverage.from).toBeNull()
      expect(report.meta.coverage.to).toBeNull()
      expect(report.totals).toMatchObject({ orders: 0, value_cents: 0 })
      expect(report.meta.currencies).toEqual([])
    })

    // `orders` carries no currency and unit_price_cents is in the product's own,
    // so a total across two of them is a made-up number — the same reason
    // checkout refuses a mixed-currency cart.
    it('omits the total value when the population quotes more than one currency', async () => {
      const { rows: productRows } = await pool.query(
        `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
         SELECT id, $1, $2, 'fabric', 'EUR', true FROM brands WHERE slug = $3
         RETURNING id`,
        [`${PREFIX} Euro Design`, `${PREFIX}-euro-design`, `${PREFIX}-other`]
      )
      const { rows: colourwayRows } = await pool.query(
        `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ivory', $2) RETURNING id`,
        [productRows[0].id, `${PREFIX}-SKU-EUR`]
      )
      const { rows: orderRows } = await pool.query(
        `INSERT INTO orders (order_number, kind, status, created_at)
         VALUES ($1, 'checkout', 'paid', '2026-03-15 12:00:00'::timestamptz) RETURNING id`,
        [`${ORDER_PREFIX}-EUR`]
      )
      await pool.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
         VALUES ($1, $2, '1.00', 50000)`,
        [orderRows[0].id, colourwayRows[0].id]
      )

      try {
        const report = await productPerformanceReport(pool, scoped())

        expect(report.meta.currencies).toEqual(['EUR', 'NZD'])
        expect(report.meta.mixed_currency).toBe(true)
        expect(Object.hasOwn(report.totals, 'value_cents')).toBe(false)
        // The rows keep theirs: one row is one currency, so its value is real.
        expect(designRow(report.rows, `${PREFIX} Euro Design`)).toMatchObject({
          currency: 'EUR',
          value_cents: 50000,
        })
      } finally {
        // Orders first: order_lines.colourway_id is the one RESTRICT edge.
        await pool.query(`DELETE FROM orders WHERE order_number = $1`, [`${ORDER_PREFIX}-EUR`])
        await pool.query(`DELETE FROM products WHERE slug = $1`, [`${PREFIX}-euro-design`])
      }
    })
  })
})

// The export over HTTP. src/reports/export.js is pure and its file format is
// proved in test/report-filters.test.js; what only Postgres and a real route can
// answer is whether the file carries the same population the table does — and
// more of it than a limited page — and whether a design name a staff member
// typed as a formula reaches the file neutralised.
//
// Requests here are counted deliberately: the export's own bucket is tighter
// than the table's, so the block fetches ONE file in beforeAll and asserts
// against it, the same posture the rate-limit header test takes.
describe('W5-US-006 — server-side CSV export', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  let csv
  let table

  const PATH = '/admin/reports/product-performance'
  const EXPORT_PATH = `${PATH}/export.csv`
  const SCOPE_QUERY = HOUSES.map((slug) => `brand=${slug}`).join('&')

  // A design name a staff member could plausibly type, and the exact thing that
  // becomes live code when the client opens the file in Excel.
  const FORMULA_NAME = '=SUM(A1:A9)'

  const request = (path, query = '', cookie = backofficeCookie) =>
    app.inject({
      method: 'GET',
      url: `${path}?${SCOPE_QUERY}${query}`,
      headers: cookie ? { cookie } : {},
    })

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }

  // The file's shape, asserted structurally: line 1 is the header, the totals row
  // is the last line before the notes' blank separator, and everything between
  // the two is the report's own rows.
  const linesOf = (body) => body.split('\r\n')
  const dataRowsOf = (body) => linesOf(body).slice(1, linesOf(body).indexOf('') - 1)
  const totalsRowOf = (body) => linesOf(body)[linesOf(body).indexOf('') - 1]

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanReports(pool)
    await cleanup(pool)

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-export-boss@example.test`, password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-export-boss@example.test`,
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-export-shopper@example.test`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)

    const fixture = await insertFixture(pool)

    // A fourth sold design, whose name is a formula.
    const { rows: productRows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, $2, $3, 'fabric', 'NZD', true) RETURNING id`,
      [fixture.houseId, FORMULA_NAME, `${PREFIX}-formula`]
    )
    const { rows: colourwayRows } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ivory', $2) RETURNING id`,
      [productRows[0].id, `${PREFIX}-SKU-FML`]
    )
    const { rows: orderRows } = await pool.query(
      `INSERT INTO orders (order_number, kind, status, created_at)
       VALUES ($1, 'checkout', 'paid', '2026-03-18 12:00:00'::timestamptz) RETURNING id`,
      [`${ORDER_PREFIX}-FML`]
    )
    await pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, '1.00', 5000)`,
      [orderRows[0].id, colourwayRows[0].id]
    )

    csv = await request(EXPORT_PATH)
    table = await request(PATH)
  })

  afterAll(async () => {
    await cleanReports(pool)
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  describe('access', () => {
    it('refuses an anonymous caller with 401', async () => {
      expect((await request(EXPORT_PATH, '', null)).statusCode).toBe(401)
    })

    it('refuses a customer with 403', async () => {
      expect((await request(EXPORT_PATH, '', customerCookie)).statusCode).toBe(403)
    })

    it('serves a back-office caller', () => {
      expect(csv.statusCode).toBe(200)
    })

    // An export runs the same aggregate with no row limit and then serialises
    // the whole of it, so it is the more expensive of the two by exactly the
    // margin the limit was providing.
    it('meters itself more tightly than the table it exports', () => {
      expect(Number(csv.headers['x-ratelimit-limit'])).toBeLessThan(
        Number(table.headers['x-ratelimit-limit'])
      )
    })
  })

  describe('the download', () => {
    it('is served as a UTF-8 CSV attachment', () => {
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8')
      expect(csv.headers['content-disposition']).toBe(
        'attachment; filename="atelier-product-performance.csv"'
      )
    })

    // `.csv` is its own path segment rather than a suffix on a param — Fastify
    // would otherwise fold it into the preceding `:param` — so the table route
    // beside it is untouched and still answers JSON.
    it('sits beside the table route without shadowing it', () => {
      expect(table.statusCode).toBe(200)
      expect(table.headers['content-type']).toMatch(/application\/json/)
      expect(table.json().report).toBe('product-performance')
    })

    it('takes its header row from the report’s declared columns', () => {
      expect(linesOf(csv.body)[0]).toBe(
        PRODUCT_PERFORMANCE_COLUMNS.map((column) => column.label).join(',')
      )
    })

    it('appends the totals row the table carries', () => {
      expect(totalsRowOf(csv.body)).toMatch(/^All houses,All designs,/)
    })

    // This report declares no finance column, so masking runs and removes
    // nothing; US-007's stock report is the first whose landed cost is deleted.
    it('carries no withheld-columns note, because nothing here is finance', () => {
      expect(csv.body).not.toContain('Columns withheld')
    })
  })

  // The whole reason src/lib/csv.js was extracted in US-001. A design name is
  // staff-typed free text via PATCH /admin/products, and this file is built to
  // open in Excel, where =HYPERLINK and =WEBSERVICE exfiltrate the sheet.
  it('neutralises a design name beginning with =', () => {
    expect(csv.body).toContain(`'${FORMULA_NAME}`)
    expect(csv.body).not.toMatch(/^=SUM/m)
  })

  // The failure this story exists to prevent: a file that silently was the page
  // the table happened to be showing.
  it('exports every row even when the table is showing one', async () => {
    const page = await request(PATH, '&limit=1')
    const file = await request(EXPORT_PATH, '&limit=1')

    expect(page.json().rows).toHaveLength(1)
    expect(page.json().meta.rows_total).toBe(4)
    // `limit` is not part of the export's vocabulary at all: Ajv strips it, and
    // the handler asks the shared builder for every row regardless.
    expect(dataRowsOf(file.body)).toHaveLength(4)
  })

  // "I want the exported file to match what I filtered" — so the file carries
  // the narrowed population AND says which filters narrowed it.
  it('exports what was filtered, and states the filters in the file', async () => {
    const file = await request(EXPORT_PATH, '&from=2026-03-18')

    expect(dataRowsOf(file.body)).toHaveLength(1)
    expect(file.body).toContain(`'${FORMULA_NAME}`)
    expect(file.body).not.toContain(`${PREFIX} Other Design`)
    expect(file.body).toContain('from=2026-03-18')
  })

  // The CSV is the copy that leaves the building, so it states its coverage
  // rather than relying on a screen's footnote.
  it('states its coverage in the file, not only in the payload', () => {
    expect(csv.body).toContain(COVERAGE_NOTE)
  })
})

// W5-US-007 — the two reports the CRM's fixtures only pretend to show, against
// live rows. What each one DECLARES is unit-tested in test/report-filters.test.js;
// this is the half only Postgres can answer — that the stock query reads
// inventory and the invoice queue reads orders, and that both narrow and export
// through the shared layers.
//
// Both exports are fetched ONCE in beforeAll: the export bucket is 10/min, so a
// per-test download would spend it and surface as a 429 in an unrelated
// assertion.
describe('W5-US-007 — stock and not-invoiced', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  let stockCsv
  let queueCsv

  const STOCK_PATH = '/admin/reports/stock'
  const QUEUE_PATH = '/admin/reports/not-invoiced'
  const SCOPE_QUERY = HOUSES.map((slug) => `brand=${slug}`).join('&')

  const CLIENT_NAME = `${PREFIX} Client Co`
  const CLIENT_EMAIL = `${PREFIX}-invoice-client@example.test`
  const GOODS_SKU = `${PREFIX}-SKU-GD`
  const RETIRED_SKU = `${PREFIX}-SKU-RET`

  const request = (path, query = '', cookie = backofficeCookie) =>
    app.inject({
      method: 'GET',
      url: `${path}?${SCOPE_QUERY}${query}`,
      headers: cookie ? { cookie } : {},
    })

  const payloadOf = async (path, query = '') => JSON.parse((await request(path, query)).body)

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }

  const rowBySku = (report, sku) => report.rows.find((row) => row.sku === sku)
  const orderNumbersOf = (report) => report.rows.map((row) => row.order_number)

  // `created_at` is timestamptz and the fixture writes wall-clock times, so what
  // an instant reads as depends on the session's timezone. Comparing against the
  // row the database actually holds is the only assertion that survives a
  // machine set to something other than the one this was written on.
  const placedAtOf = (suffix) =>
    pool
      .query('SELECT created_at FROM orders WHERE order_number = $1', [
        `${ORDER_PREFIX}-${suffix}`,
      ])
      .then(({ rows }) => new Date(rows[0].created_at).toISOString())

  const colourwayIdBySku = (sku) =>
    pool
      .query('SELECT id FROM colourways WHERE sku = $1', [sku])
      .then(({ rows }) => rows[0].id)

  const stock = (colourwayId, available, reserved, unit) =>
    pool.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (colourway_id) DO UPDATE
          SET qty_available = EXCLUDED.qty_available,
              qty_reserved = EXCLUDED.qty_reserved,
              unit = EXCLUDED.unit`,
      [colourwayId, available, reserved, unit]
    )

  const orderWithLines = async (suffix, kind, status, createdAt, options, lines) => {
    const { rows } = await pool.query(
      `INSERT INTO orders (order_number, kind, status, guest_email, user_id, xero_invoice_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
       RETURNING id`,
      [
        `${ORDER_PREFIX}-${suffix}`,
        kind,
        status,
        options.userId ? null : `${PREFIX}@example.test`,
        options.userId ?? null,
        options.invoiceRef ?? null,
        createdAt,
      ]
    )
    for (const [colourwayId, qty] of lines) {
      await pool.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
         VALUES ($1, $2, $3, 0)`,
        [rows[0].id, colourwayId, qty]
      )
    }
  }

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanReports(pool)
    await cleanup(pool)

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-stock-boss@example.test`, password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-stock-boss@example.test`,
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-stock-shopper@example.test`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)

    const fixture = await insertFixture(pool)
    const otherColourway = await colourwayIdBySku(`${PREFIX}-SKU-3`)

    // A finished good, so the population holds two units and the totals row has
    // to decline to add them.
    const { rows: goodsRows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, $2, $3, 'finished_good', 'NZD', true) RETURNING id`,
      [fixture.houseId, `${PREFIX} Cushion`, `${PREFIX}-cushion`]
    )
    const { rows: goodsColourway } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ivory', $2) RETURNING id`,
      [goodsRows[0].id, GOODS_SKU]
    )

    // An archived design with stock still on the shelf: archiving is a catalogue
    // decision, not a stock movement.
    const { rows: retiredRows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website, archived_at)
       VALUES ($1, $2, $3, 'fabric', 'NZD', false, now()) RETURNING id`,
      [fixture.houseId, `${PREFIX} Retired`, `${PREFIX}-retired`]
    )
    const { rows: retiredColourway } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ash', $2) RETURNING id`,
      [retiredRows[0].id, RETIRED_SKU]
    )

    await stock(fixture.design, '12.50', '2.50', 'metres')
    // Nothing on hand and nothing allocated: an inventory row, but not a holding.
    await stock(fixture.loose, '0.00', '0.00', 'metres')
    // Allocated past what is on hand — a backorder reserves stock that has not
    // arrived, so available is legitimately negative.
    await stock(otherColourway, '6.00', '8.00', 'metres')
    await stock(goodsColourway[0].id, '4.00', '0.00', 'units')
    await stock(retiredColourway[0].id, '9.00', '0.00', 'metres')

    const { rows: clientRows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, 'not-a-real-hash', $2, 'trade') RETURNING id`,
      [CLIENT_EMAIL, CLIENT_NAME]
    )

    // Confirmed AND invoiced: the one order the queue must not show.
    await orderWithLines(
      'INVD',
      'order_request',
      'confirmed',
      '2026-03-10 09:00:00',
      { invoiceRef: 'XERO-4471' },
      [[fixture.design, '1.00']]
    )
    // Confirmed, no reference — the queue's oldest entry.
    await orderWithLines('BAK', 'backorder_request', 'confirmed', '2026-03-12 09:00:00', {}, [
      [fixture.design, '2.00'],
    ])
    // Placed by an account rather than a guest, and spanning both units.
    await orderWithLines(
      'ACC',
      'order_request',
      'requested',
      '2026-03-14 09:00:00',
      { userId: clientRows[0].id },
      [
        [fixture.design, '1.00'],
        [goodsColourway[0].id, '1.00'],
      ]
    )

    // A date filter the stock report cannot honour, so the file has to say so.
    stockCsv = await request(`${STOCK_PATH}/export.csv`, '&from=2026-01-01')
    queueCsv = await request(`${QUEUE_PATH}/export.csv`)
  })

  afterAll(async () => {
    await cleanReports(pool)
    await cleanup(pool)
    await pool.query(`DELETE FROM users WHERE email = $1`, [CLIENT_EMAIL])
    await app.close()
    await pool.end()
  })

  describe('access', () => {
    it('refuses an anonymous caller with 401 on both reports', async () => {
      expect((await request(STOCK_PATH, '', null)).statusCode).toBe(401)
      expect((await request(QUEUE_PATH, '', null)).statusCode).toBe(401)
    })

    it('refuses a customer with 403 on both reports', async () => {
      expect((await request(STOCK_PATH, '', customerCookie)).statusCode).toBe(403)
      expect((await request(QUEUE_PATH, '', customerCookie)).statusCode).toBe(403)
    })

    // Both are unbounded aggregates, so both opt into the limiter like the
    // report routes beside them.
    it('meters both, and meters their exports more tightly', async () => {
      const table = await request(STOCK_PATH)

      expect(table.headers['x-ratelimit-limit']).toBeDefined()
      expect(Number(stockCsv.headers['x-ratelimit-limit'])).toBeLessThan(
        Number(table.headers['x-ratelimit-limit'])
      )
    })
  })

  describe('the stock report', () => {
    it('reads live inventory, one row per held colourway', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(report.report).toBe('stock')
      expect(report.title).toBe(STOCK_TITLE)
      expect(report.columns).toEqual(STOCK_COLUMNS.map((column) => ({ ...column })))
      expect(rowBySku(report, `${PREFIX}-SKU-1`)).toEqual({
        sku: `${PREFIX}-SKU-1`,
        brand_name: `${PREFIX} House`,
        product_name: `${PREFIX} Design`,
        colourway_name: 'Ivory',
        unit: 'metres',
        on_hand: 12.5,
        allocated: 2.5,
        available: 10,
      })
    })

    // Atelier runs an indent model, so most colourways carry a row at zero and
    // listing them would bury the handful of real holdings.
    it('leaves out a colourway with nothing on hand and nothing allocated', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(rowBySku(report, `${PREFIX}-SKU-2`)).toBeUndefined()
      expect(report.meta.rows_total).toBe(4)
    })

    // Archiving is a catalogue decision, not a stock movement.
    it('still reports the stock of an archived design', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(rowBySku(report, RETIRED_SKU)).toMatchObject({ on_hand: 9, available: 9 })
    })

    // A backorder request reserves stock that has not arrived. Clamping this at
    // zero would hide exactly what the report exists to surface.
    it('reports an over-allocated colourway as negative and counts it', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(rowBySku(report, `${PREFIX}-SKU-3`)).toMatchObject({
        on_hand: 6,
        allocated: 8,
        available: -2,
      })
      expect(report.meta.over_allocated).toBe(1)
    })

    // Metres and units do not add, the same rule product performance applies to
    // a mixed-currency value.
    it('omits the quantities from the totals row while the population is mixed', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(report.meta.mixed_units).toBe(true)
      expect([...report.meta.units].sort()).toEqual(['metres', 'units'])
      expect(report.totals).toEqual({ sku: 'All holdings', brand_name: 'All houses' })
    })

    it('adds them once a filter leaves one unit in the population', async () => {
      const report = await payloadOf(STOCK_PATH, '&product_type=fabric')

      expect(report.meta.mixed_units).toBe(false)
      expect(report.totals).toMatchObject({
        unit: 'metres',
        on_hand: 27.5,
        allocated: 10.5,
        available: 17,
      })
    })

    it('narrows to one house through the shared filter layer', async () => {
      const report = await payloadOf(STOCK_PATH, '')
      const narrowed = JSON.parse(
        (
          await app.inject({
            method: 'GET',
            url: `${STOCK_PATH}?brand=${PREFIX}-other`,
            headers: { cookie: backofficeCookie },
          })
        ).body
      )

      expect(report.rows.length).toBe(4)
      expect(narrowed.rows.map((row) => row.sku)).toEqual([`${PREFIX}-SKU-3`])
    })

    // The report is a snapshot and has no `orders` in its FROM, so a date range
    // or a lifecycle filter is a question it cannot answer. Ignoring it must
    // never be silent: `meta.filters` feeds the CSV's own notes.
    it('names the filters it could not honour and keeps them out of meta.filters', async () => {
      const report = await payloadOf(STOCK_PATH, '&from=2026-01-01&status=paid')

      expect(report.meta.ignored_filters).toEqual(['from', 'status'])
      expect(Object.keys(report.meta.filters)).toEqual(['brand'])
    })

    it('states that it is a snapshot carrying no valuation', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(report.meta.coverage.source).toBe('live inventory')
      expect(report.meta.coverage.valuation).toMatch(/no landed cost source/)
      expect(new Date(report.meta.coverage.as_at).toISOString()).toBe(report.meta.coverage.as_at)
    })

    // Totals cover the population, never the page that survived the limit.
    it('admits a truncated table while still totalling everything', async () => {
      const report = await payloadOf(STOCK_PATH, '&limit=1&product_type=fabric')

      expect(report.rows).toHaveLength(1)
      expect(report.meta.truncated).toBe(true)
      expect(report.meta.rows_total).toBe(3)
      expect(report.totals.on_hand).toBe(27.5)
    })

    // Masking runs over every report here, and this one declares no finance
    // column — so it removes nothing and says so.
    it('is served whole to a back-office login with no finance grant', async () => {
      const report = await payloadOf(STOCK_PATH)

      expect(report.meta.masked_columns).toEqual([])
      expect(report.columns).toHaveLength(STOCK_COLUMNS.length)
    })
  })

  describe('the not-invoiced report', () => {
    it('reads live orders that carry no Xero reference, oldest first', async () => {
      const report = await payloadOf(QUEUE_PATH)

      expect(report.report).toBe('not-invoiced')
      expect(report.title).toBe(NOT_INVOICED_TITLE)
      expect(report.columns).toEqual(NOT_INVOICED_COLUMNS.map((column) => ({ ...column })))
      expect(orderNumbersOf(report)).toEqual([
        `${ORDER_PREFIX}-BAK`,
        `${ORDER_PREFIX}-ACC`,
        `${ORDER_PREFIX}-ACC`,
        `${ORDER_PREFIX}-SHP`,
        `${ORDER_PREFIX}-REQ`,
      ])
    })

    it('leaves out an order that has already been invoiced', async () => {
      const report = await payloadOf(QUEUE_PATH)

      expect(orderNumbersOf(report)).not.toContain(`${ORDER_PREFIX}-INVD`)
    })

    // A card checkout is paid at Stripe and is never invoiced through this
    // platform; a declined order is awaiting nothing; an archived one is out of
    // the office's own lists.
    it('leaves out card checkouts, declined orders and archived ones', async () => {
      const numbers = orderNumbersOf(await payloadOf(QUEUE_PATH))

      for (const suffix of ['CHK', 'OTH', 'ARC', 'DEC']) {
        expect(numbers).not.toContain(`${ORDER_PREFIX}-${suffix}`)
      }
    })

    // The kinds are the report's DEFINITION, not an overridable default, so
    // asking for checkouts intersects to nothing rather than opening it up — and
    // the payload still states which kinds it is of.
    it('answers a kind=checkout filter with no rows, still stating its population', async () => {
      const report = await payloadOf(QUEUE_PATH, '&kind=checkout')

      expect(report.rows).toEqual([])
      // Against the constant rather than a retyped list: the set grows as the
      // platform gains kinds (a staff-keyed 'manual' order is invoiced exactly
      // like a request), and the assertion that matters is that 'checkout' is
      // never in it. The schema-vs-boundary-copy drift is caught separately, by
      // the pg_get_constraintdef test.
      expect([...report.meta.kinds]).toEqual([...INVOICEABLE_KINDS])
      expect(report.meta.kinds).not.toContain('checkout')
    })

    // The lifecycle window is a default, and a status filter replaces it.
    it('narrows to one stage through the shared filter layer', async () => {
      const report = await payloadOf(QUEUE_PATH, '&status=confirmed')

      expect(orderNumbersOf(report)).toEqual([`${ORDER_PREFIX}-BAK`])
      expect([...report.meta.statuses]).toEqual(['confirmed'])
    })

    it('names the account that placed the order, and the guest email otherwise', async () => {
      const report = await payloadOf(QUEUE_PATH)
      const account = report.rows.find((row) => row.order_number === `${ORDER_PREFIX}-ACC`)
      const guest = report.rows.find((row) => row.order_number === `${ORDER_PREFIX}-SHP`)

      expect(account.client).toBe(CLIENT_NAME)
      expect(guest.client).toBe(`${PREFIX}@example.test`)
    })

    it('carries the line, its quantity and the colourway’s current holding', async () => {
      const report = await payloadOf(QUEUE_PATH)
      const line = report.rows.find((row) => row.order_number === `${ORDER_PREFIX}-BAK`)

      expect(line).toMatchObject({
        status: 'confirmed',
        kind: 'backorder_request',
        brand_name: `${PREFIX} House`,
        product_name: `${PREFIX} Design`,
        sku: `${PREFIX}-SKU-1`,
        product_type: 'fabric',
        qty: 2,
        on_hand: 12.5,
      })
      expect(new Date(line.placed_at).toISOString()).toBe(await placedAtOf('BAK'))
    })

    // Every line in this population carries no price, which is why the report
    // has no money column at all rather than a column of zeros.
    it('counts the lines that carry no price, and states no value anywhere', async () => {
      const report = await payloadOf(QUEUE_PATH)

      expect(report.meta.lines).toBe(5)
      expect(report.meta.unpriced_lines).toBe(5)
      expect(report.meta.orders).toBe(4)
      expect(JSON.stringify(report)).not.toContain('value_cents')
    })

    // on_hand is one colourway's snapshot repeated on every line that mentions
    // it, so a column of them does not sum to anything.
    it('totals the quantity only while the population is one unit, and never the holding', async () => {
      const mixed = await payloadOf(QUEUE_PATH)
      const fabric = await payloadOf(QUEUE_PATH, '&product_type=fabric')

      expect(mixed.meta.mixed_units).toBe(true)
      expect(mixed.totals).toEqual({ order_number: 'All orders', product_name: 'All lines' })
      expect(fabric.totals).toMatchObject({ product_type: 'fabric', qty: 11 })
      expect(fabric.totals.on_hand).toBeUndefined()
    })

    it('states the window the rows came from and the one that was asked for', async () => {
      const report = await payloadOf(QUEUE_PATH, '&from=2026-03-01')

      // The oldest row in the population, which is the confirmed backorder.
      expect(report.meta.coverage.from).toBe(await placedAtOf('BAK'))
      expect(report.meta.coverage.requested_from).toBe('2026-03-01')
      expect(report.meta.coverage.requested_to).toBeNull()
    })
  })

  describe('both exports', () => {
    it('serve a CSV attachment named after the report', () => {
      expect(stockCsv.statusCode).toBe(200)
      expect(queueCsv.statusCode).toBe(200)
      expect(stockCsv.headers['content-disposition']).toBe(
        'attachment; filename="atelier-stock.csv"'
      )
      expect(queueCsv.headers['content-disposition']).toBe(
        'attachment; filename="atelier-not-invoiced.csv"'
      )
    })

    it('take their header from the report’s own columns', () => {
      expect(stockCsv.body.split('\r\n')[0]).toBe(
        STOCK_COLUMNS.map((column) => column.label).join(',')
      )
      expect(queueCsv.body.split('\r\n')[0]).toBe(
        NOT_INVOICED_COLUMNS.map((column) => column.label).join(',')
      )
    })

    it('carry every row rather than the table’s page', async () => {
      const page = await payloadOf(STOCK_PATH, '&limit=1')
      const lines = stockCsv.body.split('\r\n')

      expect(page.rows).toHaveLength(1)
      // Header, four holdings, the totals row, then the notes block.
      expect(lines.slice(1, lines.indexOf('') - 1)).toHaveLength(4)
    })

    it('state their coverage in the file, not only in the payload', () => {
      expect(stockCsv.body).toMatch(/no landed cost/i)
      expect(queueCsv.body).toContain('Card checkouts')
    })

    // A filter the report could not honour narrowed nothing, and a reader who
    // typed one would otherwise take the file as having been filtered by it.
    it('name a filter the stock snapshot could not honour', () => {
      expect(stockCsv.body).toContain('Filters ignored,from')
      expect(queueCsv.body).not.toContain('Filters ignored')
    })

    // A negative quantity meets the formula guard: csvCell neutralises a leading
    // `-`, so Excel shows the cell as text. That is the guard working as designed
    // and is widened in src/lib/csv.js or not at all.
    it('neutralise a negative available, because a leading - is a formula lead-in', () => {
      expect(stockCsv.body).toContain("'-2")
    })
  })
})

// The CRM has mapped every staff login to full director access since the day it
// was wired to this API, so its masking has never fired. What closes that is a
// DERIVED statement on /auth/me — never a stored one, and never one the caller
// supplies — plus the report routes resolving finance from the same fact.
describe('W5-US-008 — report_access on /auth/me', () => {
  let pool
  let app
  let bossCookie
  let shopperCookie

  const BOSS_EMAIL = `${PREFIX}-me-boss@example.test`
  const SHOPPER_EMAIL = `${PREFIX}-me-shopper@example.test`

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }

  const me = (cookie) =>
    app.inject({ method: 'GET', url: '/auth/me', headers: cookie ? { cookie } : {} })

  const userFrom = async (cookie) => JSON.parse((await me(cookie)).body).user

  const setFinance = (email, value) =>
    pool.query('UPDATE users SET can_view_finance = $2 WHERE email = $1', [email, value])

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanup(pool)

    // Registered once, as everywhere here: /auth/register is 10 per 15 min per
    // IP and this app instance's bucket has to last the whole block.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: BOSS_EMAIL, password: PASSWORD, name: 'Boss' },
    })
    bossCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [BOSS_EMAIL])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: SHOPPER_EMAIL, password: PASSWORD },
    })
    shopperCookie = sessionCookieFrom(shopper)
  })

  afterAll(async () => {
    await app.close()
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await setFinance(BOSS_EMAIL, false)
  })

  it('states what a back-office login may read, and withholds the flag behind it', async () => {
    const user = await userFrom(bossCookie)

    expect(user.report_access).toEqual({ reports: true, finance: false })
    // The payload carries the STATEMENT, not the fact it was derived from: two
    // versions of one rule in one body invite a client to read the flag and
    // re-derive the rule for itself, which is what report_access exists to end.
    expect(user).not.toHaveProperty('can_view_finance')
    expect(user).toMatchObject({ email: BOSS_EMAIL, role: 'backoffice' })
  })

  it('follows a grant given and taken away, on the same session', async () => {
    expect((await userFrom(bossCookie)).report_access.finance).toBe(false)

    await setFinance(BOSS_EMAIL, true)
    expect((await userFrom(bossCookie)).report_access.finance).toBe(true)

    // And back: a role-derived answer could be handed out and never taken back,
    // which is why finance is the column rather than the role.
    await setFinance(BOSS_EMAIL, false)
    expect((await userFrom(bossCookie)).report_access.finance).toBe(false)
  })

  // If it were stored, the cookie would have to be re-issued for the grant above
  // to move — and a revocation would wait for the account's next sign-in.
  it('never writes it to the session', async () => {
    await setFinance(BOSS_EMAIL, true)
    const response = await me(bossCookie)

    expect(response.statusCode).toBe(200)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(JSON.parse(response.body).user.report_access.finance).toBe(true)
  })

  it('gives a client account no report access at all', async () => {
    const user = await userFrom(shopperCookie)

    expect(user.report_access).toEqual({ reports: false, finance: false })
    expect(user.role).toBe('customer')
  })

  it('answers an anonymous caller 401 with no statement to read', async () => {
    const response = await me(null)

    expect(response.statusCode).toBe(401)
    expect(JSON.parse(response.body)).not.toHaveProperty('user')
  })

  // The statement and the gate have to be the same answer. `reports` is what the
  // CRM draws the library from; requireRole('backoffice') is what actually
  // refuses, and a drift between them would offer a screen that 403s on open.
  it('agrees with what the report routes actually serve', async () => {
    const path = '/admin/reports/product-performance'

    const staff = await app.inject({ method: 'GET', url: path, headers: { cookie: bossCookie } })
    const client = await app.inject({ method: 'GET', url: path, headers: { cookie: shopperCookie } })

    expect((await userFrom(bossCookie)).report_access.reports).toBe(true)
    expect(staff.statusCode).toBe(200)
    expect((await userFrom(shopperCookie)).report_access.reports).toBe(false)
    expect(client.statusCode).toBe(403)
  })

  // The guard loads request.user through PUBLIC_USER_COLUMNS, which carries no
  // can_view_finance — so a route reading it straight off the record would mask
  // as though nobody had finance, while /auth/me told the CRM somebody did.
  describe('loadReportAccess — the same fact on both sides', () => {
    const staffRecord = (id) => ({ id, role: 'backoffice', trade_approved: false })

    it('resolves the flag the guard did not select', async () => {
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [BOSS_EMAIL])
      const id = rows[0].id

      expect(await loadReportAccess(pool, staffRecord(id))).toEqual({ reports: true, finance: false })
      await setFinance(BOSS_EMAIL, true)
      expect(await loadReportAccess(pool, staffRecord(id))).toEqual({ reports: true, finance: true })
    })

    // The lookup exists because the projection is short. A record that already
    // carries the flag must not pay for it — which is also how this disappears
    // if the guard ever widens.
    it('does not query for a record that already carries it', async () => {
      const refuses = {
        query: () => {
          throw new Error('should not query')
        },
      }

      expect(
        await loadReportAccess(refuses, { ...staffRecord(1), can_view_finance: true })
      ).toEqual({ reports: true, finance: true })
      expect(await loadReportAccess(refuses, null)).toEqual({ reports: false, finance: false })
    })

    // Fails closed: an account deleted between the session guard and the report
    // has no finance, rather than a `finance: undefined` a reader would coerce.
    it('fails closed when the row has gone', async () => {
      expect(await loadReportAccess(pool, staffRecord(-1))).toEqual({
        reports: true,
        finance: false,
      })
    })
  })
})
