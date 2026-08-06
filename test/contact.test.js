import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'contact-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const FROM = 'studio@atelier.test'
const BACKOFFICE = 'backoffice@atelier.test'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// A transport that records every message instead of sending it.
const captureTransport = () => {
  const sent = []
  return { sent, sendMail: async (message) => sent.push(message) }
}

// Enquiries carry the test-domain email, so we can clean them by suffix.
const cleanEnquiries = (pool) =>
  pool.query('DELETE FROM contact_enquiries WHERE email LIKE $1', [`%@${DOMAIN}`])

describe('contact form + enquiries inbox', () => {
  let pool
  let app
  let transport
  let backofficeCookie
  let customerCookie

  const post = (payload, headers = {}) =>
    app.inject({ method: 'POST', url: '/contact', payload, headers })

  const inject = (method, url, cookie) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {} })

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
    transport = captureTransport()
    const mailer = createMailer({ transport, from: FROM, backofficeEmail: BACKOFFICE })
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, mailer, logger: false })
    await app.ready()

    await cleanEnquiries(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Register staff + customer ONCE (register shares a 10/15min rate bucket).
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
    await cleanEnquiries(pool)
    transport.sent.length = 0
  })

  afterAll(async () => {
    await cleanEnquiries(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  describe('POST /contact', () => {
    it('stores an enquiry and emails sender + back office (201)', async () => {
      const response = await post({
        name: 'Ada Lovelace',
        email: testEmail('ada'),
        phone: '021 555 0000',
        subject: 'Fabric sample',
        message: 'Could I get a cutting of the Atlas weave?',
      })
      expect(response.statusCode).toBe(201)
      const { enquiry } = response.json()
      expect(enquiry.id).toBeTruthy()
      expect(enquiry.email).toBe(testEmail('ada'))
      expect(enquiry.source).toBe('contact_form')
      expect(enquiry.archived_at).toBeNull()

      // Row persisted.
      const { rows } = await pool.query(
        'SELECT message FROM contact_enquiries WHERE id = $1',
        [enquiry.id]
      )
      expect(rows[0].message).toMatch(/Atlas weave/)

      // Two emails: acknowledgement to the sender, alert to the back office.
      expect(transport.sent).toHaveLength(2)
      const to = transport.sent.map((m) => m.to)
      expect(to).toContain(testEmail('ada'))
      expect(to).toContain(BACKOFFICE)
    })

    it('rejects an invalid email with a field-level 422', async () => {
      const response = await post({
        name: 'No Email',
        email: 'not-an-email',
        message: 'Hello',
      })
      expect(response.statusCode).toBe(422)
      const body = response.json()
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'email' })])
      )
      expect(transport.sent).toHaveLength(0)
    })

    it('rejects a whitespace-only name with 422', async () => {
      const response = await post({
        name: '   ',
        email: testEmail('blank'),
        message: 'Hello',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'name' })])
      )
    })

    it('rejects a missing message with a schema 400', async () => {
      const response = await post({ name: 'Ada', email: testEmail('ada') })
      expect(response.statusCode).toBe(400)
    })

    it('links a logged-in sender via user_id', async () => {
      const response = await post(
        { name: 'Shopper', email: testEmail('shopper'), message: 'Hi from my account' },
        { cookie: customerCookie }
      )
      expect(response.statusCode).toBe(201)
      expect(response.json().enquiry.user_id).toBeTruthy()
    })
  })

  describe('/admin/contact-enquiries', () => {
    const seedOne = (subject) =>
      post({ name: 'Seed', email: testEmail('seed'), subject, message: 'msg' })

    it('rejects anonymous with 401 and customer with 403', async () => {
      expect((await inject('GET', '/admin/contact-enquiries', null)).statusCode).toBe(401)
      expect(
        (await inject('GET', '/admin/contact-enquiries', customerCookie)).statusCode
      ).toBe(403)
    })

    it('lists enquiries newest first for backoffice', async () => {
      await seedOne('first')
      await seedOne('second')
      const response = await inject('GET', '/admin/contact-enquiries', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const { enquiries } = response.json()
      expect(enquiries).toHaveLength(2)
      expect(enquiries[0].subject).toBe('second')
    })

    it('archives then restores an enquiry, hiding it from the default list', async () => {
      await seedOne('to archive')
      const list = (await inject('GET', '/admin/contact-enquiries', backofficeCookie)).json()
      const id = list.enquiries[0].id

      const archived = await inject(
        'POST',
        `/admin/contact-enquiries/${id}/archive`,
        backofficeCookie
      )
      expect(archived.statusCode).toBe(200)
      expect(archived.json().enquiry.archived_at).toBeTruthy()

      // Gone from the default list...
      const after = (await inject('GET', '/admin/contact-enquiries', backofficeCookie)).json()
      expect(after.enquiries).toHaveLength(0)
      // ...but visible with include_archived.
      const withArchived = (
        await inject(
          'GET',
          '/admin/contact-enquiries?include_archived=true',
          backofficeCookie
        )
      ).json()
      expect(withArchived.enquiries).toHaveLength(1)

      // Restore brings it back.
      const restored = await inject(
        'POST',
        `/admin/contact-enquiries/${id}/restore`,
        backofficeCookie
      )
      expect(restored.statusCode).toBe(200)
      expect(restored.json().enquiry.archived_at).toBeNull()
      const back = (await inject('GET', '/admin/contact-enquiries', backofficeCookie)).json()
      expect(back.enquiries).toHaveLength(1)
    })

    it('returns 404 archiving an unknown enquiry', async () => {
      const response = await inject(
        'POST',
        '/admin/contact-enquiries/99999999/archive',
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('DELETE /admin/contact-enquiries/:id', () => {
    // Archiving spam only hides it behind ?include_archived=true; the inbox has
    // to be able to be rid of it outright.
    //
    // These fixtures are INSERTed rather than posted: POST /contact shares the
    // auth routes' 10-per-15-min-per-IP bucket with the tests above, and this
    // block would spend the rest of it and start receiving 429s.
    const seedOne = async (subject, userId = null) => {
      const { rows } = await pool.query(
        `INSERT INTO contact_enquiries (name, email, subject, message, user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        ['Seed', testEmail('seed'), subject, 'msg', userId]
      )
      return rows[0].id
    }

    const rowCount = async (id) => {
      const { rows } = await pool.query('SELECT 1 FROM contact_enquiries WHERE id = $1', [
        id,
      ])
      return rows.length
    }

    it('deletes an enquiry outright and drops it from both lists', async () => {
      const id = await seedOne('spam')
      const response = await inject(
        'DELETE',
        `/admin/contact-enquiries/${id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'contact_enquiry', id } })
      expect(await rowCount(id)).toBe(0)

      const withArchived = (
        await inject('GET', '/admin/contact-enquiries?include_archived=true', backofficeCookie)
      ).json()
      expect(withArchived.enquiries).toHaveLength(0)
    })

    it('deletes an archived enquiry too', async () => {
      const id = await seedOne('archived spam')
      await inject('POST', `/admin/contact-enquiries/${id}/archive`, backofficeCookie)
      const response = await inject(
        'DELETE',
        `/admin/contact-enquiries/${id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(await rowCount(id)).toBe(0)
    })

    it('deletes an enquiry sent by a logged-in customer without touching the account', async () => {
      const account = await pool.query('SELECT id FROM users WHERE email = $1', [
        testEmail('shopper'),
      ])
      const userId = account.rows[0].id
      const id = await seedOne('from an account', userId)

      const response = await inject(
        'DELETE',
        `/admin/contact-enquiries/${id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(await rowCount(id)).toBe(0)

      const survivor = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])
      expect(survivor.rows).toHaveLength(1)
    })

    it('returns 404 with an empty blockers list for an unknown id', async () => {
      const response = await inject(
        'DELETE',
        '/admin/contact-enquiries/99999999',
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
      expect(response.json().blockers).toEqual([])
    })

    it('rejects anonymous with 401 and customer with 403, leaving the row', async () => {
      const id = await seedOne('keep me')
      expect(
        (await inject('DELETE', `/admin/contact-enquiries/${id}`, null)).statusCode
      ).toBe(401)
      expect(
        (await inject('DELETE', `/admin/contact-enquiries/${id}`, customerCookie)).statusCode
      ).toBe(403)
      expect(await rowCount(id)).toBe(1)
    })
  })
})
