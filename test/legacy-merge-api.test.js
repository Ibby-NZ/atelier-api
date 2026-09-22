import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { adminLegacyMergeRoutes } from '../src/routes/admin-legacy-merge.js'

// POST /admin/legacy/merge: the cutover merge behind an authenticated request,
// for a server with no shell. The merge itself is proven by legacy-merge.test.js;
// this file proves the door — who may open it, what comes back, and that a
// staging row loaded through the API ends up on the live book.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'legacy-merge-route-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const PREFIX = 'ZZ Merge Route Test'
const ACCOUNT_GUID = '70000000-0000-4000-8000-00000000a001'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('POST /admin/legacy/merge', () => {
  let pool
  let app
  let directorCookie
  let backofficeCookie

  const post = (payload, cookie) =>
    app.inject({
      method: 'POST',
      url: '/admin/legacy/merge',
      headers: cookie ? { cookie } : {},
      payload,
    })

  const cleanup = async () => {
    await pool.query('DELETE FROM trade_accounts WHERE legacy_account_guid = $1', [ACCOUNT_GUID])
    await pool.query('DELETE FROM legacy_accounts WHERE guid = $1', [ACCOUNT_GUID])
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
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanup()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    directorCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'director' WHERE email = $1`, [testEmail('boss')])

    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('staff'), password: PASSWORD, name: 'Staff' },
    })
    backofficeCookie = sessionCookieFrom(staff)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('staff')])

    // One staged client, as the CRM's import panel would have landed it.
    await pool.query(
      `INSERT INTO legacy_accounts (guid, name, is_customer, is_supplier, atelier_account_number, source_file, raw)
       VALUES ($1, $2, true, false, '99001', 't.xlsx', '{}')`,
      [ACCOUNT_GUID, `${PREFIX} Client`]
    )
  })

  afterAll(async () => {
    await cleanup()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  it('needs a session', async () => {
    const response = await post({}, null)
    expect(response.statusCode).toBe(401)
  })

  // Back office may browse and correct the staging tables; promoting them onto
  // the live book is the director's, exactly like loading them.
  it('refuses back office with 403', async () => {
    const response = await post({}, backofficeCookie)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: 'Insufficient permissions.' })
  })

  // Fastify's default Ajv strips an unknown key rather than refusing it, so
  // the schema is proven on the one key it declares: a value that cannot be a
  // boolean is a 400, and the merge does not run.
  it('refuses a create_houses that is not a boolean', async () => {
    const response = await post({ create_houses: { nested: true } }, directorCookie)
    expect(response.statusCode).toBe(400)
  })

  it('runs the merge for a director and returns the summary the CLI prints', async () => {
    const response = await post({ create_houses: false }, directorCookie)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.create_houses).toBe(false)
    expect(typeof body.ms).toBe('number')
    expect(body.summary).toMatchObject({
      accounts: { created: expect.any(Number), unnamed: expect.any(Number) },
      contacts: { created: expect.any(Number) },
      reserves: { dockets: expect.any(Number), lines: expect.any(Number) },
      housesRaised: [],
      catalogue: { items: expect.any(Number), colourways: expect.any(Number) },
      stock: { matched: expect.any(Number), stocked: expect.any(Number) },
    })
    // No assertion on `accounts.created`: legacy-merge.test.js runs the same
    // merge against the same database in parallel and may have landed this
    // client first. What matters is that it is on the book, with its details.
    const { rows } = await pool.query(
      'SELECT legacy_customer_name, account_number FROM trade_accounts WHERE legacy_account_guid = $1',
      [ACCOUNT_GUID]
    )
    expect(rows).toEqual([{ legacy_customer_name: `${PREFIX} Client`, account_number: '99001' }])
  })

  it('is re-runnable: a second run creates no second account', async () => {
    const response = await post({}, directorCookie)
    expect(response.statusCode).toBe(200)
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM trade_accounts WHERE legacy_account_guid = $1',
      [ACCOUNT_GUID]
    )
    expect(rows[0].n).toBe(1)
  })
})

// The one-at-a-time rule, proven with a merge the test holds open. Two real
// requests raced through the full app are not a proof: over a small fixture the
// first merge can finish before the second request reaches the lock, and CI
// showed exactly that ([200, 200]). Here the plugin runs on a bare instance
// with an open-door guard and a `merge` that resolves when told to.
describe('POST /admin/legacy/merge runs one at a time', () => {
  const SUMMARY = {
    accounts: { created: 0, unnamed: 0 },
    contacts: { created: 0, filed: 0, unfiled: 0, no_company: 0 },
    reserves: { dockets: 0, lines: 0, declined: [] },
    housesRaised: [],
    catalogue: { items: 0, noHouse: 0, products: 0, colourways: 0, inventoryCreated: 0, unknownBrands: [], skips: [], conflicts: 0 },
    stock: { matched: 0, stocked: 0, priced: 0, unmatchedHouse: 0 },
  }

  // light-my-request dispatches lazily — an inject() nobody awaits never
  // starts — so a request that must be IN FLIGHT while the test does something
  // else is adopted into a real promise here, which calls its then() at once.
  const fire = (app, payload) =>
    Promise.resolve(app.inject({ method: 'POST', url: '/admin/legacy/merge', payload }))

  const bareApp = async (merge) => {
    const app = Fastify({ logger: false })
    app.decorate('guards', { requireRole: () => async () => {} })
    await app.register(adminLegacyMergeRoutes, { pool: null, merge })
    await app.ready()
    return app
  }

  it('answers 409 while a run is in flight, then welcomes the next', async () => {
    // One gate per merge call: the test learns when the run has STARTED and
    // decides when it ends. Reusing one resolver across calls is the trap —
    // releasing before the next call has begun resolves the old promise and
    // leaves the new run open for ever.
    const gates = []
    const gate = () => {
      let started
      let release
      const startedAt = new Promise((resolve) => { started = resolve })
      const done = new Promise((resolve) => { release = resolve })
      const opened = { started, release, startedAt, done }
      gates.push(opened)
      return opened
    }
    const calls = []
    const merge = (_pool, opts) => {
      calls.push(opts)
      const opened = gates.shift()
      opened.started()
      return opened.done
    }
    const app = await bareApp(merge)
    try {
      const gateOne = gate()
      const first = fire(app, { create_houses: true })
      await gateOne.startedAt
      const second = await fire(app, {})
      expect(second.statusCode).toBe(409)
      expect(second.json().error).toMatch(/already running/)
      expect(calls).toHaveLength(1)

      gateOne.release(SUMMARY)
      const done = await first
      expect(done.statusCode).toBe(200)
      expect(done.json()).toMatchObject({ summary: SUMMARY, create_houses: true })

      // The lock is released with the run, so the next run is welcome.
      const gateTwo = gate()
      const third = fire(app, {})
      await gateTwo.startedAt
      gateTwo.release(SUMMARY)
      expect((await third).statusCode).toBe(200)
      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual({ createHouses: false })
    } finally {
      await app.close()
    }
  })

  it('returns the reason a run failed and releases the lock', async () => {
    let attempts = 0
    const merge = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('relation "legacy_accounts" does not exist')
      return SUMMARY
    }
    const app = await bareApp(merge)
    try {
      const failed = await app.inject({ method: 'POST', url: '/admin/legacy/merge', payload: {} })
      expect(failed.statusCode).toBe(500)
      expect(failed.json().message).toMatch(/Legacy merge failed: relation "legacy_accounts" does not exist/)
      const again = await app.inject({ method: 'POST', url: '/admin/legacy/merge', payload: {} })
      expect(again.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
