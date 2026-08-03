import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { effectiveRole } from '../src/auth/guards.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const TEST_DOMAIN = 'guards-test.example.com'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`
const PASSWORD = 'correct horse battery'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const deleteTestUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])

describe('effectiveRole', () => {
  it('treats an unapproved trade user as a customer', () => {
    expect(effectiveRole({ role: 'trade', trade_approved: false })).toBe('customer')
  })

  it('keeps other roles as-is', () => {
    expect(effectiveRole({ role: 'trade', trade_approved: true })).toBe('trade')
    expect(effectiveRole({ role: 'customer', trade_approved: false })).toBe('customer')
    expect(effectiveRole({ role: 'backoffice', trade_approved: false })).toBe('backoffice')
    expect(effectiveRole({ role: 'director', trade_approved: false })).toBe('director')
  })
})

describe('role guards and trade application', () => {
  let pool
  let app
  const cookies = {}

  const signUp = async (url, local) => {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: { email: testEmail(local), password: PASSWORD, name: local },
    })
    expect(response.statusCode).toBe(201)
    cookies[local] = sessionCookieFrom(response)
    return response.json().user
  }

  const getWithCookie = (url, local) =>
    app.inject({ method: 'GET', url, headers: { cookie: cookies[local] } })

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
    await deleteTestUsers(pool)

    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })

    // Sample protected routes exercising the guards, mirroring how real
    // admin/trade routes will register them.
    app.get(
      '/test/auth-only',
      { preHandler: app.guards.requireAuth },
      async (request) => ({ userId: request.user.id, role: request.user.role })
    )
    app.get(
      '/test/trade-only',
      { preHandler: app.guards.requireRole('trade') },
      async () => ({ capability: 'trade-pricing' })
    )
    app.get(
      '/test/backoffice-only',
      { preHandler: app.guards.requireRole('backoffice') },
      async () => ({ ok: true })
    )
    // Mirrors the optional-auth pattern the public catalogue routes use to
    // decide whether to include trade pricing.
    app.get('/test/optional-user', async (request) => {
      const user = await app.guards.loadOptionalUser(request)
      return { role: user ? effectiveRole(user) : null }
    })
    await app.ready()

    await signUp('/auth/register', 'customer')
    await signUp('/auth/trade-application', 'trader')
    const backoffice = await signUp('/auth/register', 'backoffice')
    const director = await signUp('/auth/register', 'director')
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE id = $1`, [
      backoffice.id,
    ])
    await pool.query(`UPDATE users SET role = 'director' WHERE id = $1`, [
      director.id,
    ])
  })

  afterAll(async () => {
    await deleteTestUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('POST /auth/trade-application', () => {
    it('creates an unapproved trade user and never returns the hash', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/trade-application',
        payload: { email: testEmail('trader2'), password: PASSWORD },
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.user).toMatchObject({
        email: testEmail('trader2'),
        role: 'trade',
        trade_approved: false,
      })
      expect(JSON.stringify(body)).not.toContain('hash')
      expect(String(response.headers['set-cookie'])).toContain('atelier_session=')
    })

    it('rejects a duplicate email with 409', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/trade-application',
        payload: { email: testEmail('trader'), password: PASSWORD },
      })
      expect(response.statusCode).toBe(409)
    })
  })

  describe('requireAuth', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/test/auth-only' })
      expect(response.statusCode).toBe(401)
    })

    it('rejects a valid cookie whose user no longer exists', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail('ghost'), password: PASSWORD },
      })
      const cookie = sessionCookieFrom(response)
      await pool.query('DELETE FROM users WHERE email = $1', [testEmail('ghost')])
      const blocked = await app.inject({
        method: 'GET',
        url: '/test/auth-only',
        headers: { cookie },
      })
      expect(blocked.statusCode).toBe(401)
    })

    it('sets request.user for a logged-in user', async () => {
      const response = await getWithCookie('/test/auth-only', 'customer')
      expect(response.statusCode).toBe(200)
      expect(response.json().role).toBe('customer')
    })
  })

  describe("requireRole('backoffice')", () => {
    it('blocks a customer with 403', async () => {
      const response = await getWithCookie('/test/backoffice-only', 'customer')
      expect(response.statusCode).toBe(403)
    })

    it('blocks an anonymous request with 401', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/test/backoffice-only',
      })
      expect(response.statusCode).toBe(401)
    })

    it('passes a backoffice user', async () => {
      const response = await getWithCookie('/test/backoffice-only', 'backoffice')
      expect(response.statusCode).toBe(200)
    })

    it('passes a director (superset of backoffice)', async () => {
      const response = await getWithCookie('/test/backoffice-only', 'director')
      expect(response.statusCode).toBe(200)
    })
  })

  describe("requireRole('trade') and the approval gate", () => {
    it('blocks a customer with 403', async () => {
      const response = await getWithCookie('/test/trade-only', 'customer')
      expect(response.statusCode).toBe(403)
    })

    it('blocks an unapproved trade user (no trade capability)', async () => {
      const response = await getWithCookie('/test/trade-only', 'trader')
      expect(response.statusCode).toBe(403)
    })

    it('passes the same user once trade_approved is set', async () => {
      await pool.query(
        'UPDATE users SET trade_approved = true WHERE email = $1',
        [testEmail('trader')]
      )
      const response = await getWithCookie('/test/trade-only', 'trader')
      expect(response.statusCode).toBe(200)
      expect(response.json().capability).toBe('trade-pricing')
    })
  })

  // Runs last, and restores the account it archives: the trade suite above
  // depends on 'trader' still being live.
  describe('archived accounts lose every capability', () => {
    const archive = (local, archived) =>
      pool.query(
        `UPDATE users SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE email = $1`,
        [testEmail(local)]
      )

    it('blocks requireAuth for an archived user holding a valid cookie', async () => {
      await archive('customer', true)
      const response = await getWithCookie('/test/auth-only', 'customer')
      expect(response.statusCode).toBe(401)
      await archive('customer', false)
      expect((await getWithCookie('/test/auth-only', 'customer')).statusCode).toBe(200)
    })

    it('drops an archived approved-trade user back to anonymous on public routes', async () => {
      const live = await getWithCookie('/test/optional-user', 'trader')
      expect(live.json().role).toBe('trade')

      await archive('trader', true)
      const archived = await getWithCookie('/test/optional-user', 'trader')
      // null, not 'customer': an archived account is nobody, so no trade pricing.
      expect(archived.json().role).toBeNull()
      expect((await getWithCookie('/test/trade-only', 'trader')).statusCode).toBe(401)

      await archive('trader', false)
      expect((await getWithCookie('/test/trade-only', 'trader')).statusCode).toBe(200)
    })
  })

  it('requireRole throws on an unknown role at registration time', () => {
    expect(() => app.guards.requireRole('superadmin')).toThrow(/unknown role/)
  })
})
