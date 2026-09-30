// The house-visibility gate: which viewers may browse which houses.
//
// Distinct from the trade-PRICING gate (test/catalogue-detail.test.js covers
// that one). The two are deliberately not the same set of people — staff see the
// whole library and are never served trade pricing — so both directions are
// asserted here rather than assumed from the other suite.
//
// Fixtures: one OPEN house (trade_only = false, standing in for Atelier's own
// workroom) and one CLOSED house (a represented maison), each with a fabric, a
// finished good, a collection and stocked colourways, so the same viewer matrix
// can be run against the listing, the detail endpoint, the collection counts and
// both transactional SKU paths.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { cleanupTradeApplications, sampleTradeApplication } from './helpers/trade-application-fixture.js'

// POST /checkout/session requires the store-collected delivery details (Sept 2026).
const GATE_CUSTOMER = {
  name: 'Gate Tester',
  email: 'gate@example.test',
  phone: '+6421000000',
  address: { line1: '1 Gate Road', city: 'Auckland', postal_code: '1010' },
}

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'gate-test'
const TEST_DOMAIN = 'gate-test.example.com'
const PASSWORD = 'correct horse battery'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`

const OPEN_SLUG = `${PREFIX}-open-house`
const CLOSED_SLUG = `${PREFIX}-closed-house`
const OPEN_PRODUCT = `${PREFIX}-open-fabric`
const CLOSED_PRODUCT = `${PREFIX}-closed-fabric`
const OPEN_GOOD = `${PREFIX}-open-good`
const CLOSED_GOOD = `${PREFIX}-closed-good`
const OPEN_SKU = `${PREFIX}-OPEN-A`
const CLOSED_SKU = `${PREFIX}-CLOSED-A`
const OPEN_GOOD_SKU = `${PREFIX}-OPEN-GOOD`
const CLOSED_GOOD_SKU = `${PREFIX}-CLOSED-GOOD`

const get = (app, url, cookie) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

const post = (app, url, payload, cookie) =>
  app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} })

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'The open house.'),
            ($3, $4, 'France', 'NZD', false, true, 'The closed house.')
     RETURNING id, slug`,
    ['Gate Open House', OPEN_SLUG, 'Gate Closed House', CLOSED_SLUG]
  )
  const idBySlug = new Map(brands.map((row) => [row.slug, row.id]))

  await pool.query(
    `INSERT INTO collections (brand_id, name, slug)
     VALUES ($1, 'Gate Open Collection', $2), ($3, 'Gate Closed Collection', $4)`,
    [
      idBySlug.get(OPEN_SLUG),
      `${PREFIX}-open-collection`,
      idBySlug.get(CLOSED_SLUG),
      `${PREFIX}-closed-collection`,
    ]
  )

  // Both houses are domestic (is_international = false) with a retail price, so
  // nothing here is filtered by the PRICING rule — every difference the tests
  // see is the visibility gate alone.
  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, application, width, composition,
        retail_price_cents, trade_price_cents, currency, show_on_website,
        collection_id, sell_retail)
     VALUES
       ($1, 'Gate Open Fabric', $2, 'fabric', 'Drapery', '140cm', '100% Linen',
        NULL, 18776, 'NZD', true,
        (SELECT id FROM collections WHERE slug = $6), false),
       ($3, 'Gate Closed Fabric', $4, 'fabric', 'Drapery', '140cm', '100% Linen',
        NULL, 22000, 'NZD', true,
        (SELECT id FROM collections WHERE slug = $7), false),
       ($1, 'Gate Open Good', $5, 'finished_good', 'Cushion', NULL, 'Wool',
        12000, NULL, 'NZD', true, NULL, true),
       ($3, 'Gate Closed Good', $8, 'finished_good', 'Cushion', NULL, 'Wool',
        15000, NULL, 'NZD', true, NULL, true)
     RETURNING id, slug`,
    [
      idBySlug.get(OPEN_SLUG),
      OPEN_PRODUCT,
      idBySlug.get(CLOSED_SLUG),
      CLOSED_PRODUCT,
      OPEN_GOOD,
      `${PREFIX}-open-collection`,
      `${PREFIX}-closed-collection`,
      CLOSED_GOOD,
    ]
  )
  const productIdBySlug = new Map(products.map((row) => [row.slug, row.id]))

  const { rows: colourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Open', $2), ($3, 'Closed', $4), ($5, 'OpenGood', $6), ($7, 'ClosedGood', $8)
     RETURNING id, sku`,
    [
      productIdBySlug.get(OPEN_PRODUCT),
      OPEN_SKU,
      productIdBySlug.get(CLOSED_PRODUCT),
      CLOSED_SKU,
      productIdBySlug.get(OPEN_GOOD),
      OPEN_GOOD_SKU,
      productIdBySlug.get(CLOSED_GOOD),
      CLOSED_GOOD_SKU,
    ]
  )

  for (const row of colourways) {
    await pool.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, 100, 0, $2)`,
      [row.id, row.sku.endsWith('GOOD') ? 'units' : 'metres']
    )
  }

  await pool.query(
    `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
     VALUES ('gate-zone', 0, 900)
     ON CONFLICT (zone, threshold_qty) DO NOTHING`
  )
}

const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM order_lines WHERE order_id IN (
       SELECT id FROM orders WHERE order_number LIKE $1 OR guest_email LIKE $2
     )`,
    [`%${PREFIX}%`, `%@${TEST_DOMAIN}`]
  )
  await pool.query(
    `DELETE FROM orders WHERE order_number LIKE $1 OR guest_email LIKE $2
        OR user_id IN (SELECT id FROM users WHERE email LIKE $2)`,
    [`%${PREFIX}%`, `%@${TEST_DOMAIN}`]
  )
  await pool.query(
    `DELETE FROM trade_applications
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`%@${TEST_DOMAIN}`]
  )
  await cleanupTradeApplications(pool, `%@${TEST_DOMAIN}`)
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM shipping_rates WHERE zone = $1', ['gate-zone'])
}

describe('trade-gated catalogue (brands.trade_only)', () => {
  let pool
  let app
  const cookies = {}

  const signUp = async (url, local, extra = {}) => {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: {
        email: testEmail(local),
        password: PASSWORD,
        name: local,
        ...(url === '/auth/trade-application'
          ? { application: sampleTradeApplication() }
          : {}),
        ...extra,
      },
    })
    expect(response.statusCode).toBe(201)
    if (response.headers['set-cookie']) {
      cookies[local] = sessionCookieFrom(response)
    }
  }

  const logIn = async (local) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: testEmail(local), password: PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    cookies[local] = sessionCookieFrom(response)
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
    await cleanup(pool)
    await seedFixtures(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    // Four viewers: a plain customer, an approved trade account, a pending
    // trade application (which must behave exactly like a signed-out visitor),
    // and a back-office login.
    await signUp('/auth/register', 'customer')
    await signUp('/auth/trade-application', 'trader')
    await signUp('/auth/trade-application', 'pending')
    await signUp('/auth/register', 'staff')

    await pool.query('UPDATE users SET trade_approved = true WHERE email = $1', [
      testEmail('trader'),
    ])
    await logIn('trader')

    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('staff'),
    ])
    await logIn('staff')
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  const listSlugs = async (cookie) => {
    const response = await get(app, '/catalogue/products?limit=100', cookie)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    return {
      slugs: body.products.map((product) => product.slug),
      meta: body.meta,
    }
  }

  describe('GET /catalogue/products', () => {
    it('shows an anonymous visitor the open house only, and says so', async () => {
      const { slugs, meta } = await listSlugs(undefined)
      expect(slugs).toContain(OPEN_PRODUCT)
      expect(slugs).not.toContain(CLOSED_PRODUCT)
      expect(meta.trade_gated).toBe(true)
    })

    it('treats a plain customer exactly like a visitor', async () => {
      const { slugs, meta } = await listSlugs(cookies.customer)
      expect(slugs).not.toContain(CLOSED_PRODUCT)
      expect(meta.trade_gated).toBe(true)
    })

    it('shows an approved trade account the whole library', async () => {
      const { slugs, meta } = await listSlugs(cookies.trader)
      expect(slugs).toContain(OPEN_PRODUCT)
      expect(slugs).toContain(CLOSED_PRODUCT)
      expect(meta.trade_gated).toBe(false)
    })

    it('shows back office the whole library WITHOUT trade pricing', async () => {
      const response = await get(app, '/catalogue/products?limit=100', cookies.staff)
      const { products, meta } = response.json()
      const closed = products.find((product) => product.slug === CLOSED_PRODUCT)
      expect(closed).toBeDefined()
      expect(meta.trade_gated).toBe(false)
      // The two gates are independent: visibility yes, price no.
      expect(closed.trade_price_cents).toBeUndefined()
    })

    it('gives an approved trade account the trade price on a closed house', async () => {
      const response = await get(app, '/catalogue/products?limit=100', cookies.trader)
      const closed = response
        .json()
        .products.find((product) => product.slug === CLOSED_PRODUCT)
      expect(closed.trade_price_cents).toBe(22000)
    })

    it('counts only visible products in meta.total', async () => {
      const anon = await get(app, `/catalogue/products?brand=${CLOSED_SLUG}`)
      expect(anon.json().meta.total).toBe(0)
      const trade = await get(
        app,
        `/catalogue/products?brand=${CLOSED_SLUG}`,
        cookies.trader
      )
      expect(trade.json().meta.total).toBe(2)
    })

    it('cannot be bypassed by filtering or searching for a closed house', async () => {
      const byBrand = await get(app, `/catalogue/products?brand=${CLOSED_SLUG}&limit=100`)
      expect(byBrand.json().products).toHaveLength(0)
      const bySearch = await get(app, '/catalogue/products?q=Gate%20Closed&limit=100')
      expect(bySearch.json().products).toHaveLength(0)
      const bySku = await get(app, `/catalogue/products?q=${CLOSED_SKU}&limit=100`)
      expect(bySku.json().products).toHaveLength(0)
    })
  })

  describe('GET /catalogue/products/:slug', () => {
    it('serves the open house to anyone', async () => {
      const response = await get(app, `/catalogue/products/${OPEN_PRODUCT}`)
      expect(response.statusCode).toBe(200)
    })

    it('answers 403 with trade_only for a visitor, not 404', async () => {
      const response = await get(app, `/catalogue/products/${CLOSED_PRODUCT}`)
      expect(response.statusCode).toBe(403)
      const body = response.json()
      expect(body.trade_only).toBe(true)
      expect(body.message).toMatch(/trade/i)
      // Nothing about the product itself comes back with the refusal.
      expect(body.product).toBeUndefined()
      expect(JSON.stringify(body)).not.toContain('Gate Closed Fabric')
    })

    it('answers 403 to a pending trade application too', async () => {
      // A pending applicant cannot even hold a session, so this is the
      // signed-out path — asserted explicitly because "applied for trade" reads
      // like entitlement and is not.
      const response = await get(app, `/catalogue/products/${CLOSED_PRODUCT}`, cookies.pending)
      expect(response.statusCode).toBe(403)
    })

    it('serves the closed house to approved trade and to staff', async () => {
      for (const who of ['trader', 'staff']) {
        const response = await get(app, `/catalogue/products/${CLOSED_PRODUCT}`, cookies[who])
        expect(response.statusCode, who).toBe(200)
        expect(response.json().product.slug).toBe(CLOSED_PRODUCT)
      }
    })

    it('still answers 404 for a slug that does not exist', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-no-such-thing`)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('brands and collections stay public', () => {
    it('lists a closed house to a visitor, flagged trade_only', async () => {
      const response = await get(app, '/catalogue/brands')
      const closed = response.json().brands.find((brand) => brand.slug === CLOSED_SLUG)
      expect(closed).toBeDefined()
      expect(closed.trade_only).toBe(true)
      const open = response.json().brands.find((brand) => brand.slug === OPEN_SLUG)
      expect(open.trade_only).toBe(false)
    })

    it('serves a closed house page to a visitor', async () => {
      const response = await get(app, `/catalogue/brands/${CLOSED_SLUG}`)
      expect(response.statusCode).toBe(200)
      expect(response.json().brand.trade_only).toBe(true)
    })

    it('zeroes a closed collection product_count for a visitor', async () => {
      const anon = await get(app, `/catalogue/collections?brand=${CLOSED_SLUG}`)
      expect(anon.statusCode).toBe(200)
      const [collection] = anon.json().collections
      expect(collection.product_count).toBe(0)
      expect(collection.brand.trade_only).toBe(true)

      const trade = await get(
        app,
        `/catalogue/collections?brand=${CLOSED_SLUG}`,
        cookies.trader
      )
      expect(trade.json().collections[0].product_count).toBe(1)
    })

    it('zeroes the single-collection count for a visitor too', async () => {
      const url = `/catalogue/brands/${CLOSED_SLUG}/collections/${PREFIX}-closed-collection`
      expect((await get(app, url)).json().collection.product_count).toBe(0)
      expect((await get(app, url, cookies.trader)).json().collection.product_count).toBe(1)
    })
  })

  describe('the gate closes the transactional paths too', () => {
    it('refuses a guest order request for a closed SKU', async () => {
      const response = await post(app, '/orders/request', {
        lines: [{ sku: CLOSED_SKU, qty_metres: 2 }],
        contact: { email: testEmail('guest') },
      })
      expect(response.statusCode).toBe(422)
      // Same wording as an unknown SKU: a refusal must not confirm what exists.
      expect(response.json().message).toMatch(/No product available for SKU/)
    })

    it('accepts a guest order request for an open SKU', async () => {
      const response = await post(app, '/orders/request', {
        lines: [{ sku: OPEN_SKU, qty_metres: 2 }],
        contact: { email: testEmail('guest') },
      })
      expect(response.statusCode).toBe(201)
    })

    it('accepts an approved trade order request for a closed SKU', async () => {
      const response = await post(
        app,
        '/orders/request',
        { lines: [{ sku: CLOSED_SKU, qty_metres: 2 }] },
        cookies.trader
      )
      expect(response.statusCode).toBe(201)
    })

    it('refuses a guest card checkout for a closed finished good', async () => {
      const stripe = {
        checkout: {
          sessions: {
            create: async () => ({ id: 'cs_gate', url: 'https://stripe.test/gate' }),
          },
        },
      }
      const gated = buildApp({
        pool,
        cookieSecret: TEST_COOKIE_SECRET,
        logger: false,
        stripe,
        storeBaseUrl: 'https://store.test',
      })
      await gated.ready()
      try {
        const refused = await post(gated, '/checkout/session', {
          lines: [{ sku: CLOSED_GOOD_SKU, qty: 1 }],
          zone: 'gate-zone',
          customer: GATE_CUSTOMER,
        })
        expect(refused.statusCode).toBe(422)
        expect(refused.json().message).toMatch(/No purchasable product for SKU/)

        const allowed = await post(gated, '/checkout/session', {
          lines: [{ sku: OPEN_GOOD_SKU, qty: 1 }],
          zone: 'gate-zone',
          customer: GATE_CUSTOMER,
        })
        expect(allowed.statusCode).toBe(200)
      } finally {
        await gated.close()
      }
    })
  })

  // Userback 8287607 archived five departed houses, and archiving a BRAND does
  // not cascade `show_on_website = false` onto its products: the storefront 404s
  // the design while both transactional paths still resolved its SKU, reserved
  // the stock, and (for a priced finished good) would have taken the money.
  describe('an archived row closes the transactional paths too', () => {
    // Its own app instance: the rate-limit store is per instance, and
    // `POST /orders/request` allows 10 per 15 min per IP — the block above has
    // already spent three of the shared app's.
    let storeApp

    const archiveOpenHouse = (archived) =>
      pool.query(
        `UPDATE brands SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE slug = $1`,
        [OPEN_SLUG]
      )

    const archiveOpenColourway = (archived) =>
      pool.query(
        `UPDATE colourways SET archived_at = ${archived ? 'now()' : 'NULL'} WHERE sku = $1`,
        [OPEN_SKU]
      )

    const reservedFor = async (sku) => {
      const { rows } = await pool.query(
        `SELECT i.qty_reserved
           FROM inventory i JOIN colourways c ON c.id = i.colourway_id
          WHERE c.sku = $1`,
        [sku]
      )
      return Number(rows[0].qty_reserved)
    }

    const requestOpenSku = (cookie) =>
      post(
        storeApp,
        '/orders/request',
        {
          lines: [{ sku: OPEN_SKU, qty_metres: 2 }],
          ...(cookie ? {} : { contact: { email: testEmail('guest') } }),
        },
        cookie
      )

    beforeAll(async () => {
      storeApp = buildApp({
        pool,
        cookieSecret: TEST_COOKIE_SECRET,
        logger: false,
        stripe: {
          checkout: {
            sessions: {
              create: async () => ({
                id: 'cs_archived',
                url: 'https://stripe.test/archived',
              }),
            },
          },
        },
        storeBaseUrl: 'https://store.test',
      })
      await storeApp.ready()
    })

    afterAll(async () => {
      await storeApp.close()
    })

    it('refuses an order request under an archived house, reserving nothing', async () => {
      const before = await reservedFor(OPEN_SKU)
      await archiveOpenHouse(true)
      try {
        // The contradiction this closes: the storefront already 404s the design.
        expect((await get(app, `/catalogue/products/${OPEN_PRODUCT}`)).statusCode).toBe(404)

        const response = await requestOpenSku(undefined)
        expect(response.statusCode).toBe(422)
        // Same wording as an unknown SKU — the refusal must not tell a customer
        // the house has left.
        expect(response.json().message).toBe(`No product available for SKU "${OPEN_SKU}".`)
        expect(JSON.stringify(response.json())).not.toMatch(/archiv|Gate Open House/i)
      } finally {
        await archiveOpenHouse(false)
      }
      expect(await reservedFor(OPEN_SKU)).toBe(before)
    })

    it('refuses approved trade and back office as well — this is not the trade gate', async () => {
      await archiveOpenHouse(true)
      try {
        for (const who of ['trader', 'staff']) {
          const response = await requestOpenSku(cookies[who])
          expect(response.statusCode, who).toBe(422)
        }
      } finally {
        await archiveOpenHouse(false)
      }
    })

    it('refuses card checkout for a priced good under an archived house', async () => {
      await archiveOpenHouse(true)
      try {
        const response = await post(storeApp, '/checkout/session', {
          lines: [{ sku: OPEN_GOOD_SKU, qty: 1 }],
          zone: 'gate-zone',
          customer: GATE_CUSTOMER,
        })
        expect(response.statusCode).toBe(422)
        expect(response.json().message).toBe(
          `No purchasable product for SKU "${OPEN_GOOD_SKU}".`
        )
      } finally {
        await archiveOpenHouse(false)
      }

      const allowed = await post(storeApp, '/checkout/session', {
        lines: [{ sku: OPEN_GOOD_SKU, qty: 1 }],
        zone: 'gate-zone',
          customer: GATE_CUSTOMER,
      })
      expect(allowed.statusCode).toBe(200)
    })

    it('refuses a SKU whose colourway alone was archived', async () => {
      // Archiving a colourway takes the SKU off the detail page and out of the
      // swatch strip; the cart and the order request still resolved it.
      await archiveOpenColourway(true)
      try {
        const response = await requestOpenSku(undefined)
        expect(response.statusCode).toBe(422)
      } finally {
        await archiveOpenColourway(false)
      }
    })

    it('still accepts the same SKU once nothing is archived', async () => {
      const response = await requestOpenSku(undefined)
      expect(response.statusCode).toBe(201)
    })
  })

  describe('the flag is administrable', () => {
    it('opens a house from the back office and the public grid follows', async () => {
      const { rows } = await pool.query('SELECT id FROM brands WHERE slug = $1', [
        CLOSED_SLUG,
      ])
      const patch = await app.inject({
        method: 'PATCH',
        url: `/admin/brands/${rows[0].id}`,
        payload: { trade_only: false },
        headers: { cookie: cookies.staff },
      })
      expect(patch.statusCode).toBe(200)
      expect(patch.json().brand.trade_only).toBe(false)

      const { slugs } = await listSlugs(undefined)
      expect(slugs).toContain(CLOSED_PRODUCT)

      // Put it back so the ordering of this describe block cannot leak into a
      // rerun of the ones above.
      await pool.query('UPDATE brands SET trade_only = true WHERE slug = $1', [
        CLOSED_SLUG,
      ])
    })

    it('creates a house closed by default', async () => {
      const response = await post(
        app,
        '/admin/brands',
        { name: 'Gate Test New House', currency: 'NZD' },
        cookies.staff
      )
      expect(response.statusCode).toBe(201)
      expect(response.json().brand.trade_only).toBe(true)
      await pool.query('DELETE FROM brands WHERE slug = $1', ['gate-test-new-house'])
    })
  })
})
