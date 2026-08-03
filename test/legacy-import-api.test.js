import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { gzipSync } from 'node:zlib'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { decodeImportPayload, MAX_RECORDS_PER_BATCH } from '../src/legacy/import-payload.js'
import { chunk, parseArgs } from '../src/seed/push-legacy.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'legacy-push-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// Namespaced so cleanup deletes exactly these rows and never touches a real
// import sitting in the same database.
const PRICE_GUID = '00000000-0000-4000-8000-0000000000e1'
const PRICE_GUID_2 = '00000000-0000-4000-8000-0000000000e2'
const ACCOUNT_GUID = '00000000-0000-4000-8000-0000000000e3'
const FIXTURE_GUIDS = [PRICE_GUID, PRICE_GUID_2, ACCOUNT_GUID]

const priceRecord = (overrides = {}) => ({
  guid: PRICE_GUID,
  code: 'PUSH-TEST-001',
  description: 'ELLA STRIPE',
  range_name: 'MADEAUX',
  item_type: 'Fabrics',
  currency: 'Euro',
  wholesale_rate: 48,
  source_file: 'Active Product Prices TEST.xlsx',
  raw: { atelier_code: 'PUSH-TEST-001' },
  ...overrides,
})

const accountRecord = (overrides = {}) => ({
  guid: ACCOUNT_GUID,
  name: 'Push Test Account Ltd',
  is_customer: true,
  source_file: 'Customers TEST.xlsx',
  raw: { name: 'Push Test Account Ltd' },
  ...overrides,
})

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const gzipJson = (value) => gzipSync(Buffer.from(JSON.stringify(value), 'utf8'))

describe('remote legacy staging import', () => {
  let pool
  let app
  let directorCookie
  let backofficeCookie

  const postGzip = (entity, records, cookie) =>
    app.inject({
      method: 'POST',
      url: `/admin/legacy/import/${entity}`,
      headers: {
        'content-type': 'application/gzip',
        ...(cookie ? { cookie } : {}),
      },
      payload: gzipJson(records),
    })

  const priceRowsByGuid = async () => {
    const { rows } = await pool.query(
      'SELECT guid, code, description FROM legacy_product_prices WHERE guid = ANY($1::uuid[]) ORDER BY guid',
      [FIXTURE_GUIDS]
    )
    return rows
  }

  const cleanupFixtures = async () => {
    await pool.query('DELETE FROM legacy_product_prices WHERE guid = ANY($1::uuid[])', [FIXTURE_GUIDS])
    await pool.query('DELETE FROM legacy_accounts WHERE guid = ANY($1::uuid[])', [FIXTURE_GUIDS])
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

    await cleanupFixtures()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered once and kept: register shares a 10 / 15 min / IP bucket with
    // login, so re-registering per test would 429 and yield no cookie.
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
  })

  beforeEach(cleanupFixtures)

  afterAll(async () => {
    await cleanupFixtures()
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous import with 401', async () => {
      const response = await postGzip('product_prices', [priceRecord()], null)
      expect(response.statusCode).toBe(401)
      expect(await priceRowsByGuid()).toHaveLength(0)
    })

    // Backoffice may BROWSE the staging tables; bulk-writing them is director
    // only. If this ever returns 200 the privilege split has been lost.
    it('rejects a backoffice import with 403', async () => {
      const response = await postGzip('product_prices', [priceRecord()], backofficeCookie)
      expect(response.statusCode).toBe(403)
      expect(await priceRowsByGuid()).toHaveLength(0)
    })
  })

  describe('importing a batch', () => {
    it('applies a gzipped batch and returns the summary', async () => {
      const response = await postGzip('product_prices', [priceRecord()], directorCookie)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        entity: 'product_prices',
        table: 'legacy_product_prices',
        records: 1,
      })
      const rows = await priceRowsByGuid()
      expect(rows).toHaveLength(1)
      expect(rows[0].code).toBe('PUSH-TEST-001')
    })

    it('accepts a plain JSON array too (the curl path)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/legacy/import/accounts',
        headers: { cookie: directorCookie },
        payload: [accountRecord()],
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().records).toBe(1)
    })

    it('is idempotent — a resent batch refreshes rather than duplicates', async () => {
      await postGzip('product_prices', [priceRecord()], directorCookie)
      const again = await postGzip(
        'product_prices',
        [priceRecord({ description: 'ELLA STRIPE — REVISED' })],
        directorCookie
      )

      expect(again.statusCode).toBe(200)
      const rows = await priceRowsByGuid()
      expect(rows).toHaveLength(1)
      expect(rows[0].description).toBe('ELLA STRIPE — REVISED')
    })

    it('imports every record in a multi-record batch', async () => {
      const response = await postGzip(
        'product_prices',
        [priceRecord(), priceRecord({ guid: PRICE_GUID_2, code: 'PUSH-TEST-002' })],
        directorCookie
      )

      expect(response.json().records).toBe(2)
      expect(await priceRowsByGuid()).toHaveLength(2)
    })
  })

  describe('rejections', () => {
    it('400s an unknown entity', async () => {
      const response = await postGzip('not_an_entity', [priceRecord()], directorCookie)
      expect(response.statusCode).toBe(400)
    })

    it('400s a body that is not gzip', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/legacy/import/product_prices',
        headers: { 'content-type': 'application/gzip', cookie: directorCookie },
        payload: Buffer.from('this is not gzip', 'utf8'),
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().message).toMatch(/not valid gzip/i)
    })

    it('400s a gzipped object that is not an array', async () => {
      const response = await postGzip('product_prices', { guid: PRICE_GUID }, directorCookie)
      expect(response.statusCode).toBe(400)
      expect(response.json().message).toMatch(/array/i)
    })

    it('400s an empty batch', async () => {
      const response = await postGzip('product_prices', [], directorCookie)
      expect(response.statusCode).toBe(400)
    })

    // Field-level failures are business rules, not malformed requests.
    it('422s a record carrying an unknown column', async () => {
      const response = await postGzip(
        'product_prices',
        [priceRecord({ not_a_column: 'x' })],
        directorCookie
      )

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/unknown column/i)
      expect(await priceRowsByGuid()).toHaveLength(0)
    })

    it('422s a batch with a duplicate GUID (one upsert cannot hit a key twice)', async () => {
      const response = await postGzip(
        'product_prices',
        [priceRecord(), priceRecord({ code: 'PUSH-TEST-DUPE' })],
        directorCookie
      )

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/duplicate record GUID/i)
      expect(await priceRowsByGuid()).toHaveLength(0)
    })
  })

  // The gzip parser is registered inside the import plugin's scope. If it ever
  // leaks to the root instance, every JSON route on the API starts receiving a
  // Buffer and the whole thing breaks.
  it('leaves JSON parsing intact for other routes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: testEmail('boss'), password: PASSWORD },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().user.role).toBe('director')
  })
})

