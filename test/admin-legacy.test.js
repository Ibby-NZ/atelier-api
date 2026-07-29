import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

// Read-only window on the D365 staging tables. Fixtures are inserted directly
// (the endpoint is read-only) with a recognisable name prefix so assertions stay
// deterministic even though the dev DB may also hold the real import.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'legacy-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const PREFIX = 'ZZ Legacy Test'

const GUID = {
  alpha: '11111111-1111-1111-1111-111111111111',
  beta: '22222222-2222-2222-2222-222222222222',
  order: '33333333-3333-3333-3333-333333333333',
}

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seed = async (pool) => {
  await pool.query(
    `INSERT INTO legacy_accounts (guid, name, is_customer, is_supplier, atelier_account_number, primary_contact, email, source_file, raw)
     VALUES ($1,$2,true,false,'ACC-T-1','Alice Alpha','alice@ztest.example','test.xlsx','{"Account Name":"ZZ Legacy Test Alpha"}'::jsonb),
            ($3,$4,false,true,'ACC-T-2','Bob Beta','bob@ztest.example','test.xlsx','{}'::jsonb)`,
    [GUID.alpha, `${PREFIX} Alpha`, GUID.beta, `${PREFIX} Beta`]
  )
  await pool.query(
    `INSERT INTO legacy_sales_orders (guid, number, customer, status_reason, total_incl_gst, source_file, raw)
     VALUES ($1, 'SO-ZZTEST', $2, 'Order Confirmation', 146.30, 'test.xlsx', '{}'::jsonb)`,
    [GUID.order, `${PREFIX} Alpha`]
  )
}

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM legacy_accounts WHERE name LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM legacy_sales_orders WHERE number = 'SO-ZZTEST'`)
}

describe('GET /admin/legacy/:entity (read-only D365 window)', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (url, cookie) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

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

    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('boss')])
    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)

    await seed(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  it('rejects anonymous (401) and customer (403)', async () => {
    expect((await inject('/admin/legacy/accounts', null)).statusCode).toBe(401)
    expect((await inject('/admin/legacy/accounts', customerCookie)).statusCode).toBe(403)
  })

  it('400s an unknown entity', async () => {
    expect((await inject('/admin/legacy/widgets', backofficeCookie)).statusCode).toBe(400)
  })

  it('lists accounts with pagination meta', async () => {
    const res = await inject('/admin/legacy/accounts?q=ZZ%20Legacy%20Test', backofficeCookie)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.meta.entity).toBe('accounts')
    expect(body.meta.total).toBe(2)
    expect(body.items).toHaveLength(2)
    // numeric coercion + no raw in the list rows
    expect(body.items[0]).not.toHaveProperty('raw')
  })

  it('searches and filters', async () => {
    const search = (await inject('/admin/legacy/accounts?q=Alpha', backofficeCookie)).json()
    expect(search.items.every((i) => /Alpha/.test(i.name))).toBe(true)

    const customersOnly = (
      await inject('/admin/legacy/accounts?q=ZZ%20Legacy%20Test&is_customer=true', backofficeCookie)
    ).json()
    expect(customersOnly.items).toHaveLength(1)
    expect(customersOnly.items[0].name).toBe(`${PREFIX} Alpha`)
  })

  it('gets one record by guid including raw', async () => {
    const res = await inject(`/admin/legacy/accounts/${GUID.alpha}`, backofficeCookie)
    expect(res.statusCode).toBe(200)
    const { record } = res.json()
    expect(record.name).toBe(`${PREFIX} Alpha`)
    expect(record.raw).toEqual({ 'Account Name': 'ZZ Legacy Test Alpha' })
    expect(record.source_file).toBe('test.xlsx')
  })

  it('404s an unknown guid and 400s a malformed one', async () => {
    expect(
      (await inject('/admin/legacy/accounts/44444444-4444-4444-4444-444444444444', backofficeCookie))
        .statusCode
    ).toBe(404)
    expect((await inject('/admin/legacy/accounts/not-a-guid', backofficeCookie)).statusCode).toBe(400)
  })

  it('reads sales-orders too', async () => {
    const res = await inject('/admin/legacy/sales-orders?q=SO-ZZTEST', backofficeCookie)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].number).toBe('SO-ZZTEST')
    expect(body.items[0].total_incl_gst).toBe(146.3) // coerced to Number
  })
})
