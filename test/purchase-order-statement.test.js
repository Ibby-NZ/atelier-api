// The statement that asks a house for ONE consolidated invoice covering several
// purchase orders, sent as a PDF (POST /admin/purchase-orders/statement), and
// the PDF preview the CRM shows first (POST /admin/purchase-orders/pdf).
//
// 25 Sep 2026: "ask for invoice should be merged with bulk purchase orders …
// generate statement creates a PDF and attaches that PDF and sends it as an
// email". This file replaces test/supplier-invoice-statement.test.js, which
// covered the text letter at POST /admin/supplier-invoices/statement.
//
// What is protected here is the REFUSALS and WHO IS WRITTEN TO, not the prose —
// the prose is store-overridable (the CRM's Emails screen), the routing is not.
// A letter asking a house to bill an order it has already billed is not
// recallable, so the checks that stop it are the load-bearing half of this file
// — and the preview runs the same checks, so a preview that draws is a
// statement that will go.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'po-stmt-test'
const DOMAIN = 'po-stmt-test.example.com'
const PASSWORD = 'correct horse battery staple'
const BACKOFFICE = `backoffice@${DOMAIN}`
const PO_EMAIL = `comptabilite@${DOMAIN}`

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const buildMailer = ({ delivers } = {}) => {
  const transport = {
    sent: [],
    sendMail: async (message) => void transport.sent.push(message),
    ...(delivers === undefined ? {} : { delivers }),
  }
  return {
    transport,
    mailer: createMailer({
      transport,
      from: `Atelier <no-reply@${DOMAIN}>`,
      backofficeEmail: BACKOFFICE,
    }),
  }
}

