// The approved-trade client portal (/account/*).
//
// The test this file exists for is CROSS-SCOPING: two trade clients, each linked
// to their own D365 customer, must never see each other's invoices or cuttings.
// The fixture therefore also includes the shape that makes the naive
// implementation leak — two DIFFERENT legacy accounts sharing one name — because
// a name-equality scoping key serves the union of both and a fixture with
// distinct names passes anyway.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { cleanupTradeApplications, sampleTradeApplication } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'acct-portal-test'
const PASSWORD = 'super-secret-pw'

// Deterministic uuids so assertions can name a record.
const GUID = {
  studio: '11111111-1111-4111-8111-111111111111',
  rival: '22222222-2222-4222-8222-222222222222',
  // Two accounts, one name — the collision the ambiguity flag exists for.
  twinA: '33333333-3333-4333-8333-333333333333',
  twinB: '44444444-4444-4444-8444-444444444444',
  strangerInvoice: '55555555-5555-4555-8555-555555555555',
}

const insertLegacyAccount = (pool, { guid, name, email = null }) =>
  pool.query(
    `INSERT INTO legacy_accounts (guid, name, email, source_file, raw, imported_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, now())`,
    [guid, name, email, `${PREFIX}.xlsx`]
  )

const insertInvoice = (pool, { guid, customer, number, date, total }) =>
  pool.query(
    `INSERT INTO legacy_sales_invoices
       (guid, number, customer, invoice_date, currency, total_incl_gst, status, source_file, raw, imported_at)
     VALUES ($1, $2, $3, $4, 'NZD', $5, 'Active', $6, '{}'::jsonb, now())`,
    [guid, number, customer, date, total, `${PREFIX}.xlsx`]
  )

