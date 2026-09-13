import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { renderTemplate, TEMPLATE_NAMES } from '../src/email/templates.js'
import { createMailer } from '../src/email/mailer.js'
import { createMailTransport } from '../src/email/transport.js'
import { resolveOrderRecipient } from '../src/email/recipients.js'
import {
  notifyRequestReceived,
  notifyCheckoutReceipt,
  notifyOrderTransition,
  notifyOrderCreated,
  notifyBackofficeNewOrder,
  notifyTradeApplicationReceived,
} from '../src/email/notifications.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const FROM = 'Atelier <no-reply@test.example>'
const BACKOFFICE = 'orders@test.example'

// A transport that records every message instead of sending it.
const captureTransport = () => {
  const sent = []
  return {
    sent,
    sendMail: async (message) => {
      sent.push(message)
      return { messageId: 'captured' }
    },
  }
}

const buildMailer = (transport = captureTransport()) => ({
  transport,
  mailer: createMailer({ transport, from: FROM, backofficeEmail: BACKOFFICE }),
})

describe('email templates', () => {
  it('exposes the lifecycle + contact templates', () => {
    expect(TEMPLATE_NAMES).toEqual(
      expect.arrayContaining([
        'request_received',
        'backoffice_new_request',
        'checkout_receipt',
        'order_confirmed',
        // The confirm transition's own message, distinct from the creation
        // confirmation above (W12 US-005).
        'order_invoiced',
        'payment_received',
        'shipped',
        'contact_received',
        'backoffice_new_contact',
        // The trade portal's invoice-copy request (both halves).
        'backoffice_invoice_copy_request',
        'invoice_copy_requested',
        // The set letter behind an overdue-sample reminder (W20-US-007). It is
        // the first template here that a STORED row may override
        // (src/email/template-store.js) — and the code copy stays, because the
        // override falls back to it.
        'sample_loan_reminder',
        // The emailed reset link (forgot password, and the back office's reset).
        'password_reset',
        // The acceptance letter, store-backed too, sent on trade approval.
        'trade_application_approved',
        // The back office's alert that an application is waiting for review.
        'backoffice_new_trade_application',
      ])
    )
    // The count is the tripwire: arrayContaining passes on a superset, so
    // without it a template added and never listed above goes unnoticed.
    expect(TEMPLATE_NAMES).toHaveLength(15)
  })

  it('backoffice_new_trade_application names the business and links the CRM applicants tab', () => {
    const { subject, text } = renderTemplate('backoffice_new_trade_application', {
      business_name: 'Studio Interiors Ltd',
      business_type: 'limited_liability_company',
      signatory_name: 'Alex Designer',
      email: 'alex@studio.example',
      review_url: 'http://crm.example/#/clients/applicants',
    })
    expect(subject).toBe('New trade application to review: Studio Interiors Ltd')
    expect(text).toContain('Business: Studio Interiors Ltd')
    expect(text).toContain('Signatory: Alex Designer')
    expect(text).toContain('Login email: alex@studio.example')
    expect(text).toContain('http://crm.example/#/clients/applicants')
  })

  it('trade_application_approved is the office acceptance letter, addressed by name', () => {
    const { subject, text } = renderTemplate('trade_application_approved', { name: 'Alex Designer' })
    expect(subject).toContain('approved')
    expect(text).toContain('Dear Alex Designer,')
    expect(text).toContain('approved on a cash account basis')
    expect(text).toContain('16 Yorks Street, Parnell, Auckland 1052')
    expect(text).toContain('282 Thorndon Quay, Pipitea, Wellington 6011')
    expect(text).toContain('323 Madras Street, Christchurch Central 8013')
    expect(text).toContain('sales@atelier.co.nz')
    expect(text.trim().endsWith('The Atelier Team')).toBe(true)
  })

  it('request_received names the order and promises contact within 24 hours', () => {
    const { subject, text } = renderTemplate('request_received', {
      order_number: 'REQ-ABCD1234',
    })
    expect(subject).toContain('REQ-ABCD1234')
    expect(text).toContain('REQ-ABCD1234')
    expect(text).toContain('24 hours')
  })

  it('backoffice_new_request carries the kind and customer email', () => {
    const { subject, text } = renderTemplate('backoffice_new_request', {
      order_number: 'BO-1111',
      kind: 'backorder_request',
      customer_email: 'buyer@test.example',
    })
    expect(subject).toContain('BO-1111')
    expect(subject).toContain('backorder_request')
    expect(text).toContain('buyer@test.example')
  })

  it('checkout_receipt renders the paid amount as NZ dollars', () => {
    const { text } = renderTemplate('checkout_receipt', {
      order_number: 'WEB-cs_123',
      total_cents: 12500,
    })
    expect(text).toContain('WEB-cs_123')
    expect(text).toContain('$125.00 NZD')
  })

  it('order_confirmed shows the Xero invoice reference', () => {
    const { text } = renderTemplate('order_confirmed', {
      order_number: 'REQ-9',
      xero_invoice_ref: 'INV-0042',
    })
    expect(text).toContain('REQ-9')
    expect(text).toContain('INV-0042')
  })

  // Two events, two messages (FR-121). If these ever render the same body, a
  // confirmed order sends the client the creation mail a second time.
  it('order_invoiced is a different message from order_confirmed', () => {
    const data = { order_number: 'SO-ABCD1234', xero_invoice_ref: 'INV-7' }
    const created = renderTemplate('order_confirmed', data)
    const invoiced = renderTemplate('order_invoiced', data)
    expect(invoiced.subject).not.toBe(created.subject)
    expect(invoiced.text).not.toBe(created.text)
    expect(invoiced.text).toContain('SO-ABCD1234')
    expect(invoiced.text).toContain('INV-7')
  })

  it('payment_received and shipped name the order', () => {
    expect(renderTemplate('payment_received', { order_number: 'REQ-7' }).text).toContain(
      'REQ-7'
    )
    expect(renderTemplate('shipped', { order_number: 'REQ-7' }).text).toContain('REQ-7')
  })

  it('throws on an unknown template name', () => {
    expect(() => renderTemplate('nope', {})).toThrow(/Unknown email template/)
  })
})

