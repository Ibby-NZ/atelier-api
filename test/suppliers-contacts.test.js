// Supplier contact management: contact details on the record, contact PEOPLE
// as rows, and the append-only contact log behind "who has gone quiet".
//
// Three surfaces under test:
//   1. The four new detail columns on `suppliers` (phone/address/website_url/
//      notes) — writable through PATCH, served on the list and the detail.
//   2. `supplier_contacts` CRUD — several people per house, scoped writes (a
//      contact under supplier B is unreachable through supplier A's path).
//   3. `supplier_contact_log` — entries stamp the signed-in staff member and
//      snapshot their name; the newest entry rides every supplier list row as
//      `last_contact`, which is the at-a-glance ask.
//
// The guard sweep (401/403 per route) lives in test/suppliers-routes.test.js
// with the rest of the supplier surface.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { CONTACT_METHODS } from '../src/suppliers/supplier-contacts.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'w3-contacts-test'
const DOMAIN = 'w3-contacts-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// supplier_contacts and supplier_contact_log CASCADE off suppliers, so deleting
// the suppliers is the whole cleanup. Users go by domain, after the suppliers —
// a log row's staff_user_id would SET NULL either way, but the order keeps the
// deleted-staff test's assertions from racing the cleanup.
const cleanupFixtures = async (pool) => {
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const insertSupplier = async (pool, name, overrides = {}) => {
  const row = { archived_at: null, ...overrides }
  const { rows } = await pool.query(
    `INSERT INTO suppliers (name, slug, archived_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [`${PREFIX} ${name}`, `${PREFIX}-${name}`, row.archived_at]
  )
  return rows[0].id
}

describe('supplier contacts and contact log', () => {
  let pool
  let app
  let backofficeCookie
  let backofficeUserId

  const inject = (method, url, payload) =>
    app.inject({ method, url, headers: { cookie: backofficeCookie }, payload })

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
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered ONCE — register shares the 10/15min/IP bucket.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    const { rows } = await pool.query(
      `UPDATE users SET role = 'backoffice' WHERE email = $1 RETURNING id`,
      [testEmail('boss')]
    )
    backofficeUserId = rows[0].id
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app?.close()
    await pool?.end()
  })

  beforeEach(() => cleanupFixtures(pool))

  it('CONTACT_METHODS mirrors the live CHECK constraint', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'supplier_contact_log_method_check'`
    )
    expect(rows).toHaveLength(1)
    const quoted = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(new Set(quoted)).toEqual(new Set(CONTACT_METHODS))
  })

  describe('contact details on the supplier record', () => {
    it('round-trips phone/address/website_url/notes through PATCH, GET and the list', async () => {
      const id = await insertSupplier(pool, 'detailed')

      const patch = await inject('PATCH', `/admin/suppliers/${id}`, {
        phone: '+39 02 1234 5678',
        address: 'Via della Spiga 20, Milano',
        website_url: 'https://example.com',
        notes: 'Closed all of August.',
      })
      expect(patch.statusCode).toBe(200)
      expect(patch.json().supplier).toMatchObject({
        phone: '+39 02 1234 5678',
        address: 'Via della Spiga 20, Milano',
        website_url: 'https://example.com',
        notes: 'Closed all of August.',
      })

      const detail = await inject('GET', `/admin/suppliers/${id}`)
      expect(detail.json().supplier.phone).toBe('+39 02 1234 5678')

      const list = await inject('GET', `/admin/suppliers?q=${PREFIX}`)
      const row = list.json().suppliers.find((s) => s.id === id)
      expect(row.website_url).toBe('https://example.com')

      // Explicit null clears, as on every other nullable supplier column.
      const clear = await inject('PATCH', `/admin/suppliers/${id}`, { phone: null })
      expect(clear.json().supplier.phone).toBeNull()
    })

    it('accepts the four fields on create', async () => {
      const response = await inject('POST', '/admin/suppliers', {
        name: `${PREFIX} created-with-details`,
        phone: '+64 9 555 0100',
        notes: 'Met at Milan fair.',
      })
      expect(response.statusCode).toBe(201)
      expect(response.json().supplier).toMatchObject({
        phone: '+64 9 555 0100',
        notes: 'Met at Milan fair.',
      })
    })
  })

  describe('contact people', () => {
    it('creates, lists alphabetically, patches and deletes', async () => {
      const id = await insertSupplier(pool, 'people')

      const viv = await inject('POST', `/admin/suppliers/${id}/contacts`, {
        name: 'Viv',
        role: 'Accounts',
        email: 'viv@example.com',
      })
      expect(viv.statusCode).toBe(201)
      expect(viv.json().contact).toMatchObject({
        name: 'Viv',
        role: 'Accounts',
        email: 'viv@example.com',
        phone: null,
      })

      await inject('POST', `/admin/suppliers/${id}/contacts`, { name: 'Jenny' })

      const list = await inject('GET', `/admin/suppliers/${id}/contacts`)
      expect(list.json().contacts.map((c) => c.name)).toEqual(['Jenny', 'Viv'])

      const patched = await inject(
        'PATCH',
        `/admin/suppliers/${id}/contacts/${viv.json().contact.id}`,
        { phone: '+44 20 5550 0100' }
      )
      expect(patched.json().contact.phone).toBe('+44 20 5550 0100')

      const gone = await inject(
        'DELETE',
        `/admin/suppliers/${id}/contacts/${viv.json().contact.id}`
      )
      expect(gone.statusCode).toBe(204)
      const after = await inject('GET', `/admin/suppliers/${id}/contacts`)
      expect(after.json().contacts.map((c) => c.name)).toEqual(['Jenny'])
    })

    it('refuses a missing name and an unknown supplier', async () => {
      const id = await insertSupplier(pool, 'strict')
      const noName = await inject('POST', `/admin/suppliers/${id}/contacts`, {
        role: 'Accounts',
      })
      expect(noName.statusCode).toBe(400)

      const orphan = await inject('POST', '/admin/suppliers/999999/contacts', {
        name: 'Nobody',
      })
      expect(orphan.statusCode).toBe(404)
    })

    it("scopes writes: supplier A's path cannot reach supplier B's contact", async () => {
      const a = await insertSupplier(pool, 'scope-a')
      const b = await insertSupplier(pool, 'scope-b')
      const created = await inject('POST', `/admin/suppliers/${b}/contacts`, {
        name: 'Belongs to B',
      })
      const contactId = created.json().contact.id

      const patch = await inject('PATCH', `/admin/suppliers/${a}/contacts/${contactId}`, {
        name: 'Hijacked',
      })
      expect(patch.statusCode).toBe(404)

      const del = await inject('DELETE', `/admin/suppliers/${a}/contacts/${contactId}`)
      expect(del.statusCode).toBe(404)

      const intact = await inject('GET', `/admin/suppliers/${b}/contacts`)
      expect(intact.json().contacts[0].name).toBe('Belongs to B')
    })
  })

  describe('contact log', () => {
    it('stamps the signed-in staff member and snapshots their name', async () => {
      const id = await insertSupplier(pool, 'logged')
      const response = await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'call',
        note: 'Chased the September price list.',
      })
      expect(response.statusCode).toBe(201)
      const entry = response.json().entry
      expect(entry.staff_user_id).toBe(backofficeUserId)
      expect(entry.staff_name).toBe('Boss')
      expect(entry.method).toBe('call')
      // Omitted contacted_on falls to the server's CURRENT_DATE.
      expect(entry.contacted_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(entry.follow_up_on).toBeNull()
    })

    it('lists newest first with the meta envelope, and pages', async () => {
      const id = await insertSupplier(pool, 'history')
      await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'email',
        contacted_on: '2026-08-01',
      })
      await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'visit',
        contacted_on: '2026-09-01',
      })
      // Same day as the visit: the later insert wins the tie (id DESC).
      await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'showroom',
        contacted_on: '2026-09-01',
      })

      const page1 = await inject('GET', `/admin/suppliers/${id}/contact-log?limit=2`)
      expect(page1.statusCode).toBe(200)
      expect(page1.json().entries.map((e) => e.method)).toEqual(['showroom', 'visit'])
      expect(page1.json().meta).toEqual({ total: 3, page: 1, limit: 2 })

      const page2 = await inject('GET', `/admin/suppliers/${id}/contact-log?limit=2&page=2`)
      expect(page2.json().entries.map((e) => e.method)).toEqual(['email'])

      const tooBig = await inject('GET', `/admin/suppliers/${id}/contact-log?limit=5000`)
      expect(tooBig.statusCode).toBe(400)
    })

    it('refuses an unknown method at the boundary and a fake calendar date as a 422', async () => {
      const id = await insertSupplier(pool, 'refusals')
      const badMethod = await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'carrier-pigeon',
      })
      expect(badMethod.statusCode).toBe(400)

      // Passes the shape regex, is not a date. Postgres raises 22008 and the
      // module maps it — a 500 here would mean the mapping is gone.
      const badDate = await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'call',
        contacted_on: '2026-02-31',
      })
      expect(badDate.statusCode).toBe(422)

      const orphan = await inject('POST', '/admin/suppliers/999999/contact-log', {
        method: 'call',
      })
      expect(orphan.statusCode).toBe(404)
    })

    it('keeps the name when the staff account is deleted', async () => {
      const id = await insertSupplier(pool, 'departed')
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, 'x', 'Departed Staffer', 'backoffice')
         RETURNING id`,
        [testEmail('departed')]
      )
      await pool.query(
        `INSERT INTO supplier_contact_log (supplier_id, staff_user_id, staff_name, method)
         VALUES ($1, $2, 'Departed Staffer', 'visit')`,
        [id, rows[0].id]
      )
      await pool.query('DELETE FROM users WHERE id = $1', [rows[0].id])

      const log = await inject('GET', `/admin/suppliers/${id}/contact-log`)
      expect(log.json().entries[0]).toMatchObject({
        staff_user_id: null,
        staff_name: 'Departed Staffer',
      })
    })
  })

  describe('last contact at a glance', () => {
    it('rides every supplier list row, null for the never-contacted', async () => {
      const quiet = await insertSupplier(pool, 'quiet')
      const fresh = await insertSupplier(pool, 'fresh')
      await inject('POST', `/admin/suppliers/${fresh}/contact-log`, {
        method: 'email',
        contacted_on: '2026-08-15',
      })
      await inject('POST', `/admin/suppliers/${fresh}/contact-log`, {
        method: 'call',
        contacted_on: '2026-09-02',
        follow_up_on: '2026-09-20',
      })

      const list = await inject('GET', `/admin/suppliers?q=${PREFIX}`)
      const rows = list.json().suppliers
      const freshRow = rows.find((s) => s.id === fresh)
      const quietRow = rows.find((s) => s.id === quiet)

      expect(freshRow.last_contact).toEqual({
        contacted_on: '2026-09-02',
        method: 'call',
        staff_name: 'Boss',
        follow_up_on: '2026-09-20',
      })
      expect(quietRow.last_contact).toBeNull()
    })
  })

  describe('archived suppliers', () => {
    it('still accept a contact and a log entry', async () => {
      const id = await insertSupplier(pool, 'archived', { archived_at: new Date() })
      const contact = await inject('POST', `/admin/suppliers/${id}/contacts`, {
        name: 'Still Here',
      })
      expect(contact.statusCode).toBe(201)
      const entry = await inject('POST', `/admin/suppliers/${id}/contact-log`, {
        method: 'email',
      })
      expect(entry.statusCode).toBe(201)
    })
  })
})
