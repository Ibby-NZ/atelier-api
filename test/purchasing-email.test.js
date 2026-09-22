// W13 — the letters a purchase order sends.
//
// What is protected here is WHO is written to and WHEN, not the prose. The
// prose is store-overridable (the CRM's Emails screen); the routing is not, and
// it is the half that cannot be fixed after the fact — a purchase order emailed
// to the wrong house, or a draft emailed at all, is not recallable.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'po-mail-test'
const DOMAIN = 'po-mail-test.example.com'
const PASSWORD = 'correct horse battery staple'
const BACKOFFICE = 'backoffice@po-mail-test.example.com'
const PO_EMAIL = 'commandes@po-mail-test.example.com'

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const buildMailer = () => {
  const transport = { sent: [], sendMail: async (message) => void transport.sent.push(message) }
  return {
    transport,
    mailer: createMailer({
      transport,
      from: 'Atelier <no-reply@po-mail-test.example.com>',
      backofficeEmail: BACKOFFICE,
    }),
  }
}

// Receipts are RESTRICT from the lines, lines cascade from the order, and the
// order is RESTRICT-adjacent to the brand — same order as test/purchasing.js.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM purchase_order_receipts
      WHERE purchase_order_line_id IN (
        SELECT l.id FROM purchase_order_lines l
          JOIN purchase_orders po ON po.id = l.purchase_order_id
          JOIN brands b ON b.id = po.brand_id
         WHERE b.slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM purchase_orders WHERE brand_id IN (SELECT id FROM brands WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

describe('purchase-order notifications', () => {
  let pool
  let app
  let transport
  let staffCookie
  let colourwayId
  let brandId

  const inject = (method, url, payload) =>
    app.inject({ method, url, headers: { cookie: staffCookie }, payload })

  const createOrder = async ({ unitPrice = 42.5 } = {}) => {
    const response = await inject('POST', '/admin/purchase-orders', {
      brand_id: brandId,
      expected_at: '2026-12-01',
      lines: [{ colourway_id: colourwayId, qty_ordered: 40, unit_price: unitPrice }],
    })
    expect(response.statusCode).toBe(201)
    return response.json().purchase_order
  }

  const to = (address) => transport.sent.filter((message) => message.to === address)

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
    const built = buildMailer()
    transport = built.transport
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      mailer: built.mailer,
      logger: false,
    })
    await app.ready()

    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `staff@${DOMAIN}`, password: PASSWORD, name: 'Buyer' },
    })
    staffCookie = cookieOf(staff)
    await pool.query(
      `UPDATE users SET role = 'director', can_view_finance = true WHERE email = $1`,
      [`staff@${DOMAIN}`]
    )
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    transport.sent.length = 0
    await cleanupFixtures(pool)

    const { rows: suppliers } = await pool.query(
      `INSERT INTO suppliers (name, slug, country, currency, agent, incoterm, po_email)
       VALUES ($1, $2, 'France', 'EUR', 'Test Agent', 'FOB', $3)
       RETURNING id`,
      [`${PREFIX} House`, `${PREFIX}-house`, PO_EMAIL]
    )
    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
       VALUES ($1, $2, 'France', 'EUR', true, false, $3)
       RETURNING id`,
      [`${PREFIX} brand`, `${PREFIX}-brand`, suppliers[0].id]
    )
    brandId = brands[0].id
    const { rows: products } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, $2, $3, 'fabric', 'EUR', true) RETURNING id`,
      [brandId, `${PREFIX} design`, `${PREFIX}-design`]
    )
    const { rows: colourways } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ivory', $2) RETURNING id`,
      [products[0].id, `${PREFIX}-SKU`]
    )
    colourwayId = colourways[0].id
    await pool.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, 100, 0, 'metres')`,
      [colourwayId]
    )
  })

  // A draft is the state a purchase order is CREATED in. Nothing has left the
  // building and the person who typed it is looking at it.
  it('sends nothing when a purchase order is created', async () => {
    await createOrder()
    expect(transport.sent).toHaveLength(0)
  })

  it('sends the order to the house and a copy to the back office on send', async () => {
    const order = await createOrder()

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/send`)
    expect(response.statusCode).toBe(200)

    expect(to(PO_EMAIL)).toHaveLength(1)
    expect(to(BACKOFFICE)).toHaveLength(1)

    const supplierLetter = to(PO_EMAIL)[0]
    expect(supplierLetter.subject).toContain(order.po_number)
    expect(supplierLetter.text).toContain(`${PREFIX}-SKU`)
    expect(supplierLetter.text).toContain('Quantity: 40')
    // A purchase order without prices is not a purchase order.
    expect(supplierLetter.text).toContain('42.50')
    expect(supplierLetter.text).toContain('1700.00 EUR')
    expect(supplierLetter.text).toContain('FOB')

    expect(to(BACKOFFICE)[0].text).toContain(PO_EMAIL)
  })

  // Finance masking exists so a staffer does not read costs ON SCREEN. The
  // letter is composed server-side for the house that quoted those prices, so
  // it carries them whoever pressed Send — while the RESPONSE stays masked.
  it('prices the house letter even when the sender cannot see costs', async () => {
    const order = await createOrder()
    await pool.query(`UPDATE users SET role = 'backoffice', can_view_finance = false WHERE email = $1`, [
      `staff@${DOMAIN}`,
    ])

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/send`)
    expect(response.statusCode).toBe(200)
    expect(response.json().purchase_order.lines[0].unit_price).toBeUndefined()
    expect(to(PO_EMAIL)[0].text).toContain('42.50')

    await pool.query(
      `UPDATE users SET role = 'director', can_view_finance = true WHERE email = $1`,
      [`staff@${DOMAIN}`]
    )
  })

  it('tells the house to stop on close, naming the balance it is dropping', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/send`)
    transport.sent.length = 0

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/close`)
    expect(response.statusCode).toBe(200)

    expect(to(PO_EMAIL)).toHaveLength(1)
    const letter = to(PO_EMAIL)[0]
    expect(letter.subject).toContain('closed')
    expect(letter.text).toContain('40 outstanding of 40')
    // Closed short is a DECISION, not a delivery — the letter must never claim
    // the order was completed.
    expect(letter.text).not.toContain('complete')
  })

  it('cancels in full, and says so differently from a close', async () => {
    const order = await createOrder()
    transport.sent.length = 0

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/cancel`)
    expect(response.statusCode).toBe(200)

    expect(to(PO_EMAIL)).toHaveLength(1)
    expect(to(PO_EMAIL)[0].subject).toContain('cancelled')
    expect(to(PO_EMAIL)[0].text).toContain('in full')
  })

  // The status is what a PERSON did; it must not depend on a mail relay, and a
  // house with no address on file is an ordinary state of the data.
  it('still moves the order when the house has no address, and says so to the office', async () => {
    await pool.query('UPDATE suppliers SET po_email = NULL WHERE slug = $1', [`${PREFIX}-house`])
    const order = await createOrder()

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/send`)
    expect(response.statusCode).toBe(200)
    expect(response.json().purchase_order.status).toBe('sent')

    expect(to(PO_EMAIL)).toHaveLength(0)
    expect(to(BACKOFFICE)).toHaveLength(1)
    expect(to(BACKOFFICE)[0].text).toContain('NO ADDRESS ON FILE')
  })

  it('alerts the office on a receipt — and never the house', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/send`)
    transport.sent.length = 0

    const response = await inject(
      'POST',
      `/admin/purchase-order-lines/${order.lines[0].id}/receipts`,
      { qty: 44, consignment_ref: 'CON-1' }
    )
    expect(response.statusCode).toBe(201)

    expect(to(PO_EMAIL)).toHaveLength(0)
    expect(to(BACKOFFICE)).toHaveLength(1)
    const alert = to(BACKOFFICE)[0]
    expect(alert.subject).toContain(order.po_number)
    // Over-receipt is never clamped — the discrepancy is the whole point.
    expect(alert.text).toContain('over')
    expect(alert.text).toContain('CON-1')
  })

  it('is a no-op without a mailer — the routes still work', async () => {
    const bare = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await bare.ready()
    try {
      const created = await bare.inject({
        method: 'POST',
        url: '/admin/purchase-orders',
        headers: { cookie: staffCookie },
        payload: { brand_id: brandId, lines: [{ colourway_id: colourwayId, qty_ordered: 5 }] },
      })
      expect(created.statusCode).toBe(201)
      const sent = await bare.inject({
        method: 'POST',
        url: `/admin/purchase-orders/${created.json().purchase_order.id}/send`,
        headers: { cookie: staffCookie },
      })
      expect(sent.statusCode).toBe(200)
      expect(transport.sent).toHaveLength(0)
    } finally {
      await bare.close()
    }
  })
})
