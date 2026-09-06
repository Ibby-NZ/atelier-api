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
import { createSupplierBrandTerms } from '../src/suppliers/supplier-terms.js'

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
  let clerkCookie
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

    // Terms are cost data, so backoffice alone is not the gate: the boss also
    // carries finance visibility, and the clerk is the showroom login that does
    // not. Both are backoffice — the difference is the whole point.
    await pool.query(`UPDATE users SET can_view_finance = true WHERE email = $1`, [
      testEmail('boss'),
    ])

    const clerk = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('clerk'), password: PASSWORD, name: 'Clerk' },
    })
    clerkCookie = sessionCookieFrom(clerk)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('clerk'),
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
      ['GET', '/admin/suppliers/1/brand-terms', undefined],
      ['POST', '/admin/suppliers/1/brand-terms', { brand_id: 1 }],
      ['PATCH', '/admin/suppliers/1/brand-terms/1', { markup: 2 }],
      ['DELETE', '/admin/suppliers/1/brand-terms/1', undefined],
      ['POST', '/admin/suppliers/1/brand-terms/1/tiers', { label: 'Guarded', pct: 0.4 }],
      ['PATCH', '/admin/suppliers/1/brand-terms/1/tiers/1', { pct: 0.4 }],
      ['DELETE', '/admin/suppliers/1/brand-terms/1/tiers/1', undefined],
      ['GET', '/admin/suppliers/1/contacts', undefined],
      ['POST', '/admin/suppliers/1/contacts', { name: 'Guarded' }],
      ['PATCH', '/admin/suppliers/1/contacts/1', { name: 'Guarded' }],
      ['DELETE', '/admin/suppliers/1/contacts/1', undefined],
      ['GET', '/admin/suppliers/1/contact-log', undefined],
      ['POST', '/admin/suppliers/1/contact-log', { method: 'call' }],
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

  // The write path for `supplier_brand_terms` / `supplier_discount_tiers`, which
  // `npm run backfill:suppliers` was the only writer of.
  //
  // The number every one of these tests is really about is x0.36. A chain is
  // MULTIPLICATIVE, so {0.4, 0.4} is 36% of list and not the 20% a summed 0.8
  // would give — the office typing it has no other way to see which it got, so
  // the write RESPONSE carries the evaluated multiplier.
  describe('commercial terms', () => {
    const termsPath = (supplierId, ...rest) =>
      `/admin/suppliers/${supplierId}/brand-terms${rest.map((part) => `/${part}`).join('')}`

    // One supplier, one house it invoices, one set of terms — the shape every
    // test here starts from.
    const seedTerms = async (body = {}) => {
      const supplierId = await insertSupplier(pool, 'terms')
      const brandId = await insertBrand(pool, 'terms-house', supplierId)
      const created = await inject('POST', termsPath(supplierId), backofficeCookie, {
        brand_id: brandId,
        ...body,
      })
      return { supplierId, brandId, created }
    }

    it('creates a chain and answers with what it evaluates to', async () => {
      const { created } = await seedTerms({ discount_chain: [0.4, 0.4], markup: 2.2 })

      expect(created.statusCode).toBe(201)
      const { terms } = created.json()
      expect(terms.discount_chain).toEqual([0.4, 0.4])
      expect(terms.net_source).toBe('chain')
      expect(terms.net_multiplier).toBeCloseTo(0.36, 10)
      // A summed chain would be 0.8 off, i.e. a x0.2 multiplier — 44% of list
      // undercharged on every metre.
      expect(terms.net_multiplier).not.toBeCloseTo(0.2, 10)
      expect(terms.markup).toBe(2.2)
      expect(terms.discount).toBeNull()
      // The house name, without which a terms list is a column of opaque ids.
      expect(terms.brand_slug).toBe(`${PREFIX}-terms-house`)
    })

    it('400s a chain rate that is not a fraction below 1', async () => {
      const supplierId = await insertSupplier(pool, 'terms')
      const brandId = await insertBrand(pool, 'terms-house', supplierId)

      const response = await inject('POST', termsPath(supplierId), backofficeCookie, {
        brand_id: brandId,
        discount_chain: [0.4, 1],
      })

      expect(response.statusCode).toBe(400)
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM supplier_brand_terms WHERE brand_id = $1',
        [brandId]
      )
      expect(rows[0].n).toBe(0)
    })

    it('422s a bad chain element at the module too, since a CHECK cannot see inside an array', async () => {
      const supplierId = await insertSupplier(pool, 'terms')
      const brandId = await insertBrand(pool, 'terms-house', supplierId)

      // The route schema refuses this first; the module is the belt to that
      // braces, and it is the ONLY gate for any other caller — no CHECK can
      // validate an array's elements, so `chainMultiplier` is spent as the
      // validator rather than the rule being written a second time.
      await expect(
        createSupplierBrandTerms(pool, supplierId, {
          brand_id: brandId,
          discount_chain: [0.4, 1],
        })
      ).rejects.toMatchObject({ statusCode: 422 })
    })

    it('422s a flat discount and a chain on one row, in the shape CHECK’s words', async () => {
      const { created } = await seedTerms({ discount: 0.5, discount_chain: [0.4, 0.4] })

      expect(created.statusCode).toBe(422)
      expect(created.json().message).toMatch(/never both/i)
    })

    it('409s a second set of terms for the same house', async () => {
      const { supplierId, brandId } = await seedTerms({ discount: 0.5 })

      const again = await inject('POST', termsPath(supplierId), backofficeCookie, {
        brand_id: brandId,
        discount: 0.4,
      })

      expect(again.statusCode).toBe(409)
      expect(again.json().message).toMatch(/already has terms/i)
    })

    it('422s terms for a house that does not exist', async () => {
      const supplierId = await insertSupplier(pool, 'terms')

      const response = await inject('POST', termsPath(supplierId), backofficeCookie, {
        brand_id: 99999999,
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/no house/i)
    })

    it('moves the multiplier with the chain on a PATCH, and back to a flat rate', async () => {
      const { supplierId, created } = await seedTerms({ discount_chain: [0.4, 0.4] })
      const termsId = created.json().terms.id

      const rechained = await inject(
        'PATCH',
        termsPath(supplierId, termsId),
        backofficeCookie,
        { discount_chain: [0.5, 0.1] }
      )
      expect(rechained.statusCode).toBe(200)
      expect(rechained.json().terms.net_multiplier).toBeCloseTo(0.45, 10)

      // Clearing the chain and setting a flat rate in one body: the shape CHECK
      // allows it because the chain lands empty.
      const flat = await inject('PATCH', termsPath(supplierId, termsId), backofficeCookie, {
        discount_chain: [],
        discount: 0.25,
      })
      expect(flat.json().terms.net_source).toBe('flat')
      expect(flat.json().terms.net_multiplier).toBeCloseTo(0.75, 10)
    })

    it('adds tiers, resolves the fallback, and says which label can never match', async () => {
      const { supplierId, created } = await seedTerms()
      const termsId = created.json().terms.id

      const wallpaper = await inject(
        'POST',
        termsPath(supplierId, termsId, 'tiers'),
        backofficeCookie,
        { label: 'Wallpaper', pct: 0.4 }
      )
      expect(wallpaper.statusCode).toBe(201)

      const fallback = await inject(
        'POST',
        termsPath(supplierId, termsId, 'tiers'),
        backofficeCookie,
        { label: 'All other collections', pct: 0.5, is_fallback: true }
      )

      // A tier write answers with the PARENT: a tier changes what the whole row
      // resolves to, and a bare tier tells the office nothing.
      const { terms } = fallback.json()
      expect(terms.net_source).toBe('tier')
      expect(terms.net_label).toBe('All other collections')
      expect(terms.net_multiplier).toBeCloseTo(0.5, 10)
      // `label` is free text matched against the LINE's category, not the
      // products.category enum — so the write path reports which labels can ever
      // match rather than refusing the ones that cannot. `is_fallback` is what
      // makes the unmatched case (the common one) survivable.
      expect(terms.tiers.map((tier) => [tier.label, tier.matches_category])).toEqual([
        ['Wallpaper', true],
        ['All other collections', false],
      ])
    })

    it('409s a second fallback and a label differing only in case', async () => {
      const { supplierId, created } = await seedTerms()
      const termsId = created.json().terms.id
      const tiersUrl = termsPath(supplierId, termsId, 'tiers')

      await inject('POST', tiersUrl, backofficeCookie, {
        label: 'All other collections',
        pct: 0.5,
        is_fallback: true,
      })

      const second = await inject('POST', tiersUrl, backofficeCookie, {
        label: 'Everything else',
        pct: 0.45,
        is_fallback: true,
      })
      expect(second.statusCode).toBe(409)
      expect(second.json().message).toMatch(/fallback/i)

      const cased = await inject('POST', tiersUrl, backofficeCookie, {
        label: '  all other COLLECTIONS ',
        pct: 0.45,
      })
      expect(cased.statusCode).toBe(409)
      expect(cased.json().message).toMatch(/label/i)
    })

    it('422s a blank tier label, which would match nothing and take the index slot', async () => {
      const { supplierId, created } = await seedTerms()
      const termsId = created.json().terms.id

      const response = await inject(
        'POST',
        termsPath(supplierId, termsId, 'tiers'),
        backofficeCookie,
        { label: '   ', pct: 0.4 }
      )
      expect(response.statusCode).toBe(422)
    })

    it('patches a tier and recomputes the parent', async () => {
      const { supplierId, created } = await seedTerms()
      const termsId = created.json().terms.id
      const added = await inject(
        'POST',
        termsPath(supplierId, termsId, 'tiers'),
        backofficeCookie,
        { label: 'All other collections', pct: 0.5, is_fallback: true }
      )
      const tierId = added.json().terms.tiers[0].id

      const patched = await inject(
        'PATCH',
        termsPath(supplierId, termsId, 'tiers', tierId),
        backofficeCookie,
        { pct: 0.2 }
      )

      expect(patched.statusCode).toBe(200)
      expect(patched.json().terms.net_multiplier).toBeCloseTo(0.8, 10)
    })

    it('refuses to delete terms carrying tiers, then lets them go once the tier does', async () => {
      const { supplierId, created } = await seedTerms({ discount: 0.45 })
      const termsId = created.json().terms.id
      const added = await inject(
        'POST',
        termsPath(supplierId, termsId, 'tiers'),
        backofficeCookie,
        { label: 'Wallpaper', pct: 0.4 }
      )
      const tierId = added.json().terms.tiers[0].id

      // supplier_discount_tiers.supplier_brand_term_id is CASCADE, so without the
      // probe this succeeds and the rates that actually applied go with it.
      const blocked = await inject(
        'DELETE',
        termsPath(supplierId, termsId),
        backofficeCookie
      )
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().blockers).toEqual([
        { relation: 'supplier_discount_tiers', label: 'discount tiers', count: 1, capped: false },
      ])
      // No archived_at on either table: there is no soft alternative to offer.
      expect(blocked.json().archivable).toBe(false)

      const tierGone = await inject(
        'DELETE',
        termsPath(supplierId, termsId, 'tiers', tierId),
        backofficeCookie
      )
      expect(tierGone.statusCode).toBe(200)
      expect(tierGone.json()).toEqual({
        deleted: { entity: 'supplier_discount_tier', id: tierId },
      })

      const termsGone = await inject(
        'DELETE',
        termsPath(supplierId, termsId),
        backofficeCookie
      )
      expect(termsGone.statusCode).toBe(200)
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM supplier_brand_terms WHERE id = $1',
        [termsId]
      )
      expect(rows[0].n).toBe(0)
    })

    it('404s terms and tiers reached through another supplier', async () => {
      const { supplierId, created } = await seedTerms({ discount: 0.5 })
      const termsId = created.json().terms.id
      const added = await inject(
        'POST',
        termsPath(supplierId, termsId, 'tiers'),
        backofficeCookie,
        { label: 'Wallpaper', pct: 0.4 }
      )
      const tierId = added.json().terms.tiers[0].id
      const other = await insertSupplier(pool, 'bystander')

      // brand_id is unique across the whole table, so a terms id means something
      // without a supplier — the scope clause is what stops one supplier's path
      // reaching another's terms.
      for (const [method, url, payload] of [
        ['PATCH', termsPath(other, termsId), { markup: 2 }],
        ['DELETE', termsPath(other, termsId), undefined],
        ['POST', termsPath(other, termsId, 'tiers'), { label: 'Sneak', pct: 0.4 }],
        ['PATCH', termsPath(other, termsId, 'tiers', tierId), { pct: 0.1 }],
        ['DELETE', termsPath(other, termsId, 'tiers', tierId), undefined],
      ]) {
        const response = await inject(method, url, backofficeCookie, payload)
        expect(response.statusCode, `${method} ${url}`).toBe(404)
      }

      const { rows } = await pool.query(
        'SELECT markup FROM supplier_brand_terms WHERE id = $1',
        [termsId]
      )
      expect(rows[0].markup).toBeNull()
    })

    it('lists a supplier’s terms with the meta envelope, and 400s a limit past the maximum', async () => {
      const { supplierId } = await seedTerms({ discount_chain: [0.4, 0.4] })

      const listed = await inject(
        'GET',
        `${termsPath(supplierId)}?page=1&limit=10`,
        backofficeCookie
      )
      expect(listed.statusCode).toBe(200)
      const body = listed.json()
      expect(body.meta).toEqual({ total: 1, page: 1, limit: 10 })
      expect(body.terms[0].net_multiplier).toBeCloseTo(0.36, 10)

      const tooMany = await inject(
        'GET',
        `${termsPath(supplierId)}?limit=100000`,
        backofficeCookie
      )
      expect(tooMany.statusCode).toBe(400)
    })

    it('refuses a backoffice login with no finance visibility, on every verb', async () => {
      const { supplierId, brandId, created } = await seedTerms({ discount: 0.5 })
      const termsId = created.json().terms.id

      // `backoffice` covers the showroom as well as the accounts desk, which is
      // why can_view_finance exists as a second, revocable permission — and why
      // a login that may not SEE a cost may not SET one either.
      for (const [method, url, payload] of [
        ['GET', termsPath(supplierId), undefined],
        ['POST', termsPath(supplierId), { brand_id: brandId }],
        ['PATCH', termsPath(supplierId, termsId), { markup: 2 }],
        ['DELETE', termsPath(supplierId, termsId), undefined],
        ['POST', termsPath(supplierId, termsId, 'tiers'), { label: 'Nope', pct: 0.4 }],
        ['PATCH', termsPath(supplierId, termsId, 'tiers', 1), { pct: 0.4 }],
        ['DELETE', termsPath(supplierId, termsId, 'tiers', 1), undefined],
      ]) {
        const response = await inject(method, url, clerkCookie, payload)
        expect(response.statusCode, `${method} ${url}`).toBe(403)
        expect(response.json().message).toMatch(/finance visibility/i)
      }
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
