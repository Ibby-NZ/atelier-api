import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'admin-ord-test'
const DOMAIN = 'admin-ord-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const SKU = { inStock: `${PREFIX}-INSTOCK` }

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, story)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, 'A test house.')
     RETURNING id`,
    ['Admin Ord House', `${PREFIX}-house`]
  )
  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Admin InStock', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brands[0].id, `${PREFIX}-instock`]
  )
  const { rows: cw } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Default', $2) RETURNING id`,
    [products[0].id, SKU.inStock]
  )
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 100, 0, 'metres')`,
    [cw[0].id]
  )
}

// Orders + brand fixtures only — the staff/customer users are registered once in
// beforeAll and kept, because register shares a rate-limit bucket (10 / 15 min /
// IP) that re-registering every test would exhaust.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM orders
      WHERE id IN (
        SELECT ol.order_id FROM order_lines ol
          JOIN colourways c ON c.id = ol.colourway_id
         WHERE c.sku LIKE $1
      )`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

const inventoryFor = async (pool, sku) => {
  const { rows } = await pool.query(
    `SELECT i.qty_available, i.qty_reserved
       FROM inventory i JOIN colourways c ON c.id = i.colourway_id
      WHERE c.sku = $1`,
    [sku]
  )
  return {
    available: Number(rows[0].qty_available),
    reserved: Number(rows[0].qty_reserved),
  }
}

describe('back-office order management', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  // Place a fresh in-stock order-request (status=requested, reservation held).
  const placeRequest = async (qty = 10) => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders/request',
      payload: {
        lines: [{ sku: SKU.inStock, qty_metres: qty }],
        contact: { email: 'buyer@example.com' },
      },
    })
    return response.json().order
  }

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

    await cleanupFixtures(pool)
    await deleteUsers(pool)

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await inject('GET', '/admin/orders', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await inject('GET', '/admin/orders', customerCookie)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/orders', () => {
    it('lists orders with lines and reservation state', async () => {
      const placed = await placeRequest(10)
      const response = await inject('GET', '/admin/orders', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const order = response.json().orders.find((o) => o.id === placed.id)
      expect(order.reservation_state).toBe('held')
      expect(order.lines[0].sku).toBe(SKU.inStock)
      expect(Number(order.lines[0].reserved_qty)).toBe(10)
      expect(Number(order.lines[0].inventory.qty_reserved)).toBe(10)
    })

    it('filters by status', async () => {
      const placed = await placeRequest(10)
      const shipped = await inject('GET', '/admin/orders?status=shipped', backofficeCookie)
      expect(shipped.json().orders.some((o) => o.id === placed.id)).toBe(false)
      const requested = await inject(
        'GET',
        '/admin/orders?status=requested',
        backofficeCookie
      )
      expect(requested.json().orders.some((o) => o.id === placed.id)).toBe(true)
    })

    it('rejects an unknown status filter with 400', async () => {
      const response = await inject('GET', '/admin/orders?status=bogus', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })
  })

  describe('full lifecycle', () => {
    it('runs requested -> confirmed -> paid -> shipped and converts the reservation', async () => {
      const placed = await placeRequest(10)
      expect((await inventoryFor(pool, SKU.inStock))).toEqual({
        available: 100,
        reserved: 10,
      })

      const confirm = await inject(
        'POST',
        `/admin/orders/${placed.id}/confirm`,
        backofficeCookie,
        { xero_invoice_ref: 'INV-2026-001' }
      )
      expect(confirm.statusCode).toBe(200)
      expect(confirm.json().order.status).toBe('confirmed')
      expect(confirm.json().order.xero_invoice_ref).toBe('INV-2026-001')

      const paid = await inject(
        'POST',
        `/admin/orders/${placed.id}/mark-paid`,
        backofficeCookie
      )
      expect(paid.json().order.status).toBe('paid')
      // Reservation still held through payment.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)

      const ship = await inject(
        'POST',
        `/admin/orders/${placed.id}/ship`,
        backofficeCookie
      )
      expect(ship.json().order.status).toBe('shipped')
      expect(ship.json().order.reservation_state).toBe('converted')
      // Reservation converted to a real decrement.
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 90,
        reserved: 0,
      })
    })

    it('declines a requested order and releases its reservation', async () => {
      const placed = await placeRequest(15)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(15)

      const decline = await inject(
        'POST',
        `/admin/orders/${placed.id}/decline`,
        backofficeCookie
      )
      expect(decline.statusCode).toBe(200)
      expect(decline.json().order.status).toBe('declined')
      expect(decline.json().order.reservation_state).toBe('released')
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 100,
        reserved: 0,
      })
    })
  })

  describe('PATCH /admin/orders/:id', () => {
    it('edits a line quantity and adjusts the reservation to match', async () => {
      const placed = await placeRequest(10)
      const order = (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie))
        .json().order

      const response = await inject(
        'PATCH',
        `/admin/orders/${placed.id}`,
        backofficeCookie,
        { lines: [{ id: order.lines[0].id, qty: 25 }] }
      )
      expect(response.statusCode).toBe(200)
      expect(Number(response.json().order.lines[0].qty)).toBe(25)
      // 10 -> 25 raises the reservation by 15.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(25)
    })

    it('rejects editing a shipped order with 409', async () => {
      const placed = await placeRequest(10)
      const order = (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie))
        .json().order
      await inject('POST', `/admin/orders/${placed.id}/confirm`, backofficeCookie, {
        xero_invoice_ref: 'INV-X',
      })
      await inject('POST', `/admin/orders/${placed.id}/mark-paid`, backofficeCookie)
      await inject('POST', `/admin/orders/${placed.id}/ship`, backofficeCookie)

      const response = await inject('PATCH', `/admin/orders/${placed.id}`, backofficeCookie, {
        lines: [{ id: order.lines[0].id, qty: 5 }],
      })
      expect(response.statusCode).toBe(409)
    })
  })

  describe('invalid transitions (409)', () => {
    it('rejects ship before paid', async () => {
      const placed = await placeRequest(10)
      const response = await inject(
        'POST',
        `/admin/orders/${placed.id}/ship`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)
      // Reservation untouched by the rejected transition.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
    })

    it('rejects confirming an already-confirmed order', async () => {
      const placed = await placeRequest(10)
      await inject('POST', `/admin/orders/${placed.id}/confirm`, backofficeCookie, {
        xero_invoice_ref: 'INV-1',
      })
      const again = await inject(
        'POST',
        `/admin/orders/${placed.id}/confirm`,
        backofficeCookie,
        { xero_invoice_ref: 'INV-2' }
      )
      expect(again.statusCode).toBe(409)
    })

    it('rejects mark-paid before confirm', async () => {
      const placed = await placeRequest(10)
      const response = await inject(
        'POST',
        `/admin/orders/${placed.id}/mark-paid`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)
    })
  })

  describe('not found', () => {
    it('returns 404 for an unknown order id', async () => {
      const response = await inject('GET', '/admin/orders/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    it('returns 404 when confirming an unknown order id', async () => {
      const response = await inject(
        'POST',
        '/admin/orders/99999999/confirm',
        backofficeCookie,
        { xero_invoice_ref: 'INV-Z' }
      )
      expect(response.statusCode).toBe(404)
    })
  })
})
