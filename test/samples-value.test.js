// What a sample cost (W20-US-001 + US-008, FR-260…FR-264).
//
// Three claims are under test here and each one has a way of being quietly
// false:
//
//   1. NULL AND 0 ARE DIFFERENT FACTS, end to end. NULL is "nobody recorded a
//      cost"; 0 is "free of charge, and we know it" — the client gets hangers
//      for free and that is worth recording. `Number(null)` is 0, so the bug
//      this file exists to catch is a read that turns every unpriced hanger
//      into a gift. A status-code test cannot see it; only reading both back
//      and comparing them can.
//   2. `>= 0`, NOT `> 0`, unlike `price_list_items.wholesale_rate`. Zero is
//      accepted and a negative is refused, at the schema, at the module and at
//      the constraint.
//   3. COST IS A FINANCE FIGURE. `backoffice` covers the showroom and the
//      accounts desk alike, so the gate is `users.can_view_finance` through
//      `loadReportAccess` — never `request.user.can_view_finance`, which the
//      guard's projection does not carry and which therefore reads `undefined`
//      and answers false to everyone, silently and for ever. Asserted over the
//      RESPONSE (no key at all, not a nulled one) and over the STATEMENTS (the
//      column is never even selected).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  listSamples,
  getSample,
  createSample as createSampleDirect,
  updateSample as updateSampleDirect,
  SAMPLE_FINANCE_KEYS,
  SAMPLE_UPDATE_COLUMNS,
} from '../src/samples/admin-samples.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'w20-value-test'
const DOMAIN = 'w20-value-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM sample_loans
      WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1 OR label LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1 OR label LIKE $1`, [`${PREFIX}%`])
}

describe('sample value (W20-US-001, US-008)', () => {
  let pool
  let app
  let financeCookie
  let showroomCookie

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

    // Registered ONCE: register and login share a 10-per-15-min per-IP bucket,
    // so a per-test registration would 429 and yield no cookie at all.
    const accounts = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('accounts'), password: PASSWORD, name: 'Accounts' },
    })
    financeCookie = sessionCookieFrom(accounts)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = true WHERE email = $1`,
      [testEmail('accounts')]
    )

    // Same role, no finance grant — which is the whole reason the column exists
    // beside the role.
    const showroom = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('showroom'), password: PASSWORD, name: 'Showroom' },
    })
    showroomCookie = sessionCookieFrom(showroom)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = false WHERE email = $1`,
      [testEmail('showroom')]
    )
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
  })

  describe('the constraint', () => {
    it('accepts a free hanger at exactly zero', async () => {
      // Deliberately not `> 0` the way price_list_items.wholesale_rate is: "we
      // sometimes get hangers for free", and that is a fact worth storing.
      const { rows } = await pool.query(
        `INSERT INTO samples (barcode, unit_cost, cost_currency)
         VALUES ($1, 0, 'NZD') RETURNING unit_cost`,
        [`${PREFIX}-free`]
      )
      expect(Number(rows[0].unit_cost)).toBe(0)
    })

    it('accepts no cost at all', async () => {
      const { rows } = await pool.query(
        `INSERT INTO samples (barcode) VALUES ($1) RETURNING unit_cost, cost_currency`,
        [`${PREFIX}-unpriced`]
      )
      expect(rows[0]).toEqual({ unit_cost: null, cost_currency: null })
    })

    it('refuses a negative cost', async () => {
      await expect(
        pool.query(`INSERT INTO samples (barcode, unit_cost) VALUES ($1, -1)`, [`${PREFIX}-neg`])
      ).rejects.toMatchObject({ code: '23514', constraint: 'samples_unit_cost_check' })
    })

    it('leaves the cost currency uncontrolled, unlike the price-list one', async () => {
      // price_list_items.currency is CHECKed to EUR|USD|GBP because that is the
      // pipeline's own closed vocabulary. A sample can be bought from anyone in
      // anything, NZD included, and a guessed CHECK would refuse the office's
      // own currency the first time they typed it.
      const { rows } = await pool.query(
        `INSERT INTO samples (barcode, cost_currency) VALUES ($1, 'NZD') RETURNING cost_currency`,
        [`${PREFIX}-nzd`]
      )
      expect(rows[0].cost_currency).toBe('NZD')
    })
  })

  describe('NULL and 0 stay different facts', () => {
    it('reads a free sample as 0 and an unpriced one as null', async () => {
      const free = await inject('POST', '/admin/samples', financeCookie, {
        barcode: `${PREFIX}-0010`,
        unit_cost: 0,
        cost_currency: 'NZD',
      })
      const unpriced = await inject('POST', '/admin/samples', financeCookie, {
        barcode: `${PREFIX}-0011`,
      })
      expect(free.statusCode).toBe(201)
      expect(unpriced.statusCode).toBe(201)

      // The bug this asserts against is `Number(null) === 0`, which would make
      // these two rows read identically and silently count every hanger nobody
      // has costed as a gift.
      expect(free.json().sample.unit_cost).toBe(0)
      expect(unpriced.json().sample.unit_cost).toBeNull()
      expect(free.json().sample.unit_cost).not.toBe(unpriced.json().sample.unit_cost)
    })

    it('coerces the numeric to a NUMBER, not the string pg hands back', async () => {
      // pg returns `numeric` as a string, so an untouched read would answer
      // "12.5000" and every arithmetic reader downstream would concatenate.
      await inject('POST', '/admin/samples', financeCookie, {
        barcode: `${PREFIX}-0012`,
        unit_cost: 12.5,
      })
      const list = await inject('GET', `/admin/samples?q=${PREFIX}-0012`, financeCookie)
      const [sample] = list.json().samples
      expect(sample.unit_cost).toBe(12.5)
      expect(typeof sample.unit_cost).toBe('number')
    })

    it('clears a recorded cost back to null with an explicit null', async () => {
      const created = await inject('POST', '/admin/samples', financeCookie, {
        barcode: `${PREFIX}-0013`,
        unit_cost: 40,
      })
      const id = created.json().sample.id

      const zeroed = await inject('PATCH', `/admin/samples/${id}`, financeCookie, { unit_cost: 0 })
      expect(zeroed.json().sample.unit_cost).toBe(0)

      // Both moves have to stay reachable: "it was free" and "we do not know".
      const cleared = await inject('PATCH', `/admin/samples/${id}`, financeCookie, {
        unit_cost: null,
      })
      expect(cleared.json().sample.unit_cost).toBeNull()
    })

    it('refuses a negative cost at the route and at the module', async () => {
      const response = await inject('POST', '/admin/samples', financeCookie, {
        barcode: `${PREFIX}-0014`,
        unit_cost: -5,
      })
      expect(response.statusCode).toBe(400)

      // The module is also called directly, so the constraint's 23514 must not
      // surface as a 500 there either.
      await expect(
        createSampleDirect(pool, { barcode: `${PREFIX}-0015`, unit_cost: -5 }, { finance: true })
      ).rejects.toMatchObject({ statusCode: 422 })
    })
  })

  describe('cost is a finance figure', () => {
    let sampleId

    beforeEach(async () => {
      const created = await inject('POST', '/admin/samples', financeCookie, {
        barcode: `${PREFIX}-0020`,
        unit_cost: 87.25,
        cost_currency: 'EUR',
      })
      sampleId = created.json().sample.id
    })

    it('serves the cost to a login with finance visibility', async () => {
      const response = await inject('GET', `/admin/samples/${sampleId}`, financeCookie)
      expect(response.json().sample.unit_cost).toBe(87.25)
      expect(response.json().sample.cost_currency).toBe('EUR')
    })

    it('DELETES the key for a back-office login without one', async () => {
      // Not nulled and not blanked: a key that survives with an empty value
      // still tells the reader which figures exist. The same rule maskReport
      // applies to a finance column.
      const response = await inject('GET', `/admin/samples/${sampleId}`, showroomCookie)
      expect(response.statusCode).toBe(200)
      for (const key of SAMPLE_FINANCE_KEYS) {
        expect(response.json().sample).not.toHaveProperty(key)
      }
    })

    it('withholds it from every shape the register answers with', async () => {
      // A create, a patch, an archive, a movement and a plain read all return
      // through getSample, so a gate applied to one and not the others is the
      // failure mode — and the by-barcode route is the scanner's, which a
      // showroom phone is the most likely thing to be holding.
      const shapes = [
        ['GET', `/admin/samples?q=${PREFIX}-0020`, undefined],
        ['GET', `/admin/samples/by-barcode/${PREFIX}-0020`, undefined],
        ['PATCH', `/admin/samples/${sampleId}`, { location: 'Bay 4' }],
        ['POST', `/admin/samples/${sampleId}/check-out`, { holder_name: 'Somebody' }],
        ['POST', `/admin/samples/${sampleId}/check-in`, undefined],
        ['POST', `/admin/samples/${sampleId}/archive`, undefined],
        ['POST', `/admin/samples/${sampleId}/restore`, undefined],
      ]
      for (const [method, url, payload] of shapes) {
        const response = await inject(method, url, showroomCookie, payload)
        expect(response.statusCode, `${method} ${url}`).toBe(200)
        const body = JSON.stringify(response.json())
        expect(body, `${method} ${url} leaked a cost key`).not.toMatch(/unit_cost|cost_currency/)
      }
    })

    it('refuses to let a login without finance WRITE a cost', async () => {
      // Reading and writing are one permission: a staffer who may not see what
      // the library cost may not quietly restate it. Ajv does not strip a
      // DECLARED key, so without the module guard the value would land.
      const response = await inject('PATCH', `/admin/samples/${sampleId}`, showroomCookie, {
        unit_cost: 1,
      })
      expect(response.statusCode).toBe(403)

      const { rows } = await pool.query('SELECT unit_cost FROM samples WHERE id = $1', [sampleId])
      expect(Number(rows[0].unit_cost)).toBe(87.25)
    })

    it('never even SELECTS the column for a caller without finance', async () => {
      // The response assertion above can only see what a projection kept. This
      // is the stronger claim, and the one that survives a future route
      // forgetting to project: fail-closed at the SQL.
      const statements = []
      const stub = {
        query: async (text) => {
          statements.push(text)
          return { rows: [{ id: 1, total: 0 }] }
        },
      }

      await listSamples(stub, {})
      await getSample(stub, 1)
      expect(statements.length).toBeGreaterThan(0)
      expect(statements.some((sql) => /unit_cost|cost_currency/.test(sql))).toBe(false)

      // And the same reads DO name it once finance is granted — otherwise the
      // assertion above would pass against a column nobody can ever read.
      const financeStatements = []
      const financeStub = {
        query: async (text) => {
          financeStatements.push(text)
          return { rows: [{ id: 1, total: 0 }] }
        },
      }
      await listSamples(financeStub, { finance: true })
      await getSample(financeStub, 1, { finance: true })
      expect(financeStatements.some((sql) => /unit_cost/.test(sql))).toBe(true)
    })

    it('defaults to closed for a direct module caller', async () => {
      // A future report calling the read model without saying anything must get
      // no costs, not every cost.
      const sample = await getSample(pool, sampleId)
      expect(sample).not.toHaveProperty('unit_cost')
      await expect(
        updateSampleDirect(pool, sampleId, { unit_cost: 3 })
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('invariants', () => {
    it('keeps the cost columns inside the write whitelist and named in one place', () => {
      for (const key of SAMPLE_FINANCE_KEYS) {
        expect(SAMPLE_UPDATE_COLUMNS).toContain(key)
      }
      // The declaration a later cost column has to join, so the finance gate
      // and the payload cannot disagree about what a cost is.
      expect([...SAMPLE_FINANCE_KEYS]).toEqual(['unit_cost', 'cost_currency'])
    })

    it('adds no quantity column to samples', async () => {
      // A cost is not a valuation of inventory. Samples are still not stock.
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'samples'`
      )
      const offending = rows
        .map((row) => row.column_name)
        .filter((name) => /qty_available|qty_reserved/.test(name))
      expect(offending).toEqual([])
    })
  })
})
