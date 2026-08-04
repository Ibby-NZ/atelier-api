import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'chk-test'
const ZONE = 'Checkout Test Zone'
const EMPTY_ZONE = 'Checkout Nowhere Zone'
const STORE_BASE_URL = 'https://store.test'

const SKU = {
  good: `${PREFIX}-GOOD`,
  noPrice: `${PREFIX}-NOPRICE`,
  low: `${PREFIX}-LOW`,
  fabric: `${PREFIX}-FABRIC`,
}

// A Stripe stub that records the params of the last create() call and returns a
// deterministic session. No network, no SDK.
const makeStripeStub = () => {
  const stub = {
    lastCreateParams: null,
    checkout: {
      sessions: {
        create: async (params) => {
          stub.lastCreateParams = params
          return {
            id: 'cs_test_abc123',
            url: 'https://checkout.stripe.test/pay/cs_test_abc123',
          }
        },
        retrieve: async (id) => {
          if (id === 'cs_missing') {
            throw new Error('No such checkout.session')
          }
          return {
            id,
            payment_status: 'paid',
            amount_total: 5700,
            currency: 'nzd',
            customer_details: { email: 'buyer@example.test' },
          }
        },
      },
    },
  }
  return stub
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Chk Test House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, retail_price_cents, currency, show_on_website)
     VALUES
       ($1, 'Chk Good',   $2, 'finished_good', 4500, 'NZD', true),
       ($1, 'Chk NoPrice',$3, 'finished_good', NULL, 'NZD', true),
       ($1, 'Chk Low',    $4, 'finished_good', 2000, 'NZD', true),
       ($1, 'Chk Fabric', $5, 'fabric',        NULL, 'NZD', true)
     RETURNING id, slug`,
    [
      brandId,
      `${PREFIX}-good`,
      `${PREFIX}-noprice`,
      `${PREFIX}-low`,
      `${PREFIX}-fabric`,
    ]
  )
  const idBySlug = new Map(products.map((p) => [p.slug, p.id]))

  const cw = async (slug, sku) => {
    const { rows } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku)
       VALUES ($1, 'Default', $2) RETURNING id`,
      [idBySlug.get(slug), sku]
    )
    return rows[0].id
  }
  const goodCw = await cw(`${PREFIX}-good`, SKU.good)
  const noPriceCw = await cw(`${PREFIX}-noprice`, SKU.noPrice)
  const lowCw = await cw(`${PREFIX}-low`, SKU.low)
  const fabricCw = await cw(`${PREFIX}-fabric`, SKU.fabric)

  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 10, 0, 'units'),
            ($2, 10, 0, 'units'),
            ($3, 1, 0, 'units'),
            ($4, 60, 0, 'metres')`,
    [goodCw, noPriceCw, lowCw, fabricCw]
  )

  await pool.query(
    `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
     VALUES ($1, 0, 1200), ($1, 20, 3000)`,
    [ZONE]
  )
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM shipping_rates WHERE zone LIKE $1', [
    '%Checkout%Zone',
  ])
}

describe('POST /checkout/session', () => {
  let pool
  let app
  let stripe

  const post = (payload) =>
    app.inject({ method: 'POST', url: '/checkout/session', payload })

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

    stripe = makeStripeStub()
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      stripe,
      storeBaseUrl: STORE_BASE_URL,
      logger: false,
    })
    await app.ready()
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  it('creates a session and returns the redirect URL', async () => {
    const response = await post({ lines: [{ sku: SKU.good, qty: 2 }], zone: ZONE })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.session_id).toBe('cs_test_abc123')
    expect(body.url).toContain('checkout.stripe.test')

    const params = stripe.lastCreateParams
    expect(params.mode).toBe('payment')
    expect(params.success_url).toContain(STORE_BASE_URL)
    expect(params.success_url).toContain('{CHECKOUT_SESSION_ID}')
    expect(params.cancel_url).toBe(`${STORE_BASE_URL}/cart`)
    // Cart is stashed in metadata for the webhook to rebuild the order (US-011).
    expect(JSON.parse(params.metadata.cart)).toEqual([{ sku: SKU.good, qty: 2 }])
    expect(params.metadata.zone).toBe(ZONE)
  })

  it('prices every line from the DB, ignoring any client price', async () => {
    // Body carries no price; even if it did, additionalProperties blocks it.
    await post({ lines: [{ sku: SKU.good, qty: 3 }], zone: ZONE })
    const items = stripe.lastCreateParams.line_items
    const product = items[0]
    expect(product.price_data.unit_amount).toBe(4500) // server-side retail price
    expect(product.price_data.currency).toBe('nzd')
    expect(product.quantity).toBe(3)
  })

  it('adds the shipping quote as a line item from the zone', async () => {
    await post({ lines: [{ sku: SKU.good, qty: 2 }], zone: ZONE })
    const items = stripe.lastCreateParams.line_items
    const shipping = items[items.length - 1]
    expect(shipping.price_data.product_data.name).toContain(ZONE)
    expect(shipping.price_data.unit_amount).toBe(1200) // qty 2 < 20 → base tier
    expect(shipping.quantity).toBe(1)
  })

  it('rejects fabric products with 422', async () => {
    const response = await post({
      lines: [{ sku: SKU.fabric, qty: 1 }],
      zone: ZONE,
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/fabric/i)
  })

  it('rejects finished goods with no retail price (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.noPrice, qty: 1 }],
      zone: ZONE,
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/retail price/i)
  })

  it('rejects an order that exceeds available stock (422)', async () => {
    const response = await post({ lines: [{ sku: SKU.low, qty: 5 }], zone: ZONE })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/stock/i)
  })

  it('rejects an unknown SKU with 422', async () => {
    const response = await post({
      lines: [{ sku: 'no-such-sku', qty: 1 }],
      zone: ZONE,
    })
    expect(response.statusCode).toBe(422)
  })

  it('asks Stripe to collect a NZ delivery address and a phone number', async () => {
    await post({ lines: [{ sku: SKU.good, qty: 1 }], zone: ZONE })
    const params = stripe.lastCreateParams
    // Physical goods have to be dispatched somewhere, and the shipping tiers
    // only price the three NZ zones — so no other country may be offered.
    expect(params.shipping_address_collection).toEqual({ allowed_countries: ['NZ'] })
    expect(params.phone_number_collection).toEqual({ enabled: true })
    // Our own zone tiers price the freight; Stripe must not add its own.
    expect(params.shipping_options).toBeUndefined()
  })

  it('rejects an unknown shipping zone with 400', async () => {
    const response = await post({
      lines: [{ sku: SKU.good, qty: 1 }],
      zone: EMPTY_ZONE,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/zone/i)
  })

  it('rejects a body with no lines by schema (400)', async () => {
    const response = await post({ lines: [], zone: ZONE })
    expect(response.statusCode).toBe(400)
  })

  it('returns 503 when Stripe is not configured', async () => {
    const noStripe = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      storeBaseUrl: STORE_BASE_URL,
      logger: false,
    })
    await noStripe.ready()
    const response = await noStripe.inject({
      method: 'POST',
      url: '/checkout/session',
      payload: { lines: [{ sku: SKU.good, qty: 1 }], zone: ZONE },
    })
    expect(response.statusCode).toBe(503)
    await noStripe.close()
  })
})

describe('GET /checkout/session/:id', () => {
  let pool
  let app

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      stripe: makeStripeStub(),
      storeBaseUrl: STORE_BASE_URL,
      logger: false,
    })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    await pool.end()
  })

  it('verifies a paid session and returns the deterministic order number', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/checkout/session/cs_test_abc123',
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.order_number).toBe('WEB-cs_test_abc123')
    expect(body.paid).toBe(true)
    expect(body.amount_total_cents).toBe(5700)
    expect(body.currency).toBe('NZD')
    expect(body.email).toBe('buyer@example.test')
  })

  it('returns 404 for an unknown session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/checkout/session/cs_missing',
    })
    expect(response.statusCode).toBe(404)
  })

  it('returns 503 when Stripe is not configured', async () => {
    const noStripe = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      storeBaseUrl: STORE_BASE_URL,
      logger: false,
    })
    await noStripe.ready()
    const response = await noStripe.inject({
      method: 'GET',
      url: '/checkout/session/cs_test_abc123',
    })
    expect(response.statusCode).toBe(503)
    await noStripe.close()
  })
})

describe('repository secret hygiene', () => {
  // Build the literal from fragments so this assertion never matches itself.
  const secretKeyPattern = new RegExp('sk_' + '(live|test)_[0-9A-Za-z]+')

  const jsFilesUnder = (dir) => {
    const out = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        out.push(...jsFilesUnder(full))
      } else if (entry.endsWith('.js')) {
        out.push(full)
      }
    }
    return out
  }

  it('contains no hardcoded Stripe secret key in src/', () => {
    const offenders = jsFilesUnder(join(process.cwd(), 'src')).filter((file) =>
      secretKeyPattern.test(readFileSync(file, 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})
