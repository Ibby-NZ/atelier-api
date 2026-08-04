import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'

// Two distinct email domains. The persistent boss/shopper live on DOMAIN and are
// registered ONCE in beforeAll (register shares a 10 / 15 min / IP rate-limit
// bucket, so re-registering per test would 429). The disposable per-test users
// live on FIXTURE_DOMAIN and are created via direct INSERT (which bypasses the
// bucket) and cleaned each test — the distinct domain means that cleanup can
// never touch the persistent users.
const DOMAIN = 'admin-usr-test.example.com'
const FIXTURE_DOMAIN = 'admin-usr-fixture.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const fixtureEmail = (local) => `${local}@${FIXTURE_DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// Inserted users never log in, so any non-empty hash string is fine.
const DUMMY_HASH = '$argon2id$dummy'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Create a disposable account directly (no register endpoint -> no rate-limit
// spend). Returns the new id.
const insertUser = async (pool, { local, name = null, role = 'customer', tradeApproved = false }) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, trade_approved)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [fixtureEmail(local), DUMMY_HASH, name, role, tradeApproved]
  )
  return rows[0].id
}

// Cleans ONLY the disposable users; the persistent boss/shopper (on DOMAIN)
// survive so their session cookies stay valid across tests.
const cleanupFixtureUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${FIXTURE_DOMAIN}`])

const deletePersistentUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

describe('back-office users admin', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  let bossId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

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

    await cleanupFixtureUsers(pool)
    await deletePersistentUsers(pool)

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
      testEmail('boss'),
    ])
    bossId = rows[0].id

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtureUsers(pool)
  })

  afterAll(async () => {
    await cleanupFixtureUsers(pool)
    await deletePersistentUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await inject('GET', '/admin/users', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await inject('GET', '/admin/users', customerCookie)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/users', () => {
    it('lists accounts without ever exposing password_hash', async () => {
      await insertUser(pool, { local: 'alice', name: 'Alice Client', role: 'customer' })
      const response = await inject('GET', '/admin/users', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const users = response.json().users
      const alice = users.find((u) => u.email === fixtureEmail('alice'))
      expect(alice).toBeDefined()
      expect(alice.role).toBe('customer')
      expect(alice).toHaveProperty('created_at')
      expect(alice).toHaveProperty('archived_at', null)
      expect(alice).not.toHaveProperty('password_hash')
    })

    it('filters by role', async () => {
      await insertUser(pool, { local: 'trade-user', role: 'trade', tradeApproved: true })
      await insertUser(pool, { local: 'plain-user', role: 'customer' })
      const response = await inject('GET', '/admin/users?role=trade', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('trade-user'))
      expect(emails).not.toContain(fixtureEmail('plain-user'))
    })

    it('rejects an unknown role filter with 400', async () => {
      const response = await inject('GET', '/admin/users?role=wizard', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })

    it('searches email and name with q', async () => {
      await insertUser(pool, { local: 'zephyrine', name: 'Zephyrine Testperson' })
      await insertUser(pool, { local: 'nomatch', name: 'Ordinary Person' })
      const response = await inject('GET', '/admin/users?q=Zephyrine', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('zephyrine'))
      expect(emails).not.toContain(fixtureEmail('nomatch'))
    })

    // `segment` is how the CRM navigates: the Clients section manages the people
    // who buy, Users & permissions manages the staff who serve them.
    it('segment=clients returns customer and trade accounts only', async () => {
      await insertUser(pool, { local: 'seg-customer', role: 'customer' })
      await insertUser(pool, { local: 'seg-trade', role: 'trade', tradeApproved: true })
      await insertUser(pool, { local: 'seg-staff', role: 'backoffice' })
      await insertUser(pool, { local: 'seg-boss', role: 'director' })

      const response = await inject('GET', '/admin/users?segment=clients', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('seg-customer'))
      expect(emails).toContain(fixtureEmail('seg-trade'))
      expect(emails).not.toContain(fixtureEmail('seg-staff'))
      expect(emails).not.toContain(fixtureEmail('seg-boss'))
    })

    it('segment=staff returns backoffice and director accounts only', async () => {
      await insertUser(pool, { local: 'seg2-customer', role: 'customer' })
      await insertUser(pool, { local: 'seg2-staff', role: 'backoffice' })

      const response = await inject('GET', '/admin/users?segment=staff', backofficeCookie)
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('seg2-staff'))
      expect(emails).not.toContain(fixtureEmail('seg2-customer'))
    })

    it('intersects segment with role — the Clients screen asking for trade only', async () => {
      await insertUser(pool, { local: 'seg3-customer', role: 'customer' })
      await insertUser(pool, { local: 'seg3-trade', role: 'trade' })

      const response = await inject(
        'GET',
        '/admin/users?segment=clients&role=trade',
        backofficeCookie
      )
      const emails = response.json().users.map((u) => u.email)
      expect(emails).toContain(fixtureEmail('seg3-trade'))
      expect(emails).not.toContain(fixtureEmail('seg3-customer'))
    })

    it('rejects an unknown segment with 400', async () => {
      const response = await inject('GET', '/admin/users?segment=wizards', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PATCH /admin/users/:id', () => {
    it('updates role and trade_approved together', async () => {
      const id = await insertUser(pool, { local: 'applicant', role: 'customer' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'trade',
        trade_approved: true,
      })
      expect(response.statusCode).toBe(200)
      const user = response.json().user
      expect(user.role).toBe('trade')
      expect(user.trade_approved).toBe(true)
    })

    it('rejects changing your own role with 422', async () => {
      const response = await inject('PATCH', `/admin/users/${bossId}`, backofficeCookie, {
        role: 'director',
      })
      expect(response.statusCode).toBe(422)
      // The account is untouched.
      const { rows } = await pool.query(`SELECT role FROM users WHERE id = $1`, [bossId])
      expect(rows[0].role).toBe('backoffice')
    })

    it('returns 404 patching an unknown id', async () => {
      const response = await inject('PATCH', '/admin/users/99999999', backofficeCookie, {
        name: 'Ghost',
      })
      expect(response.statusCode).toBe(404)
    })

    // Email is editable so a typo taken down over the phone can be corrected;
    // without it the account is unreachable and unfixable short of SQL.
    it('updates the email, lower-cased so login still resolves it', async () => {
      const id = await insertUser(pool, { local: 'typo', role: 'trade' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        email: `FIXED.Typo@${FIXTURE_DOMAIN}`,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.email).toBe(fixtureEmail('fixed.typo'))
    })

    it('answers 409 when the new email is already taken', async () => {
      const id = await insertUser(pool, { local: 'mover', role: 'trade' })
      await insertUser(pool, { local: 'incumbent', role: 'customer' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        email: fixtureEmail('incumbent'),
      })
      expect(response.statusCode).toBe(409)
      // The original address is untouched, so nothing is left half-moved.
      const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [id])
      expect(rows[0].email).toBe(fixtureEmail('mover'))
    })

    // trade_approved only means anything on a trade row. Leaving it set on a
    // demoted account strands a flag nothing displays, and re-promoting later
    // restores trade pricing and every trade-only house with no review.
    it('clears trade_approved when the role moves off trade', async () => {
      const id = await insertUser(pool, {
        local: 'demoted',
        role: 'trade',
        tradeApproved: true,
      })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'customer',
      })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.trade_approved).toBe(false)
    })

    it('ignores a contradictory trade_approved sent with a non-trade role', async () => {
      const id = await insertUser(pool, { local: 'contradiction', role: 'trade' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        role: 'backoffice',
        trade_approved: true,
      })
      expect(response.json().user.trade_approved).toBe(false)
    })

    it('leaves trade_approved alone when the role is not part of the patch', async () => {
      const id = await insertUser(pool, {
        local: 'renamed',
        role: 'trade',
        tradeApproved: true,
      })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        name: 'New Name',
      })
      expect(response.json().user.trade_approved).toBe(true)
    })

    it('rejects a malformed email with 400 by schema', async () => {
      const id = await insertUser(pool, { local: 'badmail', role: 'customer' })
      const response = await inject('PATCH', `/admin/users/${id}`, backofficeCookie, {
        email: 'not-an-address',
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('archive / restore', () => {
    it('archive hides from the default list, include_archived shows it, restore brings it back', async () => {
      const id = await insertUser(pool, { local: 'leaver', name: 'Departing Client' })

      const archive = await inject('POST', `/admin/users/${id}/archive`, backofficeCookie)
      expect(archive.statusCode).toBe(200)
      expect(archive.json().user.archived_at).not.toBeNull()

      // Hidden from the default list.
      const defaultList = await inject('GET', '/admin/users', backofficeCookie)
      expect(defaultList.json().users.some((u) => u.id === id)).toBe(false)

      // Visible again with include_archived.
      const withArchived = await inject(
        'GET',
        '/admin/users?include_archived=true',
        backofficeCookie
      )
      expect(withArchived.json().users.some((u) => u.id === id)).toBe(true)

      const restore = await inject('POST', `/admin/users/${id}/restore`, backofficeCookie)
      expect(restore.statusCode).toBe(200)
      expect(restore.json().user.archived_at).toBeNull()

      // Back in the default list.
      const afterRestore = await inject('GET', '/admin/users', backofficeCookie)
      expect(afterRestore.json().users.some((u) => u.id === id)).toBe(true)
    })

    it('rejects archiving your own account with 422', async () => {
      const response = await inject('POST', `/admin/users/${bossId}/archive`, backofficeCookie)
      expect(response.statusCode).toBe(422)
      const { rows } = await pool.query(`SELECT archived_at FROM users WHERE id = $1`, [
        bossId,
      ])
      expect(rows[0].archived_at).toBeNull()
    })

    it('returns 404 archiving an unknown id', async () => {
      const response = await inject('POST', '/admin/users/99999999/archive', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('GET /admin/users/:id', () => {
    it('returns a single account', async () => {
      const id = await insertUser(pool, { local: 'solo', name: 'Solo Client' })
      const response = await inject('GET', `/admin/users/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().user.email).toBe(fixtureEmail('solo'))
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject('GET', '/admin/users/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /admin/users', () => {
    it('creates an account with the default temp password (201)', async () => {
      const response = await inject('POST', '/admin/users', backofficeCookie, {
        email: fixtureEmail('created'),
        name: 'Created Staff',
        role: 'backoffice',
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.user.email).toBe(fixtureEmail('created'))
      expect(body.user.role).toBe('backoffice')
      expect(body.user).not.toHaveProperty('password_hash')
      expect(body.temp_password).toBe('AtelierTemp2026!')
    })

    it('409s a duplicate email', async () => {
      await inject('POST', '/admin/users', backofficeCookie, {
        email: fixtureEmail('dupe'),
        role: 'customer',
      })
      const again = await inject('POST', '/admin/users', backofficeCookie, {
        email: fixtureEmail('dupe'),
        role: 'customer',
      })
      expect(again.statusCode).toBe(409)
    })

    it('400s an invalid email or unknown role', async () => {
      expect(
        (await inject('POST', '/admin/users', backofficeCookie, { email: 'nope', role: 'customer' }))
          .statusCode
      ).toBe(400)
      expect(
        (await inject('POST', '/admin/users', backofficeCookie, { email: fixtureEmail('x'), role: 'wizard' }))
          .statusCode
      ).toBe(400)
    })

    it('rejects a non-backoffice caller (403)', async () => {
      const response = await inject('POST', '/admin/users', customerCookie, {
        email: fixtureEmail('nope'),
        role: 'customer',
      })
      expect(response.statusCode).toBe(403)
    })
  })
})
