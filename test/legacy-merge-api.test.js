import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

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

  it('refuses a body it does not know', async () => {
    const response = await post({ createHouses: true }, directorCookie)
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
    expect(body.summary.accounts.created).toBeGreaterThanOrEqual(1)

    // The staged client is on the live book now, with its details.
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

  it('refuses a second run while one is in flight with 409', async () => {
    const [first, second] = await Promise.all([post({}, directorCookie), post({}, directorCookie)])
    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 409])
    const refused = first.statusCode === 409 ? first : second
    expect(refused.json().error).toMatch(/already running/)
    // And the lock is released: the next run is welcome.
    const third = await post({}, directorCookie)
    expect(third.statusCode).toBe(200)
  })
})
