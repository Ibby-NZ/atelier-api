import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'ord-test'

const SKU = {
  inStock: `${PREFIX}-INSTOCK`,
  short: `${PREFIX}-SHORT`,
}

const PASSWORD = 'super-secret-pw'

// The in-stock design is priced on both bases; the short one is priced on
// neither, which is the ordinary case for fabric (the office quotes it per job)
// and the reason an unpriced request line still has to be allowed.
const RETAIL_CENTS = 4500
const TRADE_CENTS = 3000

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Ord Test House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, currency, show_on_website,
        retail_price_cents, trade_price_cents)
     VALUES
       ($1, 'Ord InStock', $2, 'fabric', 'NZD', true, $4, $5),
       ($1, 'Ord Short',   $3, 'fabric', 'NZD', true, NULL, NULL)
     RETURNING id, slug`,
    [brandId, `${PREFIX}-instock`, `${PREFIX}-short`, RETAIL_CENTS, TRADE_CENTS]
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
  const inStockCw = await cw(`${PREFIX}-instock`, SKU.inStock)
  const shortCw = await cw(`${PREFIX}-short`, SKU.short)

  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 60, 0, 'metres'),
            ($2, 5, 0, 'metres')`,
    [inStockCw, shortCw]
  )
}

// Orders reference colourways with ON DELETE RESTRICT, so delete the orders that
// point at our fixtures BEFORE dropping the fixture brand/colourways.
const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM orders
      WHERE id IN (
        SELECT ol.order_id FROM order_lines ol
          JOIN colourways c ON c.id = ol.colourway_id
         WHERE c.sku LIKE $1
      )`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const orderRow = async (pool, id) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id])
  return rows[0]
}

const lineRows = async (pool, orderId) => {
  const { rows } = await pool.query(
    'SELECT qty, unit_price_cents FROM order_lines WHERE order_id = $1 ORDER BY id',
    [orderId]
  )
  return rows
}

// Register shares a 10-per-15-min-per-IP bucket with login and the store is per
// app instance, so a test registers at most one account and only when it needs
// a session.
const registerCookie = async (app, email) => {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, name: 'Ord Client' },
  })
  expect(response.statusCode).toBe(201)
  const setCookie = response.headers['set-cookie']
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
}

const reservedFor = async (pool, sku) => {
  const { rows } = await pool.query(
    `SELECT i.qty_reserved
       FROM inventory i JOIN colourways c ON c.id = i.colourway_id
      WHERE c.sku = $1`,
    [sku]
  )
  return Number(rows[0].qty_reserved)
}

describe('POST /orders/request', () => {
  let pool
  let app

  const post = (payload, headers = {}) =>
    app.inject({ method: 'POST', url: '/orders/request', payload, headers })

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
  })

  beforeEach(async () => {
    // Fresh fixtures each test so reservation counts start from a known state.
    await cleanup(pool)
    await seedFixtures(pool)
    // Fresh APP each test too: POST /orders/request is rate limited to 10 per
    // 15 min per IP and the limiter store is per app instance, so one shared
    // instance runs the bucket dry part-way down the file and every later test
    // 429s. Per-test instances keep that a property of the route, not a cap on
    // how many cases this suite may hold.
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  it('creates an order_request and reserves stock when in stock', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 12, cut_requirements: 'One 12m cut' }],
      contact: { name: 'Ada', email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect(order.kind).toBe('order_request')
    expect(order.status).toBe('requested')
    expect(order.order_number).toMatch(/^REQ-/)
    expect(order.lines[0].cut_requirements).toBe('One 12m cut')

    expect(await reservedFor(pool, SKU.inStock)).toBe(12)
  })

  it('creates a backorder_request when short and lead time is accepted', async () => {
    const response = await post({
      lines: [{ sku: SKU.short, qty_metres: 20 }],
      contact: { email: 'guest@example.com' },
      accepted_lead_time: true,
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect(order.kind).toBe('backorder_request')
    expect(order.order_number).toMatch(/^BO-/)
    // The demand is still reserved against the (short) inventory row.
    expect(await reservedFor(pool, SKU.short)).toBe(20)
  })

  it('rejects a short request without accepted lead time (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.short, qty_metres: 20 }],
      contact: { email: 'guest@example.com' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/lead time/i)
    // Nothing reserved when the request is rejected.
    expect(await reservedFor(pool, SKU.short)).toBe(0)
  })

  it('rejects qty_metres <= 0 with a field message (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 0 }],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'lines[0].qty_metres' })
    )
  })

  it('requires an email for guest requests (422)', async () => {
    const response = await post({ lines: [{ sku: SKU.inStock, qty_metres: 5 }] })
    expect(response.statusCode).toBe(422)
    expect(response.json().errors).toContainEqual(
      expect.objectContaining({ field: 'contact.email' })
    )
  })

  it('rejects an invalid email (422)', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 5 }],
      contact: { email: 'not-an-email' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().errors).toContainEqual(
      expect.objectContaining({ field: 'contact.email' })
    )
  })

  it('rejects an unknown SKU (422)', async () => {
    const response = await post({
      lines: [{ sku: 'no-such-sku', qty_metres: 5 }],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/no product/i)
  })

  it('rejects an empty lines array by schema (400)', async () => {
    const response = await post({
      lines: [],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('links the order to a logged-in user (no guest email needed)', async () => {
    const cookie = await registerCookie(app, `${PREFIX}-user@example.com`)

    const response = await post(
      { lines: [{ sku: SKU.inStock, qty_metres: 8 }] },
      { cookie }
    )
    expect(response.statusCode).toBe(201)
    const { order } = response.json()

    const { rows } = await pool.query(
      'SELECT user_id, guest_email FROM orders WHERE id = $1',
      [order.id]
    )
    expect(rows[0].user_id).not.toBeNull()
    expect(rows[0].guest_email).toBeNull()
  })

  it('stores the phone in its own column, not in the notes line', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 3 }],
      contact: { name: 'Ada', email: 'ada@example.com', phone: '021 555 0100' },
      client_reference: 'Drawing room',
      customer_po_number: 'PO-99812',
    })
    expect(response.statusCode).toBe(201)

    const row = await orderRow(pool, response.json().order.id)
    expect(row.contact_phone).toBe('021 555 0100')
    // A guest's name is the one contact detail with no column of its own; the
    // email is in guest_email, so it no longer clutters the note.
    expect(row.notes).toBe('Name: Ada')
    expect(row.notes).not.toMatch(/Phone|Email/i)
    expect(row.client_reference).toBe('Drawing room')
    expect(row.customer_po_number).toBe('PO-99812')
  })

  // The office opened a request and found the Notes box full of "Name: … |
  // Email: …" and no note, and the Delivery block saying "No address
  // collected" because the form never asked (Userback 8373461).
  it('keeps the client\'s own note first and stores a delivery address in the checkout shape', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 3 }],
      contact: { name: 'Ada', email: 'ada@example.com' },
      notes: 'Please match the batch to the sample we hold.',
      shipping_address: {
        name: ' Ada Lovelace ',
        line1: '12 Analytical Lane',
        line2: '',
        city: 'Auckland',
        postal_code: '1010',
        country: 'New Zealand',
      },
    })
    expect(response.statusCode).toBe(201)
    const row = await orderRow(pool, response.json().order.id)
    expect(row.notes).toBe('Please match the batch to the sample we hold.\nName: Ada')
    expect(row.shipping_address).toEqual({
      name: 'Ada Lovelace',
      line1: '12 Analytical Lane',
      line2: null,
      city: 'Auckland',
      state: null,
      postal_code: '1010',
      country: 'New Zealand',
    })
  })

  it('stores no address for a form that names nowhere, and packs nothing for a signed-in client', async () => {
    const cookie = await registerCookie(app, `${PREFIX}-noted@example.com`)
    const response = await post(
      {
        lines: [{ sku: SKU.inStock, qty_metres: 2 }],
        contact: { name: 'Signed In' },
        notes: '  ',
        shipping_address: { name: 'Just a name', line1: '', city: ' ' },
      },
      { cookie }
    )
    expect(response.statusCode).toBe(201)
    const row = await orderRow(pool, response.json().order.id)
    expect(row.notes).toBeNull()
    expect(row.shipping_address).toBeNull()
  })

  it('folds blank client numbers to null rather than storing empty strings', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 3 }],
      contact: { email: 'ada@example.com', phone: '   ' },
      client_reference: '   ',
      customer_po_number: '',
    })
    expect(response.statusCode).toBe(201)

    const row = await orderRow(pool, response.json().order.id)
    expect(row.contact_phone).toBeNull()
    expect(row.client_reference).toBeNull()
    expect(row.customer_po_number).toBeNull()
  })

  it('remembers a signed-in client\'s phone for the next request', async () => {
    const email = `${PREFIX}-phone@example.com`
    const cookie = await registerCookie(app, email)

    const response = await post(
      {
        lines: [{ sku: SKU.inStock, qty_metres: 2 }],
        contact: { phone: '021 555 0199' },
      },
      { cookie }
    )
    expect(response.statusCode).toBe(201)

    const { rows } = await pool.query('SELECT phone FROM users WHERE email = $1', [
      email,
    ])
    expect(rows[0].phone).toBe('021 555 0199')
  })

  it('prices lines at the catalogue retail figure and totals the order', async () => {
    const response = await post({
      lines: [{ sku: SKU.inStock, qty_metres: 4 }],
      contact: { email: 'ada@example.com' },
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect(order.lines[0].unit_price_cents).toBe(RETAIL_CENTS)

    const lines = await lineRows(pool, order.id)
    expect(lines[0].unit_price_cents).toBe(RETAIL_CENTS)

    const row = await orderRow(pool, order.id)
    expect(row.subtotal_cents).toBe(RETAIL_CENTS * 4)
    // Nothing is shipped from a request, so the total is the subtotal.
    expect(row.shipping_cents).toBe(0)
    expect(row.total_cents).toBe(RETAIL_CENTS * 4)
  })

  it('prices an approved trade client at the trade figure', async () => {
    const email = `${PREFIX}-trade@example.com`
    const cookie = await registerCookie(app, email)
    await pool.query(
      `UPDATE users SET role = 'trade', trade_approved = true WHERE email = $1`,
      [email]
    )

    const response = await post(
      { lines: [{ sku: SKU.inStock, qty_metres: 2 }] },
      { cookie }
    )
    expect(response.statusCode).toBe(201)
    expect(response.json().order.lines[0].unit_price_cents).toBe(TRADE_CENTS)

    const row = await orderRow(pool, response.json().order.id)
    expect(row.total_cents).toBe(TRADE_CENTS * 2)
  })

  it('leaves a design the catalogue does not price at 0', async () => {
    const response = await post({
      lines: [{ sku: SKU.short, qty_metres: 20 }],
      contact: { email: 'guest@example.com' },
      accepted_lead_time: true,
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect(order.lines[0].unit_price_cents).toBe(0)

    const row = await orderRow(pool, order.id)
    expect(row.subtotal_cents).toBe(0)
  })
})