describe('createMailTransport', () => {
  it('without SMTP_HOST captures the letter, prints it, and says it does not deliver', async () => {
    const warnings = []
    const transport = createMailTransport({ smtpHost: null }, { warn: (line) => warnings.push(line) })
    expect(transport.delivers).toBe(false)
    expect(warnings[0]).toMatch(/SMTP_HOST unset/)

    const mailer = createMailer({ transport, from: FROM, backofficeEmail: BACKOFFICE })
    expect(mailer.delivers).toBe(false)
    const result = await mailer.send({
      subject: 'Reset your password',
      to: 'someone@test.example',
      text: 'Choose a new password here: https://store.test/reset-password?token=abc',
    })
    expect(result.ok).toBe(true)
    // The letter is in the log, link included — the only place it goes.
    expect(warnings[1]).toContain('To: someone@test.example')
    expect(warnings[1]).toContain('https://store.test/reset-password?token=abc')
  })

  it('with SMTP_HOST set builds a delivering transport', () => {
    const transport = createMailTransport({ smtpHost: 'smtp.test', smtpPort: 587 }, { warn: () => {} })
    expect(transport.delivers).toBe(true)
    expect(typeof transport.sendMail).toBe('function')
  })

  it("a transport that does not say counts as delivering", () => {
    const { mailer } = buildMailer()
    expect(mailer.delivers).toBe(true)
  })
})

