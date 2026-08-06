// Supplier routes, including DELETE (W3-US-005).
//
// Three halves, and the last two are the point of the story:
//   1. The CRUD surface — list/get/create/patch/archive/restore, and the fact
//      that every one of them is backoffice-only. A supplier record names the
//      freight agent, the Incoterm, the PO address and how each house is
//      discounted, so there is no viewer for it below staff.
//   2. DELETE, which must be REFUSED with a count per blocker rather than
//      succeeding destructively. `price_list_items.supplier_id` is SET NULL, so
//      without its probe the delete silently unlinks the whole rate ledger and
//      returns 200 — the failure mode the probes exist for.
//   3. The 23503 backstop. `brands.supplier_id` is RESTRICT, so a house
//      inserted between the probe and the DELETE still cannot slip through. Its
//      real trigger is a race, so it is exercised against a stub pool — the
//      same instrument test/lifecycle-delete.test.js uses for the lock mode.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { deleteOrExplain } from '../src/lifecycle/delete.js'
import { DISCOUNT_METHOD_ENUM } from '../src/routes/admin-suppliers.js'
import { SUPPLIER_UPDATE_COLUMNS } from '../src/suppliers/admin-suppliers.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'w3-routes-test'
const DOMAIN = 'w3-routes-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// FK order: brands RESTRICT-reference suppliers, so the houses must go first or
// the supplier delete 23503s inside cleanup and every later test sees leftovers.
// price_list_items is SET NULL and would survive, but it carries the supplier's
// name in its identity key, so it is scoped by prefix like everything else.
const cleanupFixtures = async (pool) => {
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM price_list_items WHERE supplier LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const insertSupplier = async (pool, name, overrides = {}) => {
  const row = {
    short_code: null,
    d365_token: null,
    country: 'Italy',
    currency: 'EUR',
    discount_method: 'averaged',
    archived_at: null,
    ...overrides,
  }
  const { rows } = await pool.query(
    `INSERT INTO suppliers
       (name, slug, short_code, d365_token, country, currency, discount_method, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      `${PREFIX} ${name}`,
      `${PREFIX}-${name}`,
      row.short_code,
      row.d365_token,
      row.country,
      row.currency,
      row.discount_method,
      row.archived_at,
    ]
  )
  return rows[0].id
}

// trade_only = false: the house rule for every catalogue fixture, even one
// created purely to exercise a foreign key (the column is NOT NULL DEFAULT true).
const insertBrand = async (pool, slug, supplierId) => {
  const { rows } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
     VALUES ($1, $2, 'Italy', 'EUR', true, false, $3)
     RETURNING id`,
    [`${PREFIX} ${slug}`, `${PREFIX}-${slug}`, supplierId]
  )
  return rows[0].id
}

const insertRate = async (pool, code, supplierId) => {
  const { rows } = await pool.query(
    `INSERT INTO price_list_items
       (supplier, supplier_id, category, code, code_normalized, unit, wholesale_rate,
        currency, source_file)
     VALUES ($1, $2, 'fabric', $3, $3, 'metre', 65, 'EUR', 'w3-routes-test.csv')
     RETURNING id`,
    [`${PREFIX}Rates`, supplierId, code]
  )
  return rows[0].id
}

describe('back-office supplier routes', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

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
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

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

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app?.close()
    await pool?.end()
  })

  beforeEach(() => cleanupFixtures(pool))

  describe('every route is backoffice-only', () => {
    // Parameterised over the whole surface: a route added later without the
    // guard is the regression this catches, and it is the one that would put a
    // house's discount in front of a signed-in shopper.
    // A body is sent only where the route takes one: schema validation runs
    // before the preHandler, so a route whose body failed validation would
    // answer 400 and prove nothing about the guard.
    const ROUTES = [
      ['GET', '/admin/suppliers', undefined],
      ['GET', '/admin/suppliers/1', undefined],
      ['POST', '/admin/suppliers', { name: 'Guarded' }],
      ['PATCH', '/admin/suppliers/1', { agent: 'Guarded' }],
      ['POST', '/admin/suppliers/1/archive', undefined],
      ['POST', '/admin/suppliers/1/restore', undefined],
      ['DELETE', '/admin/suppliers/1', undefined],
    ]

    it.each(ROUTES)('%s %s is 401 for an anonymous caller', async (method, url, payload) => {
      const response = await inject(method, url, null, payload)
      expect(response.statusCode).toBe(401)
    })

    it.each(ROUTES)('%s %s is 403 for a signed-in customer', async (method, url, payload) => {
      const response = await inject(method, url, customerCookie, payload)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/suppliers', () => {
    it('returns the meta envelope the CRM pages on', async () => {
      await insertSupplier(pool, 'alpha')
      await insertSupplier(pool, 'bravo')

      const response = await inject(
        'GET',
        `/admin/suppliers?q=${PREFIX}&page=1&limit=1`,
        backofficeCookie
      )

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.suppliers).toHaveLength(1)
      // The route builds the envelope; the module returns { suppliers, total }.
      expect(body.meta).toEqual({ total: 2, page: 1, limit: 1 })
    })

    it('hides archived suppliers unless include_archived is asked for', async () => {
      await insertSupplier(pool, 'live')
      await insertSupplier(pool, 'gone', { archived_at: new Date() })

      const live = await inject('GET', `/admin/suppliers?q=${PREFIX}`, backofficeCookie)
      expect(live.json().suppliers.map((s) => s.slug)).toEqual([`${PREFIX}-live`])

      const all = await inject(
        'GET',
        `/admin/suppliers?q=${PREFIX}&include_archived=true`,
        backofficeCookie
      )
      expect(all.json().meta.total).toBe(2)
    })

    it('400s a limit past the schema maximum rather than clamping it silently', async () => {
      const response = await inject('GET', '/admin/suppliers?limit=100000', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })
  })

  describe('GET /admin/suppliers/:id', () => {
    it('carries the aliases and the houses the supplier invoices', async () => {
      const id = await insertSupplier(pool, 'detail')
      await pool.query('INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, $2)', [
        id,
        `${PREFIX}-JWALL`,
      ])
      await insertBrand(pool, 'detail-house', id)

      const response = await inject('GET', `/admin/suppliers/${id}`, backofficeCookie)

      expect(response.statusCode).toBe(200)
      const { supplier } = response.json()
      expect(supplier.aliases.map((a) => a.alias)).toEqual([`${PREFIX}-JWALL`])
      expect(supplier.brands.map((b) => b.slug)).toEqual([`${PREFIX}-detail-house`])
    })

    it('404s an unknown id and 400s a non-numeric one', async () => {
      expect((await inject('GET', '/admin/suppliers/99999999', backofficeCookie)).statusCode).toBe(
        404
      )
      expect((await inject('GET', '/admin/suppliers/abc', backofficeCookie)).statusCode).toBe(400)
    })
  })

  describe('POST /admin/suppliers', () => {
    it('derives the slug server-side and never accepts one from the client', async () => {
      const response = await inject('POST', '/admin/suppliers', backofficeCookie, {
        name: `${PREFIX} Rubelli`,
        slug: 'attacker-chosen',
        country: 'Italy',
        currency: 'EUR',
        agent: 'Wilson Freight',
        incoterm: 'FOB Milan',
        po_email: 'orders@rubelli.test',
        discount_method: 'per-brand',
      })

      expect(response.statusCode).toBe(201)
      const { supplier } = response.json()
      expect(supplier.slug).toBe(`${PREFIX}-rubelli`)
      expect(supplier.discount_method).toBe('per-brand')
      // The invoicing currency, never defaulted from the country.
      expect(supplier.currency).toBe('EUR')
    })

    it('409s a duplicate name from the database, not from a pre-check', async () => {
      await inject('POST', '/admin/suppliers', backofficeCookie, { name: `${PREFIX} Twice` })
      const again = await inject('POST', '/admin/suppliers', backofficeCookie, {
        name: `${PREFIX} Twice`,
      })

      expect(again.statusCode).toBe(409)
      expect(again.json().message).toMatch(/already exists/i)
    })

    it('409s a duplicate D365 token, which is a different constraint', async () => {
      await insertSupplier(pool, 'token-one', { d365_token: 'W3T' })
      const clash = await inject('POST', '/admin/suppliers', backofficeCookie, {
        name: `${PREFIX} Token Two`,
        d365_token: 'W3T',
      })

      expect(clash.statusCode).toBe(409)
      expect(clash.json().message).toMatch(/D365 token/i)
    })

    it('422s a name with nothing sluggable in it, and 400s a missing one', async () => {
      const punctuation = await inject('POST', '/admin/suppliers', backofficeCookie, {
        name: '!!!',
      })
      expect(punctuation.statusCode).toBe(422)

      const missing = await inject('POST', '/admin/suppliers', backofficeCookie, {
        country: 'Italy',
      })
      expect(missing.statusCode).toBe(400)
    })

    it('400s a discount_method outside the vocabulary rather than letting the CHECK 500', async () => {
      const response = await inject('POST', '/admin/suppliers', backofficeCookie, {
        name: `${PREFIX} Bad Method`,
        discount_method: 'negotiated',
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PATCH /admin/suppliers/:id', () => {
    it('writes the whitelist and leaves the slug alone on a rename', async () => {
      const id = await insertSupplier(pool, 'renamed')

      const response = await inject('PATCH', `/admin/suppliers/${id}`, backofficeCookie, {
        name: `${PREFIX} Renamed House`,
        agent: 'Bolliger',
      })

      expect(response.statusCode).toBe(200)
      const { supplier } = response.json()
      expect(supplier.name).toBe(`${PREFIX} Renamed House`)
      expect(supplier.agent).toBe('Bolliger')
      // The slug is the stable key the backfill addresses a supplier by; a
      // rename is a correction, not a new supplier.
      expect(supplier.slug).toBe(`${PREFIX}-renamed`)
    })

    it('clears an optional column with an explicit null', async () => {
      const id = await insertSupplier(pool, 'clearable', { d365_token: 'W3C' })

      const response = await inject('PATCH', `/admin/suppliers/${id}`, backofficeCookie, {
        d365_token: null,
      })

      expect(response.json().supplier.d365_token).toBeNull()
    })

    it('400s an empty body and 404s an unknown id', async () => {
      const id = await insertSupplier(pool, 'patchable')
      expect(
        (await inject('PATCH', `/admin/suppliers/${id}`, backofficeCookie, {})).statusCode
      ).toBe(400)
      expect(
        (
          await inject('PATCH', '/admin/suppliers/99999999', backofficeCookie, { agent: 'x' })
        ).statusCode
      ).toBe(404)
    })

    it('cannot write a column outside the whitelist', async () => {
      // Ajv strips the unknown key (removeAdditional), so the body reaching the
      // handler is empty and minProperties produces the 400. `slug` is the one
      // that matters: it is a public key other rows address.
      const id = await insertSupplier(pool, 'immutable')
      const response = await inject('PATCH', `/admin/suppliers/${id}`, backofficeCookie, {
        slug: 'attacker-chosen',
      })
      expect(response.statusCode).toBe(400)
      expect(SUPPLIER_UPDATE_COLUMNS).not.toContain('slug')
      expect(SUPPLIER_UPDATE_COLUMNS).not.toContain('archived_at')
    })
  })

  describe('archive and restore', () => {
    it('round-trips a supplier out of and back into the working list', async () => {
      const id = await insertSupplier(pool, 'archivable')

      const archived = await inject(
        'POST',
        `/admin/suppliers/${id}/archive`,
        backofficeCookie
      )
      expect(archived.statusCode).toBe(200)
      expect(archived.json().supplier.archived_at).not.toBeNull()

      const hidden = await inject('GET', `/admin/suppliers?q=${PREFIX}`, backofficeCookie)
      expect(hidden.json().meta.total).toBe(0)

      const restored = await inject(
        'POST',
        `/admin/suppliers/${id}/restore`,
        backofficeCookie
      )
      expect(restored.json().supplier.archived_at).toBeNull()

      const back = await inject('GET', `/admin/suppliers?q=${PREFIX}`, backofficeCookie)
      expect(back.json().meta.total).toBe(1)
    })

    it('404s an unknown id on both verbs', async () => {
      for (const verb of ['archive', 'restore']) {
        const response = await inject(
          'POST',
          `/admin/suppliers/99999999/${verb}`,
          backofficeCookie
        )
        expect(response.statusCode).toBe(404)
      }
    })
  })

  describe('DELETE /admin/suppliers/:id', () => {
    it('deletes a supplier nothing points at', async () => {
      const id = await insertSupplier(pool, 'unlinked')

      const response = await inject('DELETE', `/admin/suppliers/${id}`, backofficeCookie)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'supplier', id } })
      const { rows } = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id])
      expect(rows).toHaveLength(0)
    })

    it('is blocked by the houses it invoices, with a count, and destroys nothing', async () => {
      const id = await insertSupplier(pool, 'linked')
      await insertBrand(pool, 'house-one', id)
      await insertBrand(pool, 'house-two', id)

      const response = await inject('DELETE', `/admin/suppliers/${id}`, backofficeCookie)

      expect(response.statusCode).toBe(409)
      const body = response.json()
      expect(body.blockers).toEqual([
        { relation: 'brands', label: 'houses', count: 2, capped: false },
      ])
      // The CRM offers "Archive instead" on the strength of this flag.
      expect(body.archivable).toBe(true)
      expect(body.message).toMatch(/2 houses/)

      const { rows: houses } = await pool.query('SELECT supplier_id FROM brands WHERE supplier_id = $1', [
        id,
      ])
      expect(houses).toHaveLength(2)
      const { rows: supplier } = await pool.query('SELECT 1 FROM suppliers WHERE id = $1', [id])
      expect(supplier).toHaveLength(1)
    })

    it('is blocked by its price-list items, whose FK would have SET NULL silently', async () => {
      const id = await insertSupplier(pool, 'rated')
      await insertRate(pool, 'W3R-001', id)
      await insertRate(pool, 'W3R-002', id)
      await insertRate(pool, 'W3R-003', id)

      const response = await inject('DELETE', `/admin/suppliers/${id}`, backofficeCookie)

      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        { relation: 'price_list_items', label: 'price-list items', count: 3, capped: false },
      ])
      // The database would have raised NOTHING here: the FK is SET NULL, so the
      // delete would have succeeded and unlinked all three rates in silence.
      const { rows } = await pool.query(
        'SELECT count(*)::int AS linked FROM price_list_items WHERE supplier_id = $1',
        [id]
      )
      expect(rows[0].linked).toBe(3)
    })

    it('reports both blockers at once, each with its own count', async () => {
      const id = await insertSupplier(pool, 'both')
      await insertBrand(pool, 'both-house', id)
      await insertRate(pool, 'W3B-001', id)

      const body = (await inject('DELETE', `/admin/suppliers/${id}`, backofficeCookie)).json()

      expect(body.blockers.map((blocker) => [blocker.relation, blocker.count])).toEqual([
        ['brands', 1],
        ['price_list_items', 1],
      ])
    })

    it('404s an unknown id', async () => {
      const response = await inject('DELETE', '/admin/suppliers/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
      expect(response.json().message).toMatch(/No supplier with id/)
    })

    it('archiving is the way through: a blocked supplier can still be retired', async () => {
      const id = await insertSupplier(pool, 'retire')
      await insertBrand(pool, 'retire-house', id)

      expect((await inject('DELETE', `/admin/suppliers/${id}`, backofficeCookie)).statusCode).toBe(
        409
      )
      const archived = await inject('POST', `/admin/suppliers/${id}/archive`, backofficeCookie)
      expect(archived.statusCode).toBe(200)
      expect(archived.json().supplier.archived_at).not.toBeNull()
    })
  })

  describe('the RESTRICT backstop behind the probe', () => {
    // A house inserted between the probe and the DELETE. The probe cannot see
    // it, so the foreign key is what refuses — and it must still surface as the
    // same counted 409, not as a 500. Its real trigger is a race, so the only
    // deterministic instrument is a stub pool.
    const stubPool = (failDelete) => {
      const log = []
      const client = {
        query: async (sql) => {
          const text = String(sql)
          log.push(text)
          if (text.includes('FOR UPDATE')) return { rows: [{ id: 1 }] }
          if (text.includes('count(*)')) return { rows: [] }
          if (text.startsWith('DELETE FROM') && failDelete) throw failDelete
          return { rows: [] }
        },
        release: () => log.push('RELEASE'),
      }
      return { log, connect: async () => client }
    }

    it('turns brands_supplier_id_fkey into the same 409 shape a probe produces', async () => {
      const violation = Object.assign(new Error('update or delete violates foreign key'), {
        code: '23503',
        constraint: 'brands_supplier_id_fkey',
      })
      const pool = stubPool(violation)

      const result = await deleteOrExplain(pool, 'supplier', 7)

      expect(result.deleted).toBe(false)
      expect(result.status).toBe(409)
      // "1, capped": the database says at least one row exists and nothing about
      // how many, and "1+" is the honest reading.
      expect(result.blockers).toEqual([
        { relation: 'brands', label: 'houses', count: 1, capped: true },
      ])
      expect(result.archivable).toBe(true)
      expect(pool.log).toContain('ROLLBACK')
    })

    it('locks the supplier FOR UPDATE before it probes', async () => {
      const pool = stubPool(null)

      await deleteOrExplain(pool, 'supplier', 7)

      expect(pool.log[1]).toContain('FROM suppliers WHERE id = $1 FOR UPDATE')
      expect(pool.log[1]).not.toContain('FOR NO KEY UPDATE')
      expect(pool.log[2]).toContain('count(*)')
    })
  })

  describe('the route enum and the database CHECK cannot drift', () => {
    it('offers exactly the discount methods suppliers_discount_method_check allows', async () => {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname = 'suppliers_discount_method_check'`
      )
      expect(rows).toHaveLength(1)
      // Postgres rewrites IN as = ANY (ARRAY['x'::text, ...]), so the allowed
      // values parse straight back out.
      const allowed = [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((match) => match[1])
      expect([...allowed].sort()).toEqual([...DISCOUNT_METHOD_ENUM].sort())
    })
  })
})