// Allocations before invoices before purchase orders before brands before
// suppliers — every edge out of the join is RESTRICT, and one wrong step
// 23503s the NEXT beforeEach rather than this one.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM supplier_invoice_allocations
      WHERE supplier_invoice_id IN (
        SELECT id FROM supplier_invoices
         WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1))`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM supplier_invoices
      WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM purchase_orders WHERE brand_id IN (SELECT id FROM brands WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM supplier_contact_log
      WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM inventory WHERE colourway_id IN (
       SELECT c.id FROM colourways c JOIN products p ON p.id = c.product_id
         JOIN brands b ON b.id = p.brand_id WHERE b.slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM colourways WHERE product_id IN (
       SELECT p.id FROM products p JOIN brands b ON b.id = p.brand_id WHERE b.slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM products WHERE brand_id IN (SELECT id FROM brands WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

describe('the purchase-order statement and its PDF', () => {
  let pool
  let app
  let transport
  let staffCookie
  let supplierId
  let brandId
  let otherBrandId
  let colourwayId
  let otherColourwayId

  const inject = (method, url, payload, target = app) =>
    target.inject({ method, url, headers: { cookie: staffCookie }, payload })

  const to = (address) => transport.sent.filter((message) => message.to === address)

  const statement = (ids, target) =>
    inject('POST', '/admin/purchase-orders/statement', { purchase_order_ids: ids }, target)
  const preview = (ids, document) =>
    inject('POST', '/admin/purchase-orders/pdf', { purchase_order_ids: ids, ...(document ? { document } : {}) })

  // One house, two maisons — the ordinary shape: W13 groups purchase orders by
  // BRAND, so a statement normally spans more than one of them.
  const createOrder = async ({ brand = brandId, colourway = colourwayId, unitPrice = 25, ready = true } = {}) => {
    const response = await inject('POST', '/admin/purchase-orders', {
      brand_id: brand,
      lines: [{ colourway_id: colourway, qty_ordered: 20, unit_price: unitPrice }],
    })
    expect(response.statusCode).toBe(201)
    const order = response.json().purchase_order
    if (ready) {
      const moved = await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'ready_to_send' })
      expect(moved.statusCode).toBe(200)
    }
    return order
  }

  const makeSupplier = async (suffix, { poEmail = PO_EMAIL } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug, country, currency, po_email)
       VALUES ($1, $2, 'France', 'EUR', $3) RETURNING id`,
      [`${PREFIX} ${suffix}`, `${PREFIX}-${suffix}`, poEmail]
    )
    return rows[0].id
  }

  const makeBrandWithStock = async (suffix, supplier) => {
    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
       VALUES ($1, $2, 'France', 'EUR', true, false, $3) RETURNING id`,
      [`${PREFIX} ${suffix}`, `${PREFIX}-${suffix}`, supplier]
    )
    const { rows: products } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, $2, $3, 'fabric', 'EUR', true) RETURNING id`,
      [brands[0].id, `${PREFIX} ${suffix} design`, `${PREFIX}-${suffix}-design`]
    )
    const { rows: colourways } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ivory', $2) RETURNING id`,
      [products[0].id, `${PREFIX}-${suffix}-SKU`]
    )
    await pool.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, 100, 0, 'metres')`,
      [colourways[0].id]
    )
    return { brandId: brands[0].id, colourwayId: colourways[0].id }
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
    await pool.query(`UPDATE users SET can_view_finance = true WHERE email = $1`, [`staff@${DOMAIN}`])

    supplierId = await makeSupplier('house')
    const otherSupplierId = await makeSupplier('other')
    const first = await makeBrandWithStock('kieffer', supplierId)
    brandId = first.brandId
    colourwayId = first.colourwayId
    const second = await makeBrandWithStock('rival', otherSupplierId)
    otherBrandId = second.brandId
    otherColourwayId = second.colourwayId
  })

  it('names every purchase order on one letter to the house, the statement attached, the office copied', async () => {
    const first = await createOrder()
    const second = await createOrder({ unitPrice: 30 })
    transport.sent.length = 0

    const response = await statement([first.id, second.id])
    expect(response.statusCode).toBe(200)

    const { statement: sentStatement } = response.json()
    expect(sentStatement.purchase_order_count).toBe(2)
    expect(sentStatement.sent).toEqual([PO_EMAIL])
    expect(sentStatement.failed).toEqual([])
    expect(sentStatement.purchase_orders.map((row) => row.po_number)).toEqual([first.po_number, second.po_number])

    expect(to(PO_EMAIL)).toHaveLength(1)
    expect(to(BACKOFFICE)).toHaveLength(1)

    const letter = to(PO_EMAIL)[0]
    expect(letter.text).toContain(first.po_number)
    expect(letter.text).toContain(second.po_number)
    // 20 × 25 + 20 × 30 — the house quoted those prices, so the letter carries
    // them and the total it will be reconciled against.
    expect(letter.text).toContain('1100.00 EUR')
    // Where the bill should come back to.
    expect(letter.text).toContain(BACKOFFICE)
    const [attachment] = letter.attachments
    expect(attachment.filename).toBe(sentStatement.filename)
    expect(attachment.filename).toMatch(/^Statement-.+\.pdf$/)
    expect(attachment.content.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(letter.text).toContain(attachment.filename)

    expect(to(BACKOFFICE)[0].text).toContain(PO_EMAIL)
    expect(to(BACKOFFICE)[0].attachments[0].filename).toBe(attachment.filename)
  })

  // The response is read by whoever pressed the button, and that reader may
  // have no finance grant — so it carries no figure at all.
  it('answers the screen without money, whatever the letter said', async () => {
    const order = await createOrder()
    const response = await statement([order.id])
    const body = response.json().statement
    expect(Object.hasOwn(body, 'total')).toBe(false)
    expect(body.purchase_orders[0]).not.toHaveProperty('total_cost')
  })

  it('records that the office asked, against the house', async () => {
    const order = await createOrder()
    await statement([order.id])

    const log = await inject('GET', `/admin/suppliers/${supplierId}/contact-log`)
    expect(log.statusCode).toBe(200)
    const entries = log.json().entries
    expect(entries).toHaveLength(1)
    expect(entries[0].method).toBe('email')
    expect(entries[0].note).toContain(order.po_number)
    // The session, never the body.
    expect(entries[0].staff_name).toBe('Buyer')
  })

  it('asks for a sent purchase order too — the house may bill after it ships', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'pending_payment' })
    transport.sent.length = 0
    const response = await statement([order.id])
    expect(response.statusCode).toBe(200)
    expect(to(PO_EMAIL)).toHaveLength(1)
  })

  it('refuses the whole statement when one order is already on a bill, naming it', async () => {
    const billed = await createOrder()
    const free = await createOrder()

    const invoice = await inject('POST', '/admin/supplier-invoices', {
      supplier_id: supplierId,
      invoice_number: `${PREFIX}-2291`,
      invoice_date: '2026-09-01',
      total_amount: 500,
    })
    expect(invoice.statusCode).toBe(201)
    await inject('POST', `/admin/supplier-invoices/${invoice.json().supplier_invoice.id}/allocations`, {
      purchase_order_id: billed.id,
    })
    transport.sent.length = 0

    const response = await statement([billed.id, free.id])
    expect(response.statusCode).toBe(409)
    expect(response.json().message).toContain(billed.po_number)
    expect(response.json().message).toContain(`${PREFIX}-2291`)
    // Refused WHOLE: the free order is not quietly sent on its own.
    expect(transport.sent).toHaveLength(0)
  })

  it('refuses orders raised for another house, naming them', async () => {
    const ours = await createOrder()
    const theirs = await createOrder({ brand: otherBrandId, colourway: otherColourwayId })

    const response = await statement([ours.id, theirs.id])
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain(theirs.po_number)
    expect(transport.sent).toHaveLength(0)
  })

  it('refuses a cancelled order — a house will not bill for one Atelier withdrew', async () => {
    const order = await createOrder()
    await inject('POST', `/admin/purchase-orders/${order.id}/status`, { status: 'cancelled' })
    transport.sent.length = 0

    const response = await statement([order.id])
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain(order.po_number)
    expect(transport.sent).toHaveLength(0)
  })

  it('refuses a draft — it is marked Ready to send first', async () => {
    const order = await createOrder({ ready: false })
    const response = await statement([order.id])
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain(order.po_number)
    expect(response.json().message).toMatch(/Ready to send/)
    expect(transport.sent).toHaveLength(0)
  })

  it('refuses when nobody has an address, and says where to add one', async () => {
    // The purchase order snapshots the supplier's PO email when it is raised.
    await pool.query('UPDATE suppliers SET po_email = NULL WHERE id = $1', [supplierId])
    const order = await createOrder()

    const response = await statement([order.id])
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/address/i)
    expect(transport.sent).toHaveLength(0)
  })

  it('refuses an unknown purchase order', async () => {
    const response = await statement([2147483000])
    expect(response.statusCode).toBe(404)
    expect(transport.sent).toHaveLength(0)
  })

  it('names one order once, however many times it is ticked', async () => {
    const order = await createOrder()
    const response = await statement([order.id, order.id])
    expect(response.statusCode).toBe(200)
    expect(response.json().statement.purchase_order_count).toBe(1)
    const letter = to(PO_EMAIL)[0]
    expect(letter.text.split(order.po_number)).toHaveLength(2)
  })

  // The letter IS the act: a relay that delivers nowhere is a 503, never a 200.
  it('refuses when email does not deliver', async () => {
    const silent = buildMailer({ delivers: false })
    const offline = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, mailer: silent.mailer, logger: false })
    await offline.ready()
    try {
      const order = await createOrder()
      const response = await statement([order.id], offline)
      expect(response.statusCode).toBe(503)
      expect(silent.transport.sent).toHaveLength(0)
    } finally {
      await offline.close()
    }
  })

  it('is back-office only', async () => {
    const order = await createOrder()
    for (const url of ['/admin/purchase-orders/statement', '/admin/purchase-orders/pdf']) {
      const anonymous = await app.inject({ method: 'POST', url, payload: { purchase_order_ids: [order.id] } })
      expect(anonymous.statusCode).toBe(401)
    }
    expect(transport.sent).toHaveLength(0)
  })

  describe('the preview', () => {
    it('draws a purchase order as a PDF and sends nothing', async () => {
      const order = await createOrder({ ready: false })
      const response = await preview([order.id])
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toMatch(/^application\/pdf/)
      expect(response.headers['content-disposition']).toContain(`${order.po_number}.pdf`)
      expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(transport.sent).toHaveLength(0)
    })

    it('draws the statement it would send — and refuses it the way the send would', async () => {
      const ready = await createOrder()
      const draft = await createOrder({ ready: false })

      const drawn = await preview([ready.id], 'statement')
      expect(drawn.statusCode).toBe(200)
      expect(drawn.headers['content-disposition']).toMatch(/Statement-/)

      const refused = await preview([ready.id, draft.id], 'statement')
      expect(refused.statusCode).toBe(422)
      expect(refused.json().message).toContain(draft.po_number)
      expect(transport.sent).toHaveLength(0)
    })

    it('refuses to address one document to two houses', async () => {
      const ours = await createOrder()
      const theirs = await createOrder({ brand: otherBrandId, colourway: otherColourwayId })
      const response = await preview([ours.id, theirs.id])
      expect(response.statusCode).toBe(422)
    })

    // A login that may not see costs still reads the quantities; the prices
    // are withheld from its copy, not from the house's.
    it('draws a preview for a login without the finance grant', async () => {
      const order = await createOrder()
      await pool.query(`UPDATE users SET can_view_finance = false WHERE email = $1`, [`staff@${DOMAIN}`])
      const response = await preview([order.id])
      expect(response.statusCode).toBe(200)
      expect(response.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    })
  })
})
