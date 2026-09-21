// Back-office trade-account linking (/admin/trade-accounts).
//
// The rules under test are the ones that keep a link trustworthy: only a trade
// login may be linked, only to a staged Dynamics account, never to two companies
// at once, and a company whose name is shared by another account is flagged at
// link time rather than discovered by a client.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { sampleTradeApplication } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'trade-acct-test'
const PASSWORD = 'super-secret-pw'

const GUID = {
  alpha: 'aaaaaaaa-0000-4000-8000-000000000001',
  beta: 'aaaaaaaa-0000-4000-8000-000000000002',
  twinA: 'aaaaaaaa-0000-4000-8000-000000000003',
  twinB: 'aaaaaaaa-0000-4000-8000-000000000004',
  nameless: 'aaaaaaaa-0000-4000-8000-000000000005',
  absent: 'bbbbbbbb-0000-4000-8000-00000000ffff',
}

const insertLegacyAccount = (pool, { guid, name, email = null }) =>
  pool.query(
    `INSERT INTO legacy_accounts (guid, name, email, source_file, raw, imported_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, now())`,
    [guid, name, email, `${PREFIX}.xlsx`]
  )

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM legacy_accounts WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM trade_applications WHERE business_name LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

const cookieOf = (res) => {
  const setCookie = res.headers['set-cookie']
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
}

