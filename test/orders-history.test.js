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
    `INSERT INTO brands (name, slug, country, currency, is_international, story)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, 'A test house.')
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
     VALUES ($1, $2, $3, 'order_request', 'requested', 5000, 0, 5000, 'Auckland', NULL)
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
    expect(orders[0].status).toBe('requested')
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

  it('GET /orders/lookup returns a guest order when number and email match', async () => {
    await insertOrder(pool, colourwayId, {
      guestEmail: 'guest@example.com',
      orderNumber: `${PREFIX}-G1`,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/orders/lookup?order_number=${PREFIX}-G1&email=guest@example.com`,
    })
    expect(res.statusCode).toBe(200)
    const { order } = res.json()
    expect(order.order_number).toBe(`${PREFIX}-G1`)
    expect(order.lines).toHaveLength(1)
  })

  it('GET /orders/lookup matches the placing user\'s email (case-insensitive)', async () => {
    const userA = await registerUser(app, `${PREFIX}-a@example.com`)
    await insertOrder(pool, colourwayId, { userId: userA.id, orderNumber: `${PREFIX}-A1` })

    const res = await app.inject({
      method: 'GET',
      url: `/orders/lookup?order_number=${PREFIX}-A1&email=${PREFIX}-A@EXAMPLE.COM`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().order.order_number).toBe(`${PREFIX}-A1`)
  })

  it('GET /orders/lookup returns 404 when the email does not match', async () => {
    await insertOrder(pool, colourwayId, {
      guestEmail: 'guest@example.com',
      orderNumber: `${PREFIX}-G1`,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/orders/lookup?order_number=${PREFIX}-G1&email=someone-else@example.com`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /orders/lookup returns 404 for an unknown order number', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/orders/lookup?order_number=${PREFIX}-NOPE&email=guest@example.com`,
    })
    expect(res.statusCode).toBe(404)
  })

  it('GET /orders/lookup requires both params (400)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/orders/lookup?order_number=${PREFIX}-G1`,
    })
    expect(res.statusCode).toBe(400)
  })
})
