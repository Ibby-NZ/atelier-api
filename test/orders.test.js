import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'

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
    expect(order.status).toBe('quote_requested')
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
    // The client sees no price until the office sends the quote; the
    // indicative figure is stored for the CRM.
    expect(order.lines[0]).not.toHaveProperty('unit_price_cents')

    const lines = await lineRows(pool, order.id)
    expect(lines[0].unit_price_cents).toBe(RETAIL_CENTS)
    expect((await orderRow(pool, order.id)).price_type).toBe('retail')

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
    const [line] = await lineRows(pool, response.json().order.id)
    expect(line.unit_price_cents).toBe(TRADE_CENTS)

    const row = await orderRow(pool, response.json().order.id)
    expect(row.total_cents).toBe(TRADE_CENTS * 2)
    // The order states the basis its lines were priced on, so a line the office
    // adds later is picked up on the same one.
    expect(row.price_type).toBe('trade')
  })

  it('leaves a design the catalogue does not price at 0', async () => {
    const response = await post({
      lines: [{ sku: SKU.short, qty_metres: 20 }],
      contact: { email: 'guest@example.com' },
      accepted_lead_time: true,
    })
    expect(response.statusCode).toBe(201)
    const { order } = response.json()
    expect((await lineRows(pool, order.id))[0].unit_price_cents).toBe(0)

    const row = await orderRow(pool, order.id)
    expect(row.subtotal_cents).toBe(0)
  })
})