describe('mailer', () => {
  it('sends a rendered message to the transport with from/to/subject/text', async () => {
    const { transport, mailer } = buildMailer()
    const result = await mailer.send({
      template: 'payment_received',
      to: 'buyer@test.example',
      data: { order_number: 'REQ-1' },
    })
    expect(result.ok).toBe(true)
    expect(transport.sent).toHaveLength(1)
    const msg = transport.sent[0]
    expect(msg).toMatchObject({ from: FROM, to: 'buyer@test.example' })
    expect(msg.subject).toContain('REQ-1')
    expect(msg.text).toContain('REQ-1')
  })

  it('sets Reply-To only when asked, so a no-reply sender never swallows a staff answer', async () => {
    const { transport, mailer } = buildMailer()
    await mailer.send({ subject: 's', text: 't', to: 'a@b.c' })
    expect(transport.sent[0]).not.toHaveProperty('replyTo')
    await mailer.send({ subject: 's', text: 't', to: 'a@b.c', replyTo: 'client@b.c' })
    expect(transport.sent[1].replyTo).toBe('client@b.c')
  })

  it('drops a Reply-To carrying a line break instead of handing a header injection to the transport', async () => {
    const { transport, mailer } = buildMailer()
    const result = await mailer.send({
      subject: 's',
      text: 't',
      to: 'a@b.c',
      replyTo: 'client@b.c\r\nBcc: attacker@evil.example',
    })
    expect(result.ok).toBe(true)
    expect(transport.sent[0]).not.toHaveProperty('replyTo')
  })

  it('never throws when the transport fails; returns { ok: false }', async () => {
    const failing = {
      sendMail: async () => {
        throw new Error('SMTP down')
      },
    }
    const mailer = createMailer({
      transport: failing,
      from: FROM,
      backofficeEmail: BACKOFFICE,
    })
    const result = await mailer.send({
      template: 'shipped',
      to: 'x@test.example',
      data: { order_number: 'REQ-2' },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeInstanceOf(Error)
  })
})

describe('resolveOrderRecipient', () => {
  it('prefers the guest email without querying users', async () => {
    let queried = false
    const db = {
      query: async () => {
        queried = true
        return { rows: [] }
      },
    }
    const email = await resolveOrderRecipient(db, {
      guest_email: 'guest@test.example',
      user_id: 7,
    })
    expect(email).toBe('guest@test.example')
    expect(queried).toBe(false)
  })

  it('looks up the users email when only user_id is set', async () => {
    const db = { query: async () => ({ rows: [{ email: 'member@test.example' }] }) }
    const email = await resolveOrderRecipient(db, { guest_email: null, user_id: 9 })
    expect(email).toBe('member@test.example')
  })

  it('returns null when neither is present', async () => {
    const db = { query: async () => ({ rows: [] }) }
    expect(await resolveOrderRecipient(db, {})).toBeNull()
  })
})

describe('notifications', () => {
  it('notifyRequestReceived emails the customer and the back office', async () => {
    const { transport, mailer } = buildMailer()
    await notifyRequestReceived(mailer, {
      order: { order_number: 'REQ-5', kind: 'order_request' },
      customerEmail: 'buyer@test.example',
    })
    expect(transport.sent).toHaveLength(2)
    const [customer, staff] = transport.sent
    expect(customer.to).toBe('buyer@test.example')
    expect(customer.subject).toContain('REQ-5')
    expect(staff.to).toBe(BACKOFFICE)
    expect(staff.text).toContain('buyer@test.example')
  })

  it('notifyRequestReceived still alerts the back office when there is no customer email', async () => {
    const { transport, mailer } = buildMailer()
    await notifyRequestReceived(mailer, {
      order: { order_number: 'REQ-6', kind: 'order_request' },
      customerEmail: null,
    })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].to).toBe(BACKOFFICE)
  })

  it('notifyCheckoutReceipt emails the resolved recipient the receipt', async () => {
    const { transport, mailer } = buildMailer()
    const db = { query: async () => ({ rows: [] }) }
    await notifyCheckoutReceipt(mailer, db, {
      order_number: 'WEB-abc',
      total_cents: 5000,
      guest_email: 'guest@test.example',
      user_id: null,
    })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].to).toBe('guest@test.example')
    expect(transport.sent[0].text).toContain('$50.00 NZD')
  })

  it('notifyOrderTransition maps confirmed/paid/shipped to templates and skips others', async () => {
    const db = { query: async () => ({ rows: [] }) }
    const cases = [
      { status: 'confirmed', to: 'buyer@test.example' },
      { status: 'paid', to: 'buyer@test.example' },
      { status: 'shipped', to: 'buyer@test.example' },
    ]
    for (const { status } of cases) {
      const { transport, mailer } = buildMailer()
      await notifyOrderTransition(mailer, db, {
        order_number: 'REQ-8',
        status,
        xero_invoice_ref: 'INV-1',
        guest_email: 'buyer@test.example',
        user_id: null,
      })
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0].to).toBe('buyer@test.example')
    }

    const { transport, mailer } = buildMailer()
    await notifyOrderTransition(mailer, db, {
      order_number: 'REQ-8',
      status: 'declined',
      guest_email: 'buyer@test.example',
    })
    expect(transport.sent).toHaveLength(0)
  })

  // W12 US-005: the client's confirmation is sent when the order is CREATED, and
  // the back office hears about it in the same call (US-004).
  it('notifyOrderCreated confirms to the client and alerts the back office', async () => {
    const { transport, mailer } = buildMailer()
    const db = { query: async () => ({ rows: [] }) }
    await notifyOrderCreated(mailer, db, {
      order_number: 'SO-1234',
      kind: 'manual',
      guest_email: 'walkin@test.example',
      user_id: null,
    })

    expect(transport.sent).toHaveLength(2)
    const client = transport.sent.find((m) => m.to === 'walkin@test.example')
    const staff = transport.sent.find((m) => m.to === BACKOFFICE)
    expect(client.subject).toContain('SO-1234')
    // No invoice exists yet at creation; the template says so rather than
    // naming a reference nobody has.
    expect(client.text).toContain('An invoice will follow shortly.')
    expect(staff.text).toContain('SO-1234')
    expect(staff.text).toContain('walkin@test.example')
  })

  it('notifyOrderCreated still alerts the back office when the order has no email', async () => {
    const { transport, mailer } = buildMailer()
    const db = { query: async () => ({ rows: [] }) }
    await notifyOrderCreated(mailer, db, {
      order_number: 'SO-5678',
      kind: 'manual',
      guest_email: null,
      user_id: null,
    })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].to).toBe(BACKOFFICE)
  })

  // W12 US-004/FR-119: the alert goes to the ONE configured address. Not a
  // per-salesperson routing table — the restriction is the requirement.
  it('notifyTradeApplicationReceived alerts the back office with Reply-To the applicant', async () => {
    const { transport, mailer } = buildMailer()
    await notifyTradeApplicationReceived(mailer, {
      user: { email: 'alex@studio.example' },
      application: { business_name: 'Studio Interiors Ltd', signatory_name: 'Alex Designer' },
      crmBaseUrl: 'http://crm.example',
    })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]).toMatchObject({
      to: BACKOFFICE,
      replyTo: 'alex@studio.example',
      subject: 'New trade application to review: Studio Interiors Ltd',
    })
    expect(transport.sent[0].text).toContain('http://crm.example/#/clients/applicants')
  })

  it('notifyBackofficeNewOrder alerts the single configured address only', async () => {
    const { transport, mailer } = buildMailer()
    const db = { query: async () => ({ rows: [] }) }
    await notifyBackofficeNewOrder(mailer, db, {
      order_number: 'WEB-cs_1',
      kind: 'checkout',
      guest_email: 'shopper@test.example',
      user_id: null,
    })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].to).toBe(BACKOFFICE)
    expect(transport.sent[0].subject).toContain('checkout')
    expect(transport.sent[0].text).toContain('shopper@test.example')
  })

  // FR-121: confirming must not re-send the mail the client got at creation.
  it('the confirm transition sends a different message from the creation one', async () => {
    const db = { query: async () => ({ rows: [] }) }
    const order = {
      order_number: 'SO-9',
      kind: 'manual',
      guest_email: 'buyer@test.example',
      user_id: null,
    }

    const created = buildMailer()
    await notifyOrderCreated(created.mailer, db, order)
    const confirmed = buildMailer()
    await notifyOrderTransition(confirmed.mailer, db, {
      ...order,
      status: 'confirmed',
      xero_invoice_ref: 'INV-1',
    })

    const creationMail = created.transport.sent.find((m) => m.to === 'buyer@test.example')
    const confirmMail = confirmed.transport.sent[0]
    expect(confirmMail.to).toBe('buyer@test.example')
    expect(confirmMail.subject).not.toBe(creationMail.subject)
    expect(confirmMail.text).toContain('INV-1')
  })

  it('every helper is a safe no-op when the mailer is null', async () => {
    const db = { query: async () => ({ rows: [] }) }
    await expect(
      notifyRequestReceived(null, {
        order: { order_number: 'x', kind: 'order_request' },
        customerEmail: 'a@b.c',
      })
    ).resolves.toBeUndefined()
    await expect(
      notifyCheckoutReceipt(null, db, { order_number: 'x', total_cents: 0 })
    ).resolves.toBeUndefined()
    await expect(
      notifyOrderTransition(null, db, { order_number: 'x', status: 'paid' })
    ).resolves.toBeUndefined()
    await expect(
      notifyOrderCreated(null, db, { order_number: 'x', kind: 'manual' })
    ).resolves.toBeUndefined()
    await expect(
      notifyBackofficeNewOrder(null, db, { order_number: 'x', kind: 'checkout' })
    ).resolves.toBeUndefined()
    await expect(
      notifyTradeApplicationReceived(null, {
        user: { email: 'a@b.c' },
        application: { business_name: 'x' },
        crmBaseUrl: 'http://crm',
      })
    ).resolves.toBeUndefined()
  })
})

