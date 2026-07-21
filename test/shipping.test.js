import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const TEST_DOMAIN = 'shipping-test.example.com'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`
const PASSWORD = 'correct horse battery'

// Own test zones so the suite never depends on whether the seed has run and
// cleans up after itself.
const ZONE = 'Shipping Test Zone'
const EMPTY_ZONE = 'Nowhere Test Zone'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const deleteTestData = async (pool) => {
  await pool.query('DELETE FROM shipping_rates WHERE zone LIKE $1', ['%Test Zone'])
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])
}

describe('shipping quote and admin rates', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

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
    await deleteTestData(pool)

    // Two tiers: floor 0 -> 1200c, floor 20 -> 3000c.
    await pool.query(
      `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
       VALUES ($1, 0, 1200), ($1, 20, 3000)`,
      [ZONE]
    )

    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    const backoffice = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(backoffice)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const customer = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(customer)
  })

  afterAll(async () => {
    await deleteTestData(pool)
    await app.close()
    await pool.end()
  })

  const quote = (zone, qty) =>
    app.inject({
      method: 'GET',
      url: `/shipping/quote?zone=${encodeURIComponent(zone)}&qty=${qty}`,
    })

  describe('GET /shipping/quote', () => {
    it('returns the lower tier below the threshold', async () => {
      const response = await quote(ZONE, 5)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        zone: ZONE,
        rate_cents: 1200,
        threshold_qty: 0,
      })
    })

    it('returns the upper tier exactly at the threshold boundary', async () => {
      const response = await quote(ZONE, 20)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ rate_cents: 3000, threshold_qty: 20 })
    })

    it('stays on the lower tier just under the threshold', async () => {
      const response = await quote(ZONE, 19.99)
      expect(response.statusCode).toBe(200)
      expect(response.json().rate_cents).toBe(1200)
    })

    it('returns the upper tier above the threshold', async () => {
      const response = await quote(ZONE, 100)
      expect(response.statusCode).toBe(200)
      expect(response.json().rate_cents).toBe(3000)
    })

    it('returns 400 with a clear message for an unknown zone', async () => {
      const response = await quote(EMPTY_ZONE, 5)
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain(EMPTY_ZONE)
    })

    it('returns 400 when qty is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/shipping/quote?zone=${encodeURIComponent(ZONE)}`,
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PUT /admin/shipping-rates', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        payload: { rates: [{ zone: ZONE, threshold_qty: 0, rate_cents: 999 }] },
      })
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: customerCookie },
        payload: { rates: [{ zone: ZONE, threshold_qty: 0, rate_cents: 999 }] },
      })
      expect(response.statusCode).toBe(403)
    })

    it('updates an existing tier for a backoffice user', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: { rates: [{ zone: ZONE, threshold_qty: 0, rate_cents: 1500 }] },
      })
      expect(response.statusCode).toBe(200)
      const updated = await quote(ZONE, 5)
      expect(updated.json().rate_cents).toBe(1500)
    })

    it('adds a new tier without redeploy', async () => {
      await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: { rates: [{ zone: ZONE, threshold_qty: 50, rate_cents: 6000 }] },
      })
      const updated = await quote(ZONE, 60)
      expect(updated.json()).toMatchObject({ rate_cents: 6000, threshold_qty: 50 })
    })

    it('rejects an empty rates array with 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: { rates: [] },
      })
      expect(response.statusCode).toBe(400)
    })
  })
})