// The client's answer to a quote (24 Sep 2026). The office sends the quote from
// the CRM; the letter carries a signed link a guest answers from, and a
// signed-in client can answer from My Account. The token is read from the
// captured letter — never from the database, which holds only its hash.
//
// A fresh app per case: the public quote routes are rate limited (10 / 15 min
// per IP, per route, per app instance), and so is register.
describe('the client answers a quote', () => {
  let pool
  let app
  let sent
  let staffCookie

  const inject = (method, url, { cookie, payload } = {}) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const tokenFrom = (letter) => letter.text.match(/quote\?token=([A-Za-z0-9_-]+)/)[1]

  // A guest's request for the in-stock (catalogue-priced) design, quoted by
  // the office. Returns the order and the raw token from the quote letter.
  const quotedRequest = async ({ cookie } = {}) => {
    const placed = await inject('POST', '/orders/request', {
      cookie,
      payload: {
        lines: [{ sku: SKU.inStock, qty_metres: 2 }],
        ...(cookie ? {} : { contact: { email: `${PREFIX}-guest@example.com` } }),
      },
    })
    expect(placed.statusCode).toBe(201)
    const order = placed.json().order
    const quoted = await inject('POST', `/admin/orders/${order.id}/status`, {
      cookie: staffCookie,
      payload: { status: 'quote_sent' },
    })
    expect(quoted.statusCode).toBe(200)
    const letter = sent.find((message) => message.subject.includes('your quote for'))
    return { order, token: tokenFrom(letter) }
  }

  const eventsFor = async (id) =>
    (
      await pool.query(
        `SELECT to_status, actor_kind, actor_user_id, note FROM order_events
          WHERE order_id = $1 ORDER BY id`,
        [id]
      )
    ).rows

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
    await cleanup(pool)
    await seedFixtures(pool)
    sent = []
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      storeBaseUrl: 'https://store.test',
      mailer: createMailer({
        transport: { sendMail: async (message) => sent.push(message) },
        from: 'Atelier <no-reply@test.example>',
        backofficeEmail: 'office@test.example',
      }),
    })
    await app.ready()
    staffCookie = await registerCookie(app, `${PREFIX}-staff@example.com`)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `${PREFIX}-staff@example.com`,
    ])
  })

  afterEach(async () => {
    await app.close()
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  it('accepts by the emailed link, once, and tells the office', async () => {
    const { order, token } = await quotedRequest()

    // The link lands on the storefront, and the table holds only its hash.
    const letter = sent.find((message) => message.subject.includes('your quote for'))
    expect(letter.text).toContain(`https://store.test/quote?token=${token}`)
    const row = await orderRow(pool, order.id)
    expect(row.quote_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.quote_token_hash).not.toBe(token)

    const view = await inject('GET', `/orders/quote/${token}`)
    expect(view.statusCode).toBe(200)
    expect(view.json().order).toMatchObject({ order_number: order.order_number, status: 'quote_sent' })
    // The customer shape: none of the office's own fields.
    expect(view.json().order.notes).toBeUndefined()
    expect(view.json().order.events).toBeUndefined()

    sent.length = 0
    const accept = await inject('POST', `/orders/quote/${token}/accept`)
    expect(accept.statusCode).toBe(200)
    expect(accept.json().order.status).toBe('quote_accepted')
    expect((await eventsFor(order.id)).at(-1)).toEqual({
      to_status: 'quote_accepted',
      actor_kind: 'customer',
      actor_user_id: null,
      note: null,
    })
    const alert = sent.find((message) => message.to === 'office@test.example')
    expect(alert.subject).toBe(`Quote accepted: ${order.order_number}`)
    expect(alert.replyTo).toBe(`${PREFIX}-guest@example.com`)
    // The client did it — no letter to them.
    expect(sent.some((message) => message.to === `${PREFIX}-guest@example.com`)).toBe(false)

    const again = await inject('POST', `/orders/quote/${token}/accept`)
    expect(again.statusCode).toBe(409)
  })

  it('rejects by the link only with a reason, which the office then sees', async () => {
    const { order, token } = await quotedRequest()

    const blank = await inject('POST', `/orders/quote/${token}/reject`, {
      payload: { reason: '   ' },
    })
    expect(blank.statusCode).toBe(422)
    expect(blank.json().errors).toEqual([
      { field: 'reason', message: 'Tell us why so we can re-quote.' },
    ])
    expect((await orderRow(pool, order.id)).status).toBe('quote_sent')

    sent.length = 0
    const reject = await inject('POST', `/orders/quote/${token}/reject`, {
      payload: { reason: '  Too dear for this job  ' },
    })
    expect(reject.statusCode).toBe(200)
    expect(reject.json().order.status).toBe('quote_rejected')

    const admin = await inject('GET', `/admin/orders/${order.id}`, { cookie: staffCookie })
    expect(admin.json().order.quote_rejection_reason).toBe('Too dear for this job')
    const alert = sent.find((message) => message.to === 'office@test.example')
    expect(alert.subject).toBe(`Quote rejected: ${order.order_number}`)
    expect(alert.text).toContain('Reason: Too dear for this job')

    // A made-up token matches nothing.
    expect((await inject('GET', '/orders/quote/not-a-real-token')).statusCode).toBe(404)
    expect((await inject('POST', '/orders/quote/not-a-real-token/accept')).statusCode).toBe(404)
  })

  it('a re-quote rotates the link and clears the rejection once accepted', async () => {
    const { order, token } = await quotedRequest()
    await inject('POST', `/orders/quote/${token}/reject`, { payload: { reason: 'Wrong colour' } })

    sent.length = 0
    const requote = await inject('POST', `/admin/orders/${order.id}/status`, {
      cookie: staffCookie,
      payload: { status: 'quote_sent' },
    })
    expect(requote.statusCode).toBe(200)
    // Still shown while the new quote is out — it is what the office re-quoted from.
    expect(requote.json().order.quote_rejection_reason).toBe('Wrong colour')
    const fresh = tokenFrom(sent.find((message) => message.subject.includes('your quote for')))
    expect(fresh).not.toBe(token)
    expect((await inject('GET', `/orders/quote/${token}`)).statusCode).toBe(404)

    await inject('POST', `/orders/quote/${fresh}/accept`)
    const admin = await inject('GET', `/admin/orders/${order.id}`, { cookie: staffCookie })
    expect(admin.json().order.quote_rejection_reason).toBeNull()
  })

  it('answers from My Account for the owner only', async () => {
    const ownerCookie = await registerCookie(app, `${PREFIX}-owner@example.com`)
    const otherCookie = await registerCookie(app, `${PREFIX}-other@example.com`)
    const { order } = await quotedRequest({ cookie: ownerCookie })

    const stranger = await inject('POST', `/orders/mine/${order.order_number}/accept`, {
      cookie: otherCookie,
    })
    expect(stranger.statusCode).toBe(404)
    expect((await inject('POST', `/orders/mine/${order.order_number}/accept`)).statusCode).toBe(
      401
    )

    const reject = await inject('POST', `/orders/mine/${order.order_number}/reject`, {
      cookie: ownerCookie,
      payload: { reason: 'Need it sooner' },
    })
    expect(reject.statusCode).toBe(200)
    expect(reject.json().order.status).toBe('quote_rejected')
    const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
      `${PREFIX}-owner@example.com`,
    ])
    expect((await eventsFor(order.id)).at(-1)).toEqual({
      to_status: 'quote_rejected',
      actor_kind: 'customer',
      actor_user_id: rows[0].id,
      note: 'Need it sooner',
    })
  })
})
