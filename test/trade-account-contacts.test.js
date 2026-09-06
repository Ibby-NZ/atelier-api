// Trade-company contact people (/admin/trade-accounts/:id/contacts) and the
// bare-create path that makes them possible before any login exists.
//
// `trade_account_users` is the LOGIN grant; this is the staff-kept contact
// BOOK — several named people per company, none of whom needs a password
// ("Zomia is Jenny, Viv, Haike"). Three rules carry the weight:
//
//   1. A company row can now exist WITHOUT a login: POST /admin/trade-accounts
//      without `user_id` upserts the trade_accounts row and grants nobody
//      anything. A later real link upserts onto the SAME row (the GUID is
//      unique), so contacts added before the first login survive it.
//   2. Contact writes are scoped in the writing statement — a contact under
//      company B is unreachable through company A's path.
//   3. `d365_people` surfaces the matching legacy_contacts rows READ-ONLY with
//      a whitelisted projection: names and reachability, never the credit /
//      do-not-contact / GDPR columns (the price-list-exposure posture).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'ta-contacts-test'
const PASSWORD = 'super-secret-pw'

const GUID = {
  zomia: 'cccccccc-0000-4000-8000-000000000001',
  other: 'cccccccc-0000-4000-8000-000000000002',
  nameless: 'cccccccc-0000-4000-8000-000000000003',
  absent: 'cccccccc-0000-4000-8000-00000000ffff',
}

const insertLegacyAccount = (pool, { guid, name }) =>
  pool.query(
    `INSERT INTO legacy_accounts (guid, name, source_file, raw, imported_at)
     VALUES ($1, $2, $3, '{}'::jsonb, now())`,
    [guid, name, `${PREFIX}.xlsx`]
  )

const insertLegacyContact = (pool, { fullName, companyName, email = null }) =>
  pool.query(
    `INSERT INTO legacy_contacts
       (guid, full_name, company_name, email, job_title, mobile_phone,
        credit_limit, do_not_email, source_file, raw, imported_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Design lead', '+64 21 555 0100',
             99999, true, $4, '{}'::jsonb, now())`,
    [fullName, companyName, email, `${PREFIX}.xlsx`]
  )

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM legacy_contacts WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM legacy_accounts WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

const cookieOf = (res) => {
  const setCookie = res.headers['set-cookie']
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
}

