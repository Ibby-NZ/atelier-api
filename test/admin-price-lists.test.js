import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
// Fixtures are namespaced by supplier prefix so cleanup can scope to them and
// never touch the ~19.5k real seeded rows the table also holds.
const PREFIX = 'PLTEST-'
const DOMAIN = 'admin-pl-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Insert a disposable price-list item, returning its id. Every column has a
// sensible default so a test overrides only what it cares about.
const insertItem = async (pool, overrides = {}) => {
  const row = {
    supplier: `${PREFIX}Alpha`,
    product_range: 'Range One',
    category: 'fabric',
    code: 'PLT-001',
    code_normalized: 'PLT-001',
    description: 'Linen Weave',
    contents: '100% Linen',
    unit: 'metre',
    width: '140',
    repeat: '0',
    vertical_repeat: '32',
    duty_class: null,
    wholesale_rate: 65,
    currency: 'EUR',
    freight_class: 'A',
    date_effective: '2026-02-18',
    source_file: 'PLTEST.csv',
    ...overrides,
  }
  const { rows } = await pool.query(
    `INSERT INTO price_list_items
       (supplier, product_range, category, code, code_normalized, description,
        contents, unit, width, "repeat", vertical_repeat, duty_class,
        wholesale_rate, currency, freight_class, date_effective, source_file)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      row.supplier,
      row.product_range,
      row.category,
      row.code,
      row.code_normalized,
      row.description,
      row.contents,
      row.unit,
      row.width,
      row.repeat,
      row.vertical_repeat,
      row.duty_class,
      row.wholesale_rate,
      row.currency,
      row.freight_class,
      row.date_effective,
      row.source_file,
    ]
  )
  return rows[0].id
}

// The recorded rate history goes FIRST: W17 made
// price_list_item_price_history.price_list_item_id ON DELETE RESTRICT so a
// delete cannot destroy the audit, which means the cleanup itself 23503s on any
// fixture whose rate a test moved. Same class of trap as orders before brands.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM price_list_item_price_history
      WHERE price_list_item_id IN
            (SELECT id FROM price_list_items WHERE supplier LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM price_list_items WHERE supplier LIKE $1', [`${PREFIX}%`])
}

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

describe('back-office price-list management', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  let fixtures

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

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
    await deleteUsers(pool)

    // Register the two users ONCE — register shares a 10/15min/IP rate-limit
    // bucket, so re-registering per test would 429 and yield no cookie.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    fixtures = {
      alphaFabric: await insertItem(pool, {
        supplier: `${PREFIX}Alpha`,
        category: 'fabric',
        code: 'PLT-001',
        code_normalized: 'PLT-001',
        description: 'Linen Weave',
        product_range: 'Range One',
      }),
      alphaWall: await insertItem(pool, {
        supplier: `${PREFIX}Alpha`,
        category: 'wallpaper',
        code: 'PLT-002',
        code_normalized: 'PLT-002',
        unit: 'roll',
        description: 'Damask Wall',
        product_range: 'Range Two',
      }),
      betaFabric: await insertItem(pool, {
        supplier: `${PREFIX}Beta`,
        category: 'fabric',
        code: 'PLT-003',
        code_normalized: 'PLT-003',
        description: 'Velvet Plain',
        product_range: 'Range Three',
      }),
    }
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous list request with 401', async () => {
      const response = await inject('GET', '/admin/price-list-items', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice list request with 403', async () => {
      const response = await inject('GET', '/admin/price-list-items', customerCookie)
      expect(response.statusCode).toBe(403)
    })

    it('rejects a non-backoffice create with 403', async () => {
      const response = await inject('POST', '/admin/price-list-items', customerCookie, {
        supplier: `${PREFIX}Gamma`,
        category: 'fabric',
        code: 'PLT-999',
        unit: 'metre',
        wholesale_rate: 10,
        currency: 'EUR',
      })
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/price-list-items', () => {
    it('lists items with a pagination meta envelope', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.meta).toEqual({ total: 2, page: 1, limit: 50 })
      expect(body.items).toHaveLength(2)
      // pg numeric coerced back to a number by the mapper.
      expect(typeof body.items[0].wholesale_rate).toBe('number')
    })

    it('filters by supplier', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Beta`,
        backofficeCookie
      )
      const body = response.json()
      expect(body.meta.total).toBe(1)
      expect(body.items.map((i) => i.code)).toEqual(['PLT-003'])
    })

    it('filters by category', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha&category=wallpaper`,
        backofficeCookie
      )
      const body = response.json()
      expect(body.meta.total).toBe(1)
      expect(body.items[0].id).toBe(fixtures.alphaWall)
    })

    it('searches code/description/product_range via q', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha&q=Damask`,
        backofficeCookie
      )
      const body = response.json()
      expect(body.meta.total).toBe(1)
      expect(body.items[0].id).toBe(fixtures.alphaWall)
    })

    it('paginates and reports the full total', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha&limit=1&page=1`,
        backofficeCookie
      )
      const body = response.json()
      expect(body.items).toHaveLength(1)
      expect(body.meta).toEqual({ total: 2, page: 1, limit: 1 })
    })

    // Was a 400 from a schema enum until migration 1791379200000 made the
    // vocabulary a table the office adds to: a filter compiled at boot cannot
    // know about a category created since, so an unknown one now reports
    // nothing — which is what a real category with no lines does too.
    it('answers an unknown category filter with an empty page', async () => {
      const response = await inject(
        'GET',
        '/admin/price-list-items?category=sofa',
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().items).toEqual([])
    })
  })

  describe('GET /admin/price-list-items/:id', () => {
    it('returns one row in the same shape the list returns', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const { item } = response.json()
      expect(item.id).toBe(fixtures.alphaFabric)
      expect(item.supplier).toBe(`${PREFIX}Alpha`)
      expect(item.code).toBe('PLT-001')
      expect(item.description).toBe('Linen Weave')
      // pg returns numeric as a string; the mapper is what coerces it, and the
      // detail read must go through the same one or the CRM's form gets a string.
      expect(item.wholesale_rate).toBe(65)
    })

    it('reflects a PATCH without a list refetch', async () => {
      await inject(
        'PATCH',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie,
        // A rate change carries its note or it is a 422 (W17 US-004).
        { wholesale_rate: 71.5, reason: 'Supplier increase' }
      )
      const response = await inject(
        'GET',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie
      )
      expect(response.json().item.wholesale_rate).toBe(71.5)
    })

    it('returns an archived row rather than 404', async () => {
      await inject(
        'POST',
        `/admin/price-list-items/${fixtures.alphaFabric}/archive`,
        backofficeCookie
      )
      // Archive is the durable removal here (a re-import undoes a delete), so
      // the archived row is the one staff go back to most — a 404 would read as
      // "someone deleted it".
      const response = await inject(
        'GET',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().item.archived_at).not.toBeNull()
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject('GET', '/admin/price-list-items/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
      expect(response.json().message).toMatch(/not found/i)
    })

    it('rejects an anonymous caller with 401 and a customer with 403', async () => {
      const path = `/admin/price-list-items/${fixtures.alphaFabric}`
      expect((await inject('GET', path, null)).statusCode).toBe(401)
      expect((await inject('GET', path, customerCookie)).statusCode).toBe(403)
    })
  })

  describe('POST /admin/price-list-items', () => {
    it('creates an item, deriving code_normalized and defaulting source_file', async () => {
      const response = await inject('POST', '/admin/price-list-items', backofficeCookie, {
        supplier: `${PREFIX}Gamma`,
        category: 'trimming',
        code: 'plt/new 01',
        unit: 'piece',
        wholesale_rate: 12.5,
        currency: 'GBP',
        description: 'Braided Cord',
      })
      expect(response.statusCode).toBe(201)
      const { item } = response.json()
      expect(item.code).toBe('plt/new 01')
      expect(item.code_normalized).toBe('PLT-NEW-01')
      expect(item.source_file).toBe('manual-entry')
      expect(item.wholesale_rate).toBe(12.5)
      expect(item.archived_at).toBeNull()
    })

    it('rejects a duplicate (supplier, category, code) with 409', async () => {
      const response = await inject('POST', '/admin/price-list-items', backofficeCookie, {
        supplier: `${PREFIX}Alpha`,
        category: 'fabric',
        code: 'PLT-001',
        unit: 'metre',
        wholesale_rate: 20,
        currency: 'EUR',
      })
      expect(response.statusCode).toBe(409)
    })

    it('rejects a non-positive wholesale_rate with 400', async () => {
      const response = await inject('POST', '/admin/price-list-items', backofficeCookie, {
        supplier: `${PREFIX}Gamma`,
        category: 'fabric',
        code: 'PLT-ZERO',
        unit: 'metre',
        wholesale_rate: 0,
        currency: 'EUR',
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PATCH /admin/price-list-items/:id', () => {
    it('updates the wholesale_rate', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie,
        { wholesale_rate: 88.5, reason: 'Supplier increase' }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().item.wholesale_rate).toBe(88.5)
    })

    it('updates the quoted "repeat" column', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie,
        { repeat: '64' }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().item.repeat).toBe('64')
    })

    it('recomputes code_normalized when the code changes', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie,
        { code: 'plt-999 x' }
      )
      expect(response.statusCode).toBe(200)
      const { item } = response.json()
      expect(item.code).toBe('plt-999 x')
      expect(item.code_normalized).toBe('PLT-999-X')
    })

    it('returns 404 for an unknown id', async () => {
      const response = await inject(
        'PATCH',
        '/admin/price-list-items/99999999',
        backofficeCookie,
        { wholesale_rate: 10 }
      )
      expect(response.statusCode).toBe(404)
    })

    it('rejects an empty patch body with 400', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(400)
    })
  })

  describe('archive + restore', () => {
    it('hides an archived item from the default list and restores it', async () => {
      const archive = await inject(
        'POST',
        `/admin/price-list-items/${fixtures.alphaFabric}/archive`,
        backofficeCookie
      )
      expect(archive.statusCode).toBe(200)
      expect(archive.json().item.archived_at).not.toBeNull()

      const hidden = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha`,
        backofficeCookie
      )
      expect(hidden.json().items.some((i) => i.id === fixtures.alphaFabric)).toBe(false)

      const shown = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha&include_archived=true`,
        backofficeCookie
      )
      expect(shown.json().items.some((i) => i.id === fixtures.alphaFabric)).toBe(true)

      const restore = await inject(
        'POST',
        `/admin/price-list-items/${fixtures.alphaFabric}/restore`,
        backofficeCookie
      )
      expect(restore.statusCode).toBe(200)
      expect(restore.json().item.archived_at).toBeNull()

      const back = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha`,
        backofficeCookie
      )
      expect(back.json().items.some((i) => i.id === fixtures.alphaFabric)).toBe(true)
    })

    it('returns 404 when archiving an unknown id', async () => {
      const response = await inject(
        'POST',
        '/admin/price-list-items/99999999/archive',
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
    })

    it('rejects an anonymous archive with 401', async () => {
      const response = await inject(
        'POST',
        `/admin/price-list-items/${fixtures.alphaFabric}/archive`,
        null
      )
      expect(response.statusCode).toBe(401)
    })
  })

  describe('DELETE /admin/price-list-items/:id', () => {
    const rowCount = async (id) => {
      const { rows } = await pool.query(
        'SELECT 1 FROM price_list_items WHERE id = $1',
        [id]
      )
      return rows.length
    }

    it('deletes the row and warns that a re-import re-creates it', async () => {
      const response = await inject(
        'DELETE',
        `/admin/price-list-items/${fixtures.alphaFabric}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.deleted).toEqual({
        entity: 'price_list_item',
        id: fixtures.alphaFabric,
      })
      // The one thing staff cannot infer from a 200: the supplier file still
      // holds this rate, so `npm run import:pricing` brings it straight back.
      expect(body.warning).toMatch(/import:pricing/)
      expect(body.warning).toMatch(/[Aa]rchive/)

      expect(await rowCount(fixtures.alphaFabric)).toBe(0)
      const list = await inject(
        'GET',
        `/admin/price-list-items?supplier=${PREFIX}Alpha&include_archived=true`,
        backofficeCookie
      )
      expect(list.json().items.some((i) => i.id === fixtures.alphaFabric)).toBe(false)
    })

    it('deletes an already-archived row too', async () => {
      await inject(
        'POST',
        `/admin/price-list-items/${fixtures.alphaWall}/archive`,
        backofficeCookie
      )
      const response = await inject(
        'DELETE',
        `/admin/price-list-items/${fixtures.alphaWall}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(await rowCount(fixtures.alphaWall)).toBe(0)
    })

    it('returns 404 with an empty blockers list for an unknown id', async () => {
      const response = await inject(
        'DELETE',
        '/admin/price-list-items/99999999',
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
      const body = response.json()
      expect(body.blockers).toEqual([])
      // No `warning`: the row was never deleted, so the re-import caveat would
      // be a statement about something that did not happen.
      expect(body.warning).toBeUndefined()
    })

    it('rejects an anonymous delete with 401 and leaves the row', async () => {
      const response = await inject(
        'DELETE',
        `/admin/price-list-items/${fixtures.betaFabric}`,
        null
      )
      expect(response.statusCode).toBe(401)
      expect(await rowCount(fixtures.betaFabric)).toBe(1)
    })

    it('rejects a customer delete with 403 and leaves the row', async () => {
      const response = await inject(
        'DELETE',
        `/admin/price-list-items/${fixtures.betaFabric}`,
        customerCookie
      )
      expect(response.statusCode).toBe(403)
      expect(await rowCount(fixtures.betaFabric)).toBe(1)
    })
  })
})