const insertCutting = (pool, { guid, customer, product, supplier }) =>
  pool.query(
    `INSERT INTO legacy_cuttings
       (guid, name, customer, product, supplier, quantity, status, created_on, source_file, raw, imported_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'Returned', now(), $6, '{}'::jsonb, now())`,
    [guid, `${PREFIX} cutting`, customer, product, supplier, `${PREFIX}.xlsx`]
  )

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM legacy_sales_invoices WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM legacy_cuttings WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM legacy_accounts WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM trade_applications WHERE business_name LIKE $1`, [`${PREFIX}%`])
  await cleanupTradeApplications(pool, `${PREFIX}-%`)
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

const cookieOf = (res) => {
  const setCookie = res.headers['set-cookie']
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
}

describe('trade client portal', () => {
  let pool
  let app
  // Same cookie secret, so a session minted on `app` is valid on `priceListApp`.
  let priceListApp
  let studio
  let rival
  let twin
  let unlinked
  let customer
  let staffCookie
  let mailbox

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

    mailbox = { sent: [] }
    const mailer = {
      backofficeEmail: 'backoffice@example.test',
      send: async (message) => {
        mailbox.sent.push(message)
        return { ok: true }
      },
    }

    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, mailer, logger: false })
    priceListApp = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      tradePriceListsEnabled: true,
    })

    // --- Legacy fixture --------------------------------------------------
    await insertLegacyAccount(pool, {
      guid: GUID.studio,
      name: `${PREFIX} Studio Interiors`,
      email: `${PREFIX}-studio@example.test`,
    })
    await insertLegacyAccount(pool, { guid: GUID.rival, name: `${PREFIX} Rival Interiors` })
    // Two accounts, identical name.
    await insertLegacyAccount(pool, { guid: GUID.twinA, name: `${PREFIX} Twin Design` })
    await insertLegacyAccount(pool, { guid: GUID.twinB, name: `${PREFIX} Twin Design` })

    await insertInvoice(pool, {
      guid: '10000000-0000-4000-8000-000000000001',
      customer: `${PREFIX} Studio Interiors`,
      number: 'INV-STUDIO-1',
      date: '2026-01-15',
      total: '1234.50',
    })
    await insertInvoice(pool, {
      guid: '10000000-0000-4000-8000-000000000002',
      // Same customer, differently cased and padded — the match is normalised.
      customer: `  ${PREFIX.toUpperCase()} STUDIO INTERIORS `,
      number: 'INV-STUDIO-2',
      date: '2026-02-15',
      total: '99.00',
    })
    await insertInvoice(pool, {
      guid: GUID.strangerInvoice,
      customer: `${PREFIX} Rival Interiors`,
      number: 'INV-RIVAL-1',
      date: '2026-03-15',
      total: '5000.00',
    })
    await insertInvoice(pool, {
      guid: '10000000-0000-4000-8000-000000000004',
      customer: `${PREFIX} Twin Design`,
      number: 'INV-TWIN-1',
      date: '2026-04-15',
      total: '10.00',
    })

    await insertCutting(pool, {
      guid: '20000000-0000-4000-8000-000000000001',
      customer: `${PREFIX} Studio Interiors`,
      product: 'Atlas — Ecru',
      supplier: 'Pierre Frey',
    })
    await insertCutting(pool, {
      guid: '20000000-0000-4000-8000-000000000002',
      customer: `${PREFIX} Rival Interiors`,
      product: 'Wright — Clay',
      supplier: 'Larsen',
    })

    // --- Accounts --------------------------------------------------------
    // Registered ONCE: register shares a 10-per-15-minutes-per-IP bucket with
    // login, so re-registering per test would 429 and yield no cookie.
    studio = await registerTrade(app, pool, `${PREFIX}-studio-user@example.test`)
    rival = await registerTrade(app, pool, `${PREFIX}-rival-user@example.test`)
    twin = await registerTrade(app, pool, `${PREFIX}-twin-user@example.test`)
    unlinked = await registerTrade(app, pool, `${PREFIX}-unlinked-user@example.test`)
    customer = await registerCustomer(app, `${PREFIX}-customer@example.test`)

    // Staff, promoted directly (there is no self-serve path to backoffice).
    const staff = await registerCustomer(app, `${PREFIX}-staff@example.test`)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-staff@example.test`,
    ])
    staffCookie = staff.cookie

    // --- Links, made the way the back office makes them -------------------
    await link(app, staffCookie, { guid: GUID.studio, userId: studio.id })
    await link(app, staffCookie, { guid: GUID.rival, userId: rival.id })
    await link(app, staffCookie, { guid: GUID.twinA, userId: twin.id })
  })

  afterAll(async () => {
    await cleanup(pool)
    await app?.close()
    await priceListApp?.close()
    await pool?.end()
  })

  // Registers an APPROVED trade account. A pending one cannot authenticate at
  // all, so the approval flip has to happen before the session is minted.
  const registerTrade = async (instance, db, email) => {
    const res = await instance.inject({
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
    await db.query(`UPDATE users SET trade_approved = true WHERE email = $1`, [email])
    // The form raised its own company and granted the login to it (Sept
    // 2026); these tests link the login to a Dynamics account themselves, so
    // drop that row — the grant cascades with it.
    await db.query(
      `DELETE FROM trade_accounts WHERE id IN
         (SELECT trade_account_id FROM trade_applications ta JOIN users u ON u.id = ta.user_id
           WHERE u.email = $1)`,
      [email]
    )
    const login = await instance.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    const { rows } = await db.query('SELECT id FROM users WHERE email = $1', [email])
    return { cookie: cookieOf(login), id: rows[0].id }
  }

  const registerCustomer = async (instance, email) => {
    const res = await instance.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: PASSWORD, name: 'Customer' },
    })
    expect(res.statusCode).toBe(201)
    return { cookie: cookieOf(res) }
  }

  const link = async (instance, cookie, { guid, userId }) => {
    const res = await instance.inject({
      method: 'POST',
      url: '/admin/trade-accounts',
      headers: { cookie },
      payload: { legacy_account_guid: guid, user_id: userId },
    })
    expect(res.statusCode).toBe(201)
    return res.json().trade_account
  }

  const get = (instance, url, cookie) =>
    instance.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

  describe('access control', () => {
    it('refuses an anonymous visitor with 401', async () => {
      for (const url of ['/account/summary', '/account/samples', '/account/invoices']) {
        expect((await get(app, url)).statusCode).toBe(401)
      }
    })

    it('refuses a plain customer with 403', async () => {
      for (const url of ['/account/summary', '/account/samples', '/account/invoices']) {
        expect((await get(app, url, customer.cookie)).statusCode).toBe(403)
      }
    })

    it('refuses BACK-OFFICE staff too — this portal is the client view', async () => {
      // requireRole('trade') grants ['trade'] only. Staff read the same data
      // through /admin/legacy/*, where it is not scoped to one company.
      expect((await get(app, '/account/summary', staffCookie)).statusCode).toBe(403)
    })

    it('refuses a trade account whose approval has been revoked', async () => {
      await pool.query(`UPDATE users SET trade_approved = false WHERE id = $1`, [unlinked.id])
      // Not 403: SESSION_USER_CONDITION excludes a pending trade account, so the
      // session resolves to no user at all.
      expect((await get(app, '/account/summary', unlinked.cookie)).statusCode).toBe(401)
      await pool.query(`UPDATE users SET trade_approved = true WHERE id = $1`, [unlinked.id])
    })
  })

  describe('scoping', () => {
    it('serves a client only their own invoices', async () => {
      const res = await get(app, '/account/invoices', studio.cookie)
      expect(res.statusCode).toBe(200)
      const numbers = res.json().invoices.map((invoice) => invoice.number)
      expect(numbers.sort()).toEqual(['INV-STUDIO-1', 'INV-STUDIO-2'])
      expect(res.json().meta.total).toBe(2)
    })

    it('matches the customer name case- and whitespace-insensitively', async () => {
      const res = await get(app, '/account/invoices', studio.cookie)
      expect(res.json().invoices.map((i) => i.number)).toContain('INV-STUDIO-2')
    })

    it('never serves one client another client’s invoices', async () => {
      const res = await get(app, '/account/invoices', rival.cookie)
      const numbers = res.json().invoices.map((invoice) => invoice.number)
      expect(numbers).toEqual(['INV-RIVAL-1'])
      expect(numbers).not.toContain('INV-STUDIO-1')
    })

    it('serves a client only their own cuttings', async () => {
      const res = await get(app, '/account/samples', studio.cookie)
      expect(res.statusCode).toBe(200)
      expect(res.json().samples.map((sample) => sample.product)).toEqual(['Atlas — Ecru'])
    })

    it('serves NOTHING to a client whose company name collides with another account', async () => {
      // Twin Design exists twice in D365. Matching on the name would return the
      // union, so the link is flagged and the reads fail closed.
      const invoices = await get(app, '/account/invoices', twin.cookie)
      expect(invoices.statusCode).toBe(200)
      expect(invoices.json().invoices).toEqual([])
      const samples = await get(app, '/account/samples', twin.cookie)
      expect(samples.json().samples).toEqual([])
    })

    it('tells a colliding client their account is not ready rather than showing zeroes', async () => {
      const res = await get(app, '/account/summary', twin.cookie)
      expect(res.json().trade_account.linked).toBe(false)
    })

    it('closes a collision that appears AFTER the link was made', async () => {
      // `name_is_ambiguous` is computed once, at link time — but the D365 import
      // re-runs until cutover and can insert a new account with a name that
      // collides with an already-linked one. The stored flag would still say
      // false while the name match silently widened onto the new company's
      // records, so the guard is re-derived on every read.
      const intruder = '66666666-6666-4666-8666-666666666666'
      await insertLegacyAccount(pool, { guid: intruder, name: `${PREFIX} Studio Interiors` })
      await insertInvoice(pool, {
        guid: '10000000-0000-4000-8000-000000000005',
        customer: `${PREFIX} Studio Interiors`,
        number: 'INV-INTRUDER-1',
        date: '2026-05-15',
        total: '1.00',
      })
      try {
        // The stored flag is untouched and still false...
        const { rows } = await pool.query(
          `SELECT name_is_ambiguous FROM trade_accounts WHERE legacy_account_guid = $1`,
          [GUID.studio]
        )
        expect(rows[0].name_is_ambiguous).toBe(false)

        // ...but nothing is served, and the client is told the account is not ready.
        const invoices = await get(app, '/account/invoices', studio.cookie)
        expect(invoices.json().invoices).toEqual([])
        expect((await get(app, '/account/summary', studio.cookie)).json().trade_account.linked).toBe(
          false
        )
      } finally {
        await pool.query(`DELETE FROM legacy_sales_invoices WHERE number = 'INV-INTRUDER-1'`)
        await pool.query(`DELETE FROM legacy_accounts WHERE guid = $1`, [intruder])
      }

      // ...and the client is served normally again once the collision is gone.
      const after = await get(app, '/account/invoices', studio.cookie)
      expect(after.json().invoices.map((i) => i.number).sort()).toEqual([
        'INV-STUDIO-1',
        'INV-STUDIO-2',
      ])
    })

    it('closes a rename that hands the old name to another company', async () => {
      // The case recomputing the flag would NOT catch: the linked account is
      // renamed and an unrelated company takes its old name, so the collision
      // count is legitimately 1 and only the snapshot is wrong. Requiring the
      // snapshot to still equal the LINKED GUID's current name is what closes it.
      await pool.query(`UPDATE legacy_accounts SET name = $2 WHERE guid = $1`, [
        GUID.studio,
        `${PREFIX} Studio Interiors Ltd`,
      ])
      try {
        const invoices = await get(app, '/account/invoices', studio.cookie)
        expect(invoices.json().invoices).toEqual([])
      } finally {
        await pool.query(`UPDATE legacy_accounts SET name = $2 WHERE guid = $1`, [
          GUID.studio,
          `${PREFIX} Studio Interiors`,
        ])
      }
    })

    it('serves nothing to a trade account nobody has linked, and says so', async () => {
      const summary = await get(app, '/account/summary', unlinked.cookie)
      expect(summary.statusCode).toBe(200)
      expect(summary.json().trade_account).toEqual({
        linked: false,
        company_name: null,
        account_manager: null,
      })
      expect(summary.json().invoices.total).toBe(0)
      const invoices = await get(app, '/account/invoices', unlinked.cookie)
      expect(invoices.json().invoices).toEqual([])
    })
  })

  describe('dashboard', () => {
    it('summarises the linked company, its counts and recent orders', async () => {
      const body = (await get(app, '/account/summary', studio.cookie)).json()
      expect(body.trade_account.linked).toBe(true)
      expect(body.trade_account.company_name).toBe(`${PREFIX} Studio Interiors`)
      expect(body.invoices.total).toBe(2)
      expect(body.samples.total).toBe(1)
      expect(body.orders).toHaveProperty('recent')
      expect(body.price_lists.available).toBe(false)
    })

    it('never exposes the Dynamics record id to the client', async () => {
      const body = (await get(app, '/account/summary', studio.cookie)).json()
      expect(JSON.stringify(body)).not.toContain(GUID.studio)
    })

    it('shows the staff-set account manager, and null when none is set', async () => {
      const body = (await get(app, '/account/summary', studio.cookie)).json()
      expect(body.trade_account.account_manager).toBeNull()

      const { rows } = await pool.query(
        `SELECT id FROM trade_accounts WHERE legacy_account_guid = $1`,
        [GUID.studio]
      )
      const patch = await app.inject({
        method: 'PATCH',
        url: `/admin/trade-accounts/${rows[0].id}`,
        headers: { cookie: staffCookie },
        payload: { account_manager_name: 'Charlotte Savill', account_manager_email: 'c@example.test' },
      })
      expect(patch.statusCode).toBe(200)

      const after = (await get(app, '/account/summary', studio.cookie)).json()
      expect(after.trade_account.account_manager).toEqual({
        name: 'Charlotte Savill',
        email: 'c@example.test',
        phone: null,
      })
    })
  })

  describe('invoice copy request', () => {
    it('emails the back office and the client for the client’s own invoice', async () => {
      mailbox.sent.length = 0
      const res = await app.inject({
        method: 'POST',
        url: '/account/invoices/10000000-0000-4000-8000-000000000001/copy-request',
        headers: { cookie: studio.cookie },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toMatchObject({ requested: true, invoice_number: 'INV-STUDIO-1' })
      expect(mailbox.sent.map((m) => m.template)).toEqual([
        'backoffice_invoice_copy_request',
        'invoice_copy_requested',
      ])
    })

    it('404s a request for someone else’s invoice and sends no mail', async () => {
      mailbox.sent.length = 0
      const res = await app.inject({
        method: 'POST',
        url: `/account/invoices/${GUID.strangerInvoice}/copy-request`,
        headers: { cookie: studio.cookie },
      })
      // 404 not 403: a 403 would confirm the invoice exists.
      expect(res.statusCode).toBe(404)
      expect(mailbox.sent).toEqual([])
    })

    it('400s a malformed record id rather than reaching the database', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/account/invoices/not-a-uuid/copy-request',
        headers: { cookie: studio.cookie },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('price lists', () => {
    it('does not exist while the feature is off', async () => {
      expect((await get(app, '/account/price-lists', studio.cookie)).statusCode).toBe(404)
    })

    it('is still trade-only when the feature is on', async () => {
      expect((await get(priceListApp, '/account/price-lists', customer.cookie)).statusCode).toBe(403)
      expect((await get(priceListApp, '/account/price-lists')).statusCode).toBe(401)
    })

    it('lists houses that have priced designs', async () => {
      const res = await get(priceListApp, '/account/price-lists', studio.cookie)
      expect(res.statusCode).toBe(200)
      expect(Array.isArray(res.json().brands)).toBe(true)
    })
  })
})
