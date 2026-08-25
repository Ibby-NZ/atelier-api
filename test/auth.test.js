import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { MIN_PASSWORD_LENGTH } from '../src/auth/passwords.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const TEST_DOMAIN = 'auth-test.example.com'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`

// Reuses the "name=value" pair from Set-Cookie verbatim so signed values survive round-trips.
const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const deleteTestUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])

describe('config', () => {
  it('throws a clear error when COOKIE_SECRET is unset', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://localhost:5432/atelier_dev' })
    ).toThrow(/COOKIE_SECRET is not set/)
  })

  it('rejects a too-short COOKIE_SECRET', () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: 'postgresql://localhost:5432/atelier_dev',
        COOKIE_SECRET: 'short',
      })
    ).toThrow(/COOKIE_SECRET/)
  })
})

describe('auth endpoints', () => {
  let pool
  let app

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
    await app.ready()
  })

  afterAll(async () => {
    await deleteTestUsers(pool)
    await app.close()
    await pool.end()
  })

  it('requires a cookie secret to build the app', () => {
    expect(() => buildApp({ pool, logger: false })).toThrow(/cookieSecret/)
  })

  describe('POST /auth/register', () => {
    it('creates a customer, returns the user without the hash, sets a session cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: testEmail('alice'),
          password: 'correct horse battery',
          name: 'Alice',
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.user).toMatchObject({
        email: testEmail('alice'),
        name: 'Alice',
        role: 'customer',
        trade_approved: false,
      })
      expect(body.user.id).toBeGreaterThan(0)
      expect(JSON.stringify(body)).not.toContain('hash')

      const setCookie = String(response.headers['set-cookie'])
      expect(setCookie).toContain('atelier_session=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('Secure')
      expect(setCookie).toContain('SameSite=Lax')
    })

    it('rejects a duplicate email with 409', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail('alice'), password: 'another password' },
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().error).toMatch(/already exists/)
    })

    it('rejects an invalid email with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'not-an-email', password: 'long enough password' },
      })
      expect(response.statusCode).toBe(400)
    })

    it('rejects a short password with 400', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail('shortpw'), password: 'short' },
      })
      expect(response.statusCode).toBe(400)
    })

    it('rejects a password one character under the minimum', async () => {
      // Pins the floor itself rather than merely that something short fails —
      // MIN_PASSWORD_LENGTH is imported so this cannot drift away from the rule
      // it guards, and 'short' above would keep passing at any minimum >= 6.
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: {
          email: testEmail('boundarypw'),
          password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1),
        },
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('POST /auth/login and GET /auth/me', () => {
    it('logs in with correct credentials and /auth/me returns the user', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('alice'), password: 'correct horse battery' },
      })
      expect(login.statusCode).toBe(200)
      expect(login.json().user.email).toBe(testEmail('alice'))
      expect(JSON.stringify(login.json())).not.toContain('hash')

      const me = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: sessionCookieFrom(login) },
      })
      expect(me.statusCode).toBe(200)
      expect(me.json().user).toMatchObject({
        email: testEmail('alice'),
        role: 'customer',
      })
      expect(JSON.stringify(me.json())).not.toContain('hash')
    })

    it('rejects a wrong password with 401 and no cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('alice'), password: 'wrong password here' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.headers['set-cookie']).toBeUndefined()
    })

    it('rejects an unknown email with the same 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('nobody'), password: 'whatever password' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.json().error).toMatch(/Invalid email or password/)
    })

    it('rejects /auth/me without a session', async () => {
      const response = await app.inject({ method: 'GET', url: '/auth/me' })
      expect(response.statusCode).toBe(401)
    })

    it('rejects /auth/me with a tampered cookie', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: 'atelier_session=1.forged-signature' },
      })
      expect(response.statusCode).toBe(401)
    })
  })

  // Archiving is the back office's "remove this account" action (US-023). It is
  // a soft delete precisely because commerce records point at the row, so the
  // row survives — which means access has to be denied explicitly. Without
  // these, an archived account keeps its live session AND can log back in.
  describe('archived accounts', () => {
    it('refuses to log an archived account in, with the generic 401', async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail('archived'), password: 'correct horse battery' },
      })
      await pool.query('UPDATE users SET archived_at = now() WHERE email = $1', [
        testEmail('archived'),
      ])

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('archived'), password: 'correct horse battery' },
      })
      expect(response.statusCode).toBe(401)
      // Same message as a wrong password: archiving must not be discoverable.
      expect(response.json().error).toMatch(/Invalid email or password/)
      expect(response.headers['set-cookie']).toBeUndefined()
    })

    it('rejects a session cookie minted before the account was archived', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('alice'), password: 'correct horse battery' },
      })
      const cookie = sessionCookieFrom(login)

      await pool.query('UPDATE users SET archived_at = now() WHERE email = $1', [
        testEmail('alice'),
      ])
      const me = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie },
      })
      expect(me.statusCode).toBe(401)
      // Same treatment as a deleted user: drop the now-useless cookie.
      expect(String(me.headers['set-cookie'])).toMatch(/Expires=|Max-Age=0/)

      await pool.query('UPDATE users SET archived_at = NULL WHERE email = $1', [
        testEmail('alice'),
      ])
      const restored = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie },
      })
      expect(restored.statusCode).toBe(200)
    })
  })

  describe('POST /auth/logout', () => {
    it('clears the session cookie', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('alice'), password: 'correct horse battery' },
      })
      const logout = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { cookie: sessionCookieFrom(login) },
      })
      expect(logout.statusCode).toBe(204)
      const setCookie = String(logout.headers['set-cookie'])
      expect(setCookie).toContain('atelier_session=')
      expect(setCookie).toMatch(/Expires=|Max-Age=0/)
    })
  })
})

describe('login rate limiting', () => {
  let pool
  let app

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    // Fresh app instance: the limiter store is per-instance and other suites
    // above already spent login attempts for this IP.
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
  })

  it('returns 429 on the 11th login attempt from one IP', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('nobody'), password: 'wrong password here' },
      })

    for (let i = 0; i < 10; i += 1) {
      const response = await attempt()
      expect(response.statusCode).toBe(401)
    }

    const eleventh = await attempt()
    expect(eleventh.statusCode).toBe(429)
  })

  it('returns 429 on the 11th register attempt from one IP', async () => {
    // Invalid payload (schema 400) still counts: the limiter runs before
    // validation, and this keeps the test free of argon2 hashing and inserts.
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'not-an-email', password: 'short' },
      })

    for (let i = 0; i < 10; i += 1) {
      const response = await attempt()
      expect(response.statusCode).toBe(400)
    }

    const eleventh = await attempt()
    expect(eleventh.statusCode).toBe(429)
  })
})