describe('trade account contacts', () => {
  let pool
  let app
  let staffCookie
  let tradeUserId

  const inject = (method, url, payload) =>
    app.inject({ method, url, headers: { cookie: staffCookie }, payload })

  const bareCreate = async (guid) => {
    const response = await inject('POST', '/admin/trade-accounts', {
      legacy_account_guid: guid,
    })
    return response
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
    await cleanup(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await insertLegacyAccount(pool, { guid: GUID.zomia, name: `${PREFIX} Zomia` })
    await insertLegacyAccount(pool, { guid: GUID.other, name: `${PREFIX} Other Studio` })
    await insertLegacyAccount(pool, { guid: GUID.nameless, name: '   ' })
    await insertLegacyContact(pool, {
      fullName: 'Jenny Example',
      companyName: `${PREFIX} Zomia`,
      email: 'jenny@example.test',
    })
    await insertLegacyContact(pool, { fullName: 'Viv Example', companyName: `${PREFIX} Zomia` })
    await insertLegacyContact(pool, { fullName: 'Nobody Here', companyName: `${PREFIX} Elsewhere` })

    // Registered once — the register bucket is 10 / 15 min / IP.
    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-staff@example.test`, password: PASSWORD, name: 'Staff' },
    })
    staffCookie = cookieOf(staff)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-staff@example.test`,
    ])

    const trade = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-trade@example.test`, password: PASSWORD, name: 'Trade' },
    })
    expect(trade.statusCode).toBe(201)
    const { rows } = await pool.query(
      `UPDATE users SET role = 'trade', trade_approved = true WHERE email = $1 RETURNING id`,
      [`${PREFIX}-trade@example.test`]
    )
    tradeUserId = rows[0].id
  })

  afterAll(async () => {
    await cleanup(pool)
    await app?.close()
    await pool?.end()
  })

  describe('bare create (a company with no login yet)', () => {
    it('creates the company row with no grant, and refuses the unusable ones', async () => {
      const created = await bareCreate(GUID.other)
      expect(created.statusCode).toBe(201)
      expect(created.json().trade_account.users).toEqual([])

      const unknown = await bareCreate(GUID.absent)
      expect(unknown.statusCode).toBe(422)

      const nameless = await bareCreate(GUID.nameless)
      expect(nameless.statusCode).toBe(422)
    })

    it('a later real link lands on the same row, and contacts survive it', async () => {
      const created = await bareCreate(GUID.zomia)
      expect(created.statusCode).toBe(201)
      const accountId = created.json().trade_account.id

      const contact = await inject('POST', `/admin/trade-accounts/${accountId}/contacts`, {
        name: 'Haike',
        role: 'Accounts',
      })
      expect(contact.statusCode).toBe(201)

      const linked = await inject('POST', '/admin/trade-accounts', {
        legacy_account_guid: GUID.zomia,
        user_id: tradeUserId,
      })
      expect(linked.statusCode).toBe(201)
      const account = linked.json().trade_account
      expect(account.id).toBe(accountId)
      expect(account.users.map((u) => u.id)).toEqual([tradeUserId])
      expect(account.contacts.map((c) => c.name)).toEqual(['Haike'])
    })
  })

  describe('contacts CRUD', () => {
    let accountId

    beforeAll(async () => {
      const created = await bareCreate(GUID.other)
      accountId = created.json().trade_account.id
    })

    it('creates, serves on the detail, patches and deletes', async () => {
      const created = await inject('POST', `/admin/trade-accounts/${accountId}/contacts`, {
        name: 'Jenny',
        email: 'jenny@zomia.test',
        role: '',
      })
      expect(created.statusCode).toBe(201)
      const account = created.json().trade_account
      const jenny = account.contacts.find((c) => c.name === 'Jenny')
      // '' folds to null on the way in, the applyOrderHeader rule.
      expect(jenny.role).toBeNull()
      expect(jenny.email).toBe('jenny@zomia.test')

      const patched = await inject(
        'PATCH',
        `/admin/trade-accounts/${accountId}/contacts/${jenny.id}`,
        { phone: '+64 21 555 0199' }
      )
      expect(patched.statusCode).toBe(200)
      expect(
        patched.json().trade_account.contacts.find((c) => c.id === jenny.id).phone
      ).toBe('+64 21 555 0199')

      const removed = await inject(
        'DELETE',
        `/admin/trade-accounts/${accountId}/contacts/${jenny.id}`
      )
      expect(removed.statusCode).toBe(200)
      expect(
        removed.json().trade_account.contacts.some((c) => c.id === jenny.id)
      ).toBe(false)
    })

    it('refuses a nameless contact and scopes ids to their own company', async () => {
      const noName = await inject('POST', `/admin/trade-accounts/${accountId}/contacts`, {
        role: 'Accounts',
      })
      expect(noName.statusCode).toBe(400)

      const home = await inject('POST', `/admin/trade-accounts/${accountId}/contacts`, {
        name: 'Belongs here',
      })
      const contactId = home.json().trade_account.contacts.find(
        (c) => c.name === 'Belongs here'
      ).id

      // Another company's path cannot reach it.
      const zomia = await inject('GET', `/admin/trade-accounts/by-guid/${GUID.zomia}`)
      const otherAccountId = zomia.json().trade_account.id
      const hijack = await inject(
        'PATCH',
        `/admin/trade-accounts/${otherAccountId}/contacts/${contactId}`,
        { name: 'Hijacked' }
      )
      expect(hijack.statusCode).toBe(404)
      const del = await inject(
        'DELETE',
        `/admin/trade-accounts/${otherAccountId}/contacts/${contactId}`
      )
      expect(del.statusCode).toBe(404)
    })

    it('404s contact writes against an unknown company', async () => {
      const orphan = await inject('POST', '/admin/trade-accounts/99999999/contacts', {
        name: 'Nobody',
      })
      expect(orphan.statusCode).toBe(404)
    })
  })

  describe('by-guid', () => {
    it('resolves the mirror GUID to the trade account', async () => {
      const response = await inject('GET', `/admin/trade-accounts/by-guid/${GUID.zomia}`)
      expect(response.statusCode).toBe(200)
      expect(response.json().trade_account.company_name).toBe(`${PREFIX} Zomia`)
    })

    it('404s a GUID no company row exists for — the CRM "enable contacts" branch', async () => {
      const response = await inject('GET', `/admin/trade-accounts/by-guid/${GUID.absent}`)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('the Dynamics people (legacy_contacts, read-only)', () => {
    it('lists the company-name matches with ONLY the whitelisted columns', async () => {
      const response = await inject('GET', `/admin/trade-accounts/by-guid/${GUID.zomia}`)
      const account = response.json().trade_account
      const names = account.d365_people.map((p) => p.full_name).sort()
      expect(names).toEqual(['Jenny Example', 'Viv Example'])

      // The projection is a whitelist: reachability only. The staged row
      // carries credit_limit and do_not_email, and neither may travel — scan
      // the serialised body for the KEYS and the fixture's VALUE.
      const raw = response.body
      expect(raw).not.toContain('credit_limit')
      expect(raw).not.toContain('do_not_email')
      expect(raw).not.toContain('99999')
    })
  })

  it('deleting the company row cascades its contacts', async () => {
    const created = await bareCreate(GUID.other)
    const accountId = created.json().trade_account.id
    await inject('POST', `/admin/trade-accounts/${accountId}/contacts`, { name: 'Doomed' })
    await pool.query('DELETE FROM trade_accounts WHERE id = $1', [accountId])
    const { rows } = await pool.query(
      'SELECT count(*)::int AS total FROM trade_account_contacts WHERE trade_account_id = $1',
      [accountId]
    )
    expect(rows[0].total).toBe(0)
  })
})
