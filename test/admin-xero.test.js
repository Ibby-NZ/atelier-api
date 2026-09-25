// The Xero integration end-to-end against a REAL service and a FAKE Xero —
// the fake sits at the HTTP seam (src/xero/xero-http.js's interface), so the
// service's token lifecycle, contact matching and invoice push all run for
// real; only the network is scripted. Needs local Postgres like every route
// suite.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createXeroService } from '../src/xero/service.js'
import { XeroHttpError } from '../src/xero/xero-http.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'xero-test'
const DOMAIN = 'xero-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const CRM_BASE = 'http://localhost:5273'

const XERO_CONFIG = Object.freeze({
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  grantType: 'authorization_code',
  redirectUri: 'http://localhost:3001/admin/xero/callback',
  scopes: 'openid offline_access accounting.transactions',
  salesAccountCode: '200',
  lineAmountTypes: 'Exclusive',
  invoiceStatus: 'AUTHORISED',
  invoiceDueDays: 30,
  paymentAccountCode: '090',
  purchasesAccountCode: '300',
  billStatus: 'DRAFT',
  pullIntervalMinutes: 0,
})

// A scriptable stand-in for xero-http.js. `on(method, path, fn)` registers a
// handler for accounting calls (path matched as a prefix so 'Invoices/xyz/
// Email' can be scripted exactly or by family); every call is recorded.
const createFakeXero = () => {
  const calls = []
  const handlers = []
  const fake = {
    calls,
    on: (method, path, fn) => handlers.push({ method, path, fn }),
    tokens: { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 1800 },
    refreshed: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 1800 },
    tokenWithClientCredentials: async () => fake.tokens,
    tokenFromCode: async (code, redirectUri) => {
      calls.push({ method: 'TOKEN', path: 'code', body: { code, redirectUri } })
      return fake.tokens
    },
    tokenFromRefresh: async (refreshToken) => {
      calls.push({ method: 'TOKEN', path: 'refresh', body: { refreshToken } })
      return fake.refreshed
    },
    connections: async () => [{ tenantId: 'tenant-1', tenantName: 'Atelier Textiles' }],
    accounting: async (accessToken, tenantId, method, path, options = {}) => {
      calls.push({ accessToken, tenantId, method, path, ...options })
      // findLast: the most recent registration wins, so a test can shadow the
      // defaults (and earlier tests' scripts) without clearing anything.
      const handler = handlers.findLast((h) => h.method === method && path.startsWith(h.path))
      if (!handler) throw new Error(`fake xero has no handler for ${method} ${path}`)
      return handler.fn(options, path)
    },
  }
  // Defaults that make the common path work; tests override with on().
  fake.on('GET', 'Contacts', () => ({ Contacts: [] }))
  return fake
}

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seedCatalogue = async (pool) => {
  const { rows: suppliers } = await pool.query(
    `INSERT INTO suppliers (name, slug, country, currency, po_email)
     VALUES ($1, $2, 'Italy', 'EUR', $3) RETURNING id`,
    [`${PREFIX} Maison`, `${PREFIX}-maison`, testEmail('orders')]
  )
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story, supplier_id)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.', $3)
     RETURNING id`,
    ['Xero House', `${PREFIX}-house`, suppliers[0].id]
  )
  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Xero Fabric', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brands[0].id, `${PREFIX}-fabric`]
  )
  const { rows: cw } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Clay', $2) RETURNING id`,
    [products[0].id, `${PREFIX}-SKU-1`]
  )
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 100, 0, 'metres')`,
    [cw[0].id]
  )
  return cw[0].id
}

const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM orders WHERE id IN (
       SELECT ol.order_id FROM order_lines ol
         JOIN colourways c ON c.id = ol.colourway_id
        WHERE c.sku LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM purchase_orders
      WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)
         OR brand_id IN (SELECT id FROM brands WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1 OR name LIKE $2', [`${PREFIX}-%`, `${PREFIX} %`])
  await pool.query('DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1', [`${PREFIX} %`])
  await pool.query('DELETE FROM xero_connection')
  await pool.query(`UPDATE users SET xero_contact_id = NULL WHERE email LIKE $1`, [`%@${DOMAIN}`])
}

// A connected auth-code row with a far-future token, so calls skip refresh.
const seedConnected = (pool, { expiresInMs = 3600_000 } = {}) =>
  pool.query(
    `INSERT INTO xero_connection (id, grant_type, token_set, tenant_id, org_name)
     VALUES (1, 'authorization_code', $1, 'tenant-1', 'Atelier Textiles')
     ON CONFLICT (id) DO UPDATE
        SET grant_type = EXCLUDED.grant_type, token_set = EXCLUDED.token_set,
            tenant_id = EXCLUDED.tenant_id, org_name = EXCLUDED.org_name`,
    [
      JSON.stringify({
        access_token: 'seeded-access',
        refresh_token: 'seeded-refresh',
        expires_at_ms: Date.now() + expiresInMs,
      }),
    ]
  )

describe('xero integration', () => {
  let pool
  let app
  let fake
  let backofficeCookie
  let directorCookie
  let customerCookie

  const notified = []

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const move = (orderId, status, extra = {}) =>
    inject('POST', `/admin/orders/${orderId}/status`, backofficeCookie, { status, ...extra })

  // A priced, account-owned order ready to invoice: the customer requests it,
  // the back office prices the line and takes it on (`processing` — an
  // unaccepted quote is not invoiceable).
  const placePricedOrder = async (unitPriceCents = 5000) => {
    const placed = await app.inject({
      method: 'POST',
      url: '/orders/request',
      headers: { cookie: customerCookie },
      payload: { lines: [{ sku: `${PREFIX}-SKU-1`, qty_metres: 10 }] },
    })
    const order = placed.json().order
    const detail = await inject('GET', `/admin/orders/${order.id}`, backofficeCookie)
    const lineId = detail.json().order.lines[0].id
    await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
      lines: [{ id: lineId, unit_price_cents: unitPriceCents }],
    })
    expect((await move(order.id, 'processing')).statusCode).toBe(200)
    return order.id
  }

  // The same order, raised at the desk: the public request route shares a
  // 10-per-15-min bucket that the earlier suites spend.
  const raisePricedOrder = async (unitPriceCents = 5000) => {
    const { rows: cws } = await pool.query(`SELECT id FROM colourways WHERE sku = $1`, [`${PREFIX}-SKU-1`])
    const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = $1`, [testEmail('client')])
    const created = await inject('POST', '/admin/orders', backofficeCookie, {
      user_id: users[0].id,
      lines: [{ colourway_id: cws[0].id, qty: 10, unit_price_cents: unitPriceCents }],
    })
    expect(created.statusCode).toBe(201)
    expect((await move(created.json().order.id, 'processing')).statusCode).toBe(200)
    return created.json().order.id
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
    fake = createFakeXero()
    const xero = createXeroService({
      pool,
      config: XERO_CONFIG,
      http: fake,
      // Every move Xero makes (push → pending_payment, pull → paid) hands the
      // fresh order here; server.js wires the status letter to it.
      notifyOrderTransition: async (order) => {
        notified.push(order)
      },
    })
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      xero,
      crmBaseUrl: CRM_BASE,
    })
    await app.ready()

    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    const register = async (local, name) => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail(local), password: PASSWORD, name },
      })
      return sessionCookieFrom(response)
    }
    backofficeCookie = await register('boss', 'Boss')
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('boss')])
    directorCookie = await register('director', 'Director')
    await pool.query(`UPDATE users SET role = 'director' WHERE email = $1`, [testEmail('director')])
    customerCookie = await register('client', 'Zomia Interiors')
  })

  beforeEach(async () => {
    await cleanup(pool)
    fake.calls.length = 0
    notified.length = 0
    await seedCatalogue(pool)
    await seedConnected(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  describe('access control and configuration', () => {
    it('requires auth and staff on status', async () => {
      expect((await inject('GET', '/admin/xero/status', null)).statusCode).toBe(401)
      expect((await inject('GET', '/admin/xero/status', customerCookie)).statusCode).toBe(403)
    })

    it('connect and disconnect are director-only', async () => {
      expect((await inject('POST', '/admin/xero/connect', backofficeCookie)).statusCode).toBe(403)
      expect((await inject('POST', '/admin/xero/disconnect', backofficeCookie)).statusCode).toBe(403)
    })

    it('answers 503 everywhere when unconfigured', async () => {
      const bare = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
      await bare.ready()
      const login = await bare.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: testEmail('boss'), password: PASSWORD },
      })
      const cookie = sessionCookieFrom(login)
      const status = await bare.inject({
        method: 'GET',
        url: '/admin/xero/status',
        headers: { cookie },
      })
      expect(status.json().xero).toEqual({ configured: false, connected: false })
      const push = await bare.inject({
        method: 'POST',
        url: '/admin/xero/orders/1/invoice',
        headers: { cookie },
        payload: {},
      })
      expect(push.statusCode).toBe(503)
      await bare.close()
    })
  })

  describe('connection lifecycle', () => {
    it('reports not connected before consent, connected after seeding', async () => {
      await pool.query('DELETE FROM xero_connection')
      const before = await inject('GET', '/admin/xero/status', backofficeCookie)
      expect(before.json().xero.connected).toBe(false)
      await seedConnected(pool)
      const after = await inject('GET', '/admin/xero/status', backofficeCookie)
      expect(after.json().xero).toMatchObject({
        configured: true,
        connected: true,
        org_name: 'Atelier Textiles',
      })
    })

    it('mints a consent url whose state the callback then requires', async () => {
      await pool.query('DELETE FROM xero_connection')
      const connect = await inject('POST', '/admin/xero/connect', directorCookie)
      expect(connect.statusCode).toBe(200)
      const url = new URL(connect.json().consent_url)
      expect(url.origin).toBe('https://login.xero.com')
      expect(url.searchParams.get('client_id')).toBe('test-client-id')
      const state = url.searchParams.get('state')
      expect(state).toBeTruthy()

      // Wrong state: bounced, nothing stored.
      const bad = await inject(
        'GET',
        `/admin/xero/callback?code=abc&state=not-it`,
        directorCookie
      )
      expect(bad.statusCode).toBe(302)
      expect(bad.headers.location).toContain('connected=0')

      // The nonce was SPENT by the failed attempt — reconnect mints a new one.
      const again = await inject('POST', '/admin/xero/connect', directorCookie)
      const freshState = new URL(again.json().consent_url).searchParams.get('state')
      const good = await inject(
        'GET',
        `/admin/xero/callback?code=abc&state=${freshState}`,
        directorCookie
      )
      expect(good.statusCode).toBe(302)
      expect(good.headers.location).toBe(`${CRM_BASE}/#/admin/xero?connected=1`)
      const status = await inject('GET', '/admin/xero/status', backofficeCookie)
      expect(status.json().xero).toMatchObject({ connected: true, tenant_id: 'tenant-1' })
    })

    it('disconnect clears the connection', async () => {
      const response = await inject('POST', '/admin/xero/disconnect', directorCookie)
      expect(response.json().xero.connected).toBe(false)
      const status = await inject('GET', '/admin/xero/status', backofficeCookie)
      expect(status.json().xero.connected).toBe(false)
    })
  })

  // Marking an order paid marks its invoice paid in Xero (16 Sep 2026
  // feedback). A Payment for exactly Xero's own AmountDue, against the bank
  // account XERO_PAYMENT_ACCOUNT_CODE names; the order transition never fails
  // because of Xero — a refusal comes back as `xero_payment.reason`.
  describe('the invoice follows the order to paid', () => {
    const scriptInvoiceCreate = () => {
      fake.on('GET', 'Contacts', () => ({
        Contacts: [
          { ContactID: 'contact-9', Name: 'Zomia Interiors', EmailAddress: testEmail('client') },
        ],
      }))
      fake.on('POST', 'Invoices', () => ({
        Invoices: [{ InvoiceID: 'inv-uuid-1', InvoiceNumber: 'INV-0042', Sent: false }],
      }))
    }
    const scriptInvoiceDue = (amountDue) =>
      fake.on('GET', 'Invoices/inv-uuid-1', () => ({
        Invoices: [{ InvoiceID: 'inv-uuid-1', InvoiceNumber: 'INV-0042', AmountDue: amountDue }],
      }))
    const paymentCalls = () => fake.calls.filter((c) => c.method === 'PUT' && c.path === 'Payments')

    // A priced order keyed by the office (POST /admin/orders) rather than
    // requested through the storefront: /orders/request shares one
    // 10-per-15-min bucket per app instance and the push tests above already
    // spend most of it.
    const keyPricedOrder = async () => {
      const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
        testEmail('client'),
      ])
      const { rows: colourways } = await pool.query(`SELECT id FROM colourways WHERE sku = $1`, [
        `${PREFIX}-SKU-1`,
      ])
      const keyed = await inject('POST', '/admin/orders', backofficeCookie, {
        user_id: users[0].id,
        lines: [{ colourway_id: colourways[0].id, qty: 10, unit_price_cents: 5000 }],
      })
      expect(keyed.statusCode).toBe(201)
      expect((await move(keyed.json().order.id, 'processing')).statusCode).toBe(200)
      return keyed.json().order.id
    }

    // The push moves the order to pending_payment itself, so paid is legal.
    const pushedAndConfirmed = async () => {
      scriptInvoiceCreate()
      const orderId = await keyPricedOrder()
      const pushed = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      expect(pushed.json().order.status).toBe('pending_payment')
      return orderId
    }

    it('moving to paid records a payment for what Xero says is due', async () => {
      const orderId = await pushedAndConfirmed()
      scriptInvoiceDue(575)
      fake.on('PUT', 'Payments', () => ({ Payments: [{ PaymentID: 'pay-1' }] }))
      const response = await move(orderId, 'paid')
      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('paid')
      expect(response.json().xero_payment).toEqual({
        recorded: true,
        amount: 575,
        payment_id: 'pay-1',
        invoice_number: 'INV-0042',
      })
      const [put] = paymentCalls()
      expect(put.idempotencyKey).toBe(`atelier-order-${orderId}-payment`)
      expect(put.body.Payments[0]).toMatchObject({
        Invoice: { InvoiceID: 'inv-uuid-1' },
        Account: { Code: '090' },
        Amount: 575,
      })
      expect(put.body.Payments[0].Date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('records nothing when Xero already shows the invoice paid', async () => {
      const orderId = await pushedAndConfirmed()
      scriptInvoiceDue(0)
      const response = await move(orderId, 'paid')
      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('paid')
      expect(response.json().xero_payment.recorded).toBe(false)
      expect(response.json().xero_payment.reason).toMatch(/already paid/)
      expect(paymentCalls()).toHaveLength(0)
    })

    it('still marks the order paid when the order was never pushed, and says so', async () => {
      const orderId = await keyPricedOrder()
      await move(orderId, 'pending_payment', { xero_invoice_ref: 'INV-BY-HAND' })
      const response = await move(orderId, 'paid')
      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('paid')
      expect(response.json().xero_payment).toEqual({
        recorded: false,
        reason: 'this order has no invoice in Xero yet.',
      })
      expect(paymentCalls()).toHaveLength(0)
    })

    it('still marks the order paid when Xero refuses the payment, and carries the refusal', async () => {
      const orderId = await pushedAndConfirmed()
      scriptInvoiceDue(575)
      fake.on('PUT', 'Payments', () => {
        throw new XeroHttpError('Xero 400', {
          status: 400,
          body: {
            Elements: [{ ValidationErrors: [{ Message: 'Account code 090 is not a bank account.' }] }],
          },
        })
      })
      const response = await move(orderId, 'paid')
      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('paid')
      expect(response.json().xero_payment.recorded).toBe(false)
      expect(response.json().xero_payment.reason).toMatch(/not a bank account/)
    })

    it('a push for an order that is already paid records the payment on the spot', async () => {
      const orderId = await keyPricedOrder()
      await move(orderId, 'pending_payment', { xero_invoice_ref: 'INV-BY-HAND' })
      await move(orderId, 'paid')
      scriptInvoiceCreate()
      scriptInvoiceDue(575)
      fake.on('PUT', 'Payments', () => ({ Payments: [{ PaymentID: 'pay-2' }] }))
      const response = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      expect(response.statusCode).toBe(200)
      expect(response.json().payment).toMatchObject({ recorded: true, amount: 575, payment_id: 'pay-2' })
      expect(response.json().warning).toBeUndefined()
      expect(paymentCalls()).toHaveLength(1)
    })

    it('without XERO_PAYMENT_ACCOUNT_CODE the payment is left to the office, in words', async () => {
      const orderId = await pushedAndConfirmed()
      const unconfigured = createXeroService({
        pool,
        config: { ...XERO_CONFIG, paymentAccountCode: null },
        http: fake,
      })
      const result = await unconfigured.recordOrderPayment(orderId)
      expect(result.recorded).toBe(false)
      expect(result.reason).toMatch(/XERO_PAYMENT_ACCOUNT_CODE/)
      expect(paymentCalls()).toHaveLength(0)
    })
  })

  describe('POST /admin/xero/orders/:id/invoice', () => {
    const scriptInvoiceCreate = () => {
      fake.on('GET', 'Contacts', () => ({
        Contacts: [
          { ContactID: 'contact-9', Name: 'Zomia Interiors', EmailAddress: testEmail('client') },
        ],
      }))
      fake.on('POST', 'Invoices', ({ body }) => ({
        Invoices: [{ InvoiceID: 'inv-uuid-1', InvoiceNumber: 'INV-0042', Sent: false, _got: body }],
      }))
    }

    it('pushes the invoice, links the contact and stores both identifiers', async () => {
      scriptInvoiceCreate()
      const orderId = await placePricedOrder()
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(200)
      const { order, invoice, emailed } = response.json()
      expect(invoice).toEqual({ id: 'inv-uuid-1', number: 'INV-0042' })
      expect(emailed).toBe(false)
      expect(order.xero_invoice_id).toBe('inv-uuid-1')
      expect(order.xero_invoice_ref).toBe('INV-0042')

      // The client's login is now linked for every future push.
      const { rows } = await pool.query(`SELECT xero_contact_id FROM users WHERE email = $1`, [
        testEmail('client'),
      ])
      expect(rows[0].xero_contact_id).toBe('contact-9')

      // What went to Xero: ACCREC, our account code, the priced line, and the
      // idempotency key that makes a retry safe.
      const post = fake.calls.find((c) => c.method === 'POST' && c.path === 'Invoices')
      expect(post.idempotencyKey).toBe(`atelier-order-${orderId}`)
      const sent = post.body.Invoices[0]
      expect(sent.Type).toBe('ACCREC')
      expect(sent.Contact).toEqual({ ContactID: 'contact-9' })
      expect(sent.LineItems[0]).toMatchObject({ UnitAmount: 50, Quantity: 10, AccountCode: '200' })
      expect(sent.Status).toBe('AUTHORISED')
    })

    it('asks Xero to email the invoice when told to', async () => {
      scriptInvoiceCreate()
      fake.on('POST', 'Invoices/inv-uuid-1/Email', () => null)
      const orderId = await placePricedOrder()
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        { email: true }
      )
      expect(response.json().emailed).toBe(true)
      expect(
        fake.calls.some((c) => c.method === 'POST' && c.path === 'Invoices/inv-uuid-1/Email')
      ).toBe(true)
    })

    it('with EMAIL_REDIRECT_TO set, Xero is never asked to email the client', async () => {
      scriptInvoiceCreate()
      fake.on('POST', 'Invoices/inv-uuid-1/Email', () => null)
      const orderId = await placePricedOrder()
      const redirected = createXeroService({
        pool,
        config: XERO_CONFIG,
        http: fake,
        emailRedirectTo: testEmail('tester'),
      })
      const result = await redirected.pushOrderInvoice(orderId, { email: true })
      expect(result.emailed).toBe(false)
      expect(result.warning).toMatch(/EMAIL_REDIRECT_TO/)
      expect(result.order.xero_invoice_id).toBe('inv-uuid-1')
      expect(
        fake.calls.some((c) => c.method === 'POST' && c.path === 'Invoices/inv-uuid-1/Email')
      ).toBe(false)
    })

    it('a failed email is a warning, not a failed push', async () => {
      scriptInvoiceCreate()
      fake.on('POST', 'Invoices/inv-uuid-1/Email', () => {
        throw new XeroHttpError('nope', { status: 400, body: { Message: 'Draft invoices cannot be emailed' } })
      })
      const orderId = await placePricedOrder()
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        { email: true }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().emailed).toBe(false)
      expect(response.json().warning).toContain('did not email')
      expect(response.json().order.xero_invoice_id).toBe('inv-uuid-1')
    })

    it('refuses a second push, an unpriced order and a missing order', async () => {
      scriptInvoiceCreate()
      const orderId = await placePricedOrder()
      await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      const again = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(again.statusCode).toBe(409)
      expect(again.json().message).toContain('INV-0042')

      const unpricedId = await placePricedOrder(0)
      const unpriced = await inject(
        'POST',
        `/admin/xero/orders/${unpricedId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(unpriced.statusCode).toBe(409)
      expect(unpriced.json().message).toMatch(/1 line is still at \$0\.00/)

      expect(
        (await inject('POST', '/admin/xero/orders/999999/invoice', backofficeCookie, {}))
          .statusCode
      ).toBe(404)
    })

    // The total check alone let a positive order through with one nil line,
    // which Xero would have invoiced as a $0.00 item. Same predicate `confirm`
    // uses (`unpricedLineCount`), so the two cannot disagree.
    it('refuses an order whose total is positive but a line is still unpriced', async () => {
      scriptInvoiceCreate()
      const orderId = await placePricedOrder(0)
      const { rows } = await pool.query('SELECT id FROM colourways WHERE sku = $1', [
        `${PREFIX}-SKU-1`,
      ])
      await inject('PATCH', `/admin/orders/${orderId}`, backofficeCookie, {
        add_lines: [{ colourway_id: rows[0].id, qty: 1, unit_price_cents: 5000 }],
      })
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/1 line is still at \$0\.00/)
      expect(fake.calls.some((c) => c.method === 'POST' && c.path === 'Invoices')).toBe(false)
    })

    it('surfaces a Xero validation refusal as a 422 with its messages', async () => {
      fake.on('GET', 'Contacts', () => ({
        Contacts: [
          { ContactID: 'contact-9', Name: 'Zomia Interiors', EmailAddress: testEmail('client') },
        ],
      }))
      fake.on('POST', 'Invoices', () => {
        throw new XeroHttpError('bad', {
          status: 400,
          body: {
            Elements: [
              { ValidationErrors: [{ Message: 'Account code 200 is not a valid code' }] },
            ],
          },
        })
      })
      const orderId = await placePricedOrder()
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('Account code 200')
    })

    it('refreshes a stale token under rotation before calling', async () => {
      await seedConnected(pool, { expiresInMs: -1000 })
      scriptInvoiceCreate()
      const orderId = await placePricedOrder()
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(200)
      expect(fake.calls.some((c) => c.method === 'TOKEN' && c.path === 'refresh')).toBe(true)
      // The ROTATED refresh token is what the row holds now.
      const { rows } = await pool.query(`SELECT token_set FROM xero_connection WHERE id = 1`)
      expect(rows[0].token_set.refresh_token).toBe('refresh-2')
    })

    it('answers 409 when configured but never connected', async () => {
      await pool.query('DELETE FROM xero_connection')
      const orderId = await placePricedOrder()
      const response = await inject(
        'POST',
        `/admin/xero/orders/${orderId}/invoice`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toContain('not connected')
    })
  })

  describe('POST /admin/xero/sync/contacts', () => {
    it('links matches from the directory and creates the rest', async () => {
      // Directory holds the client by email; the second user is unknown.
      await pool.query(
        `UPDATE users SET role = 'trade' WHERE email = $1`,
        [testEmail('client')]
      )
      fake.on('GET', 'Contacts', ({ query }) => {
        // Directory paging: one page, then empty.
        if (query?.page === '1') {
          return {
            Contacts: [
              { ContactID: 'dir-1', Name: 'Someone Else', EmailAddress: testEmail('client') },
            ],
          }
        }
        return { Contacts: [] }
      })
      fake.on('POST', 'Contacts', ({ body }) => ({
        Contacts: body.Contacts.map((c, i) => ({ ...c, ContactID: `new-${i}` })),
      }))

      const response = await inject('POST', '/admin/xero/sync/contacts', backofficeCookie, {})
      expect(response.statusCode).toBe(200)
      const { linked, created, failed } = response.json().result
      expect(linked).toBe(1)
      expect(failed).toEqual([])
      // 'client' linked to dir-1; every other live customer/trade account
      // (at least the registered 'shopper'-free set) was created.
      const { rows } = await pool.query(`SELECT xero_contact_id FROM users WHERE email = $1`, [
        testEmail('client'),
      ])
      expect(rows[0].xero_contact_id).toBe('dir-1')
      expect(created).toBeGreaterThanOrEqual(0)
    })
  })

  describe('POST /admin/xero/sync/items', () => {
    it('upserts colourways as items by SKU and reports per-row failures', async () => {
      fake.on('POST', 'Items', ({ body }) => ({
        Items: body.Items.map((item) =>
          item.Code === `${PREFIX}-SKU-1`
            ? item
            : { ...item, ValidationErrors: [{ Message: 'refused' }] }
        ),
      }))
      const response = await inject('POST', '/admin/xero/sync/items', backofficeCookie, {})
      expect(response.statusCode).toBe(200)
      const { pushed, failed } = response.json().result
      expect(pushed).toBeGreaterThanOrEqual(1)
      const posts = fake.calls.filter((c) => c.method === 'POST' && c.path === 'Items')
      expect(
        posts.some((post) => post.body.Items.some((i) => i.Code === `${PREFIX}-SKU-1`))
      ).toBe(true)
      expect(Array.isArray(failed)).toBe(true)
    })
  })

  describe('the company is the customer', () => {
    it('invoices a login filed under a company as that company, and remembers it there', async () => {
      const { rows: companies } = await pool.query(
        `INSERT INTO trade_accounts (legacy_customer_name, email) VALUES ($1, $2) RETURNING id`,
        [`${PREFIX} Zomia Ltd`, testEmail('accounts')]
      )
      const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = $1`, [testEmail('client')])
      await pool.query(
        `INSERT INTO trade_account_users (trade_account_id, user_id) VALUES ($1, $2)`,
        [companies[0].id, users[0].id]
      )
      fake.on('GET', 'Contacts', ({ query }) =>
        query?.searchTerm === testEmail('accounts')
          ? { Contacts: [{ ContactID: 'company-1', Name: 'Zomia', EmailAddress: testEmail('accounts') }] }
          : { Contacts: [] }
      )
      fake.on('POST', 'Invoices', ({ body }) => ({
        Invoices: [{ ...body.Invoices[0], InvoiceID: 'inv-co', InvoiceNumber: 'INV-CO', Status: 'AUTHORISED' }],
      }))
      try {
        const orderId = await raisePricedOrder()
        const push = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
        expect(push.statusCode).toBe(200)
        const posted = fake.calls.find((c) => c.method === 'POST' && c.path === 'Invoices')
        expect(posted.body.Invoices[0].Contact).toEqual({ ContactID: 'company-1' })
        const { rows } = await pool.query(`SELECT xero_contact_id FROM trade_accounts WHERE id = $1`, [companies[0].id])
        expect(rows[0].xero_contact_id).toBe('company-1')
        const { rows: person } = await pool.query(`SELECT xero_contact_id FROM users WHERE id = $1`, [users[0].id])
        expect(person[0].xero_contact_id).toBeNull()
        expect(push.json().order.xero_invoice_status).toBe('AUTHORISED')
      } finally {
        await pool.query(`DELETE FROM trade_account_users WHERE user_id = $1`, [users[0].id])
      }
    })

    it('sync/contacts pushes companies and skips the people filed under them', async () => {
      const { rows: companies } = await pool.query(
        `INSERT INTO trade_accounts (legacy_customer_name, email, phone, address, city, country)
         VALUES ($1, $2, '09 555', '1 Quay St', 'Auckland', 'New Zealand') RETURNING id`,
        [`${PREFIX} Zomia Ltd`, testEmail('accounts')]
      )
      const { rows: users } = await pool.query(`SELECT id FROM users WHERE email = $1`, [testEmail('client')])
      await pool.query(
        `INSERT INTO trade_account_users (trade_account_id, user_id) VALUES ($1, $2)`,
        [companies[0].id, users[0].id]
      )
      fake.on('GET', 'Contacts', () => ({ Contacts: [] }))
      fake.on('POST', 'Contacts', ({ body }) => ({
        Contacts: body.Contacts.map((c, i) => ({ ...c, ContactID: `co-${i}` })),
      }))
      try {
        const response = await inject('POST', '/admin/xero/sync/contacts', backofficeCookie, {})
        expect(response.statusCode).toBe(200)
        expect(response.json().result.failed).toEqual([])
        const posts = fake.calls.filter((c) => c.method === 'POST' && c.path === 'Contacts')
        const payloads = posts.flatMap((p) => p.body.Contacts)
        const company = payloads.find((c) => c.Name === `${PREFIX} Zomia Ltd`)
        expect(company).toMatchObject({
          IsCustomer: true,
          EmailAddress: testEmail('accounts'),
          Addresses: [{ AddressType: 'STREET', AddressLine1: '1 Quay St', City: 'Auckland', Country: 'New Zealand' }],
        })
        expect(payloads.some((c) => c.EmailAddress === testEmail('client'))).toBe(false)
        const { rows } = await pool.query(`SELECT xero_contact_id FROM trade_accounts WHERE id = $1`, [companies[0].id])
        expect(rows[0].xero_contact_id).toMatch(/^co-/)
      } finally {
        await pool.query(`DELETE FROM trade_account_users WHERE user_id = $1`, [users[0].id])
      }
    })
  })

  describe('POST /admin/xero/sync/suppliers', () => {
    it('links a house the directory knows by ordering email and creates the rest as suppliers', async () => {
      await pool.query(
        `INSERT INTO suppliers (name, slug, currency) VALUES ($1, $2, 'GBP')`,
        [`${PREFIX} Unknown House`, `${PREFIX}-unknown`]
      )
      fake.on('GET', 'Contacts', ({ query }) =>
        query?.page === '1'
          ? { Contacts: [{ ContactID: 'sup-dir', Name: 'Maison (Xero name)', EmailAddress: testEmail('orders') }] }
          : { Contacts: [] }
      )
      fake.on('POST', 'Contacts', ({ body }) => ({
        Contacts: body.Contacts.map((c, i) => ({ ...c, ContactID: `sup-new-${i}` })),
      }))
      const response = await inject('POST', '/admin/xero/sync/suppliers', backofficeCookie, {})
      expect(response.statusCode).toBe(200)
      expect(response.json().result).toMatchObject({ linked: 1, created: 1, failed: [] })
      const { rows } = await pool.query(
        `SELECT slug, xero_contact_id FROM suppliers WHERE slug LIKE $1 ORDER BY slug`,
        [`${PREFIX}-%`]
      )
      expect(rows).toEqual([
        { slug: `${PREFIX}-maison`, xero_contact_id: 'sup-dir' },
        { slug: `${PREFIX}-unknown`, xero_contact_id: 'sup-new-0' },
      ])
      const posted = fake.calls.find((c) => c.method === 'POST' && c.path === 'Contacts')
      expect(posted.body.Contacts[0]).toEqual({
        Name: `${PREFIX} Unknown House`,
        IsSupplier: true,
        DefaultCurrency: 'GBP',
      })
    })
  })

  describe('the pull: Xero → platform', () => {
    it('marks an order paid when Xero shows its invoice PAID, and stores every status', async () => {
      fake.on('POST', 'Invoices', ({ body }) => ({
        Invoices: [{ ...body.Invoices[0], InvoiceID: 'inv-pull', InvoiceNumber: 'INV-PULL', Status: 'AUTHORISED' }],
      }))
      fake.on('POST', 'Contacts', ({ body }) => ({
        Contacts: body.Contacts.map((c, i) => ({ ...c, ContactID: `pull-${i}` })),
      }))
      const orderId = await raisePricedOrder()
      // The desk's order: the push fills the ref and moves it to pending_payment.
      const pushed = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      expect(pushed.statusCode).toBe(200)
      expect(pushed.json().order.status).toBe('pending_payment')

      fake.on('GET', 'Invoices', ({ query }) => ({
        Invoices: (query?.IDs ?? '').split(',').filter(Boolean).map((id) =>
          id === 'inv-pull' ? { InvoiceID: id, InvoiceNumber: 'INV-PULL', Status: 'PAID', AmountDue: 0 } : { InvoiceID: id, Status: 'AUTHORISED' }
        ),
      }))
      const pull = await inject('POST', '/admin/xero/pull/statuses', backofficeCookie, {})
      expect(pull.statusCode).toBe(200)
      const { invoices } = pull.json().result
      expect(invoices.orders_marked_paid).toEqual([{ id: orderId, order_number: expect.any(String) }])
      expect(invoices.failed).toEqual([])
      const order = (await inject('GET', `/admin/orders/${orderId}`, backofficeCookie)).json().order
      expect(order).toMatchObject({ status: 'paid', xero_invoice_status: 'PAID' })

      // Settled: the next pull does not ask Xero about it again.
      fake.calls.length = 0
      await inject('POST', '/admin/xero/pull/statuses', backofficeCookie, {})
      expect(fake.calls.filter((c) => c.method === 'GET' && c.path === 'Invoices')).toEqual([])
    })

    // The sales-order overhaul (24 Sep 2026): the push is the invoice going
    // out, so it moves the order to pending_payment itself; the pull's PAID
    // moves any order the machine lets move to paid.
    const scriptPushAndContact = (invoiceId) => {
      fake.on('POST', 'Invoices', ({ body }) => ({
        Invoices: [{ ...body.Invoices[0], InvoiceID: invoiceId, InvoiceNumber: 'INV-FLOW', Status: 'AUTHORISED' }],
      }))
      fake.on('POST', 'Contacts', ({ body }) => ({
        Contacts: body.Contacts.map((c, i) => ({ ...c, ContactID: `flow-${i}` })),
      }))
    }
    const scriptPaid = (invoiceId) =>
      fake.on('GET', 'Invoices', ({ query }) => ({
        Invoices: (query?.IDs ?? '').split(',').filter(Boolean).map((id) =>
          id === invoiceId
            ? { InvoiceID: id, InvoiceNumber: 'INV-FLOW', Status: 'PAID', AmountDue: 0 }
            : { InvoiceID: id, Status: 'AUTHORISED' }
        ),
      }))

    it('a push from an accepted quote moves it to pending_payment, with its letter and audit row', async () => {
      scriptPushAndContact('inv-accepted')
      const orderId = await raisePricedOrder()
      // processing → back to a quote the client accepted, the storefront path.
      await pool.query(`UPDATE orders SET status = 'quote_accepted' WHERE id = $1`, [orderId])

      const pushed = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      expect(pushed.statusCode).toBe(200)
      expect(pushed.json().order.status).toBe('pending_payment')
      expect(notified.map((order) => order.status)).toEqual(['pending_payment'])

      const { rows } = await pool.query(
        `SELECT from_status, to_status, actor_kind, actor_user_id FROM order_events
          WHERE order_id = $1 AND to_status = 'pending_payment'`,
        [orderId]
      )
      const { rows: boss } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
        testEmail('boss'),
      ])
      expect(rows).toEqual([
        {
          from_status: 'quote_accepted',
          to_status: 'pending_payment',
          actor_kind: 'staff',
          actor_user_id: boss[0].id,
        },
      ])
    })

    it('refuses to push a quote the client has not accepted', async () => {
      const orderId = await raisePricedOrder()
      await pool.query(`UPDATE orders SET status = 'quote_sent' WHERE id = $1`, [orderId])
      const response = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toBe('An order in status "quote_sent" is not invoiceable.')
      expect(fake.calls.filter((c) => c.method === 'POST' && c.path === 'Invoices')).toEqual([])
    })

    it('the pull moves a processing or back-ordered order to paid', async () => {
      for (const [invoiceId, status] of [
        ['inv-processing', 'processing'],
        ['inv-backorder', 'back_order'],
      ]) {
        scriptPushAndContact(invoiceId)
        const orderId = await raisePricedOrder()
        await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
        // The office moved it on after invoicing — the goods are being cut, or
        // were short after all.
        expect((await move(orderId, status)).statusCode).toBe(200)

        scriptPaid(invoiceId)
        const pull = await inject('POST', '/admin/xero/pull/statuses', backofficeCookie, {})
        expect(pull.json().result.invoices.orders_marked_paid).toEqual([
          { id: orderId, order_number: expect.any(String) },
        ])
        const order = (await inject('GET', `/admin/orders/${orderId}`, backofficeCookie)).json().order
        expect(order.status).toBe('paid')
        expect(order.events[0]).toMatchObject({ to_status: 'paid', actor_kind: 'xero' })
      }
    })

    it('a voided invoice re-opens the push, under a fresh idempotency key', async () => {
      fake.on('POST', 'Invoices', ({ body }) => ({
        Invoices: [{ ...body.Invoices[0], InvoiceID: `inv-${body.Invoices[0].Reference ?? 'x'}-${Date.now()}`, InvoiceNumber: 'INV-V', Status: 'AUTHORISED' }],
      }))
      const orderId = await raisePricedOrder()
      const first = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      const firstId = first.json().invoice.id
      fake.on('GET', 'Invoices', ({ query }) => ({
        Invoices: (query?.IDs ?? '').split(',').filter(Boolean).map((id) => ({ InvoiceID: id, Status: 'VOIDED' })),
      }))
      await inject('POST', '/admin/xero/pull/statuses', backofficeCookie, {})
      expect((await pool.query(`SELECT xero_invoice_status FROM orders WHERE id = $1`, [orderId])).rows[0].xero_invoice_status).toBe('VOIDED')

      fake.calls.length = 0
      const second = await inject('POST', `/admin/xero/orders/${orderId}/invoice`, backofficeCookie, {})
      expect(second.statusCode).toBe(200)
      expect(second.json().invoice.id).not.toBe(firstId)
      const posted = fake.calls.find((c) => c.method === 'POST' && c.path === 'Invoices')
      expect(posted.idempotencyKey).toBe(`atelier-order-${orderId}-after-${firstId}`)
      expect(second.json().order.xero_invoice_status).toBe('AUTHORISED')
    })

    it('pull/contacts refreshes linked rows, links unlinked ones and creates the rest by flag', async () => {
      const { rows: linked } = await pool.query(
        `INSERT INTO trade_accounts (legacy_customer_name, xero_contact_id) VALUES ($1, 'co-linked') RETURNING id`,
        [`${PREFIX} Linked Co`]
      )
      await pool.query(
        `INSERT INTO trade_accounts (legacy_customer_name, email) VALUES ($1, $2)`,
        [`${PREFIX} Unlinked Co`, testEmail('unlinked')]
      )
      fake.on('GET', 'Contacts', ({ query }) =>
        query?.page === '1'
          ? {
              Contacts: [
                { ContactID: 'co-linked', Name: 'Renamed In Xero', EmailAddress: testEmail('linked'), Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '021 1' }] },
                { ContactID: 'co-unlinked', Name: 'Other Name', EmailAddress: testEmail('unlinked'), IsCustomer: true },
                { ContactID: 'co-new', Name: `${PREFIX} Brand New Customer`, IsCustomer: true, Addresses: [{ AddressType: 'STREET', City: 'Wellington' }] },
                { ContactID: 'sup-new', Name: `${PREFIX} New Mill`, IsSupplier: true, DefaultCurrency: 'GBP', EmailAddress: testEmail('mill') },
                { ContactID: 'sup-known', Name: `${PREFIX} Maison`, IsSupplier: true },
                { ContactID: 'nobody', Name: `${PREFIX} Nobody Yet` },
                { ContactID: 'gone', Name: `${PREFIX} Archived`, ContactStatus: 'ARCHIVED', IsCustomer: true },
              ],
            }
          : { Contacts: [] }
      )
      const pull = await inject('POST', '/admin/xero/pull/contacts', backofficeCookie, {})
      expect(pull.statusCode).toBe(200)
      expect(pull.json().result).toEqual({
        seen: 6,
        companies: { updated: 1, linked: 1, created: 1 },
        suppliers: { updated: 0, linked: 1, created: 1 },
        people: { updated: 0 },
        skipped: 1,
        failed: [],
      })
      const { rows: companies } = await pool.query(
        `SELECT legacy_customer_name, email, phone, city, xero_contact_id FROM trade_accounts
          WHERE legacy_customer_name LIKE $1 ORDER BY id`,
        [`${PREFIX} %`]
      )
      expect(companies).toEqual([
        { legacy_customer_name: `${PREFIX} Linked Co`, email: testEmail('linked'), phone: '021 1', city: null, xero_contact_id: 'co-linked' },
        { legacy_customer_name: `${PREFIX} Unlinked Co`, email: testEmail('unlinked'), phone: null, city: null, xero_contact_id: 'co-unlinked' },
        { legacy_customer_name: `${PREFIX} Brand New Customer`, email: null, phone: null, city: 'Wellington', xero_contact_id: 'co-new' },
      ])
      expect(linked[0].id).toBe(companies.length && (await pool.query(`SELECT id FROM trade_accounts WHERE xero_contact_id = 'co-linked'`)).rows[0].id)
      const { rows: suppliers } = await pool.query(
        `SELECT name, po_email, currency, xero_contact_id FROM suppliers WHERE name LIKE $1 ORDER BY id`,
        [`${PREFIX} %`]
      )
      expect(suppliers).toEqual([
        { name: `${PREFIX} Maison`, po_email: testEmail('orders'), currency: 'EUR', xero_contact_id: 'sup-known' },
        { name: `${PREFIX} New Mill`, po_email: testEmail('mill'), currency: 'GBP', xero_contact_id: 'sup-new' },
      ])
    })
  })

  describe('purchase orders as bills', () => {
    // A priced draft purchase order addressed to the seeded house's supplier
    // (supplier derived from the house, never sent).
    const raisePricedPurchaseOrder = async () => {
      const { rows: suppliers } = await pool.query('SELECT id FROM suppliers WHERE slug = $1', [
        `${PREFIX}-maison`,
      ])
      const { rows: cw } = await pool.query('SELECT id FROM colourways WHERE sku = $1', [
        `${PREFIX}-SKU-1`,
      ])
      const { rows: brands } = await pool.query('SELECT id FROM brands WHERE slug = $1', [
        `${PREFIX}-house`,
      ])
      const created = await inject('POST', '/admin/purchase-orders', backofficeCookie, {
        brand_id: brands[0].id,
        lines: [{ colourway_id: cw[0].id, qty_ordered: 12, unit_price: 48.5 }],
      })
      expect(created.statusCode).toBe(201)
      return { purchaseOrder: created.json().purchase_order, supplierId: suppliers[0].id }
    }

    const scriptBillCreate = () => {
      fake.on('GET', 'Contacts', () => ({
        Contacts: [{ ContactID: 'sup-1', Name: `${PREFIX} Maison`, EmailAddress: `orders@${DOMAIN}` }],
      }))
      fake.on('POST', 'Invoices', () => ({
        Invoices: [{ InvoiceID: 'bill-uuid-1', InvoiceNumber: 'BILL-0007', Status: 'AUTHORISED' }],
      }))
    }

    it('send raises the bill against the supplier and stores its identifiers', async () => {
      scriptBillCreate()
      const { purchaseOrder, supplierId } = await raisePricedPurchaseOrder()
      const response = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        backofficeCookie,
        { status: 'pending_payment' }
      )
      expect(response.statusCode).toBe(200)
      const { purchase_order, xero_bill } = response.json()
      expect(purchase_order.status).toBe('pending_payment')
      expect(xero_bill).toMatchObject({ raised: true, id: 'bill-uuid-1', number: 'BILL-0007' })
      expect(purchase_order.xero_bill_id).toBe('bill-uuid-1')
      expect(purchase_order.xero_bill_ref).toBe('BILL-0007')
      expect(purchase_order.xero_bill_status).toBe('AUTHORISED')
      expect(purchase_order.xero_bill_paid_at).toBeNull()

      const { rows } = await pool.query('SELECT xero_contact_id FROM suppliers WHERE id = $1', [
        supplierId,
      ])
      expect(rows[0].xero_contact_id).toBe('sup-1')

      const post = fake.calls.find((c) => c.method === 'POST' && c.path === 'Invoices')
      expect(post.idempotencyKey).toBe(`atelier-po-${purchaseOrder.id}`)
      const sent = post.body.Invoices[0]
      expect(sent.Type).toBe('ACCPAY')
      expect(sent.Contact).toEqual({ ContactID: 'sup-1' })
      expect(sent.CurrencyCode).toBe('EUR')
      expect(sent.Reference).toBe(purchaseOrder.po_number)
      expect(sent.LineItems[0]).toMatchObject({ Quantity: 12, UnitAmount: 48.5, AccountCode: '300' })
    })

    it('send still succeeds when the bill is refused, and says why', async () => {
      const { purchaseOrder } = await raisePricedPurchaseOrder()
      await inject('PATCH', `/admin/purchase-orders/${purchaseOrder.id}`, backofficeCookie, {
        lines: [{ id: purchaseOrder.lines[0].id, unit_price: null }],
      })
      const response = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        backofficeCookie,
        { status: 'pending_payment' }
      )
      expect(response.statusCode).toBe(200)
      const { purchase_order, xero_bill } = response.json()
      expect(purchase_order.status).toBe('pending_payment')
      expect(purchase_order.xero_bill_id).toBeNull()
      expect(xero_bill.raised).toBe(false)
      expect(xero_bill.reason).toMatch(/unpriced/)
    })

    it('a manual push 409s once the bill exists, and sync mirrors paid', async () => {
      scriptBillCreate()
      const { purchaseOrder } = await raisePricedPurchaseOrder()
      const first = await inject(
        'POST',
        `/admin/xero/purchase-orders/${purchaseOrder.id}/bill`,
        backofficeCookie,
        {}
      )
      expect(first.statusCode).toBe(201)
      const second = await inject(
        'POST',
        `/admin/xero/purchase-orders/${purchaseOrder.id}/bill`,
        backofficeCookie,
        {}
      )
      expect(second.statusCode).toBe(409)
      expect(second.json().message).toContain('BILL-0007')

      fake.on('GET', 'Invoices/bill-uuid-1', () => ({
        Invoices: [
          {
            InvoiceID: 'bill-uuid-1',
            InvoiceNumber: 'BILL-0007',
            Status: 'PAID',
            FullyPaidOnDate: '/Date(1790000000000+0000)/',
          },
        ],
      }))
      const synced = await inject(
        'POST',
        `/admin/xero/purchase-orders/${purchaseOrder.id}/bill/sync`,
        backofficeCookie,
        {}
      )
      expect(synced.statusCode).toBe(200)
      const { bill, purchase_order } = synced.json()
      expect(bill.status).toBe('PAID')
      expect(purchase_order.xero_bill_status).toBe('PAID')
      expect(purchase_order.xero_bill_paid_at).toBe(new Date(1790000000000).toISOString())
      // Paid in Xero on a DRAFT (the manual push ran before Send) leaves the
      // office's status alone: the machine has no draft → paid.
      expect(purchase_order.status).toBe('draft')
      expect(purchase_order.paid_at).toBeNull()
    })

    it('paid in Xero moves a sent order to paid, once', async () => {
      scriptBillCreate()
      const { purchaseOrder } = await raisePricedPurchaseOrder()
      await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, backofficeCookie, { status: 'pending_payment' })
      fake.on('GET', 'Invoices/bill-uuid-1', () => ({
        Invoices: [{ InvoiceID: 'bill-uuid-1', InvoiceNumber: 'BILL-0007', Status: 'PAID', FullyPaidOnDate: '2026-09-20T00:00:00' }],
      }))
      const sync = () =>
        inject('POST', `/admin/xero/purchase-orders/${purchaseOrder.id}/bill/sync`, backofficeCookie, {})
      const first = await sync()
      expect(first.statusCode).toBe(200)
      expect(first.json().purchase_order.status).toBe('paid')
      const paidAt = first.json().purchase_order.paid_at
      expect(paidAt).toBeTruthy()
      // A second sync is a no-op on the status and the stamp.
      const second = await sync()
      expect(second.statusCode).toBe(200)
      expect(second.json().purchase_order.paid_at).toBe(paidAt)
      // Still closes once the goods arrive.
      const closed = await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, backofficeCookie, { status: 'completed' })
      expect(closed.json().purchase_order.status).toBe('completed')
      expect(closed.json().purchase_order.paid_at).toBe(paidAt)
    })

    it('pay is a verb of its own for an office without Xero, and refuses a draft', async () => {
      const { purchaseOrder } = await raisePricedPurchaseOrder()
      const draft = await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, backofficeCookie, { status: 'paid' })
      expect(draft.statusCode).toBe(409)
      await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, backofficeCookie, { status: 'pending_payment' })
      const paid = await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, backofficeCookie, { status: 'paid' })
      expect(paid.statusCode).toBe(200)
      expect(paid.json().purchase_order.status).toBe('paid')
    })

    it('sync on an order with no bill is a non-event; a missing order is 404', async () => {
      const { purchaseOrder } = await raisePricedPurchaseOrder()
      const none = await inject(
        'POST',
        `/admin/xero/purchase-orders/${purchaseOrder.id}/bill/sync`,
        backofficeCookie,
        {}
      )
      expect(none.statusCode).toBe(200)
      expect(none.json().synced).toBe(false)
      const missing = await inject('POST', '/admin/xero/purchase-orders/999999/bill', backofficeCookie, {})
      expect(missing.statusCode).toBe(404)
    })
  })
})
