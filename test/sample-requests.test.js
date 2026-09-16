// The storefront's sample enquiry cart, end to end: the public submission, its
// two letters, and the back office's queue with its two moves.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'sample-req-test'
const DOMAIN = 'sample-req.test'
const PASSWORD = 'correct horse battery staple'
const email = (local) => `${PREFIX}-${local}@${DOMAIN}`

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('sample requests', () => {
  let pool
  let app
  let mailbox
  let backofficeCookie
  let customerCookie
  let skus

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const cleanup = async () => {
    await pool.query(`DELETE FROM sample_requests WHERE contact_email LIKE $1`, [`%@${DOMAIN}`])
    await pool.query(`DELETE FROM colourways WHERE sku LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
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
    mailbox = []
    const mailer = {
      backofficeEmail: 'office@example.test',
      send: async (message) => {
        mailbox.push(message)
        return { ok: true }
      },
    }
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false, mailer })
    await app.ready()
    await cleanup()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    const register = async (local, name) => {
      const response = await inject('POST', '/auth/register', null, {
        email: email(local),
        password: PASSWORD,
        name,
      })
      return cookieOf(response)
    }
    backofficeCookie = await register('boss', 'Boss')
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [email('boss')])
    customerCookie = await register('client', 'Zomia Interiors')

    const brand = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only) VALUES ($1, $2, 'NZD', false) RETURNING id`,
      [`${PREFIX} house`, `${PREFIX}-house`]
    )
    const product = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency)
       VALUES ($1, $2, $3, 'fabric', 'NZD') RETURNING id`,
      [brand.rows[0].id, 'Atlas', `${PREFIX}-atlas`]
    )
    skus = [`${PREFIX}-ATL-01`, `${PREFIX}-ATL-02`]
    for (const [index, sku] of skus.entries()) {
      await pool.query(`INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3)`, [
        product.rows[0].id,
        index === 0 ? 'Flax' : 'Indigo',
        sku,
      ])
    }
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM sample_requests WHERE contact_email LIKE $1`, [`%@${DOMAIN}`])
    mailbox.length = 0
  })

  afterAll(async () => {
    await cleanup()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  it('a guest sends the cart, lands pending, and both letters go', async () => {
    const response = await inject('POST', '/samples/request', null, {
      lines: [{ sku: skus[0], note: 'for a sofa' }, { sku: skus[1] }],
      contact: { name: 'Liz', email: email('guest'), phone: '021 000' },
      notes: 'Sending to the studio please.',
    })
    expect(response.statusCode).toBe(201)
    const { sample_request } = response.json()
    expect(sample_request.request_number).toMatch(/^SR-[0-9A-F]{8}$/)
    expect(sample_request.status).toBe('pending')
    expect(sample_request.user_id).toBeNull()
    expect(sample_request.contact_email).toBe(email('guest'))
    expect(sample_request.lines).toHaveLength(2)
    expect(sample_request.lines[0]).toMatchObject({
      sku: skus[0],
      product_name: 'Atlas',
      colourway_name: 'Flax',
      brand_name: `${PREFIX} house`,
      note: 'for a sofa',
    })

    expect(mailbox.map((m) => m.template)).toEqual([
      'sample_request_received',
      'backoffice_new_sample_request',
    ])
    expect(mailbox[0].to).toBe(email('guest'))
    expect(mailbox[0].data.lines_text).toContain(`Atlas — Flax (${skus[0]})`)
    expect(mailbox[0].data.lines_text).toContain('for a sofa')
    expect(mailbox[1].to).toBe('office@example.test')
    expect(mailbox[1].replyTo).toBe(email('guest'))
  })

  it('a signed-in shopper needs no contact block — the account supplies it', async () => {
    const response = await inject('POST', '/samples/request', customerCookie, {
      lines: [{ sku: skus[0] }],
    })
    expect(response.statusCode).toBe(201)
    const { sample_request } = response.json()
    expect(sample_request.contact_email).toBe(email('client'))
    expect(sample_request.contact_name).toBe('Zomia Interiors')
    expect(sample_request.user_id).not.toBeNull()
  })

  it('refuses a guest with no email, an empty cart and an unknown SKU, naming the field', async () => {
    const noEmail = await inject('POST', '/samples/request', null, { lines: [{ sku: skus[0] }] })
    expect(noEmail.statusCode).toBe(422)
    expect(noEmail.json().errors[0].field).toBe('contact.email')

    const empty = await inject('POST', '/samples/request', customerCookie, { lines: [] })
    expect(empty.statusCode).toBe(422)
    expect(empty.json().errors[0].field).toBe('lines')

    const unknown = await inject('POST', '/samples/request', customerCookie, {
      lines: [{ sku: 'NOPE-1' }],
    })
    expect(unknown.statusCode).toBe(422)
    expect(unknown.json().errors[0].field).toBe('lines[0].sku')
    expect(mailbox).toHaveLength(0)
  })

  it('the honeypot answers 201 and stores nothing', async () => {
    const response = await inject('POST', '/samples/request', null, {
      website: 'http://spam.example',
      lines: [{ sku: skus[0] }],
      contact: { email: email('bot') },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json().sample_request).toBeNull()
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM sample_requests WHERE contact_email = $1`, [
      email('bot'),
    ])
    expect(rows[0].n).toBe(0)
    expect(mailbox).toHaveLength(0)
  })

  describe('the back office queue', () => {
    const submit = async () =>
      (
        await inject('POST', '/samples/request', customerCookie, {
          lines: [{ sku: skus[0] }],
        })
      ).json().sample_request

    it('is staff-only', async () => {
      expect((await inject('GET', '/admin/sample-requests', null)).statusCode).toBe(401)
      expect((await inject('GET', '/admin/sample-requests', customerCookie)).statusCode).toBe(403)
    })

    it('lists pending requests, searches them, and reads one by id', async () => {
      const created = await submit()
      const list = await inject('GET', '/admin/sample-requests?status=pending', backofficeCookie)
      expect(list.statusCode).toBe(200)
      expect(list.json().sample_requests.map((r) => r.id)).toContain(created.id)
      expect(list.json().meta.total).toBeGreaterThan(0)

      const search = await inject('GET', `/admin/sample-requests?q=${created.request_number}`, backofficeCookie)
      expect(search.json().sample_requests.map((r) => r.id)).toEqual([created.id])

      const one = await inject('GET', `/admin/sample-requests/${created.id}`, backofficeCookie)
      expect(one.json().sample_request.lines[0].sku).toBe(skus[0])
      expect((await inject('GET', '/admin/sample-requests/999999', backofficeCookie)).statusCode).toBe(404)
    })

    it('moves pending to sent (stamped) and refuses the next move', async () => {
      const created = await submit()
      const sent = await inject('POST', `/admin/sample-requests/${created.id}/transition`, backofficeCookie, {
        status: 'sent',
      })
      expect(sent.statusCode).toBe(200)
      expect(sent.json().sample_request.status).toBe('sent')
      expect(sent.json().sample_request.sent_at).not.toBeNull()
      const again = await inject('POST', `/admin/sample-requests/${created.id}/transition`, backofficeCookie, {
        status: 'declined',
      })
      expect(again.statusCode).toBe(409)
    })

    it('deletes a pending request, refuses a sent one and offers archive instead', async () => {
      const pending = await submit()
      expect((await inject('DELETE', `/admin/sample-requests/${pending.id}`, backofficeCookie)).statusCode).toBe(200)

      const sent = await submit()
      await inject('POST', `/admin/sample-requests/${sent.id}/transition`, backofficeCookie, { status: 'sent' })
      const refused = await inject('DELETE', `/admin/sample-requests/${sent.id}`, backofficeCookie)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().archivable).toBe(true)

      const archived = await inject('POST', `/admin/sample-requests/${sent.id}/archive`, backofficeCookie)
      expect(archived.json().sample_request.archived_at).not.toBeNull()
      const hidden = await inject('GET', '/admin/sample-requests', backofficeCookie)
      expect(hidden.json().sample_requests.map((r) => r.id)).not.toContain(sent.id)
      const shown = await inject('GET', '/admin/sample-requests?include_archived=true', backofficeCookie)
      expect(shown.json().sample_requests.map((r) => r.id)).toContain(sent.id)
    })
  })
})