describe('import payload decoding', () => {
  it('unwraps a gzipped array', () => {
    expect(decodeImportPayload(gzipJson([{ guid: 'a' }]))).toEqual([{ guid: 'a' }])
  })

  it('passes an already-parsed array straight through', () => {
    expect(decodeImportPayload([{ guid: 'a' }])).toEqual([{ guid: 'a' }])
  })

  it('rejects a batch over the record cap with 413', () => {
    const oversized = Array.from({ length: MAX_RECORDS_PER_BATCH + 1 }, () => ({ guid: 'a' }))
    expect(() => decodeImportPayload(oversized)).toThrowError(/exceeds/i)
    try {
      decodeImportPayload(oversized)
    } catch (error) {
      expect(error.statusCode).toBe(413)
    }
  })

  it('rejects gzip that decompresses to something other than JSON', () => {
    const notJson = gzipSync(Buffer.from('<html>nope</html>', 'utf8'))
    expect(() => decodeImportPayload(notJson)).toThrowError(/not valid JSON/i)
  })
})

describe('push client helpers', () => {
  it('splits records into fixed-size batches, last one short', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns no batches for no records', () => {
    expect(chunk([], 100)).toEqual([])
  })

  // A password in argv shows up in shell history and `ps`, so the environment
  // wins over the flag.
  it('prefers the environment password over the flag', () => {
    const options = parseArgs(
      ['--api', 'https://api.example.com/', '--email', 'a@b.c', '--password', 'from-argv'],
      { ATELIER_API_PASSWORD: 'from-env' }
    )

    expect(options.password).toBe('from-env')
    expect(options.email).toBe('a@b.c')
  })

  it('strips a trailing slash off the API base and defaults the batch size', () => {
    const options = parseArgs(['--api', 'https://api.example.com/'], {})
    expect(options.api).toBe('https://api.example.com')
    expect(options.batch).toBe(1000)
  })

  it('reads bare flags as booleans', () => {
    expect(parseArgs(['--dry-run'], {}).dryRun).toBe(true)
    expect(parseArgs([], {}).dryRun).toBe(false)
  })
})
