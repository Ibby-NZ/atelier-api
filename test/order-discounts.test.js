// The director-only pricing override (Rebecca-R2), end to end: standard tiers
// writable by any back-office user, anything else director-only and carrying a
// reason, `discount_applied_by` stamped from the session, and — the part that
// pays for the design — the discount surviving every later recompute because
// it is an INPUT to the one recompute rather than a second total.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { discountedTotalCents } from '../src/orders/discounts.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'ord-disc-test'
const DOMAIN = 'ord-disc-test.example.com'
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
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Discount House', `${PREFIX}-house`]
  )
  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Discount Cloth', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brands[0].id, `${PREFIX}-cloth`]
  )
  const { rows: cw } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Default', $2)
     RETURNING id`,
    [products[0].id, SKU.inStock]
  )
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 100, 0, 'metres')`,
    [cw[0].id]
  )
  return cw[0].id
}

// Orders + brand fixtures only — the users are registered once in beforeAll and
// kept, because register shares a rate-limit bucket (10 / 15 min / IP).
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

describe('order discounts (Rebecca-R2)', () => {
  let pool
  let app
  let backofficeCookie
  let directorCookie
  let directorId
  let colourwayId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const patch = (id, cookie, body) =>
    inject('PATCH', `/admin/orders/${id}`, cookie, body)

  const orderFor = async (id) =>
    (await inject('GET', `/admin/orders/${id}`, backofficeCookie)).json().order

  // A priced sales order to discount: 10 metres at $10.00 → subtotal 10000.
  const placeOrder = async () => {
    const response = await inject('POST', '/admin/orders', backofficeCookie, {
      contact: { name: 'Discount Client' },
      lines: [{ colourway_id: colourwayId, qty: 10, unit_price_cents: 1000 }],
    })
    expect(response.statusCode).toBe(201)
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

    const director = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('director'), password: PASSWORD, name: 'Director' },
    })
    directorCookie = sessionCookieFrom(director)
    const { rows } = await pool.query(
      `UPDATE users SET role = 'director' WHERE email = $1 RETURNING id`,
      [testEmail('director')]
    )
    directorId = rows[0].id
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    colourwayId = await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('standard tiers (0 / 5 / 10)', () => {
    it('lets a back-office user set 5% and recomputes the total, not the subtotal', async () => {
      const order = await placeOrder()
      const response = await patch(order.id, backofficeCookie, { discount_pct: 5 })

      expect(response.statusCode).toBe(200)
      const discounted = response.json().order
      expect(Number(discounted.discount_pct)).toBe(5)
      // The subtotal stays the un-discounted figure; only the total moves.
      expect(discounted.subtotal_cents).toBe(10000)
      expect(discounted.total_cents).toBe(9500)
    })

    it('lets a back-office user set 10%, and 0 to take it off again', async () => {
      const order = await placeOrder()

      const ten = await patch(order.id, backofficeCookie, { discount_pct: 10 })
      expect(ten.statusCode).toBe(200)
      expect(ten.json().order.total_cents).toBe(9000)

      const none = await patch(order.id, backofficeCookie, { discount_pct: 0 })
      expect(none.statusCode).toBe(200)
      expect(none.json().order.total_cents).toBe(10000)
    })
  })

  describe('the director-only override', () => {
    it('403s a non-standard value from a back-office user and changes nothing', async () => {
      const order = await placeOrder()
      const response = await patch(order.id, backofficeCookie, {
        discount_pct: 7.5,
        discount_reason: 'I would like to, though',
      })

      expect(response.statusCode).toBe(403)
      expect(response.json().message).toMatch(/director/i)
      // The refusal rolled back — money and columns exactly as they were.
      const after = await orderFor(order.id)
      expect(Number(after.discount_pct)).toBe(0)
      expect(after.total_cents).toBe(10000)
    })

    it('422s a director override with no reason', async () => {
      const order = await placeOrder()
      const response = await patch(order.id, directorCookie, { discount_pct: 7.5 })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/reason/i)
    })

    it('accepts a director override with a reason and recomputes by the shared formula', async () => {
      const order = await placeOrder()
      const response = await patch(order.id, directorCookie, {
        discount_pct: 7.5,
        discount_reason: 'Hutchinson job, agreed with Rebecca 12 Aug',
      })

      expect(response.statusCode).toBe(200)
      const discounted = response.json().order
      expect(Number(discounted.discount_pct)).toBe(7.5)
      expect(discounted.discount_reason).toBe('Hutchinson job, agreed with Rebecca 12 Aug')
      expect(discounted.subtotal_cents).toBe(10000)
      // 10000 * 0.925 — and the same answer the pure mirror gives, which is
      // the tripwire that keeps the SQL and discounts.js agreeing.
      expect(discounted.total_cents).toBe(9250)
      expect(discounted.total_cents).toBe(
        discountedTotalCents(
          discounted.subtotal_cents,
          discounted.discount_pct,
          discounted.shipping_cents
        )
      )
    })

    it('records who applied it, from the session and never the body', async () => {
      const order = await placeOrder()
      const response = await patch(order.id, directorCookie, {
        discount_pct: 7.5,
        discount_reason: 'negotiated',
        // Ajv strips this unknown key; if it ever reached the module the
        // assertion below would catch the forgery.
        discount_applied_by: 999999,
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().order.discount_applied_by).toBe(directorId)
    })

    it('400s a reason travelling without a percentage', async () => {
      const order = await placeOrder()
      const response = await patch(order.id, backofficeCookie, {
        discount_reason: 'orphaned',
      })
      expect(response.statusCode).toBe(400)
    })

    it('refuses a discount on a paid order like any other commercial term', async () => {
      const order = await placeOrder()
      await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, {
        status: 'pending_payment',
        xero_invoice_ref: 'INV-DISC',
      })
      await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'paid' })

      const response = await patch(order.id, directorCookie, {
        discount_pct: 7.5,
        discount_reason: 'too late',
      })
      expect(response.statusCode).toBe(409)
    })
  })

  describe('the discount is an input to the one recompute', () => {
    it('survives a later line edit — the total keeps reflecting it', async () => {
      const order = await placeOrder()
      await patch(order.id, directorCookie, {
        discount_pct: 7.5,
        discount_reason: 'negotiated',
      })

      // An ordinary back-office repricing afterwards: 10 → 20 metres.
      const line = (await orderFor(order.id)).lines[0]
      const response = await patch(order.id, backofficeCookie, {
        lines: [{ id: line.id, qty: 20 }],
      })

      expect(response.statusCode).toBe(200)
      const edited = response.json().order
      expect(edited.subtotal_cents).toBe(20000)
      // 20000 * 0.925 — the override held through a recompute it did not run.
      expect(edited.total_cents).toBe(18500)
      expect(Number(edited.discount_pct)).toBe(7.5)
      expect(edited.discount_reason).toBe('negotiated')
    })

    it('clears the reason when the pct returns to a standard tier without one', async () => {
      const order = await placeOrder()
      await patch(order.id, directorCookie, {
        discount_pct: 7.5,
        discount_reason: 'negotiated',
      })

      const response = await patch(order.id, backofficeCookie, { discount_pct: 5 })

      expect(response.statusCode).toBe(200)
      // The pair travels together: a justification must not outlive the
      // override it justified.
      expect(response.json().order.discount_reason).toBeNull()
      expect(response.json().order.total_cents).toBe(9500)
    })
  })

  describe('POST /admin/orders with a discount', () => {
    const create = (cookie, extra = {}) =>
      inject('POST', '/admin/orders', cookie, {
        contact: { name: 'Keyed Client' },
        lines: [{ colourway_id: colourwayId, qty: 10, unit_price_cents: 1000 }],
        ...extra,
      })

    it('creates with a standard tier from a back-office user', async () => {
      const response = await create(backofficeCookie, { discount_pct: 10 })
      expect(response.statusCode).toBe(201)
      const order = response.json().order
      expect(order.subtotal_cents).toBe(10000)
      expect(order.total_cents).toBe(9000)
    })

    it('403s a non-standard create discount from a back-office user, writing nothing', async () => {
      const before = await pool.query('SELECT count(*)::int AS n FROM orders')
      const response = await create(backofficeCookie, {
        discount_pct: 12.5,
        discount_reason: 'trying it on',
      })
      expect(response.statusCode).toBe(403)
      const after = await pool.query('SELECT count(*)::int AS n FROM orders')
      expect(after.rows[0].n).toBe(before.rows[0].n)
    })

    it('creates a director override with a reason, stamped with the director', async () => {
      const response = await create(directorCookie, {
        discount_pct: 12.5,
        discount_reason: 'clearance, agreed at the showroom',
      })
      expect(response.statusCode).toBe(201)
      const order = response.json().order
      expect(Number(order.discount_pct)).toBe(12.5)
      expect(order.discount_applied_by).toBe(directorId)
      expect(order.total_cents).toBe(8750)
    })

    it('defaults to no discount and nobody having applied one', async () => {
      const response = await create(backofficeCookie)
      const order = response.json().order
      expect(Number(order.discount_pct)).toBe(0)
      expect(order.discount_reason).toBeNull()
      expect(order.discount_applied_by).toBeNull()
    })
  })

  describe('schema bounds', () => {
    it('400s a discount over 100 or under 0 before the module sees it', async () => {
      const order = await placeOrder()
      expect((await patch(order.id, directorCookie, { discount_pct: 101 })).statusCode).toBe(400)
      expect((await patch(order.id, directorCookie, { discount_pct: -1 })).statusCode).toBe(400)
    })
  })
})
