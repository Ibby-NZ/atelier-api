import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { LEGACY_TABLES } from '../src/seed/legacy-import.js'
import { ARCHIVE_ENTITIES, parseFilter } from '../src/legacy/archive-read.js'

// The Dynamics archive read (/admin/dynamics/*): every legacy_* table, any
// column filterable. Fixtures carry a recognisable prefix because the dev
// database may also hold the real corpus.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'dyn-archive-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const PREFIX = 'ZZ Archive Test'

const GUID = {
  alpha: '61111111-1111-1111-1111-111111111111',
  beta: '62222222-2222-2222-2222-222222222222',
  gamma: '63333333-3333-3333-3333-333333333333',
  order: '64444444-4444-4444-4444-444444444444',
  invoice: '65555555-5555-5555-5555-555555555555',
}

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seed = async (pool) => {
  await pool.query(
    `INSERT INTO legacy_accounts (guid, name, is_customer, customer_type, credit_limit, main_phone, source_file, raw)
     VALUES ($1, $2, true,  'Trade',  5000, '021 000 001', 'test.xlsx', '{"Account Name":"A"}'::jsonb),
            ($3, $4, true,  'Retail', NULL, '',            'test.xlsx', '{}'::jsonb),
            ($5, $6, false, 'Trade',  250,  NULL,          'test.xlsx', '{}'::jsonb)`,
    [GUID.alpha, `${PREFIX} Alpha`, GUID.beta, `${PREFIX} Beta`, GUID.gamma, `${PREFIX} Gamma`]
  )
  await pool.query(
    `INSERT INTO legacy_sales_orders (guid, number, customer, order_date, total_incl_gst, source_file, raw)
     VALUES ($1, 'SO-ZZARCH', $2, '2026-03-05 00:00:00', 146.30, 'test.xlsx', '{}'::jsonb)`,
    [GUID.order, `${PREFIX} Alpha`]
  )
  // An entity with NO curated read route — proves the archive reaches all twelve.
  await pool.query(
    `INSERT INTO legacy_sales_invoices (guid, number, customer, source_file, raw)
     VALUES ($1, 'INV-ZZARCH', $2, 'test.xlsx', '{}'::jsonb)`,
    [GUID.invoice, `${PREFIX} Alpha`]
  )
  // A correction on Beta and a suppression on Gamma, through the overrides table.
  await pool.query(
    `INSERT INTO d365_overrides (entity, guid, patch) VALUES ('accounts', $1, $2::jsonb)`,
    [GUID.beta, JSON.stringify({ main_phone: '09 555 0000', credit_limit: '1200' })]
  )
  await pool.query(
    `INSERT INTO d365_overrides (entity, guid, archived_at) VALUES ('accounts', $1, now())`,
    [GUID.gamma]
  )
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM d365_overrides WHERE guid = ANY($1::uuid[])', [Object.values(GUID)])
  await pool.query('DELETE FROM legacy_accounts WHERE name LIKE $1', [`${PREFIX}%`])
  await pool.query(`DELETE FROM legacy_sales_orders WHERE number = 'SO-ZZARCH'`)
  await pool.query(`DELETE FROM legacy_sales_invoices WHERE number = 'INV-ZZARCH'`)
}

describe('parseFilter', () => {
  it('splits column:op:value and keeps colons inside the value', () => {
    expect(parseFilter('sales_orders', 'order_date:gte:2026-03-05T10:30')).toEqual({
      column: 'order_date', op: 'gte', type: 'timestamp', value: '2026-03-05T10:30',
    })
    expect(parseFilter('accounts', 'customer_type:in:Trade,Retail').value).toEqual(['Trade', 'Retail'])
    expect(parseFilter('accounts', 'main_phone:empty').value).toBeNull()
  })

  it('refuses unknown columns, wrong operators and malformed values with the reason', () => {
    expect(() => parseFilter('accounts', 'nope:eq:x')).toThrow(/Unknown column "nope"/)
    expect(() => parseFilter('accounts', 'name:gt:1')).toThrow(/"gt" is not valid for name/)
    expect(() => parseFilter('accounts', 'credit_limit:eq:abc')).toThrow(/not a valid numeric/)
    expect(() => parseFilter('sales_orders', 'order_date:eq:2026-02-30')).toThrow(/not a valid timestamp/)
    expect(() => parseFilter('accounts', 'raw:eq:x')).toThrow(/Unknown column "raw"/)
    expect(() => parseFilter('accounts', 'name:eq:')).toThrow(/needs a value/)
  })
})

