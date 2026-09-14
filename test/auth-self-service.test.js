import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/passwords.js'

// Self-service account maintenance: the two things a client could not do for
// themselves before (edit their details, change their password) and the two
// things they still must not (change the sign-in email, skip the old password).
//
// Its own buildApp(): every route here sits in the auth rate-limit bucket and
// the limiter store is per instance AND per route, so sharing an app with
// another suite would let the two spend each other's attempts.
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'self-service-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const OLD_PASSWORD = 'the password they had'
const NEW_PASSWORD = 'the password they chose'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const deleteTestUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

// Direct INSERT rather than POST /auth/register: register shares the same
// 10 / 15 min bucket and the account is not what is under test here.
const insertUser = async (pool, local) =>
  pool.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, $2, $3, 'customer')`,
    [testEmail(local), await hashPassword(OLD_PASSWORD), 'Before Edit']
  )

describe('self-service profile and password', () => {
  let pool
  let app
  let cookie

  const patchMe = (payload, headers = { cookie }) =>
    app.inject({ method: 'PATCH', url: '/auth/me', payload, headers })
  const changePassword = (payload, headers = { cookie }) =>
    app.inject({ method: 'POST', url: '/auth/change-password', payload, headers })
  const login = (password) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: testEmail('client'), password },
    })

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
    await insertUser(pool, 'client')
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    cookie = sessionCookieFrom(await login(OLD_PASSWORD))
  })

  afterAll(async () => {
    await deleteTestUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('PATCH /auth/me', () => {
    it('edits the name and phone and hands them back on /auth/me', async () => {
      const response = await patchMe({ name: 'Nina Client', phone: '021 555 0134' })

      expect(response.statusCode).toBe(200)
      expect(response.json().user).toMatchObject({
        email: testEmail('client'),
        name: 'Nina Client',
        phone: '021 555 0134',
      })
      expect(JSON.stringify(response.json())).not.toContain('hash')

      // phone reaches the session read because it is in PUBLIC_USER_COLUMNS —
      // the storefront prefills the order-request form from this payload.
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
      expect(me.json().user).toMatchObject({ name: 'Nina Client', phone: '021 555 0134' })
    })

    it('clears the phone when the field is sent empty', async () => {
      const response = await patchMe({ phone: '  ' })
      expect(response.statusCode).toBe(200)
      expect(response.json().user.phone).toBeNull()
      expect(response.json().user.name).toBe('Nina Client')
    })

    it('never changes the sign-in email, even when one is sent', async () => {
      // Ajv strips the unknown key silently (removeAdditional), so the body
      // arrives as {name}; PROFILE_COLUMNS is what actually keeps email out.
      const response = await patchMe({ name: 'Nina Client', email: testEmail('stolen') })

      expect(response.statusCode).toBe(200)
      expect(response.json().user.email).toBe(testEmail('client'))
      const { rows } = await pool.query('SELECT email FROM users WHERE email = $1', [
        testEmail('stolen'),
      ])
      expect(rows).toHaveLength(0)
    })

    it('401s without a session', async () => {
      const response = await patchMe({ name: 'Nobody' }, {})
      expect(response.statusCode).toBe(401)
    })
  })

  describe('POST /auth/change-password', () => {
    it('401s on the wrong current password and leaves the old one working', async () => {
      const response = await changePassword({
        current_password: 'not the password they had',
        new_password: NEW_PASSWORD,
      })
      expect(response.statusCode).toBe(401)
      expect(response.json().error).toMatch(/current password/i)
      expect((await login(OLD_PASSWORD)).statusCode).toBe(200)
    })

    it('rejects a new password one character under the floor', async () => {
      const response = await changePassword({
        current_password: OLD_PASSWORD,
        new_password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1),
      })
      expect(response.statusCode).toBe(400)
    })

    it('401s without a session', async () => {
      const response = await changePassword(
        { current_password: OLD_PASSWORD, new_password: NEW_PASSWORD },
        {}
      )
      expect(response.statusCode).toBe(401)
    })

    it('changes the password, and the new one is what signs in', async () => {
      const response = await changePassword({
        current_password: OLD_PASSWORD,
        new_password: NEW_PASSWORD,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })

      expect((await login(OLD_PASSWORD)).statusCode).toBe(401)
      expect((await login(NEW_PASSWORD)).statusCode).toBe(200)
      // Sessions are stateless signed cookies: the one held here is untouched.
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })
      expect(me.statusCode).toBe(200)
    })
  })
})
