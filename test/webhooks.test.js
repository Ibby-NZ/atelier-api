import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const WEBHOOK_SECRET = 'whsec_test_webhook_secret'
const PREFIX = 'wh-test'
const VALID_SIG = 'valid-sig'

const SKU = { good: `${PREFIX}-GOOD`, other: `${PREFIX}-OTHER` }

// Stripe stub: constructEvent parses the raw body back into an event, but only
// when the signature header matches — otherwise it throws like the real SDK.
const makeStripeStub = () => ({
  webhooks: {
    constructEvent: (body, signature) => {
      if (signature !== VALID_SIG) {
        throw new Error(
          'No signatures found matching the expected signature for payload.'
        )
      }
      return JSON.parse(body.toString())
    },
  },
})

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, story)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, 'A test house.')
     RETURNING id`,
    ['Wh Test House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, retail_price_cents, currency, show_on_website)
     VALUES
       ($1, 'Wh Good',  $2, 'finished_good', 4500, 'NZD', true),
       ($1, 'Wh Other', $3, 'finished_good', 2000, 'NZD', true)
     RETURNING id, slug`,
    [brandId, `${PREFIX}-good`, `${PREFIX}-other`]
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
  const otherCw = await cw(`${PREFIX}-other`, SKU.other)

  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 10, 0, 'units'), ($2, 10, 0, 'units')`,
    [goodCw, otherCw]
  )
}

const cleanup = async (pool) => {
  // Orders must go first: order_lines.colourway_id is ON DELETE RESTRICT, so the
  // brand/colourway delete would fail while commerce rows reference them.
  await pool.query('DELETE FROM orders WHERE stripe_session_id LIKE $1', [
    `cs_${PREFIX}%`,
  ])
  await pool.query('DELETE FROM webhook_events WHERE event_id LIKE $1', [
    `evt_${PREFIX}%`,
  ])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const completedEvent = (eventId, sessionId, cart, extra = {}) => ({
  id: eventId,
  type: 'checkout.session.completed',
  data: {
    object: {
      id: sessionId,
      client_reference_id: null,
      customer_details: { email: 'buyer@example.test' },
      metadata: {
        cart: JSON.stringify(cart),
        zone: 'Auckland',
        shipping_cents: '1200',
      },
      ...extra,
    },
  },
})

describe('POST /webhooks/stripe', () => {
  let pool
  let app

  const post = (payload, signature = VALID_SIG) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
      payload,
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
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      stripe: makeStripeStub(),
      stripeWebhookSecret: WEBHOOK_SECRET,
      logger: false,
    })
    await app.ready()
  })

  beforeEach(async () => {
    await cleanup(pool)
    await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  const orderBySession = async (sessionId) => {
    const { rows } = await pool.query(
      'SELECT * FROM orders WHERE stripe_session_id = $1',
      [sessionId]
    )
    return rows
  }

  const availabilityBySku = async (sku) => {
    const { rows } = await pool.query(
      `SELECT i.qty_available
         FROM inventory i
         JOIN colourways c ON c.id = i.colourway_id
        WHERE c.sku = $1`,
      [sku]
    )
    return Number(rows[0].qty_available)
  }

  it('creates a paid checkout order with lines and decrements inventory', async () => {
    const event = completedEvent(`evt_${PREFIX}_1`, `cs_${PREFIX}_1`, [
      { sku: SKU.good, qty: 2 },
      { sku: SKU.other, qty: 1 },
    ])
    const response = await post(event)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ received: true, duplicate: false })

    const orders = await orderBySession(`cs_${PREFIX}_1`)
    expect(orders).toHaveLength(1)
    const order = orders[0]
    expect(order.kind).toBe('checkout')
    expect(order.status).toBe('paid')
    expect(order.guest_email).toBe('buyer@example.test')
    expect(order.subtotal_cents).toBe(4500 * 2 + 2000) // priced server-side
    expect(order.shipping_cents).toBe(1200)
    expect(order.total_cents).toBe(4500 * 2 + 2000 + 1200)

    const { rows: lines } = await pool.query(
      'SELECT * FROM order_lines WHERE order_id = $1 ORDER BY id',
      [order.id]
    )
    expect(lines).toHaveLength(2)

    // Inventory decremented by ordered qty.
    expect(await availabilityBySku(SKU.good)).toBe(8)
    expect(await availabilityBySku(SKU.other)).toBe(9)
  })

  it('stores the delivery address and phone Stripe collected', async () => {
    const event = completedEvent(
      `evt_${PREFIX}_addr`,
      `cs_${PREFIX}_addr`,
      [{ sku: SKU.good, qty: 1 }],
      {
        customer_details: { email: 'buyer@example.test', phone: '+6421555000' },
        collected_information: {
          shipping_details: {
            name: 'Olivia Marlow',
            address: {
              line1: '12 Parnell Road',
              line2: 'Level 2',
              city: 'Auckland',
              state: 'Auckland',
              postal_code: '1052',
              country: 'NZ',
            },
          },
        },
      }
    )
    expect((await post(event)).statusCode).toBe(200)

    const [order] = await orderBySession(`cs_${PREFIX}_addr`)
    expect(order.contact_phone).toBe('+6421555000')
    expect(order.shipping_address).toEqual({
      name: 'Olivia Marlow',
      line1: '12 Parnell Road',
      line2: 'Level 2',
      city: 'Auckland',
      state: 'Auckland',
      postal_code: '1052',
      country: 'NZ',
    })
  })

  it('reads a top-level shipping_details, as older Stripe API versions send it', async () => {
    const event = completedEvent(
      `evt_${PREFIX}_addr_legacy`,
      `cs_${PREFIX}_addr_legacy`,
      [{ sku: SKU.good, qty: 1 }],
      {
        shipping_details: {
          name: 'Legacy Buyer',
          address: { line1: '1 Old Road', city: 'Wellington', country: 'NZ' },
        },
      }
    )
    expect((await post(event)).statusCode).toBe(200)

    const [order] = await orderBySession(`cs_${PREFIX}_addr_legacy`)
    expect(order.shipping_address).toMatchObject({
      name: 'Legacy Buyer',
      line1: '1 Old Road',
      city: 'Wellington',
      country: 'NZ',
    })
    // Absent sub-fields are recorded as null, never dropped or undefined.
    expect(order.shipping_address.postal_code).toBeNull()
  })

  it('records nulls when no delivery details were collected', async () => {
    const event = completedEvent(`evt_${PREFIX}_noaddr`, `cs_${PREFIX}_noaddr`, [
      { sku: SKU.good, qty: 1 },
    ])
    expect((await post(event)).statusCode).toBe(200)

    const [order] = await orderBySession(`cs_${PREFIX}_noaddr`)
    expect(order.shipping_address).toBeNull()
    expect(order.contact_phone).toBeNull()
  })

  it('is idempotent: a replayed event creates nothing', async () => {
    const event = completedEvent(`evt_${PREFIX}_2`, `cs_${PREFIX}_2`, [
      { sku: SKU.good, qty: 3 },
    ])

    const first = await post(event)
    expect(first.json()).toEqual({ received: true, duplicate: false })

    const replay = await post(event)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual({ received: true, duplicate: true })

    // Exactly one order, inventory decremented exactly once.
    expect(await orderBySession(`cs_${PREFIX}_2`)).toHaveLength(1)
    expect(await availabilityBySku(SKU.good)).toBe(7)
  })

  it('links the order to a logged-in user via client_reference_id', async () => {
    const { rows: users } = await pool.query(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, 'x', 'customer') RETURNING id`,
      [`${PREFIX}-buyer@example.test`]
    )
    const userId = users[0].id
    const event = completedEvent(
      `evt_${PREFIX}_3`,
      `cs_${PREFIX}_3`,
      [{ sku: SKU.good, qty: 1 }],
      { client_reference_id: String(userId) }
    )
    await post(event)

    const order = (await orderBySession(`cs_${PREFIX}_3`))[0]
    expect(order.user_id).toBe(userId)
    expect(order.guest_email).toBeNull()

    await pool.query('DELETE FROM orders WHERE stripe_session_id = $1', [
      `cs_${PREFIX}_3`,
    ])
    await pool.query('DELETE FROM users WHERE id = $1', [userId])
  })

  it('rejects an invalid signature with 400 and creates no order', async () => {
    const event = completedEvent(`evt_${PREFIX}_4`, `cs_${PREFIX}_4`, [
      { sku: SKU.good, qty: 1 },
    ])
    const response = await post(event, 'bad-signature')
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/signature/i)

    expect(await orderBySession(`cs_${PREFIX}_4`)).toHaveLength(0)
    expect(await availabilityBySku(SKU.good)).toBe(10)
  })

  it('records non-checkout events without creating an order', async () => {
    const event = {
      id: `evt_${PREFIX}_5`,
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_x' } },
    }
    const response = await post(event)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ received: true, duplicate: false })

    // Replaying it is still idempotent.
    const replay = await post(event)
    expect(replay.json().duplicate).toBe(true)
  })

  it('returns 503 when the webhook secret is not configured', async () => {
    const unconfigured = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      stripe: makeStripeStub(),
      logger: false,
    })
    await unconfigured.ready()
    const response = await unconfigured.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': VALID_SIG, 'content-type': 'application/json' },
      payload: completedEvent(`evt_${PREFIX}_6`, `cs_${PREFIX}_6`, []),
    })
    expect(response.statusCode).toBe(503)
    await unconfigured.close()
  })
})