// Integration: the /orders/request route actually fires the notification through
// the injected mailer (proves the trigger is wired, not just the helpers).
describe('order-request trigger wiring', () => {
  const PREFIX = 'email-test'
  const SKU = `${PREFIX}-INSTOCK`
  const STAFF_EMAIL = 'staff@email-test.example'
  let pool
  let app
  let transport
  // Registered ONCE: register shares a 10-per-15-min per-IP bucket, so a
  // per-test registration 429s and yields no cookie.
  let backofficeCookie

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

    await pool.query('DELETE FROM users WHERE email = $1', [STAFF_EMAIL])
    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: STAFF_EMAIL, password: 'correct horse battery staple' },
    })
    const setCookie = staff.headers['set-cookie']
    backofficeCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      STAFF_EMAIL,
    ])
  })

  afterAll(async () => {
    await pool.query(
      `DELETE FROM orders WHERE id IN (
         SELECT ol.order_id FROM order_lines ol
           JOIN colourways c ON c.id = ol.colourway_id
          WHERE c.sku LIKE $1)`,
      [`${PREFIX}-%`]
    )
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
    await pool.query('DELETE FROM users WHERE email = $1', [STAFF_EMAIL])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    transport.sent.length = 0
    await pool.query(
      `DELETE FROM orders WHERE id IN (
         SELECT ol.order_id FROM order_lines ol
           JOIN colourways c ON c.id = ol.colourway_id
          WHERE c.sku LIKE $1)`,
      [`${PREFIX}-%`]
    )
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
       -- trade_only false: this fixture models the PUBLIC storefront.
       VALUES ('Email Test House', $1, 'New Zealand', 'NZD', false, false, 'Test.')
       RETURNING id`,
      [`${PREFIX}-house`]
    )
    const { rows: products } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, 'Email InStock', $2, 'fabric', 'NZD', true) RETURNING id`,
      [brands[0].id, `${PREFIX}-instock`]
    )
    const { rows: cws } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku)
       VALUES ($1, 'Default', $2) RETURNING id`,
      [products[0].id, SKU]
    )
    await pool.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, 60, 0, 'metres')`,
      [cws[0].id]
    )
  })

  it('sends customer + back-office emails when a guest requests an order', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders/request',
      payload: {
        lines: [{ sku: SKU, qty_metres: 4 }],
        contact: { name: 'Guest Buyer', email: 'guest@email-test.example' },
      },
    })
    expect(response.statusCode).toBe(201)
    const orderNumber = response.json().order.order_number

    expect(transport.sent).toHaveLength(2)
    const customer = transport.sent.find((m) => m.to === 'guest@email-test.example')
    const staff = transport.sent.find((m) => m.to === BACKOFFICE)
    expect(customer.subject).toContain(orderNumber)
    expect(staff.text).toContain(orderNumber)
  })

  it('a filled honeypot answers 201 and neither stores the order nor sends a letter', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/orders/request',
      payload: {
        website: 'http://spam.example',
        lines: [{ sku: SKU, qty_metres: 4 }],
        contact: { name: 'Bot', email: 'bot@email-test.example' },
      },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ order: null })
    expect(transport.sent).toHaveLength(0)
    const { rows } = await pool.query('SELECT 1 FROM orders WHERE guest_email = $1', [
      'bot@email-test.example',
    ])
    expect(rows).toHaveLength(0)
  })

  // W12 US-004 + US-005: the back-office order path notified nobody at all —
  // not the client it was keyed for, and not the desk.
  it('confirms to the client and alerts the back office when staff key an order', async () => {
    const { rows } = await pool.query('SELECT id FROM colourways WHERE sku = $1', [SKU])
    const response = await app.inject({
      method: 'POST',
      url: '/admin/orders',
      headers: { cookie: backofficeCookie },
      payload: {
        contact: { name: 'Walk In', email: 'walkin@email-test.example' },
        lines: [{ colourway_id: rows[0].id, qty: 2, unit_price_cents: 9900 }],
      },
    })
    expect(response.statusCode).toBe(201)
    const orderNumber = response.json().order.order_number

    expect(transport.sent).toHaveLength(2)
    const client = transport.sent.find((m) => m.to === 'walkin@email-test.example')
    const staff = transport.sent.find((m) => m.to === BACKOFFICE)
    expect(client.subject).toContain(orderNumber)
    expect(staff.subject).toContain(orderNumber)
  })
})
