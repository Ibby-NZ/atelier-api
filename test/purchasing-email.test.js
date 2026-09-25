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
  // Bulk orders are RESTRICT from their supplier and hold nothing once their
  // purchase orders are gone.
  await pool.query(
    `DELETE FROM purchase_order_bulks WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)`,
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

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
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

    // The PDF the CRM previewed rides on the letter (25 Sep 2026).
    const [attachment] = supplierLetter.attachments ?? []
    expect(attachment.filename).toBe(`${order.po_number}.pdf`)
    expect(attachment.contentType).toBe('application/pdf')
    expect(attachment.content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(supplierLetter.text).toContain(`${order.po_number}.pdf`)
  })

  // Ready to send (25 Sep 2026) is the office's own bookkeeping: nothing has
  // gone to the house, so nothing is written to it.
  it('sends nothing when a purchase order is marked ready to send, or taken back', async () => {
    const order = await createOrder()
    const ready = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'ready_to_send' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json().purchase_order.status).toBe('ready_to_send')
    expect(ready.json().purchase_order.ready_at).not.toBeNull()
    const back = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'draft' })
    expect(back.statusCode).toBe(200)
    expect(back.json().purchase_order.status).toBe('draft')
    expect(transport.sent).toHaveLength(0)
  })

  // Finance masking exists so a staffer does not read costs ON SCREEN. The
  // letter is composed server-side for the house that quoted those prices, so
  // it carries them whoever pressed Send — while the RESPONSE stays masked.
  it('prices the house letter even when the sender cannot see costs', async () => {
    const order = await createOrder()
    await pool.query(`UPDATE users SET role = 'backoffice', can_view_finance = false WHERE email = $1`, [
      `staff@${DOMAIN}`,
    ])

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    expect(response.statusCode).toBe(200)
    expect(response.json().purchase_order.lines[0].unit_price).toBeUndefined()
    expect(to(PO_EMAIL)[0].text).toContain('42.50')

    await pool.query(
      `UPDATE users SET role = 'director', can_view_finance = true WHERE email = $1`,
      [`staff@${DOMAIN}`]
    )
  })

  // So the Emails list is no way round the masking: whoever is on it gets
  // those priced letters, so only a staffer who can see costs may change it.
  it('refuses the Emails list to a staffer who cannot see costs', async () => {
    const order = await createOrder()
    await pool.query(`UPDATE users SET role = 'backoffice', can_view_finance = false WHERE email = $1`, [
      `staff@${DOMAIN}`,
    ])
    try {
      const response = await inject('PATCH', `/admin/purchase-orders/${order.id}`, {
        notify_emails: ['me@po-mail-test.example.com'],
      })
      expect(response.statusCode).toBe(403)
      expect(response.json().message).toContain('see costs')
      const { rows } = await pool.query(`SELECT notify_emails FROM purchase_orders WHERE id = $1`, [order.id])
      expect(rows[0].notify_emails).toEqual([])
      // The rest of the purchase order is theirs to edit as before.
      const other = await inject('PATCH', `/admin/purchase-orders/${order.id}`, { notes: 'Rush' })
      expect(other.statusCode).toBe(200)
    } finally {
      await pool.query(`UPDATE users SET role = 'director', can_view_finance = true WHERE email = $1`, [
        `staff@${DOMAIN}`,
      ])
    }
  })

  it('tells the house to stop on a short completion, naming the balance it is dropping', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'paid' })
    transport.sent.length = 0

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'completed' })
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

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'cancelled' })
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

    const response = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    expect(response.statusCode).toBe(200)
    expect(response.json().purchase_order.status).toBe('pending_payment')

    expect(to(PO_EMAIL)).toHaveLength(0)
    expect(to(BACKOFFICE)).toHaveLength(1)
    expect(to(BACKOFFICE)[0].text).toContain('NO ADDRESS ON FILE')
  })

  it('alerts the office on a receipt — and never the house', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
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
        url: `/admin/purchase-orders/${created.json().purchase_order.id}/status`,
        payload: { status: 'pending_payment' },
        headers: { cookie: staffCookie },
      })
      expect(sent.statusCode).toBe(200)
      expect(transport.sent).toHaveLength(0)
    } finally {
      await bare.close()
    }
  })

  // 24 Sep 2026: the purchase order's own Emails list, the sales order's rule.
  it('sends every letter to the house to the purchase order\'s Emails list too', async () => {
    const order = await createOrder()
    const patched = await inject('PATCH', `/admin/purchase-orders/${order.id}`, {
      // One spelling per address: a case variant is the same inbox.
      notify_emails: ['accounts@po-mail-test.example.com', 'ACCOUNTS@po-mail-test.example.com'],
    })
    expect(patched.json().purchase_order.notify_emails).toEqual(['accounts@po-mail-test.example.com'])

    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    expect(to(PO_EMAIL).map((m) => m.subject)).toEqual([expect.stringContaining(order.po_number)])
    expect(to('accounts@po-mail-test.example.com')).toHaveLength(1)

    transport.sent.length = 0
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'paid' })
    expect(to(PO_EMAIL)[0].subject).toContain('paid')
    expect(to('accounts@po-mail-test.example.com')[0].subject).toContain('paid')
    // Awaiting delivery and received are the office's own bookkeeping.
    transport.sent.length = 0
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'awaiting_delivery' })
    expect(transport.sent).toHaveLength(0)
  })

  it('completes in full without writing to the house — there is no balance to drop', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    await inject('POST', `/admin/purchase-order-lines/${order.lines[0].id}/receipts`, { qty: 40 })
    transport.sent.length = 0
    const completed = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'completed' })
    expect(completed.statusCode).toBe(200)
    expect(to(PO_EMAIL)).toHaveLength(0)
  })

  // The Emails panel's buttons: the purchase order itself, or the letter for
  // where it stands — "email function like sales order".
  it('re-sends the purchase order or its status letter from the Emails panel', async () => {
    const order = await createOrder()
    const early = await inject('POST', `/admin/purchase-orders/${order.id}/email`, { letter: 'details' })
    expect(early.statusCode).toBe(409)
    // Ready to send has not gone to the house either.
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'ready_to_send' })
    const ready = await inject('POST', `/admin/purchase-orders/${order.id}/email`, { letter: 'details' })
    expect(ready.statusCode).toBe(409)
    expect(transport.sent).toHaveLength(0)

    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    transport.sent.length = 0
    const details = await inject('POST', `/admin/purchase-orders/${order.id}/email`, { letter: 'details' })
    expect(details.statusCode).toBe(200)
    expect(details.json()).toEqual({ template: 'purchase_order_sent', sent: [PO_EMAIL], failed: [] })
    expect(to(PO_EMAIL)[0].text).toContain('42.50')
    expect(to(PO_EMAIL)[0].attachments[0].filename).toBe(`${order.po_number}.pdf`)

    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'awaiting_delivery' })
    const none = await inject('POST', `/admin/purchase-orders/${order.id}/email`, { letter: 'status' })
    expect(none.statusCode).toBe(422)
  })

  // The Bulk orders tab: ONE letter to a house for several purchase orders.
  describe('bulk orders', () => {
    const bulk = (ids) => inject('POST', '/admin/purchase-orders/bulk', { purchase_order_ids: ids })
    // A bulk order takes purchase orders marked Ready to send (25 Sep 2026).
    const readyOrder = async (options) => {
      const order = await createOrder(options)
      const moved = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'ready_to_send' })
      expect(moved.statusCode).toBe(200)
      return order
    }

    it('sends several ready purchase orders to their house as ONE letter, each under its own PO number', async () => {
      const first = await readyOrder()
      const second = await readyOrder({ unitPrice: 10 })
      transport.sent.length = 0

      const response = await bulk([first.id, second.id])
      expect(response.statusCode).toBe(201)
      const { bulk_order: bulkOrder } = response.json()
      expect(bulkOrder.bulk_number).toMatch(/^BULK-\d{6}$/)
      expect(bulkOrder.purchase_orders.map((po) => po.status)).toEqual(['pending_payment', 'pending_payment'])
      expect(bulkOrder.purchase_orders.every((po) => po.bulk_order.id === bulkOrder.id)).toBe(true)
      // Members read upward, in the order they were raised.
      expect(bulkOrder.purchase_orders.map((po) => po.po_number)).toEqual([first.po_number, second.po_number])

      const [letter] = to(PO_EMAIL)
      expect(to(PO_EMAIL)).toHaveLength(1)
      expect(letter.subject).toContain(`${bulkOrder.bulk_number} (${first.po_number}, ${second.po_number})`)
      expect(letter.text).toContain(first.po_number)
      expect(letter.text).toContain(second.po_number)
      // The bulk order's PDF — the document the CRM previewed — rides on it.
      expect(letter.attachments[0].filename).toBe(`${bulkOrder.bulk_number}.pdf`)
      expect(letter.attachments[0].content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      // The office's record is the same letter.
      expect(to(BACKOFFICE)[0].subject).toBe(letter.subject)
      expect(to(BACKOFFICE)[0].attachments[0].filename).toBe(`${bulkOrder.bulk_number}.pdf`)

      const read = await inject('GET', `/admin/purchase-orders/bulk/${bulkOrder.id}`)
      expect(read.json().bulk_order.purchase_orders).toHaveLength(2)
      const list = await inject('GET', '/admin/purchase-orders/bulk')
      expect(list.json().bulk_orders[0]).toMatchObject({
        bulk_number: bulkOrder.bulk_number,
        po_numbers: [first.po_number, second.po_number],
      })
    })

    it('refuses a purchase order that has already gone to the house, and sends nothing', async () => {
      const first = await readyOrder()
      const second = await createOrder()
      await inject('POST', `/admin/purchase-orders/${second.id}/status`, { status: 'pending_payment' })
      transport.sent.length = 0

      const response = await bulk([first.id, second.id])
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toContain(second.po_number)
      expect(transport.sent).toHaveLength(0)
      const { rows } = await pool.query(`SELECT status, bulk_order_id FROM purchase_orders WHERE id = $1`, [first.id])
      expect(rows[0]).toEqual({ status: 'ready_to_send', bulk_order_id: null })
    })

    // A draft is still being written: marking it Ready to send is what puts it
    // on the Bulk purchase orders tab.
    it('refuses a draft, naming it, and sends nothing', async () => {
      const ready = await readyOrder()
      const draft = await createOrder()
      transport.sent.length = 0

      const response = await bulk([ready.id, draft.id])
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toContain(draft.po_number)
      expect(response.json().message).toMatch(/Ready to send/)
      expect(transport.sent).toHaveLength(0)
    })

    it('refuses to mix suppliers in one bulk', async () => {
      const first = await readyOrder()
      const { rows: suppliers } = await pool.query(
        `INSERT INTO suppliers (name, slug, currency, po_email) VALUES ($1, $2, 'GBP', 'other@po-mail-test.example.com') RETURNING id`,
        [`${PREFIX} Other`, `${PREFIX}-other`]
      )
      const { rows: brands } = await pool.query(
        `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
         VALUES ($1, $2, 'UK', 'GBP', true, false, $3) RETURNING id`,
        [`${PREFIX} other brand`, `${PREFIX}-other-brand`, suppliers[0].id]
      )
      const other = await inject('POST', '/admin/purchase-orders', {
        brand_id: brands[0].id,
        lines: [{ colourway_id: colourwayId, qty_ordered: 5 }],
      })
      const otherId = other.json().purchase_order.id
      await inject('POST', `/admin/purchase-orders/${otherId}/status`, { status: 'ready_to_send' })
      const response = await bulk([first.id, otherId])
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/ONE supplier/)
    })
  })
})
