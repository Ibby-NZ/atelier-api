// GET /admin/dashboard — the CRM's landing tiles, live.
//
// One round trip answers the four things the office glances at: month-to-date
// sales (the SAME population the revenue reports use — paid+shipped, archived
// orders excluded), the open order book (HELD_STATUSES, not month-bounded),
// inbound purchase orders (status=sent), and the newest orders.
//
// Two postures under test matter more than the numbers:
//   - The payload STATES its populations (`statuses`, `status`, `from`) so the
//     CRM can build drill-down links that cannot disagree with the figures.
//   - PO money is finance-gated by KEY DELETION exactly as the PO screen gets
//     it; sell-side money (sales MTD) is deliberately not gated — see
//     src/reports/CLAUDE.md ("a sell value is money and is not a cost").
//
// Counts and sums are asserted as DELTAS against a baseline read taken before
// the fixtures land: the dashboard aggregates the WHOLE ledger (there is no
// fixture-scoping filter on "open orders"), so exact assertions would couple
// this file to every other file's cleanup.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { HELD_STATUSES } from '../src/orders/order-states.js'
import { REVENUE_STATUSES } from '../src/reports/revenue-lines.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'dash-test'
const DOMAIN = 'dash-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const monthStart = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

describe('GET /admin/dashboard', () => {
  let pool
  let app
  let bossCookie
  let clerkCookie
  let customerCookie
  let colourwayId
  let euroColourwayId
  let baseline

  const fetchDashboard = async (cookie) => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie },
    })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  const cleanupFixtures = async () => {
    await pool.query('DELETE FROM orders WHERE order_number LIKE $1', [`${PREFIX}-%`])
    await pool.query('DELETE FROM purchase_orders WHERE po_number LIKE $1', [`${PREFIX}-%`])
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
    await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
  }

  const insertOrder = async (suffix, kind, status, createdAt, { archived = false } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO orders (order_number, kind, status, guest_email, created_at, archived_at)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
       RETURNING id`,
      [
        `${PREFIX}-${suffix}`,
        kind,
        status,
        testEmail('guest'),
        createdAt,
        archived ? new Date() : null,
      ]
    )
    return rows[0].id
  }

  const insertLine = (orderId, cwId, qty, unitPriceCents) =>
    pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, $3, $4)`,
      [orderId, cwId, qty, unitPriceCents]
    )

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanupFixtures()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered ONCE — the register bucket is 10 / 15 min / IP.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    bossCookie = sessionCookieFrom(boss)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = true WHERE email = $1`,
      [testEmail('boss')]
    )

    const clerk = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('clerk'), password: PASSWORD, name: 'Clerk' },
    })
    clerkCookie = sessionCookieFrom(clerk)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('clerk'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)

    // Baseline BEFORE any fixture lands — every count below asserts a delta.
    baseline = await fetchDashboard(bossCookie)

    // Catalogue: one NZD house and one EUR one (for the mixed-currency case).
    const { rows: brandRows } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only)
       VALUES ('Dash House', $1, 'New Zealand', 'NZD', false, false)
       RETURNING id`,
      [`${PREFIX}-house`]
    )
    const { rows: productRows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, 'Dash Cloth', $2, 'fabric', 'NZD', true),
              ($1, 'Dash Euro Cloth', $3, 'fabric', 'EUR', true)
       RETURNING id`,
      [brandRows[0].id, `${PREFIX}-cloth`, `${PREFIX}-euro-cloth`]
    )
    const { rows: cwRows } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku)
       VALUES ($1, 'Ivory', $3), ($2, 'Euro', $4)
       RETURNING id`,
      [productRows[0].id, productRows[1].id, `${PREFIX}-SKU`, `${PREFIX}-SKU-EUR`]
    )
    colourwayId = cwRows[0].id
    euroColourwayId = cwRows[1].id

    const thisMonth = `${monthStart()} 12:00:00`
    const lastMonthDay = new Date()
    lastMonthDay.setDate(1)
    lastMonthDay.setDate(0) // last day of the previous month
    const lastMonth = `${lastMonthDay.toISOString().slice(0, 10)} 12:00:00`

    // The MTD population: paid + shipped this month, archived out, declined
    // out, last month out. The paid order_request carries an unpriced line.
    await insertLine(await insertOrder('paid', 'checkout', 'paid', thisMonth), colourwayId, 2, 5000)
    await insertLine(
      await insertOrder('shipped', 'order_request', 'shipped', thisMonth),
      colourwayId,
      1,
      20000
    )
    await insertLine(
      await insertOrder('request', 'order_request', 'paid', thisMonth),
      colourwayId,
      3,
      0
    )
    await insertLine(
      await insertOrder('lastmonth', 'checkout', 'paid', lastMonth),
      colourwayId,
      1,
      99900
    )
    await insertLine(
      await insertOrder('declined', 'checkout', 'declined', thisMonth),
      colourwayId,
      1,
      70000
    )
    await insertLine(
      await insertOrder('archived', 'checkout', 'paid', thisMonth, { archived: true }),
      colourwayId,
      1,
      80000
    )
    // Held but unpaid: counts toward open orders, not toward MTD sales.
    await insertLine(
      await insertOrder('requested', 'order_request', 'requested', thisMonth),
      colourwayId,
      1,
      0
    )

    // Purchase orders: sent is inbound; draft and closed are not.
    const { rows: supplierRows } = await pool.query(
      `INSERT INTO suppliers (name, slug) VALUES ('Dash Supplier', $1) RETURNING id`,
      [`${PREFIX}-supplier`]
    )
    const insertPo = async (suffix, status) => {
      const { rows } = await pool.query(
        `INSERT INTO purchase_orders (po_number, brand_id, supplier_id, supplier_name, status)
         VALUES ($1, $2, $3, 'Dash Supplier', $4)
         RETURNING id`,
        [`${PREFIX}-${suffix}`, brandRows[0].id, supplierRows[0].id, status]
      )
      return rows[0].id
    }
    await insertPo('draft', 'draft')
    const sentId = await insertPo('sent-1', 'sent')
    await insertPo('sent-2', 'sent')
    await insertPo('closed', 'closed')
    // A costed line on one sent PO, so the finance masking has a figure to hide.
    await pool.query(
      `INSERT INTO purchase_order_lines (purchase_order_id, colourway_id, qty_ordered, unit_price)
       VALUES ($1, $2, 10, 42.50)`,
      [sentId, colourwayId]
    )
  })

  afterAll(async () => {
    await cleanupFixtures()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app?.close()
    await pool?.end()
  })

  it('is backoffice-only', async () => {
    const anon = await app.inject({ method: 'GET', url: '/admin/dashboard' })
    expect(anon.statusCode).toBe(401)
    const shopper = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: customerCookie },
    })
    expect(shopper.statusCode).toBe(403)
  })

  it('answers the month-to-date sales out of the revenue population', async () => {
    const body = await fetchDashboard(bossCookie)

    // paid (2 × 5000) + shipped (1 × 20000); the request contributes 0; the
    // declined, archived and last-month orders contribute nothing at all.
    expect(body.sales_mtd.value_cents - baseline.sales_mtd.value_cents).toBe(30000)
    expect(body.sales_mtd.orders - baseline.sales_mtd.orders).toBe(3)
    expect(body.sales_mtd.unpriced_lines - baseline.sales_mtd.unpriced_lines).toBe(1)
    expect(body.sales_mtd.mixed_currency).toBe(false)
    expect(body.sales_mtd.from).toBe(monthStart())
    // The population is stated, not implied — the CRM links with it.
    expect(body.sales_mtd.statuses).toEqual([...REVENUE_STATUSES])
  })

  it('counts the open order book across months, archived excluded', async () => {
    const body = await fetchDashboard(bossCookie)
    // paid + shipped? No: HELD only — paid (MTD), paid request, LAST month's
    // paid, and the requested one. Shipped, declined and archived are out.
    expect(body.open_orders.count - baseline.open_orders.count).toBe(4)
    expect(body.open_orders.statuses).toEqual([...HELD_STATUSES])
  })

  it('counts only sent purchase orders as inbound', async () => {
    const body = await fetchDashboard(bossCookie)
    expect(body.inbound.count - baseline.inbound.count).toBe(2)
    expect(body.inbound.status).toBe('sent')
    const mine = body.inbound.purchase_orders.filter((po) =>
      po.po_number.startsWith(PREFIX)
    )
    expect(mine.map((po) => po.status)).toEqual(['sent', 'sent'])
  })

  it('deletes PO cost keys for a login without finance visibility', async () => {
    const boss = await fetchDashboard(bossCookie)
    const clerk = await fetchDashboard(clerkCookie)
    const bossPo = boss.inbound.purchase_orders.find((po) => po.po_number === `${PREFIX}-sent-1`)
    const clerkPo = clerk.inbound.purchase_orders.find((po) => po.po_number === `${PREFIX}-sent-1`)
    expect(bossPo).toBeTruthy()
    expect(Object.hasOwn(bossPo, 'total_cost')).toBe(true)
    expect(clerkPo).toBeTruthy()
    // Deleted, not nulled — a null reads as "no cost on file", which is a lie.
    expect(Object.hasOwn(clerkPo, 'total_cost')).toBe(false)
  })

  it('lists the newest orders, at most five', async () => {
    const body = await fetchDashboard(bossCookie)
    expect(body.recent_orders.length).toBeLessThanOrEqual(5)
    expect(body.recent_orders.length).toBeGreaterThan(0)
    // Newest first: every fixture was created just now, so the head is ours.
    expect(body.recent_orders[0].order_number.startsWith(PREFIX)).toBe(true)
  })

  it('opts into the report-table rate limit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/dashboard',
      headers: { cookie: bossCookie },
    })
    expect(response.headers['x-ratelimit-limit']).toBe('60')
  })

  it('withholds a total it cannot honestly add: mixed currencies', async () => {
    const euroOrder = await insertOrder('euro', 'checkout', 'paid', `${monthStart()} 13:00:00`)
    await insertLine(euroOrder, euroColourwayId, 1, 30000)
    try {
      const body = await fetchDashboard(bossCookie)
      expect(body.sales_mtd.mixed_currency).toBe(true)
      expect(body.sales_mtd.value_cents).toBeNull()
    } finally {
      await pool.query('DELETE FROM orders WHERE id = $1', [euroOrder])
    }
  })
})
