import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'ord-test'

const SKU = {
  inStock: `${PREFIX}-INSTOCK`,
  short: `${PREFIX}-SHORT`,
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Ord Test House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES
       ($1, 'Ord InStock', $2, 'fabric', 'NZD', true),
       ($1, 'Ord Short',   $3, 'fabric', 'NZD', true)
     RETURNING id, slug`,
    [brandId, `${PREFIX}-instock`, `${PREFIX}-short`]
  )
  const idBySlug = new Map(products.map((p) => [p.slug, p.id]))

  const cw = async (slug, sku) => {
    const { rows } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku)
       VALUES ($1, 'Default', $2) RETURNING id`,
      [idBySlug.get(slug), sku]
    )
    return rows[0].id
  }
  const inStockCw = await cw(`${PREFIX}-instock`, SKU.inStock)
  const shortCw = await cw(`${PREFIX}-short`, SKU.short)

  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 60, 0, 'metres'),
            ($2, 5, 0, 'metres')`,
    [inStockCw, shortCw]
  )
}

// Orders reference colourways with ON DELETE RESTRICT, so delete the orders that
// point at our fixtures BEFORE dropping the fixture brand/colourways.
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

const reservedFor = async (pool, sku) => {
  const { rows } = await pool.query(
    `SELECT i.qty_reserved
       FROM inventory i JOIN colourways c ON c.id = i.colourway_id
      WHERE c.sku = $1`,
    [sku]
  )
  return Number(rows[0].qty_reserved)
}

describe('POST /orders/request', () => {
  let pool
  let app

  const post = (payload, headers = {}) =>
    app.inject({ method: 'POST', url: '/orders/request', payload, headers })

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
  })

  beforeEach(async () => {
    // Fresh fixtures each test so reservation counts start from a known state.
    await cleanup(pool)
    await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  it('creates an order_request and reserves stock when in stock', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 12, cut_requirements: 'One 12m cut' }],
      contact: { name: 'Ada', email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect(order.kind).toBe('order_request')
    expect(order.status).toBe('requested')
    expect(order.order_number).toMatch(/^REQ-/)
    expect(order.lines[0].cut_requirements).toBe('One 12m cut')

    expect(await reservedFor(pool, SKU.inStock)).toBe(12)
  })

  it('creates a backorder_request when short and lead time is accepted', async () => {
    const response = await post({
      lines: [{ sku: SKU.short, qty_metres: 20 }],
      contact: { email: 'guest@example.com' },
      accepted_lead_time: true,
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect(order.kind).toBe('backorder_request')
    expect(order.order_number).toMatch(/^BO-/)
    // The demand is still reserved against the (short) inventory row.
    expect(await reservedFor(pool, SKU.short)).toBe(20)
  })

  it('rejects a short request without accepted lead time (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.short, qty_metres: 20 }],
      contact: { email: 'guest@example.com' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/lead time/i)
    // Nothing reserved when the request is rejected.
    expect(await reservedFor(pool, SKU.short)).toBe(0)
  })

  it('rejects qty_metres <= 0 with a field message (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 0 }],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'lines[0].qty_metres' })
    )
  })

  it('requires an email for guest requests (422)', async () => {
    const response = await post({ lines: [{ sku: SKU.inStock, qty_metres: 5 }] })
    expect(response.statusCode).toBe(422)
    expect(response.json().errors).toContainEqual(
      expect.objectContaining({ field: 'contact.email' })
    )
  })

  it('rejects an invalid email (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 5 }],
      contact: { email: 'not-an-email' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().errors).toContainEqual(
      expect.objectContaining({ field: 'contact.email' })
    )
  })

  it('rejects an unknown SKU (422)', async () => {
    const response = await post({
      lines: [{ sku: 'no-such-sku', qty_metres: 5 }],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/no product/i)
  })

  it('rejects an empty lines array by schema (400)', async () => {
    const response = await post({
      lines: [],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('links the order to a logged-in user (no guest email needed)', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: `${PREFIX}-user@example.com`,
        password: 'super-secret-pw',
        name: 'Logged In',
      },
    })
    expect(register.statusCode).toBe(201)
    const setCookie = register.headers['set-cookie']
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]

    const response = await post(
      { lines: [{ sku: SKU.inStock, qty_metres: 8 }] },
      { cookie }
    )
    expect(response.statusCode).toBe(201)
    const { order } = response.json()

    const { rows } = await pool.query(
      'SELECT user_id, guest_email FROM orders WHERE id = $1',
      [order.id]
    )
    expect(rows[0].user_id).not.toBeNull()
    expect(rows[0].guest_email).toBeNull()
  })
})
