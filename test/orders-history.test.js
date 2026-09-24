import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'ordh-test'

// Fixtures: one colourway to hang order lines on, plus two registered users so
// we can prove cross-user isolation.
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Ordh Test House', `${PREFIX}-house`]
  )
  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Ordh Fabric', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brands[0].id, `${PREFIX}-fabric`]
  )
  const { rows: colourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Default', $2) RETURNING id`,
    [products[0].id, `${PREFIX}-SKU`]
  )
  return { colourwayId: colourways[0].id }
}

const insertOrder = async (pool, colourwayId, { userId, guestEmail, orderNumber }) => {
  const { rows } = await pool.query(
    `INSERT INTO orders
       (user_id, guest_email, order_number, kind, status,
        subtotal_cents, shipping_cents, total_cents, shipping_zone, xero_invoice_ref)
     VALUES ($1, $2, $3, 'order_request', 'quote_requested', 5000, 0, 5000, 'Auckland', NULL)
     RETURNING id`,
    [userId ?? null, guestEmail ?? null, orderNumber]
  )
  const orderId = rows[0].id
  await pool.query(
    `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents, cut_requirements)
     VALUES ($1, $2, 10, 5000, 'One 10m cut')`,
    [orderId, colourwayId]
  )
  return orderId
}

const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM orders
      WHERE id IN (
        SELECT ol.order_id FROM order_lines ol
          JOIN colourways c ON c.id = ol.colourway_id
         WHERE c.sku LIKE $1
      )`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const registerUser = async (app, email) => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'super-secret-pw', name: 'User' },
  })
  expect(res.statusCode).toBe(201)
  const setCookie = res.headers['set-cookie']
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
  const { rows } = await appPool.query('SELECT id FROM users WHERE email = $1', [email])
  return { cookie, id: rows[0].id }
}

let appPool

describe('order history + guest lookup', () => {
  let pool
  let app
  let colourwayId

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    appPool = pool
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
  })

  beforeEach(async () => {
    await cleanup(pool)
    const fx = await seedFixtures(pool)
    colourwayId = fx.colourwayId
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  it('GET /orders/mine returns the user\'s own orders with lines', async () => {
    const userA = await registerUser(app, `${PREFIX}-a@example.com`)
    await insertOrder(pool, colourwayId, { userId: userA.id, orderNumber: `${PREFIX}-A1` })
    await insertOrder(pool, colourwayId, { userId: userA.id, orderNumber: `${PREFIX}-A2` })

    const res = await app.inject({
      method: 'GET',
      url: '/orders/mine',
      headers: { cookie: userA.cookie },
    })
    expect(res.statusCode).toBe(200)
    const { orders } = res.json()
    expect(orders).toHaveLength(2)
    expect(orders[0].order_number).toMatch(new RegExp(`^${PREFIX}-A`))
    expect(orders[0].lines[0].sku).toBe(`${PREFIX}-SKU`)
    expect(orders[0].status).toBe('quote_requested')
  })

  // The office's discount used to be invisible to the client: a $700 subtotal
  // and a $665 total with nothing in between reads as an arithmetic error
  // (Userback 8367809). The percentage travels; the reason and who applied it
  // stay in the back office.
  it('GET /orders/mine carries the discount percentage but not its reason', async () => {
    const user = await registerUser(app, `${PREFIX}-disc@example.com`)
    const orderId = await insertOrder(pool, colourwayId, { userId: user.id, orderNumber: `${PREFIX}-D1` })
    // Past the quote stage: a quote the office has not sent shows no money.
    await pool.query(
      `UPDATE orders SET status = 'pending_payment', discount_pct = 5, discount_reason = 'Loyal',
              total_cents = 4750 WHERE id = $1`,
      [orderId]
    )
    const res = await app.inject({ method: 'GET', url: '/orders/mine', headers: { cookie: user.cookie } })
    const [order] = res.json().orders
    expect(Number(order.discount_pct)).toBe(5)
    expect(order).not.toHaveProperty('discount_reason')
    expect(order).not.toHaveProperty('discount_applied_by')
  })

  // 24 Sep 2026: "customer cannot see price on quote made until quote status
  // set sent". The office's indicative figures stay stored; the client reads
  // none of them until the quote goes out.
  it('GET /orders/mine shows no money on a quote the office has not sent', async () => {
    const user = await registerUser(app, `${PREFIX}-hide@example.com`)
    const orderId = await insertOrder(pool, colourwayId, { userId: user.id, orderNumber: `${PREFIX}-H1` })
    await pool.query(`UPDATE order_lines SET unit_price_cents = 1250 WHERE order_id = $1`, [orderId])
    const read = async () =>
      (await app.inject({ method: 'GET', url: '/orders/mine', headers: { cookie: user.cookie } }))
        .json()
        .orders.find((order) => order.order_number === `${PREFIX}-H1`)

    const hidden = await read()
    expect(hidden.status).toBe('quote_requested')
    expect(hidden).toMatchObject({
      subtotal_cents: null,
      shipping_cents: null,
      gst_cents: null,
      total_cents: null,
      discount_pct: null,
    })
    expect(hidden.lines.every((line) => line.unit_price_cents === null)).toBe(true)

    await pool.query(`UPDATE orders SET status = 'quote_sent' WHERE id = $1`, [orderId])
    const shown = await read()
    expect(shown.total_cents).toBe(5000)
    expect(shown.lines[0].unit_price_cents).toBe(1250)
  })

  it('GET /orders/mine never returns another user\'s orders', async () => {
    const userA = await registerUser(app, `${PREFIX}-a@example.com`)
    const userB = await registerUser(app, `${PREFIX}-b@example.com`)
    await insertOrder(pool, colourwayId, { userId: userA.id, orderNumber: `${PREFIX}-A1` })

    const res = await app.inject({
      method: 'GET',
      url: '/orders/mine',
      headers: { cookie: userB.cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orders).toHaveLength(0)
  })

  it('GET /orders/mine requires authentication (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/orders/mine' })
    expect(res.statusCode).toBe(401)
  })

  // The public order_number + email lookup was removed: anyone who knew both
  // halves could read another client's order. Even a correct pair must now
  // find no route.
  it('GET /orders/lookup no longer exists (404 even with a matching pair)', async () => {
    await insertOrder(pool, colourwayId, {
      guestEmail: 'guest@example.com',
      orderNumber: `${PREFIX}-G1`,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/orders/lookup?order_number=${PREFIX}-G1&email=guest@example.com`,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().order).toBeUndefined()
  })
})
