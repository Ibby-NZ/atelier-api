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
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Xero House', `${PREFIX}-house`]
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
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
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

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  // A priced, account-owned order ready to invoice: the customer requests it,
  // the back office prices the line.
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
    return order.id
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
    const xero = createXeroService({ pool, config: XERO_CONFIG, http: fake })
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
})
