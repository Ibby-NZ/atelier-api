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
  trade: `${PREFIX}-TRADE`,
}

const PASSWORD = 'checkout-test-password-123'

// The delivery details the store collects (Sept 2026); every post carries them
// unless a test deliberately drops them.
const CUSTOMER = Object.freeze({
  name: 'Olivia Marlow',
  email: 'olivia@example.test',
  phone: '+6421555000',
  address: { line1: '12 Parnell Road', line2: 'Level 2', city: 'Auckland', postal_code: '1052' },
})
const TRADE_EMAIL = `${PREFIX}-trader@example.test`

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
    // The trade fixture is priced in EUR at retail and carries a trade figure:
    // trade money is NZD cents whatever `currency` says, so the two are only
    // told apart when they disagree.
    `INSERT INTO products
       (brand_id, name, slug, product_type, retail_price_cents, trade_price_cents, currency, show_on_website)
     VALUES
       ($1, 'Chk Good',   $2, 'finished_good', 4500, NULL, 'NZD', true),
       ($1, 'Chk NoPrice',$3, 'finished_good', NULL, NULL, 'NZD', true),
       ($1, 'Chk Low',    $4, 'finished_good', 2000, NULL, 'NZD', true),
       ($1, 'Chk Fabric', $5, 'fabric',        NULL, NULL, 'NZD', true),
       ($1, 'Chk Trade',  $6, 'finished_good', 4500, 9900, 'EUR', true)
     RETURNING id, slug`,
    [
      brandId,
      `${PREFIX}-good`,
      `${PREFIX}-noprice`,
      `${PREFIX}-low`,
      `${PREFIX}-fabric`,
      `${PREFIX}-trade`,
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
  const tradeCw = await cw(`${PREFIX}-trade`, SKU.trade)

  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 10, 0, 'units'),
            ($2, 10, 0, 'units'),
            ($3, 1, 0, 'units'),
            ($4, 60, 0, 'metres'),
            ($5, 10, 0, 'units')`,
    [goodCw, noPriceCw, lowCw, fabricCw, tradeCw]
  )

  await pool.query(
    `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
     VALUES ($1, 0, 1200), ($1, 20, 3000)`,
    [ZONE]
  )
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM shipping_rates WHERE zone LIKE $1', [
    '%Checkout%Zone',
  ])
}

describe('POST /checkout/session', () => {
  let pool
  let app
  let stripe

  let tradeCookie

  const post = (payload, cookie) =>
    app.inject({
      method: 'POST',
      url: '/checkout/session',
      payload: { customer: CUSTOMER, ...payload },
      headers: cookie ? { cookie } : {},
    })

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

    // An approved trade shopper, for the price-basis tests. Registered once —
    // register shares a 10-per-15-min bucket with login.
    await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: TRADE_EMAIL, password: PASSWORD, name: 'Chk Trader' },
    })
    await pool.query(
      `UPDATE users SET role = 'trade', trade_approved = true WHERE email = $1`,
      [TRADE_EMAIL]
    )
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: TRADE_EMAIL, password: PASSWORD },
    })
    expect(login.statusCode).toBe(200)
    const setCookie = login.headers['set-cookie']
    tradeCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
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
    // Stripe must present the NZD figure the store quoted, not a converted
    // local currency for a buyer abroad.
    expect(params.adaptive_pricing).toEqual({ enabled: false })
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
    const shipping = items[items.length - 2] // GST is the last line
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

  it('rejects finished goods with no price at all (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.noPrice, qty: 1 }],
      zone: ZONE,
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/no price/i)
  })

  // FR-3: the figure on the product card and the amount Stripe takes come from
  // the same gate. Charging retail while the card said "Trade $X" is the bug.
  it('charges an approved trade shopper the trade price, in NZD', async () => {
    const response = await post(
      { lines: [{ sku: SKU.trade, qty: 2 }], zone: ZONE },
      tradeCookie
    )
    expect(response.statusCode).toBe(200)
    const product = stripe.lastCreateParams.line_items[0]
    expect(product.price_data.unit_amount).toBe(9900)
    // Trade money is NZD cents, never the product's own (here EUR) currency.
    expect(product.price_data.currency).toBe('nzd')
    // The basis the webhook has to re-resolve on.
    expect(stripe.lastCreateParams.metadata.trade).toBe('true')
  })

  it('charges everyone else the retail price', async () => {
    const response = await post({ lines: [{ sku: SKU.trade, qty: 1 }], zone: ZONE })
    expect(response.statusCode).toBe(200)
    const product = stripe.lastCreateParams.line_items[0]
    expect(product.price_data.unit_amount).toBe(4500)
    expect(product.price_data.currency).toBe('eur')
    expect(stripe.lastCreateParams.metadata.trade).toBe('false')
  })

  // 8367547 / 8367555: the checkout form had nowhere to say "leave it with the
  // concierge" or name the client's own PO. This endpoint writes no order row —
  // the webhook does — so anything typed has to travel in the session metadata.
  it("carries the shopper's notes, reference and PO number in the metadata", async () => {
    const response = await post({
      lines: [{ sku: SKU.good, qty: 1 }],
      zone: ZONE,
      notes: '  Leave with the concierge.  ',
      client_reference: 'Ponsonby Rd — master bedroom',
      customer_po_number: 'PO-4417',
    })
    expect(response.statusCode).toBe(200)
    const { metadata } = stripe.lastCreateParams
    expect(metadata.notes).toBe('Leave with the concierge.') // trimmed
    expect(metadata.client_reference).toBe('Ponsonby Rd — master bedroom')
    expect(metadata.customer_po_number).toBe('PO-4417')
  })

  it('omits a blank note rather than sending an empty metadata value', async () => {
    await post({
      lines: [{ sku: SKU.good, qty: 1 }],
      zone: ZONE,
      notes: '   ',
      client_reference: '',
    })
    const { metadata } = stripe.lastCreateParams
    expect(metadata).not.toHaveProperty('notes')
    expect(metadata).not.toHaveProperty('client_reference')
    expect(metadata).not.toHaveProperty('customer_po_number')
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

  it('forwards the delivery details the store collected, and does not ask Stripe to collect them again', async () => {
    await post({ lines: [{ sku: SKU.good, qty: 1 }], zone: ZONE })
    const params = stripe.lastCreateParams
    expect(params.payment_intent_data.shipping).toEqual({
      name: 'Olivia Marlow',
      phone: '+6421555000',
      address: {
        line1: '12 Parnell Road',
        line2: 'Level 2',
        city: 'Auckland',
        postal_code: '1052',
        country: 'NZ', // fixed: the shipping tiers only price NZ
      },
    })
    expect(params.customer_email).toBe('olivia@example.test')
    expect(params.shipping_address_collection).toBeUndefined()
    expect(params.phone_number_collection).toBeUndefined()
    // Our own zone tiers price the freight; Stripe must not add its own.
    expect(params.shipping_options).toBeUndefined()
    // The webhook persists the address from metadata (signed), not the intent.
    expect(params.metadata).toMatchObject({
      ship_name: 'Olivia Marlow',
      ship_phone: '+6421555000',
      ship_line1: '12 Parnell Road',
      ship_line2: 'Level 2',
      ship_city: 'Auckland',
      ship_postal_code: '1052',
    })
  })

  it('the confirmed email wins over the account login for the receipt', async () => {
    await post({ lines: [{ sku: SKU.good, qty: 1 }], zone: ZONE }, tradeCookie)
    expect(stripe.lastCreateParams.customer_email).toBe('olivia@example.test')
  })

  it('charges 15% GST on goods plus freight as its own line, and records it in metadata', async () => {
    await post({ lines: [{ sku: SKU.good, qty: 2 }], zone: ZONE })
    const items = stripe.lastCreateParams.line_items
    const gst = items[items.length - 1]
    expect(gst.price_data.product_data.name).toMatch(/GST/)
    expect(gst.price_data.unit_amount).toBe(Math.round((4500 * 2 + 1200) * 0.15)) // 1530
    expect(gst.quantity).toBe(1)
    expect(stripe.lastCreateParams.metadata.gst_cents).toBe('1530')
  })

  it('rejects a body with no customer by schema (400)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/checkout/session',
      payload: { lines: [{ sku: SKU.good, qty: 1 }], zone: ZONE },
    })
    expect(response.statusCode).toBe(400)
  })

  it('strips a client-sent country: delivery is NZ whatever the body says', async () => {
    await post({
      lines: [{ sku: SKU.good, qty: 1 }],
      zone: ZONE,
      customer: { ...CUSTOMER, address: { ...CUSTOMER.address, country: 'AU' } },
    })
    expect(stripe.lastCreateParams.payment_intent_data.shipping.address.country).toBe('NZ')
  })

  it('GET /checkout/prefill starts a signed-in shopper from the account, and refuses guests', async () => {
    const guest = await app.inject({ method: 'GET', url: '/checkout/prefill' })
    expect(guest.statusCode).toBe(401)

    const trader = await app.inject({
      method: 'GET',
      url: '/checkout/prefill',
      headers: { cookie: tradeCookie },
    })
    expect(trader.statusCode).toBe(200)
    expect(trader.json()).toEqual({
      name: 'Chk Trader',
      email: TRADE_EMAIL,
      phone: '',
      address: { line1: '', line2: '', city: '', postal_code: '' },
    })
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
      payload: { lines: [{ sku: SKU.good, qty: 1 }], zone: ZONE, customer: CUSTOMER },
    })
    expect(response.statusCode).toBe(503)
    await noStripe.close()
  })
})

// The success page (US-019). The order is written by the webhook, so this reads
// the row back by stripe_session_id rather than deriving anything from the
// session id — which is what used to put `WEB-cs_test_a1b2c3…` in front of the
// client (8367539).
describe('GET /checkout/session/:id', () => {
  let pool
  let app

  const SESSION_PREFIX = 'chk-sess'
  const PAID_SESSION = 'cs_test_abc123'
  const PENDING_SESSION = 'cs_test_pending'
  const ORDER_NUMBER = 'WEB-9F3A21BC'
  const SESSION_SKU = `${SESSION_PREFIX}-GOOD`
  const ADDRESS = {
    name: 'Olivia Marlow',
    line1: '12 Parnell Road',
    line2: null,
    city: 'Auckland',
    state: 'Auckland',
    postal_code: '1052',
    country: 'NZ',
  }

  const cleanupSession = async () => {
    // order_lines.colourway_id is ON DELETE RESTRICT — orders go first.
    await pool.query('DELETE FROM orders WHERE stripe_session_id = $1', [PAID_SESSION])
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${SESSION_PREFIX}-%`])
  }

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await cleanupSession()

    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
       VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
       RETURNING id`,
      ['Chk Session House', `${SESSION_PREFIX}-house`]
    )
    const { rows: products } = await pool.query(
      `INSERT INTO products
         (brand_id, name, slug, product_type, retail_price_cents, currency, show_on_website)
       VALUES ($1, 'Chk Session Good', $2, 'finished_good', 4500, 'NZD', true)
       RETURNING id`,
      [brands[0].id, `${SESSION_PREFIX}-good`]
    )
    const { rows: colourways } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Default', $2)
       RETURNING id`,
      [products[0].id, SESSION_SKU]
    )
    const { rows: orders } = await pool.query(
      `INSERT INTO orders
         (guest_email, order_number, kind, status, subtotal_cents, shipping_cents,
          total_cents, shipping_zone, stripe_session_id, shipping_address)
       VALUES ($1, $2, 'checkout', 'paid', 9000, 1200, 10200, $3, $4, $5)
       RETURNING id`,
      // jsonb binds as text: a raw JS object would map to a Postgres record.
      ['buyer@example.test', ORDER_NUMBER, ZONE, PAID_SESSION, JSON.stringify(ADDRESS)]
    )
    await pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, 2, 4500)`,
      [orders[0].id, colourways[0].id]
    )

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
    await cleanupSession()
    await app.close()
    await pool.end()
  })

  it('returns the human order number the webhook wrote, with lines and address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/checkout/session/${PAID_SESSION}`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    // Not `WEB-<stripe session id>`: something a client can read down a phone.
    expect(body.order_number).toBe(ORDER_NUMBER)
    expect(body.order_number).toMatch(/^WEB-[A-Z0-9]{8}$/)
    expect(body.pending).toBe(false)
    expect(body.paid).toBe(true)
    expect(body.amount_total_cents).toBe(5700)
    expect(body.currency).toBe('NZD')
    expect(body.email).toBe('buyer@example.test')
    expect(body.lines).toEqual([
      {
        sku: SESSION_SKU,
        name: 'Chk Session Good',
        qty: 2,
        unit_price_cents: 4500,
      },
    ])
    expect(body.shipping_address).toEqual(ADDRESS)
  })

  // The webhook is a separate request from Stripe: the shopper can land here
  // first. Say so rather than invent a number — and still confirm the payment.
  it('reports pending with a null order number until the webhook lands', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/checkout/session/${PENDING_SESSION}`,
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.pending).toBe(true)
    expect(body.order_number).toBeNull()
    expect(body.lines).toEqual([])
    expect(body.shipping_address).toBeNull()
    expect(body.paid).toBe(true)
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
      url: `/checkout/session/${PAID_SESSION}`,
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
