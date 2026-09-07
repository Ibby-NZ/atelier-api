import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'
import { hashPassword } from '../src/auth/passwords.js'
import { RESET_TOKEN_TTL_MINUTES, issueResetTokenFor } from '../src/auth/password-reset.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'pw-reset-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const OLD_PASSWORD = 'the password before the reset'
const NEW_PASSWORD = 'the password after the reset'
const STORE_BASE_URL = 'https://store.test'
const CRM_BASE_URL = 'https://crm.test'

// A transport that records every message instead of sending it.
const captureTransport = () => {
  const sent = []
  return { sent, sendMail: async (message) => sent.push(message) }
}

const tokenFrom = (message) =>
  new URL(message.text.match(/https?:\S+/)[0]).searchParams.get('token')

const deleteTestUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

// Direct INSERT: the register route shares a 10 / 15 min rate-limit bucket and
// this suite makes more accounts than that. Each one gets a real argon2 hash so
// the "old password still works" assertions mean something.
const insertUser = async (pool, local, { role = 'customer', tradeApproved = false } = {}) => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, role, trade_approved)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [testEmail(local), await hashPassword(OLD_PASSWORD), `Person ${local}`, role, tradeApproved]
  )
  return rows[0].id
}

describe('password reset by emailed link', () => {
  let pool
  let app
  let transport

  const forgot = (email) =>
    app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } })
  const reset = (token, password = NEW_PASSWORD) =>
    app.inject({ method: 'POST', url: '/auth/reset-password', payload: { token, password } })
  const login_ = (target, email, password) =>
    target.inject({ method: 'POST', url: '/auth/login', payload: { email, password } })
  const login = (email, password) => login_(app, email, password)

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
    transport = captureTransport()
    const mailer = createMailer({
      transport,
      from: 'studio@atelier.test',
      backofficeEmail: 'office@atelier.test',
    })
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      mailer,
      storeBaseUrl: STORE_BASE_URL,
      crmBaseUrl: CRM_BASE_URL,
      logger: false,
    })
    await app.ready()
  })

  // The two routes each carry a 10 / 15 min / IP bucket, per app instance, and
  // this suite spends more than that. The reset half runs on its own instance
  // and issues tokens directly, so the forgot bucket is not what caps it.
  const freshApp = async () => {
    const mailer = createMailer({
      transport,
      from: 'studio@atelier.test',
      backofficeEmail: 'office@atelier.test',
    })
    const next = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      mailer,
      storeBaseUrl: STORE_BASE_URL,
      crmBaseUrl: CRM_BASE_URL,
      logger: false,
    })
    await next.ready()
    return next
  }

  afterAll(async () => {
    await deleteTestUsers(pool)
    await app.close()
    await pool.end()
  })

  beforeEach(() => {
    transport.sent.length = 0
  })

  describe('POST /auth/forgot-password', () => {
    it('emails a storefront link to a client, and the letter names the expiry', async () => {
      await insertUser(pool, 'client')
      const response = await forgot(testEmail('client'))
      expect(response.statusCode).toBe(202)

      expect(transport.sent).toHaveLength(1)
      const [message] = transport.sent
      expect(message.to).toBe(testEmail('client'))
      expect(message.subject).toMatch(/reset your password/i)
      expect(message.text).toContain(`${STORE_BASE_URL}/reset-password?token=`)
      expect(message.text).toContain(`${RESET_TOKEN_TTL_MINUTES} minutes`)
      expect(tokenFrom(message)).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    })

    it('sends staff to the CRM instead', async () => {
      await insertUser(pool, 'staff', { role: 'backoffice' })
      await forgot(testEmail('staff'))
      expect(transport.sent[0].text).toContain(`${CRM_BASE_URL}/#/reset-password?token=`)
    })

    it('answers an unknown address with the same 202 and sends nothing', async () => {
      const known = await forgot(testEmail('client'))
      const unknown = await forgot(testEmail('nobody'))
      expect(unknown.statusCode).toBe(202)
      expect(unknown.json()).toEqual(known.json())
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0].to).toBe(testEmail('client'))
    })

    it('sends nothing to an archived account', async () => {
      const id = await insertUser(pool, 'archived')
      await pool.query('UPDATE users SET archived_at = now() WHERE id = $1', [id])
      const response = await forgot(testEmail('archived'))
      expect(response.statusCode).toBe(202)
      expect(transport.sent).toHaveLength(0)
    })

    it('matches the address case-insensitively', async () => {
      await forgot(testEmail('CLIENT').toUpperCase())
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0].to).toBe(testEmail('client'))
    })

    it('rejects a malformed address with 400', async () => {
      const response = await forgot('not-an-email')
      expect(response.statusCode).toBe(400)
    })
  })

  describe('without SMTP (a transport that captures but does not deliver)', () => {
    let quietApp
    beforeAll(async () => {
      const transport = { delivers: false, sent: [], sendMail: async (m) => transport.sent.push(m) }
      const mailer = createMailer({ transport, from: 'studio@atelier.test', backofficeEmail: 'office@atelier.test' })
      quietApp = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, mailer, logger: false })
      await quietApp.ready()
    })
    afterAll(async () => {
      await quietApp.close()
    })

    it('forgot-password says so with 503 instead of promising a letter', async () => {
      await insertUser(pool, 'unmailed')
      const response = await quietApp.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: testEmail('unmailed') },
      })
      expect(response.statusCode).toBe(503)
      expect(response.json().error).toMatch(/cannot send email/)
    })

    it('the back-office reset says so too, while a supplied password still works', async () => {
      const staffId = await insertUser(pool, 'quiet-staff', { role: 'backoffice' })
      const clientId = await insertUser(pool, 'quiet-client')
      const login = await quietApp.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('quiet-staff'), password: OLD_PASSWORD },
      })
      expect(login.statusCode).toBe(200)
      const header = login.headers['set-cookie']
      const cookie = (Array.isArray(header) ? header[0] : header).split(';')[0]

      const emailed = await quietApp.inject({
        method: 'POST',
        url: `/admin/users/${clientId}/reset-password`,
        headers: { cookie },
        payload: {},
      })
      expect(emailed.statusCode).toBe(503)
      expect(emailed.json().message).toMatch(/SMTP_HOST is unset/)

      const direct = await quietApp.inject({
        method: 'POST',
        url: `/admin/users/${clientId}/reset-password`,
        headers: { cookie },
        payload: { password: NEW_PASSWORD },
      })
      expect(direct.statusCode).toBe(200)
      expect((await login_(quietApp, testEmail('quiet-client'), NEW_PASSWORD)).statusCode).toBe(200)
      expect(staffId).toBeGreaterThan(0)
    })
  })

  describe('POST /auth/reset-password', () => {
    beforeAll(async () => {
      await app.close()
      app = await freshApp()
    })

    it('changes the password, once, and signs in with the new one', async () => {
      const id = await insertUser(pool, 'once')
      const token = await issueResetTokenFor(pool, id)

      const response = await reset(token)
      expect(response.statusCode).toBe(200)
      expect(response.json().user).toMatchObject({ email: testEmail('once') })
      expect(response.json().user.password_hash).toBeUndefined()
      // No session is minted by the reset itself.
      expect(response.headers['set-cookie']).toBeUndefined()

      expect((await login(testEmail('once'), NEW_PASSWORD)).statusCode).toBe(200)
      expect((await login(testEmail('once'), OLD_PASSWORD)).statusCode).toBe(401)

      // Single use.
      const again = await reset(token, 'yet another password')
      expect(again.statusCode).toBe(400)
      expect((await login(testEmail('once'), NEW_PASSWORD)).statusCode).toBe(200)
    })

    it('rejects an unknown token with 400 and changes nothing', async () => {
      const response = await reset('not-a-token-anyone-was-sent')
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toMatch(/invalid or has expired/)
    })

    it('rejects an expired token', async () => {
      const id = await insertUser(pool, 'late')
      const token = await issueResetTokenFor(pool, id)
      await pool.query(
        `UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
        [id]
      )
      expect((await reset(token)).statusCode).toBe(400)
      expect((await login(testEmail('late'), OLD_PASSWORD)).statusCode).toBe(200)
    })

    it('a fresh request voids the earlier link', async () => {
      const id = await insertUser(pool, 'twice')
      const first = await issueResetTokenFor(pool, id)
      const second = await issueResetTokenFor(pool, id)
      expect(second).not.toBe(first)

      expect((await reset(first)).statusCode).toBe(400)
      expect((await reset(second)).statusCode).toBe(200)
    })

    it('refuses a token whose account was archived after it was issued', async () => {
      const id = await insertUser(pool, 'archived-later')
      const token = await issueResetTokenFor(pool, id)
      await pool.query('UPDATE users SET archived_at = now() WHERE id = $1', [id])
      expect((await reset(token)).statusCode).toBe(400)
    })

    it('holds the new password to the same floor as registration', async () => {
      const id = await insertUser(pool, 'floor')
      const token = await issueResetTokenFor(pool, id)
      expect((await reset(token, 'short')).statusCode).toBe(400)
      // A schema refusal spends nothing: the link still works.
      expect((await reset(token)).statusCode).toBe(200)
    })

    it('never stores the raw token', async () => {
      const id = await insertUser(pool, 'hashed')
      const token = await issueResetTokenFor(pool, id)
      const { rows } = await pool.query(
        'SELECT token_hash FROM password_reset_tokens WHERE user_id = $1',
        [id]
      )
      expect(rows[0].token_hash).not.toBe(token)
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    })
  })
})