describe('/admin/dynamics/* (the Dynamics archive)', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (url, cookie) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })
  const list = async (entity, query) => {
    const res = await inject(`/admin/dynamics/${entity}?${query}`, backofficeCookie)
    expect(res.statusCode).toBe(200)
    return res.json()
  }
  const mine = (q) => `q=${encodeURIComponent(PREFIX)}${q ? `&${q}` : ''}`

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
    expect((await inject('/admin/dynamics', null)).statusCode).toBe(401)
    expect((await inject('/admin/dynamics', customerCookie)).statusCode).toBe(403)
    expect((await inject('/admin/dynamics/accounts', customerCookie)).statusCode).toBe(403)
  })

  it('describes all twelve entities with their columns, counts and read key', async () => {
    const res = await inject('/admin/dynamics', backofficeCookie)
    expect(res.statusCode).toBe(200)
    const { entities } = res.json()
    expect(entities.map((e) => e.entity)).toEqual(ARCHIVE_ENTITIES)
    expect(ARCHIVE_ENTITIES).toEqual(Object.keys(LEGACY_TABLES))
    const accounts = entities.find((e) => e.entity === 'accounts')
    expect(accounts.read_entity).toBe('accounts')
    expect(accounts.total).toBeGreaterThanOrEqual(2)
    expect(accounts.columns.some((c) => c.name === 'raw')).toBe(false)
    expect(accounts.columns.find((c) => c.name === 'credit_limit').type).toBe('numeric')
    expect(entities.find((e) => e.entity === 'sales_orders').read_entity).toBe('sales-orders')
    expect(entities.find((e) => e.entity === 'sales_invoices').read_entity).toBeNull()
  })

  it('400s an entity outside the twelve', async () => {
    expect((await inject('/admin/dynamics/widgets', backofficeCookie)).statusCode).toBe(400)
  })

  it('searches every text column and hides suppressed records', async () => {
    const body = await list('accounts', mine())
    expect(body.meta.total).toBe(2)
    expect(body.items.map((i) => i.name).sort()).toEqual([`${PREFIX} Alpha`, `${PREFIX} Beta`])
    expect(body.items[0]).not.toHaveProperty('raw')
  })

  it('applies corrections to the listed value and reports which fields', async () => {
    const body = await list('accounts', mine('filter=main_phone:eq:09 555 0000'))
    expect(body.items).toHaveLength(1)
    expect(body.items[0].guid).toBe(GUID.beta)
    expect(body.items[0].credit_limit).toBe(1200)
    expect(body.items[0].overridden_fields.sort()).toEqual(['credit_limit', 'main_phone'])
  })

  it('filters by operator per type: numeric range, text in, boolean, empty', async () => {
    expect((await list('accounts', mine('filter=credit_limit:gte:2000'))).items.map((i) => i.name))
      .toEqual([`${PREFIX} Alpha`])
    expect((await list('accounts', mine('filter=customer_type:in:Retail'))).items.map((i) => i.name))
      .toEqual([`${PREFIX} Beta`])
    expect((await list('accounts', mine('filter=is_customer:eq:true'))).meta.total).toBe(2)
    // Beta's phone is corrected to a value, so nothing of ours is empty any more.
    expect((await list('accounts', mine('filter=main_phone:empty'))).meta.total).toBe(0)
    expect((await list('accounts', mine('filter=main_phone:starts:021'))).items[0].guid).toBe(GUID.alpha)
  })

  it('sorts on any column with a stable secondary key', async () => {
    const asc = await list('accounts', mine('sort=credit_limit&dir=asc'))
    expect(asc.meta.sort).toEqual({ column: 'credit_limit', dir: 'asc' })
    expect(asc.items.map((i) => i.credit_limit)).toEqual([1200, 5000])
    const desc = await list('accounts', mine('sort=credit_limit&dir=desc'))
    expect(desc.items.map((i) => i.credit_limit)).toEqual([5000, 1200])
  })

  it('400s a bad filter naming the reason, and a bad sort column', async () => {
    const bad = await inject(`/admin/dynamics/accounts?filter=credit_limit:eq:abc`, backofficeCookie)
    expect(bad.statusCode).toBe(400)
    expect(bad.json().message).toMatch(/not a valid numeric/)
    expect((await inject(`/admin/dynamics/accounts?sort=raw`, backofficeCookie)).statusCode).toBe(400)
  })

  it('writes a zone-less timestamp exactly as staged', async () => {
    const body = await list('sales_orders', 'filter=number:eq:SO-ZZARCH')
    expect(body.items[0].order_date).toBe('2026-03-05T00:00:00')
    expect(body.items[0].total_incl_gst).toBe(146.3)
    expect((await list('sales_orders', 'filter=number:eq:SO-ZZARCH&filter=order_date:lt:2026-03-05')).meta.total).toBe(0)
    expect((await list('sales_orders', 'filter=number:eq:SO-ZZARCH&filter=order_date:lte:2026-03-05')).meta.total).toBe(1)
  })

  it('reaches an entity with no curated read route', async () => {
    const body = await list('sales_invoices', 'filter=number:eq:INV-ZZARCH')
    expect(body.items).toHaveLength(1)
    expect(body.items[0].overridden_fields).toEqual([])
  })

  it('serves facets for a text column and refuses them for a numeric one', async () => {
    const res = await inject('/admin/dynamics/accounts/facets?column=customer_type', backofficeCookie)
    expect(res.statusCode).toBe(200)
    const { values } = res.json()
    expect(values.find((v) => v.value === 'Trade').count).toBeGreaterThanOrEqual(1)
    expect(values.every((v) => typeof v.count === 'number')).toBe(true)
    expect((await inject('/admin/dynamics/accounts/facets?column=credit_limit', backofficeCookie)).statusCode).toBe(400)
  })

  it('gets one record with raw, 404s an unknown guid and a suppressed one', async () => {
    const res = await inject(`/admin/dynamics/accounts/${GUID.alpha}`, backofficeCookie)
    expect(res.statusCode).toBe(200)
    expect(res.json().record.raw).toEqual({ 'Account Name': 'A' })
    expect((await inject(`/admin/dynamics/accounts/${GUID.gamma}`, backofficeCookie)).statusCode).toBe(404)
    expect((await inject('/admin/dynamics/accounts/not-a-guid', backofficeCookie)).statusCode).toBe(400)
  })
})