describe('admin trade accounts', () => {
  let pool
  let app
  let staffCookie
  let tradeA
  let tradeB
  let plainCustomerId

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

    await insertLegacyAccount(pool, {
      guid: GUID.alpha,
      name: `${PREFIX} Alpha Studio`,
      email: `${PREFIX}-alpha@example.test`,
    })
    await insertLegacyAccount(pool, { guid: GUID.beta, name: `${PREFIX} Beta Studio` })
    await insertLegacyAccount(pool, { guid: GUID.twinA, name: `${PREFIX} Twin Studio` })
    await insertLegacyAccount(pool, { guid: GUID.twinB, name: `${PREFIX} Twin Studio` })
    await insertLegacyAccount(pool, { guid: GUID.nameless, name: '   ' })

    // Registered once — register and login share a 10/15min/IP bucket.
    tradeA = await registerTrade(`${PREFIX}-a@example.test`)
    tradeB = await registerTrade(`${PREFIX}-b@example.test`)

    const plain = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-plain@example.test`, password: PASSWORD, name: 'Plain' },
    })
    expect(plain.statusCode).toBe(201)
    const { rows: plainRows } = await pool.query('SELECT id FROM users WHERE email = $1', [
      `${PREFIX}-plain@example.test`,
    ])
    plainCustomerId = plainRows[0].id

    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-staff@example.test`, password: PASSWORD, name: 'Staff' },
    })
    expect(staff.statusCode).toBe(201)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-staff@example.test`,
    ])
    staffCookie = cookieOf(staff)
  })

  afterAll(async () => {
    await cleanup(pool)
    await app?.close()
    await pool?.end()
  })

  const registerTrade = async (email) => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/trade-application',
      payload: {
        email,
        password: PASSWORD,
        name: 'Trade User',
        application: sampleTradeApplication({ business_name: `${PREFIX} Studio` }),
      },
    })
    expect(res.statusCode).toBe(201)
    await pool.query(`UPDATE users SET trade_approved = true WHERE email = $1`, [email])
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email])
    return { id: rows[0].id, email }
  }

  const post = (payload, cookie = staffCookie) =>
    app.inject({
      method: 'POST',
      url: '/admin/trade-accounts',
      headers: cookie ? { cookie } : {},
      payload,
    })

  describe('authorisation', () => {
    it('401s an anonymous caller and 403s a non-staff one', async () => {
      expect((await post({ legacy_account_guid: GUID.alpha, user_id: tradeA.id }, null)).statusCode).toBe(401)
      // A trade client must not be able to link themselves to a company.
      const tradeLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: tradeA.email, password: PASSWORD },
      })
      const res = await post(
        { legacy_account_guid: GUID.alpha, user_id: tradeA.id },
        cookieOf(tradeLogin)
      )
      expect(res.statusCode).toBe(403)
    })
  })

  describe('linking', () => {
    it('links a trade login to a staged Dynamics account', async () => {
      const res = await post({ legacy_account_guid: GUID.alpha, user_id: tradeA.id })
      expect(res.statusCode).toBe(201)
      const account = res.json().trade_account
      expect(account.company_name).toBe(`${PREFIX} Alpha Studio`)
      expect(account.name_is_ambiguous).toBe(false)
      expect(account.users.map((user) => user.id)).toEqual([tradeA.id])
      // Coverage is what tells staff the link found the right company.
      expect(account.coverage).toEqual({ invoices: 0, samples: 0 })
    })

    it('is idempotent — re-linking the same pair is not an error', async () => {
      const res = await post({ legacy_account_guid: GUID.alpha, user_id: tradeA.id })
      expect(res.statusCode).toBe(201)
      expect(res.json().trade_account.users).toHaveLength(1)
    })

    it('409s a login already linked to a DIFFERENT company', async () => {
      const res = await post({ legacy_account_guid: GUID.beta, user_id: tradeA.id })
      expect(res.statusCode).toBe(409)
      expect(res.json().message).toMatch(/already linked/i)
    })

    it('422s a login that is not a trade account', async () => {
      const res = await post({ legacy_account_guid: GUID.beta, user_id: plainCustomerId })
      expect(res.statusCode).toBe(422)
    })

    it('422s an unknown Dynamics account', async () => {
      const res = await post({ legacy_account_guid: GUID.absent, user_id: tradeB.id })
      expect(res.statusCode).toBe(422)
    })

    it('422s a Dynamics account with no name — its history could never be matched', async () => {
      const res = await post({ legacy_account_guid: GUID.nameless, user_id: tradeB.id })
      expect(res.statusCode).toBe(422)
    })

    it('400s a malformed record id', async () => {
      const res = await post({ legacy_account_guid: 'nope', user_id: tradeB.id })
      expect(res.statusCode).toBe(400)
    })

    it('flags a company whose name is shared by another Dynamics account', async () => {
      const res = await post({ legacy_account_guid: GUID.twinA, user_id: tradeB.id })
      expect(res.statusCode).toBe(201)
      // The flag is what makes the client-facing reads serve nothing rather than
      // the union of both companies' records.
      expect(res.json().trade_account.name_is_ambiguous).toBe(true)
    })
  })

  // The roster's own create: a client the business won today, in no export and
  // with no GUID to link to. Without it the order desk cannot bill a new client
  // at all — every other create path demands a Dynamics customer.
  describe('a client raised by hand', () => {
    it('creates a company row with no Dynamics account behind it', async () => {
      const res = await post({
        company_name: `${PREFIX} Fernhill Interiors`,
        email: `${PREFIX}-FERNHILL@example.test`,
        phone: '09 555 0111',
        address: '12 Sale Street',
        city: 'Auckland',
        country: 'New Zealand',
        customer_type: 'Trade',
      })

      expect(res.statusCode).toBe(201)
      const account = res.json().trade_account
      expect(account.company_name).toBe(`${PREFIX} Fernhill Interiors`)
      // No GUID: the row says, truthfully, that it is nobody in Dynamics.
      expect(account.legacy_account_guid).toBeNull()
      expect(account.address).toBe('12 Sale Street')
      expect(account.city).toBe('Auckland')
      // Normalised on the way in, like every other email column.
      expect(account.email).toBe(`${PREFIX}-fernhill@example.test`)
      expect(account.users).toEqual([])
      // Serves no legacy history, which is correct — none of it is theirs.
      expect(account.coverage).toEqual({ invoices: 0, samples: 0 })
    })

    it('is found by the same search the order desk uses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/trade-accounts?q=${encodeURIComponent('Fernhill')}`,
        headers: { cookie: staffCookie },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().trade_accounts.map((a) => a.company_name)).toContain(
        `${PREFIX} Fernhill Interiors`
      )
    })

    // NULLs are distinct to the UNIQUE constraint, so the roster can hold as
    // many hand-raised clients as the office raises.
    it('lets a second one exist alongside the first', async () => {
      const res = await post({ company_name: `${PREFIX} Second Local` })
      expect(res.statusCode).toBe(201)
      expect(res.json().trade_account.legacy_account_guid).toBeNull()
    })

    it('422s a body naming neither a Dynamics customer nor a company', async () => {
      const res = await post({ city: 'Auckland' })
      expect(res.statusCode).toBe(422)
    })

    it('422s a company name that is only whitespace', async () => {
      const res = await post({ company_name: '   ' })
      expect(res.statusCode).toBe(422)
    })
  })

  describe('suggestions', () => {
    it('ranks an exact email match above a name match', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/trade-accounts/suggestions?email=${encodeURIComponent(`${PREFIX}-alpha@example.test`)}&q=${encodeURIComponent(`${PREFIX} `)}`,
        headers: { cookie: staffCookie },
      })
      expect(res.statusCode).toBe(200)
      const suggestions = res.json().suggestions
      expect(suggestions[0].matched_on).toBe('email')
      expect(suggestions[0].legacy_account_guid).toBe(GUID.alpha)
      expect(suggestions[0].already_linked).toBe(true)
    })

    it('warns that a candidate name is ambiguous BEFORE the link is made', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/trade-accounts/suggestions?q=${encodeURIComponent(`${PREFIX} Twin`)}`,
        headers: { cookie: staffCookie },
      })
      expect(res.json().suggestions.every((s) => s.name_is_ambiguous)).toBe(true)
    })

    it('returns nothing when given nothing to match on', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/trade-accounts/suggestions',
        headers: { cookie: staffCookie },
      })
      expect(res.json().suggestions).toEqual([])
    })

    it('treats ILIKE metacharacters in the search term as literal', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/trade-accounts/suggestions?q=%25',
        headers: { cookie: staffCookie },
      })
      // A bare % must not match every account in the corpus.
      expect(res.json().suggestions).toEqual([])
    })
  })

  describe('account manager + unlink', () => {
    it('stores and clears the client-visible account manager', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM trade_accounts WHERE legacy_account_guid = $1`,
        [GUID.alpha]
      )
      const id = rows[0].id
      const set = await app.inject({
        method: 'PATCH',
        url: `/admin/trade-accounts/${id}`,
        headers: { cookie: staffCookie },
        payload: { account_manager_name: 'Rebecca Bowering', account_manager_phone: '09 555 0100' },
      })
      expect(set.statusCode).toBe(200)
      expect(set.json().trade_account.account_manager).toEqual({
        name: 'Rebecca Bowering',
        email: null,
        phone: '09 555 0100',
      })

      // An explicit null clears it; an absent key would leave it alone.
      const clear = await app.inject({
        method: 'PATCH',
        url: `/admin/trade-accounts/${id}`,
        headers: { cookie: staffCookie },
        payload: { account_manager_name: null },
      })
      expect(clear.json().trade_account.account_manager.name).toBeNull()
    })

    it('400s an empty patch and 404s an unknown account', async () => {
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/admin/trade-accounts/999999',
            headers: { cookie: staffCookie },
            payload: {},
          })
        ).statusCode
      ).toBe(400)
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/admin/trade-accounts/999999',
            headers: { cookie: staffCookie },
            payload: { account_manager_name: 'X' },
          })
        ).statusCode
      ).toBe(404)
    })

    it('revokes one login but keeps the company row', async () => {
      const { rows } = await pool.query(
        `SELECT id FROM trade_accounts WHERE legacy_account_guid = $1`,
        [GUID.alpha]
      )
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/trade-accounts/${rows[0].id}/users/${tradeA.id}`,
        headers: { cookie: staffCookie },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().trade_account.users).toEqual([])
      expect(res.json().trade_account.company_name).toBe(`${PREFIX} Alpha Studio`)
    })

    it('lets a revoked login be linked somewhere else', async () => {
      const res = await post({ legacy_account_guid: GUID.beta, user_id: tradeA.id })
      expect(res.statusCode).toBe(201)
      expect(res.json().trade_account.company_name).toBe(`${PREFIX} Beta Studio`)
    })
  })

  describe('listing', () => {
    it('pages and searches by company name', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/trade-accounts?q=${encodeURIComponent(`${PREFIX} Beta`)}`,
        headers: { cookie: staffCookie },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().trade_accounts).toHaveLength(1)
      expect(res.json().meta).toMatchObject({ page: 1 })
    })
  })
})
