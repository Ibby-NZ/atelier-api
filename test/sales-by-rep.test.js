// GET /admin/reports/sales-by-rep — how many sales each staff member made.
//
// The report the client described ("how many sales Rebecca has made, date
// select, click through") — order-grain attribution over the SAME revenue
// scope every money report selects from. Three rules carry it:
//
//   - NULL reps are an explicit 'Unassigned' row, never dropped: every order
//     raised before the column existed (and every web checkout) is unassigned,
//     and a report that hid them would overstate everyone else's share.
//   - Grouped by the ID, displayed by the name — two staff named Rebecca stay
//     two rows, and a deleted account keeps its row as Unassigned (SET NULL).
//   - Attribution is STAFF-ASSERTED (A6 is open) and never derived from the
//     legacy owner column; the coverage note says so in the payload.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'rep-report-test'
const DOMAIN = 'rep-report-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('GET /admin/reports/sales-by-rep', () => {
  let pool
  let app
  let staffCookie
  let rebeccaId
  let colourwayId

  const fetchReport = async (query = '') => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/reports/sales-by-rep${query}`,
      headers: { cookie: staffCookie },
    })
    expect(response.statusCode).toBe(200)
    return response.json()
  }

  const repRow = (rows, label) => rows.find((row) => row.sales_rep === label)

  const cleanupFixtures = async () => {
    await pool.query('DELETE FROM orders WHERE order_number LIKE $1', [`${PREFIX}-%`])
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  }

  const insertOrder = async (suffix, status, createdAt, repId) => {
    const { rows } = await pool.query(
      `INSERT INTO orders (order_number, kind, status, guest_email, created_at, sales_rep_user_id)
       VALUES ($1, 'checkout', $2, $3, $4::timestamptz, $5)
       RETURNING id`,
      [`${PREFIX}-${suffix}`, status, testEmail('guest'), createdAt, repId]
    )
    return rows[0].id
  }

  const insertLine = (orderId, qty, unitPriceCents) =>
    pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, $3, $4)`,
      [orderId, colourwayId, qty, unitPriceCents]
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

    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('staff'), password: PASSWORD, name: 'Staff' },
    })
    staffCookie = sessionCookieFrom(staff)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('staff'),
    ])

    const { rows: repRows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, 'x', 'Rebecca Rep', 'backoffice')
       RETURNING id`,
      [testEmail('rebecca')]
    )
    rebeccaId = repRows[0].id

    const { rows: brandRows } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only)
       VALUES ('Rep House', $1, 'New Zealand', 'NZD', false, false)
       RETURNING id`,
      [`${PREFIX}-house`]
    )
    const { rows: productRows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, 'Rep Cloth', $2, 'fabric', 'NZD', true)
       RETURNING id`,
      [brandRows[0].id, `${PREFIX}-cloth`]
    )
    const { rows: cwRows } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku)
       VALUES ($1, 'Ivory', $2) RETURNING id`,
      [productRows[0].id, `${PREFIX}-SKU`]
    )
    colourwayId = cwRows[0].id

    // Rebecca: two paid orders (three lines) in August 2026. Unassigned: one
    // paid order. A quote_requested order stays outside the revenue population.
    const paid1 = await insertOrder('r1', 'paid', '2026-08-05 12:00:00', rebeccaId)
    await insertLine(paid1, 2, 5000)
    await insertLine(paid1, 1, 10000)
    const paid2 = await insertOrder('r2', 'shipped', '2026-08-20 12:00:00', rebeccaId)
    await insertLine(paid2, 1, 30000)
    const orphan = await insertOrder('u1', 'paid', '2026-08-10 12:00:00', null)
    await insertLine(orphan, 1, 7000)
    const requested = await insertOrder('req', 'quote_requested', '2026-08-11 12:00:00', rebeccaId)
    await insertLine(requested, 1, 0)
  })

  afterAll(async () => {
    await cleanupFixtures()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app?.close()
    await pool?.end()
  })

  it('is backoffice-only', async () => {
    const anon = await app.inject({ method: 'GET', url: '/admin/reports/sales-by-rep' })
    expect(anon.statusCode).toBe(401)
  })

  it('answers a row per rep plus an explicit Unassigned row, orders counted once', async () => {
    const body = await fetchReport(`?brand=${PREFIX}-house`)
    const rebecca = repRow(body.rows, 'Rebecca Rep')
    expect(rebecca).toMatchObject({
      orders: 2,
      value_cents: 50000,
      currency: 'NZD',
    })
    const unassigned = repRow(body.rows, 'Unassigned')
    expect(unassigned).toMatchObject({ orders: 1, value_cents: 7000 })
    // The requested order is outside the default population entirely.
    expect(rebecca.orders + unassigned.orders).toBe(3)
  })

  it('honours the date range', async () => {
    const body = await fetchReport(`?brand=${PREFIX}-house&from=2026-08-15&to=2026-08-31`)
    expect(repRow(body.rows, 'Rebecca Rep')).toMatchObject({ orders: 1, value_cents: 30000 })
    expect(repRow(body.rows, 'Unassigned')).toBeUndefined()
  })

  it('takes a rep filter, and so does product performance', async () => {
    const mine = await fetchReport(`?brand=${PREFIX}-house&rep=${rebeccaId}`)
    expect(mine.rows).toHaveLength(1)
    expect(mine.rows[0].sales_rep).toBe('Rebecca Rep')

    const performance = await app.inject({
      method: 'GET',
      url: `/admin/reports/product-performance?brand=${PREFIX}-house&rep=${rebeccaId}`,
      headers: { cookie: staffCookie },
    })
    expect(performance.statusCode).toBe(200)
    expect(performance.json().meta.filters.rep).toBe(rebeccaId)
    expect(Number(performance.json().totals.value_cents)).toBe(50000)
  })

  it('states the A6 caveat in its own coverage note', async () => {
    const body = await fetchReport(`?brand=${PREFIX}-house`)
    expect(body.meta.coverage.note).toContain('Unassigned')
    expect(body.meta.coverage.note).toMatch(/Dynamics|owner/i)
  })

  it('exports through the same builder', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/admin/reports/sales-by-rep/export.csv?brand=${PREFIX}-house`,
      headers: { cookie: staffCookie },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-disposition']).toContain('atelier-sales-by-rep.csv')
    expect(response.body).toContain('Rebecca Rep')
    expect(response.body).toContain('Unassigned')
  })
})
