import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'
import { createOrderRequest } from '../src/orders/order-request.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'admin-ord-test'
const DOMAIN = 'admin-ord-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const SKU = {
  inStock: `${PREFIX}-INSTOCK`,
  // A second stocked colourway, so an added line can be told apart from the one
  // the storefront request already placed.
  second: `${PREFIX}-SECOND`,
  // No inventory row at all: a design that has never been stocked. Every
  // reservation write must simply match nothing for it, rather than fail.
  unstocked: `${PREFIX}-UNSTOCKED`,
}

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Admin Ord House', `${PREFIX}-house`]
  )
  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Admin InStock', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brands[0].id, `${PREFIX}-instock`]
  )
  const { rows: cw } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Default', $2), ($1, 'Second', $3), ($1, 'Unstocked', $4)
     RETURNING id, sku`,
    [products[0].id, SKU.inStock, SKU.second, SKU.unstocked]
  )
  const idBySku = new Map(cw.map((row) => [row.sku, row.id]))
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 100, 0, 'metres'), ($2, 50, 0, 'metres')`,
    [idBySku.get(SKU.inStock), idBySku.get(SKU.second)]
  )
  return idBySku
}

// Orders + brand fixtures only — the staff/customer users are registered once in
// beforeAll and kept, because register shares a rate-limit bucket (10 / 15 min /
// IP) that re-registering every test would exhaust.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM orders
      WHERE id IN (
        SELECT ol.order_id FROM order_lines ol
          JOIN colourways c ON c.id = ol.colourway_id
         WHERE c.sku LIKE $1
      )`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

const inventoryFor = async (pool, sku) => {
  const { rows } = await pool.query(
    `SELECT i.qty_available, i.qty_reserved
       FROM inventory i JOIN colourways c ON c.id = i.colourway_id
      WHERE c.sku = $1`,
    [sku]
  )
  return {
    available: Number(rows[0].qty_available),
    reserved: Number(rows[0].qty_reserved),
  }
}

describe('back-office order management', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  // Refreshed by beforeEach, since the fixtures are rebuilt for every test.
  let colourwayId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  // Place a fresh in-stock order-request (status=quote_requested, reservation held).
  //
  // Calls the service DIRECTLY rather than POSTing to /orders/request, which is
  // the same reason the enquiry-delete block in test/contact.test.js INSERTs its
  // fixtures: this file needs ~30 orders and that route is rate-limited (10 per
  // 15 min per IP), so going through HTTP would spend the bucket and the rest of
  // the file would receive 429s instead of orders. app.inject always presents
  // the same address, so every call lands in one bucket.
  //
  // Nothing is lost by the shortcut. These orders are FIXTURES for the
  // /admin/orders tests below, not the subject of them; the route's own
  // behaviour — validation, the 422s, the mail — is covered in
  // test/orders.test.js, and this app is built with no mailer anyway.
  //
  // The line is PRICED before it is handed back (through the real PATCH, so the
  // money is recomputed the way the office's edit would): `quote_sent`,
  // `pending_payment` and `paid` refuse a $0.00 line, and most of this file drives the fixture
  // through them. Pass `{ unitPriceCents: 0 }` to get the raw storefront state.
  const placeRequest = async (qty = 10, { unitPriceCents = 1000 } = {}) => {
    const { order } = await createOrderRequest(pool, {
      lines: [{ sku: SKU.inStock, qty_metres: qty }],
      contact: { email: 'buyer@example.com' },
    })
    if (unitPriceCents === 0) return order
    const detail = await inject('GET', `/admin/orders/${order.id}`, backofficeCookie)
    const lineId = detail.json().order.lines[0].id
    const priced = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
      lines: [{ id: lineId, unit_price_cents: unitPriceCents }],
    })
    return priced.json().order
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
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanupFixtures(pool)
    await deleteUsers(pool)

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    colourwayId = await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await inject('GET', '/admin/orders', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await inject('GET', '/admin/orders', customerCookie)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/orders', () => {
    it('lists orders with lines and reservation state', async () => {
      const placed = await placeRequest(10)
      const response = await inject('GET', '/admin/orders', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const order = response.json().orders.find((o) => o.id === placed.id)
      expect(order.reservation_state).toBe('held')
      expect(order.lines[0].sku).toBe(SKU.inStock)
      expect(Number(order.lines[0].reserved_qty)).toBe(10)
      expect(Number(order.lines[0].inventory.qty_reserved)).toBe(10)
    })

    // A line names where it came from, so the CRM can open the catalogue
    // record behind a SKU rather than retyping it (Userback 8367841).
    it('each line carries the product id, slug and colourway name', async () => {
      const placed = await placeRequest(1)
      const response = await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)
      const [line] = response.json().order.lines
      expect(line.product_id).toEqual(expect.any(Number))
      expect(line.product_slug).toEqual(expect.any(String))
      expect(line.colourway_name).toEqual(expect.any(String))
      // And its unit, so "10" reads as metres on the order desk.
      expect(line.unit).toBe('metres')
    })

    // GST is a function of the total and the Xero basis (Exclusive unless
    // configured), computed at read time on every admin order response so the
    // Money block and the invoice agree (Userback 8367857).
    it('every order answers with its GST figures on the configured basis', async () => {
      const placed = await placeRequest(1)
      const one = await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)
      const { order } = one.json()
      expect(order.gst).toEqual({
        basis: 'Exclusive',
        rate: 0.15,
        gst_cents: Math.round(Number(order.total_cents) * 0.15),
        total_incl_gst_cents: Number(order.total_cents) + Math.round(Number(order.total_cents) * 0.15),
      })
      const list = await inject('GET', '/admin/orders', backofficeCookie)
      expect(list.json().orders.find((o) => o.id === placed.id).gst.basis).toBe('Exclusive')
    })

    it('filters by status', async () => {
      const placed = await placeRequest(10)
      const shipped = await inject('GET', '/admin/orders?status=shipped', backofficeCookie)
      expect(shipped.json().orders.some((o) => o.id === placed.id)).toBe(false)
      const requested = await inject(
        'GET',
        '/admin/orders?status=quote_requested',
        backofficeCookie
      )
      expect(requested.json().orders.some((o) => o.id === placed.id)).toBe(true)
    })

    // The CRM's Source filter rides on this. Without it the office can only
    // narrow the page it already fetched, and the count above the table lies.
    it('filters by kind, so a website order can be told from a keyed one', async () => {
      const placed = await placeRequest(4)

      const requests = await inject(
        'GET',
        '/admin/orders?kind=order_request',
        backofficeCookie
      )
      expect(requests.statusCode).toBe(200)
      expect(requests.json().orders.some((o) => o.id === placed.id)).toBe(true)

      // A checkout order is one nobody keyed, so the request placed above must
      // not appear under it.
      const website = await inject('GET', '/admin/orders?kind=checkout', backofficeCookie)
      expect(website.json().orders.some((o) => o.id === placed.id)).toBe(false)

      // The total has to narrow with the rows, or a paged screen prints a
      // server count above a filtered table.
      expect(website.json().meta.total).toBeLessThan(requests.json().meta.total + 1)
    })

    it('rejects an unknown kind filter with 400', async () => {
      const response = await inject('GET', '/admin/orders?kind=bogus', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })

    it('rejects an unknown status filter with 400', async () => {
      const response = await inject('GET', '/admin/orders?status=bogus', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })

    // The list and the by-id read are two queries over one projection, so the
    // account join has to be in both or a screen names the client only when it
    // opens the order.
    it('names the client on every listed order placed under an account', async () => {
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
        testEmail('shopper'),
      ])
      const created = await inject('POST', '/admin/orders', backofficeCookie, {
        user_id: rows[0].id,
        lines: [{ colourway_id: colourwayId.get(SKU.inStock), qty: 1, unit_price_cents: 100 }],
      })
      const id = created.json().order.id
      const response = await inject('GET', '/admin/orders', backofficeCookie)
      const order = response.json().orders.find((o) => o.id === id)
      expect(order.client_email).toBe(testEmail('shopper'))
    })
  })

  // The one status route (24 Sep 2026): every move the office makes, checked by
  // the machine in src/orders/order-states.js, with the stock settled on the
  // TRANSITION and an audit row for every move.
  describe('POST /admin/orders/:id/status', () => {
    const move = (id, status, extra = {}) =>
      inject('POST', `/admin/orders/${id}/status`, backofficeCookie, { status, ...extra })

    const eventsFor = async (id) =>
      (
        await pool.query(
          `SELECT from_status, to_status, actor_kind, actor_user_id, note
             FROM order_events WHERE order_id = $1 ORDER BY id`,
          [id]
        )
      ).rows

    const bossId = async () =>
      (await pool.query(`SELECT id FROM users WHERE email = $1`, [testEmail('boss')])).rows[0].id

    it('runs quote → accepted → processing → invoiced → paid → shipped → completed, converting the reservation', async () => {
      const placed = await placeRequest(10)
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 100, reserved: 10 })

      for (const status of ['quote_sent', 'quote_accepted', 'processing']) {
        const response = await move(placed.id, status)
        expect(response.statusCode).toBe(200)
        expect(response.json().order.status).toBe(status)
      }

      const invoiced = await move(placed.id, 'pending_payment', {
        xero_invoice_ref: 'INV-2026-001',
      })
      expect(invoiced.json().order.status).toBe('pending_payment')
      expect(invoiced.json().order.xero_invoice_ref).toBe('INV-2026-001')

      const paid = await move(placed.id, 'paid')
      expect(paid.json().order.status).toBe('paid')
      // Reservation still held through payment.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)

      const shipped = await move(placed.id, 'shipped')
      expect(shipped.json().order.status).toBe('shipped')
      expect(shipped.json().order.reservation_state).toBe('converted')
      // Reservation converted to a real decrement.
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 90, reserved: 0 })

      const completed = await move(placed.id, 'completed')
      expect(completed.json().order.reservation_state).toBe('converted')
      // Completing touches no stock.
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 90, reserved: 0 })
    })

    it('writes an audit row for every move, naming the staffer and the note', async () => {
      const placed = await placeRequest(10)
      await move(placed.id, 'quote_sent', { note: '  Priced off the trade list  ' })
      await move(placed.id, 'back_order')

      const events = await eventsFor(placed.id)
      const boss = await bossId()
      expect(events).toEqual([
        {
          from_status: 'quote_requested',
          to_status: 'quote_sent',
          actor_kind: 'staff',
          actor_user_id: boss,
          note: 'Priced off the trade list',
        },
        {
          from_status: 'quote_sent',
          to_status: 'back_order',
          actor_kind: 'staff',
          actor_user_id: boss,
          note: null,
        },
      ])

      // …and serves them on the order, newest first, with the staffer's name.
      const order = (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)).json()
        .order
      expect(order.events.map((event) => event.to_status)).toEqual(['back_order', 'quote_sent'])
      expect(order.events[0].actor_name).toBe('Boss')
      expect(order.quote_rejection_reason).toBeNull()
    })

    it('stamps quote_sent_at when the quote goes out', async () => {
      const placed = await placeRequest(10)
      await move(placed.id, 'quote_sent')
      const { rows } = await pool.query(`SELECT quote_sent_at FROM orders WHERE id = $1`, [
        placed.id,
      ])
      expect(rows[0].quote_sent_at).toBeInstanceOf(Date)
    })

    it('cancels a quote and releases its reservation', async () => {
      const placed = await placeRequest(15)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(15)

      const cancel = await move(placed.id, 'cancelled')
      expect(cancel.statusCode).toBe(200)
      expect(cancel.json().order.status).toBe('cancelled')
      expect(cancel.json().order.reservation_state).toBe('released')
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 100, reserved: 0 })
    })

    it('releases the reservation when a processing order is cancelled', async () => {
      const placed = await placeRequest(12)
      await move(placed.id, 'processing')
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(12)

      expect((await move(placed.id, 'cancelled')).statusCode).toBe(200)
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 100, reserved: 0 })
    })

    it('releases the reservation when a paid order is refunded before it ships', async () => {
      const placed = await placeRequest(8)
      await move(placed.id, 'pending_payment')
      await move(placed.id, 'paid')

      const refund = await move(placed.id, 'refunded')
      expect(refund.statusCode).toBe(200)
      expect(refund.json().order.reservation_state).toBe('released')
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 100, reserved: 0 })
    })

    it('touches no stock when a shipped order is refunded — it already left', async () => {
      const placed = await placeRequest(8)
      await move(placed.id, 'pending_payment')
      await move(placed.id, 'paid')
      await move(placed.id, 'shipped')
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 92, reserved: 0 })

      expect((await move(placed.id, 'refunded')).statusCode).toBe(200)
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({ available: 92, reserved: 0 })
    })

    it('takes an invoice move without a Xero reference', async () => {
      const placed = await placeRequest(10)
      const response = await move(placed.id, 'pending_payment')
      expect(response.statusCode).toBe(200)
      expect(response.json().order.xero_invoice_ref).toBeNull()
    })

    it('refuses a move the machine does not list with 409, touching nothing', async () => {
      const placed = await placeRequest(10)
      const response = await move(placed.id, 'shipped')
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toBe(
        'Cannot move an order from "quote_requested" to "shipped".'
      )
      // Reservation untouched and no audit row for the refused move.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
      expect(await eventsFor(placed.id)).toEqual([])
    })

    it('refuses to move a cancelled order anywhere', async () => {
      const placed = await placeRequest(10)
      await move(placed.id, 'cancelled')
      expect((await move(placed.id, 'quote_sent')).statusCode).toBe(409)
      expect((await move(placed.id, 'cancelled')).statusCode).toBe(409)
    })

    it('rejects an unknown status with 400', async () => {
      const placed = await placeRequest(10)
      // A word retired by the overhaul is not a status any more.
      expect((await move(placed.id, 'confirmed')).statusCode).toBe(400)
    })

    it('answers 404 for an unknown order', async () => {
      expect((await move(99999999, 'quote_sent')).statusCode).toBe(404)
    })

    it('rejects a non-backoffice caller with 403', async () => {
      const placed = await placeRequest(10)
      const response = await inject('POST', `/admin/orders/${placed.id}/status`, customerCookie, {
        status: 'quote_sent',
      })
      expect(response.statusCode).toBe(403)
    })
  })

  // A4 (Userback 8367567). "Your order has shipped" was the whole letter: the
  // office had nowhere to put the courier link, so it went out in a mail
  // somebody typed by hand, or nowhere.
  describe('moving to shipped — the tracking URL', () => {
    const TRACKING = 'https://tracking.courier.test/parcel/ABC123'

    const paidOrder = async () => {
      const placed = await placeRequest(10)
      await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'pending_payment', xero_invoice_ref: 'INV-TRACK' })
      await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'paid' })
      return placed
    }

    // The suite's own app carries no mailer, so a letter needs an app of its
    // own. Nothing is re-registered for it: a session is a stateless signed
    // cookie, so the boss's cookie is valid on any instance built with the same
    // secret — and the rate-limit bucket a second instance does NOT share is
    // precisely why registering again would be the wrong move.
    const shipCapturingMail = async (id, payload) => {
      const sent = []
      const mailed = buildApp({
        pool,
        cookieSecret: TEST_COOKIE_SECRET,
        mailer: createMailer({
          transport: { sendMail: async (message) => sent.push(message) },
          from: 'Atelier <no-reply@test.example>',
          backofficeEmail: 'office@test.example',
        }),
        logger: false,
      })
      await mailed.ready()
      try {
        const response = await mailed.inject({
          method: 'POST',
          url: `/admin/orders/${id}/status`,
          headers: { cookie: backofficeCookie },
          payload: { status: 'shipped', ...payload },
        })
        return { response, sent }
      } finally {
        await mailed.close()
      }
    }

    it('stores the link, returns it, and puts it in the shipped letter', async () => {
      const placed = await paidOrder()

      const { response, sent } = await shipCapturingMail(placed.id, {
        tracking_url: TRACKING,
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('shipped')
      expect(response.json().order.tracking_url).toBe(TRACKING)

      const { rows } = await pool.query(
        'SELECT tracking_url FROM orders WHERE id = $1',
        [placed.id]
      )
      expect(rows[0].tracking_url).toBe(TRACKING)

      const letter = sent.find((message) => message.subject.includes('has shipped'))
      expect(letter.text).toContain(TRACKING)
    })

    // The office hand-delivers plenty of orders. A letter reading "Track your
    // parcel:" with nothing after it is worse than one that never mentions it.
    // `''` is what a text input sends when the field is left empty — it means
    // hand-delivered, not "bad URL", and it must not be stored as an empty
    // string either (FR-127). The body-less ship the CRM sends today is proved
    // by the full-lifecycle test above.
    it('says nothing about tracking when the order is hand-delivered', async () => {
      const placed = await paidOrder()

      const { response, sent } = await shipCapturingMail(placed.id, { tracking_url: '' })

      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('shipped')
      expect(response.json().order.tracking_url).toBeNull()
      const letter = sent.find((message) => message.subject.includes('has shipped'))
      expect(letter.text).not.toContain('Track your parcel')
    })

    // The value lands in a client's inbox as a link, so `javascript:` and a
    // bare hostname are both refused before anything ships.
    it('refuses a tracking URL that is not http(s) with 400, and ships nothing', async () => {
      const placed = await paidOrder()

      const response = await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'shipped', tracking_url: 'javascript:alert(1)' })

      expect(response.statusCode).toBe(400)
      const order = (
        await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)
      ).json().order
      expect(order.status).toBe('paid')
      expect(order.tracking_url).toBeNull()
      // The refused transition converted no reservation.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
    })
  })

  describe('PATCH /admin/orders/:id', () => {
    it('edits a line quantity and adjusts the reservation to match', async () => {
      const placed = await placeRequest(10)
      const order = (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie))
        .json().order

      const response = await inject(
        'PATCH',
        `/admin/orders/${placed.id}`,
        backofficeCookie,
        { lines: [{ id: order.lines[0].id, qty: 25 }] }
      )
      expect(response.statusCode).toBe(200)
      expect(Number(response.json().order.lines[0].qty)).toBe(25)
      // 10 -> 25 raises the reservation by 15.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(25)
    })

    it('rejects editing a shipped order with 409', async () => {
      const placed = await placeRequest(10)
      const order = (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie))
        .json().order
      await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'pending_payment', xero_invoice_ref: 'INV-X' })
      await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'paid' })
      await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'shipped' })

      const response = await inject('PATCH', `/admin/orders/${placed.id}`, backofficeCookie, {
        lines: [{ id: order.lines[0].id, qty: 5 }],
      })
      expect(response.statusCode).toBe(409)
    })
  })

  // A storefront request arrives with every line at $0.00 — "not priced yet",
  // not "free" — and used to confirm and invoice at nil. The moves that state a
  // price (quote_sent, pending_payment, paid) refuse until every line is priced
  // (422, not 409: it is a business rule, not a wrong state), naming the count
  // so the desk knows what is left.
  describe('unpriced lines (422)', () => {
    const orderFor = async (id) =>
      (await inject('GET', `/admin/orders/${id}`, backofficeCookie)).json().order

    it('refuses to send a quote while any line is unpriced and names the count', async () => {
      const placed = await placeRequest(10, { unitPriceCents: 0 })
      await inject('PATCH', `/admin/orders/${placed.id}`, backofficeCookie, {
        add_lines: [{ colourway_id: colourwayId.get(SKU.second), qty: 1, unit_price_cents: 0 }],
      })
      const response = await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, {
        status: 'quote_sent',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/send the quote — 2 lines are still at \$0\.00/)
      expect((await orderFor(placed.id)).status).toBe('quote_requested')
    })

    it('lets an unpriced order go on back order — no price is stated', async () => {
      const placed = await placeRequest(10, { unitPriceCents: 0 })
      const response = await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, {
        status: 'back_order',
      })
      expect(response.statusCode).toBe(200)
    })

    it('refuses paid after an invoiced order was zeroed back', async () => {
      const placed = await placeRequest(10)
      const invoiced = await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, {
        status: 'pending_payment',
        xero_invoice_ref: 'INV-1',
      })
      expect(invoiced.statusCode).toBe(200)
      // A price edit is still allowed at `pending_payment`.
      await inject('PATCH', `/admin/orders/${placed.id}`, backofficeCookie, {
        lines: [{ id: placed.lines[0].id, unit_price_cents: 0 }],
      })
      const response = await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, {
        status: 'paid',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/1 line is still at \$0\.00/)
      expect((await orderFor(placed.id)).status).toBe('pending_payment')
    })
  })

  // A sales order the office keys itself. It lands in the same queue as a
  // storefront request and drives the same lifecycle from there — what differs
  // is that it carries prices from the first minute and names its own client.
  describe('POST /admin/orders', () => {
    const lineFor = (sku, extra = {}) => ({
      colourway_id: colourwayId.get(sku),
      qty: 4,
      unit_price_cents: 12550,
      ...extra,
    })

    const create = (payload) =>
      inject('POST', '/admin/orders', backofficeCookie, payload)

    it('creates a priced manual order against a client account and holds stock', async () => {
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
        testEmail('shopper'),
      ])
      const response = await create({
        user_id: rows[0].id,
        lines: [lineFor(SKU.inStock, { qty: 4, cut_requirements: 'Cut one length' })],
        notes: 'Phoned in.',
      })

      expect(response.statusCode).toBe(201)
      const order = response.json().order
      expect(order.kind).toBe('manual')
      expect(order.status).toBe('quote_requested')
      expect(order.order_number).toMatch(/^SO-[0-9A-F]{8}$/)
      expect(order.user_id).toBe(rows[0].id)
      // An account's address lives on the account; duplicating it here goes stale.
      expect(order.guest_email).toBeNull()
      // ...which is why the read joins it back: without this the CRM can only
      // say "Account #<id>" on every order placed under a login.
      expect(order.client_email).toBe(testEmail('shopper'))
      expect(order.reservation_state).toBe('held')
      // 4 x 125.50 — the whole point of a manual order over a request.
      expect(order.subtotal_cents).toBe(50200)
      expect(order.total_cents).toBe(50200)
      expect(order.lines[0].unit_price_cents).toBe(12550)
      expect(order.lines[0].cut_requirements).toBe('Cut one length')
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(4)
    })

    it('records a walk-in from contact details alone', async () => {
      const response = await create({
        contact: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '021 555' },
        lines: [lineFor(SKU.inStock)],
      })

      expect(response.statusCode).toBe(201)
      const order = response.json().order
      expect(order.user_id).toBeNull()
      expect(order.guest_email).toBe('ada@example.com')
      // No account, so nothing to join — the guest email is the only client.
      expect(order.client_name).toBeNull()
      expect(order.client_email).toBeNull()
      // The same packing a storefront request writes, so one CRM renderer reads both.
      expect(order.notes).toContain('Name: Ada Lovelace')
      expect(order.notes).toContain('Phone: 021 555')
    })

    // The client roster holds where its clients are, so the order desk does not
    // retype it: the CRM sends the address off the client it picked, into the
    // same column the webhook and a storefront request write.
    it('stores the delivery address the client record carried', async () => {
      const response = await create({
        contact: { name: 'Fernhill Interiors', email: 'hello@fernhill.test' },
        lines: [lineFor(SKU.inStock)],
        shipping_address: {
          name: 'Fernhill Interiors',
          line1: '12 Sale Street',
          city: 'Auckland',
          country: 'New Zealand',
        },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().order.shipping_address).toMatchObject({
        name: 'Fernhill Interiors',
        line1: '12 Sale Street',
        city: 'Auckland',
        country: 'New Zealand',
      })
    })

    // A client with nothing but a name on file has no address, and `{}` in the
    // column would print an empty Ship-to block on the packing slip.
    it('treats an address that says nowhere as no address at all', async () => {
      const response = await create({
        contact: { name: 'Walk-in' },
        lines: [lineFor(SKU.inStock)],
        shipping_address: { name: 'Walk-in', line1: '  ', city: '' },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().order.shipping_address).toBeNull()
    })

    it('reserves nothing for a colourway that has never been stocked', async () => {
      const response = await create({
        contact: { name: 'Walk-in' },
        lines: [lineFor(SKU.unstocked)],
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().order.lines[0].inventory).toBeNull()
      expect(response.json().order.lines[0].unit).toBeNull()
    })

    it('refuses an order nobody can be billed for with 422', async () => {
      const response = await create({ lines: [lineFor(SKU.inStock)] })
      expect(response.statusCode).toBe(422)
    })

    it('refuses an unknown colourway with 422 and writes nothing', async () => {
      const before = await pool.query('SELECT count(*)::int AS n FROM orders')
      const response = await create({
        contact: { name: 'Walk-in' },
        lines: [lineFor(SKU.inStock), { colourway_id: 99999999, qty: 1, unit_price_cents: 1 }],
      })

      expect(response.statusCode).toBe(422)
      // The whole order rolls back — a half-written sales order is worse than none.
      const after = await pool.query('SELECT count(*)::int AS n FROM orders')
      expect(after.rows[0].n).toBe(before.rows[0].n)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(0)
    })

    it('refuses an unknown client account with 422', async () => {
      const response = await create({
        user_id: 99999999,
        lines: [lineFor(SKU.inStock)],
      })
      expect(response.statusCode).toBe(422)
    })

    it('rejects an empty line list with 400', async () => {
      const response = await create({ contact: { name: 'Walk-in' }, lines: [] })
      expect(response.statusCode).toBe(400)
    })

    it('rejects a non-backoffice caller with 403', async () => {
      const response = await inject('POST', '/admin/orders', customerCookie, {
        contact: { name: 'Walk-in' },
        lines: [lineFor(SKU.inStock)],
      })
      expect(response.statusCode).toBe(403)
    })
  })

  // Pricing a storefront request in place: this is what turns the quote a
  // shopper submitted (every line at 0) into an invoiceable sales order.
  describe('PATCH /admin/orders/:id — pricing and line edits', () => {
    const orderFor = async (id) =>
      (await inject('GET', `/admin/orders/${id}`, backofficeCookie)).json().order

    const patch = (id, body) =>
      inject('PATCH', `/admin/orders/${id}`, backofficeCookie, body)

    it('prices a request line and recomputes the money, touching no stock', async () => {
      const placed = await placeRequest(10, { unitPriceCents: 0 })
      const order = await orderFor(placed.id)
      expect(order.subtotal_cents).toBe(0)

      const response = await patch(placed.id, {
        lines: [{ id: order.lines[0].id, unit_price_cents: 9900 }],
      })

      expect(response.statusCode).toBe(200)
      const priced = response.json().order
      expect(priced.lines[0].unit_price_cents).toBe(9900)
      expect(priced.subtotal_cents).toBe(99000)
      expect(priced.total_cents).toBe(99000)
      // Repricing is not a change of demand.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
    })

    it('adds a line, reserving its stock and re-totalling', async () => {
      const placed = await placeRequest(10, { unitPriceCents: 0 })

      const response = await patch(placed.id, {
        add_lines: [
          { colourway_id: colourwayId.get(SKU.second), qty: 3, unit_price_cents: 20000 },
        ],
      })

      expect(response.statusCode).toBe(200)
      const order = response.json().order
      expect(order.lines).toHaveLength(2)
      expect(order.subtotal_cents).toBe(60000)
      expect((await inventoryFor(pool, SKU.second)).reserved).toBe(3)
      // The original line's reservation is untouched.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
    })

    it('removes a line, releasing its stock', async () => {
      const placed = await placeRequest(10)
      const order = await orderFor(placed.id)
      await patch(placed.id, {
        add_lines: [
          { colourway_id: colourwayId.get(SKU.second), qty: 3, unit_price_cents: 20000 },
        ],
      })

      const response = await patch(placed.id, { remove_line_ids: [order.lines[0].id] })

      expect(response.statusCode).toBe(200)
      expect(response.json().order.lines).toHaveLength(1)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(0)
      expect((await inventoryFor(pool, SKU.second)).reserved).toBe(3)
    })

    it('refuses to leave an order with no lines', async () => {
      const placed = await placeRequest(10)
      const order = await orderFor(placed.id)

      const response = await patch(placed.id, { remove_line_ids: [order.lines[0].id] })

      expect(response.statusCode).toBe(422)
      // Nothing was released — the refusal rolled the whole edit back.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
      expect((await orderFor(placed.id)).lines).toHaveLength(1)
    })

    it('still accepts the qty-only body the CRM sent before', async () => {
      const placed = await placeRequest(10)
      const order = await orderFor(placed.id)

      const response = await patch(placed.id, {
        lines: [{ id: order.lines[0].id, qty: 25 }],
      })

      expect(response.statusCode).toBe(200)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(25)
    })

    it('edits the contact header without touching the lines', async () => {
      const placed = await placeRequest(10)

      const response = await patch(placed.id, {
        notes: 'Deliver to the site office.',
        contact_phone: '021 999',
      })

      expect(response.statusCode).toBe(200)
      expect(response.json().order.notes).toBe('Deliver to the site office.')
      expect(response.json().order.contact_phone).toBe('021 999')
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
    })

    it('rejects a line id belonging to another order with 422', async () => {
      const mine = await placeRequest(10)
      const theirs = await placeRequest(5)
      const theirLine = (await orderFor(theirs.id)).lines[0]

      const response = await patch(mine.id, {
        lines: [{ id: theirLine.id, unit_price_cents: 1 }],
      })
      expect(response.statusCode).toBe(422)
    })

    it('rejects an empty body with 400', async () => {
      const placed = await placeRequest(10)
      const response = await patch(placed.id, {})
      expect(response.statusCode).toBe(400)
    })

    // A4 (Userback 8367567). The note about a delivery — the courier used, the
    // phone call, what the client asked for on the doorstep — arrives once the
    // order is paid or shipped. A guard that refuses it there sends it to
    // somebody's notebook instead. `notes` ALONE is the whole relaxation.
    describe('notes past pending_payment', () => {
      const advanceTo = async (id, ...statuses) => {
        for (const status of statuses) {
          const response = await inject(
            'POST',
            `/admin/orders/${id}/status`,
            backofficeCookie,
            { status, xero_invoice_ref: 'INV-NOTES' }
          )
          expect(response.statusCode).toBe(200)
        }
      }

      it('accepts a notes-only patch on a paid order', async () => {
        const placed = await placeRequest(10)
        await advanceTo(placed.id, 'pending_payment', 'paid')

        const response = await patch(placed.id, { notes: 'Courier called, left with reception.' })

        expect(response.statusCode).toBe(200)
        expect(response.json().order.status).toBe('paid')
        expect(response.json().order.notes).toBe('Courier called, left with reception.')
      })

      it('accepts a notes-only patch on a shipped order', async () => {
        const placed = await placeRequest(10)
        await advanceTo(placed.id, 'pending_payment', 'paid', 'shipped')

        const response = await patch(placed.id, { notes: 'Client rang to say it arrived.' })

        expect(response.statusCode).toBe(200)
        expect(response.json().order.notes).toBe('Client rang to say it arrived.')
      })

      // The relaxation is one key wide. Notes in company with anything else is
      // an ordinary edit, and the money, the lines and the delivery details
      // stay frozen exactly as they were.
      it('keeps the status guard for every other body', async () => {
        const placed = await placeRequest(10)
        const order = await orderFor(placed.id)
        await advanceTo(placed.id, 'pending_payment', 'paid')

        const withCompany = await patch(placed.id, {
          notes: 'Courier called.',
          contact_phone: '021 555 0000',
        })
        expect(withCompany.statusCode).toBe(409)

        const lineEdit = await patch(placed.id, {
          lines: [{ id: order.lines[0].id, unit_price_cents: 1 }],
        })
        expect(lineEdit.statusCode).toBe(409)

        // Neither refusal wrote anything.
        const after = await orderFor(placed.id)
        expect(after.notes).toBe(order.notes)
        expect(after.contact_phone).toBeNull()
        expect(after.subtotal_cents).toBe(order.subtotal_cents)
      })
    })

    // The order page's Edit delivery. Where the cloth goes changes after the
    // money is settled as a matter of course — "send it to the upholsterer" —
    // and the packing slip prints this address, so it stays editable until the
    // order ships. Like notes, it is one key wide.
    describe('delivery details', () => {
      const advanceTo = async (id, ...statuses) => {
        for (const status of statuses) {
          const response = await inject(
            'POST',
            `/admin/orders/${id}/status`,
            backofficeCookie,
            { status, xero_invoice_ref: 'INV-DELIVERY' }
          )
          expect(response.statusCode).toBe(200)
        }
      }

      const DELIVERY = {
        name: ' Designers Collection ',
        line1: 'c/o The Foundation',
        line2: '8 George Street, Newmarket',
        city: 'Auckland',
        postal_code: '1023',
        country: 'New Zealand',
        phone: '09 307 7839',
        instructions: 'Mark parcel: Lounge',
      }

      it('stores the address, the delivery phone and the instructions, trimmed', async () => {
        const placed = await placeRequest(10)

        const response = await patch(placed.id, { shipping_address: DELIVERY })

        expect(response.statusCode).toBe(200)
        expect(response.json().order.shipping_address).toEqual({
          name: 'Designers Collection',
          line1: 'c/o The Foundation',
          line2: '8 George Street, Newmarket',
          city: 'Auckland',
          state: null,
          postal_code: '1023',
          country: 'New Zealand',
          phone: '09 307 7839',
          instructions: 'Mark parcel: Lounge',
        })
      })

      it('is accepted on a paid order and leaves the money exactly as it was', async () => {
        const placed = await placeRequest(10)
        await advanceTo(placed.id, 'pending_payment', 'paid')
        const before = await orderFor(placed.id)

        const response = await patch(placed.id, { shipping_address: DELIVERY })

        expect(response.statusCode).toBe(200)
        const after = response.json().order
        expect(after.status).toBe('paid')
        expect(after.shipping_address.line1).toBe('c/o The Foundation')
        expect(after.subtotal_cents).toBe(before.subtotal_cents)
        expect(after.total_cents).toBe(before.total_cents)
        expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
      })

      // Once shipped, the address is the record of where the order went.
      it('is refused once the order has shipped, and writes nothing', async () => {
        const placed = await placeRequest(10)
        await patch(placed.id, { shipping_address: DELIVERY })
        await advanceTo(placed.id, 'pending_payment', 'paid', 'shipped')

        const response = await patch(placed.id, {
          shipping_address: { ...DELIVERY, line1: '1 Somewhere Else' },
        })

        expect(response.statusCode).toBe(409)
        expect((await orderFor(placed.id)).shipping_address.line1).toBe('c/o The Foundation')
      })

      it('clears the address with null (collected from the showroom)', async () => {
        const placed = await placeRequest(10)
        await patch(placed.id, { shipping_address: DELIVERY })

        const response = await patch(placed.id, { shipping_address: null })

        expect(response.statusCode).toBe(200)
        expect(response.json().order.shipping_address).toBeNull()
      })

      // On the create paths an empty form is "no address"; here somebody pressed
      // Save, so a delivery that names nowhere is a mistake to say out loud.
      it('refuses an address that names neither a street nor a town', async () => {
        const placed = await placeRequest(10)
        await patch(placed.id, { shipping_address: DELIVERY })

        const response = await patch(placed.id, {
          shipping_address: { name: 'Designers Collection', phone: '09 307 7839', line1: ' ' },
        })

        expect(response.statusCode).toBe(422)
        expect(response.json().message).toMatch(/street or a town/)
        expect((await orderFor(placed.id)).shipping_address.line1).toBe('c/o The Foundation')
      })

      it('keeps the status guard when the address travels with anything else', async () => {
        const placed = await placeRequest(10)
        const order = await orderFor(placed.id)
        await advanceTo(placed.id, 'pending_payment', 'paid')

        const response = await patch(placed.id, {
          shipping_address: DELIVERY,
          lines: [{ id: order.lines[0].id, unit_price_cents: 1 }],
        })

        expect(response.statusCode).toBe(409)
        expect((await orderFor(placed.id)).shipping_address).toBeNull()
      })

      it('rides with an ordinary edit while the order is still being priced', async () => {
        const placed = await placeRequest(10)
        const order = await orderFor(placed.id)

        const response = await patch(placed.id, {
          shipping_address: DELIVERY,
          lines: [{ id: order.lines[0].id, unit_price_cents: 2000 }],
        })

        expect(response.statusCode).toBe(200)
        expect(response.json().order.shipping_address.city).toBe('Auckland')
        expect(response.json().order.subtotal_cents).toBe(20000)
      })
    })

    // What the packing slip prints under a design: the catalogue's own words.
    it('carries each line\'s composition, width, size and description from the product', async () => {
      const placed = await placeRequest(10)
      await pool.query(
        `UPDATE products SET composition = '100% Linen', width = '137 cm',
                description = 'A washed linen with a soft hand.'
          WHERE id = (SELECT product_id FROM colourways WHERE sku = $1)`,
        [SKU.inStock]
      )

      const [line] = (await orderFor(placed.id)).lines

      expect(line).toMatchObject({
        composition: '100% Linen',
        width: '137 cm',
        size: null,
        description: 'A washed linen with a soft hand.',
      })
    })

    it('rejects a line edit that says nothing but its id with 400', async () => {
      const placed = await placeRequest(10)
      const order = await orderFor(placed.id)
      const response = await patch(placed.id, { lines: [{ id: order.lines[0].id }] })
      expect(response.statusCode).toBe(400)
    })
  })

  // Hard delete, for an order that is not yet a financial record. The rule and
  // the reservation release live in the lifecycle registry.
  describe('DELETE /admin/orders/:id', () => {
    const del = (id) => inject('DELETE', `/admin/orders/${id}`, backofficeCookie)

    const advance = async (id, ...statuses) => {
      for (const status of statuses) {
        await inject('POST', `/admin/orders/${id}/status`, backofficeCookie, {
          status,
          xero_invoice_ref: 'INV-DEL',
        })
      }
    }

    it('deletes a quote and hands its reservation back', async () => {
      const placed = await placeRequest(10)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)

      const response = await del(placed.id)

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'order', id: placed.id } })
      expect((await inventoryFor(pool, SKU.inStock))).toEqual({
        available: 100,
        reserved: 0,
      })
      const after = await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)
      expect(after.statusCode).toBe(404)
    })

    it('deletes an invoiced-by-hand order and releases its reservation', async () => {
      const placed = await placeRequest(6)
      await advance(placed.id, 'pending_payment')

      expect((await del(placed.id)).statusCode).toBe(200)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(0)
    })

    it('deletes a cancelled order without releasing its reservation twice', async () => {
      const placed = await placeRequest(10)
      await advance(placed.id, 'cancelled')
      // Cancelling already handed the stock back.
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 100,
        reserved: 0,
      })

      expect((await del(placed.id)).statusCode).toBe(200)
      // A second release would read as -10 and inflate availability for ever.
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 100,
        reserved: 0,
      })
    })

    it('deletes the lines with the order', async () => {
      const placed = await placeRequest(10)
      await del(placed.id)
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM order_lines WHERE order_id = $1',
        [placed.id]
      )
      expect(rows[0].n).toBe(0)
    })

    it('refuses a paid order with 409 and offers archiving instead', async () => {
      const placed = await placeRequest(10)
      await advance(placed.id, 'pending_payment', 'paid')

      const response = await del(placed.id)

      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        blockers: [],
        archivable: true,
      })
      // The refusal rolled back: the reservation is exactly as it was.
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
      expect(
        (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)).statusCode
      ).toBe(200)
    })

    it('refuses a shipped order with 409', async () => {
      const placed = await placeRequest(10)
      await advance(placed.id, 'pending_payment', 'paid', 'shipped')
      expect((await del(placed.id)).statusCode).toBe(409)
    })

    it('refuses a card checkout with 409 whatever its status', async () => {
      const { rows } = await pool.query(
        `INSERT INTO orders (order_number, kind, status, guest_email)
         VALUES ($1, 'checkout', 'quote_requested', 'buyer@example.com')
         RETURNING id`,
        [`${PREFIX}-CHK`]
      )
      await pool.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
         VALUES ($1, $2, 1, 5000)`,
        [rows[0].id, colourwayId.get(SKU.inStock)]
      )

      const response = await del(rows[0].id)

      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/Stripe/)
      expect(response.json().archivable).toBe(true)
    })

    it('deletes a manual order the office keyed by mistake', async () => {
      const created = await inject('POST', '/admin/orders', backofficeCookie, {
        contact: { name: 'Walk-in' },
        lines: [{ colourway_id: colourwayId.get(SKU.second), qty: 2, unit_price_cents: 100 }],
      })
      const order = created.json().order
      expect((await inventoryFor(pool, SKU.second)).reserved).toBe(2)

      expect((await del(order.id)).statusCode).toBe(200)
      expect((await inventoryFor(pool, SKU.second)).reserved).toBe(0)
    })

    it('returns 404 for an unknown order id', async () => {
      expect((await del(99999999)).statusCode).toBe(404)
    })

    it('rejects a non-backoffice caller with 403', async () => {
      const placed = await placeRequest(10)
      const response = await inject(
        'DELETE',
        `/admin/orders/${placed.id}`,
        customerCookie
      )
      expect(response.statusCode).toBe(403)
    })
  })

  // Two lines may name ONE colourway — two cuts of the same cloth with different
  // cut requirements is an ordinary order — and every whole-order inventory move
  // must therefore sum the demand per colourway. `UPDATE … FROM order_lines`
  // updates a target row once however many lines match it, so the reservation
  // would be taken twice and handed back once, stranding stock permanently and
  // silently. All three moves (ship, cancel, delete) are asserted, because they
  // are three copies of the same statement.
  describe('an order with two lines on one colourway', () => {
    const twoLinesOn = async (sku, first, second) => {
      const response = await inject('POST', '/admin/orders', backofficeCookie, {
        contact: { name: 'Double liner' },
        lines: [
          { colourway_id: colourwayId.get(sku), qty: first, unit_price_cents: 1000 },
          { colourway_id: colourwayId.get(sku), qty: second, unit_price_cents: 1000 },
        ],
      })
      expect(response.statusCode).toBe(201)
      return response.json().order
    }

    it('reserves the SUM of both lines', async () => {
      await twoLinesOn(SKU.inStock, 4, 6)
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(10)
    })

    it('releases everything it reserved when cancelled', async () => {
      const order = await twoLinesOn(SKU.inStock, 4, 6)

      await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'cancelled' })

      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 100,
        reserved: 0,
      })
    })

    it('draws down the SUM of both lines when shipped', async () => {
      const order = await twoLinesOn(SKU.inStock, 4, 6)
      await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'pending_payment', xero_invoice_ref: 'INV-DOUBLE' })
      await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'paid' })

      await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'shipped' })

      // 10 metres left the shelf, not 4 or 6.
      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 90,
        reserved: 0,
      })
    })

    it('releases everything it reserved when deleted', async () => {
      const order = await twoLinesOn(SKU.inStock, 4, 6)

      expect((await inject('DELETE', `/admin/orders/${order.id}`, backofficeCookie)).statusCode).toBe(200)

      expect(await inventoryFor(pool, SKU.inStock)).toEqual({
        available: 100,
        reserved: 0,
      })
    })

    it('holds the sum when a second line is ADDED for a colourway already on the order', async () => {
      const placed = await placeRequest(10)
      const order = (await inject('GET', `/admin/orders/${placed.id}`, backofficeCookie)).json().order

      await inject('PATCH', `/admin/orders/${placed.id}`, backofficeCookie, {
        add_lines: [
          { colourway_id: order.lines[0].colourway_id, qty: 5, unit_price_cents: 100 },
        ],
      })
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(15)

      await inject('POST', `/admin/orders/${placed.id}/status`, backofficeCookie, { status: 'cancelled' })
      expect((await inventoryFor(pool, SKU.inStock)).reserved).toBe(0)
    })
  })

  // W12 US-003/US-006: the order desk's search bar, its filters, its paging, and
  // the client's own two numbers that three of those filters search.
  describe('search, filters and pagination', () => {
    // Every reference below carries this, so each assertion scopes itself to the
    // orders the test just made rather than to whatever else the database holds.
    const TAG = 'W12DESK'

    const patch = (id, body) =>
      inject('PATCH', `/admin/orders/${id}`, backofficeCookie, body)

    const list = (query = '') =>
      inject('GET', `/admin/orders${query}`, backofficeCookie)

    // Place a request and hang the client's own numbers off it through the
    // admin update whitelist — which is US-006's write path, so the fixture and
    // the feature are the same code.
    const placeWith = async (reference, poNumber = null) => {
      const placed = await placeRequest(1)
      const response = await patch(placed.id, {
        client_reference: reference,
        customer_po_number: poNumber,
      })
      expect(response.statusCode).toBe(200)
      return response.json().order
    }

    describe('the client reference and PO number (US-006)', () => {
      it('writes both through the update whitelist and reads them back', async () => {
        const order = await placeWith(`${TAG} lounge`, 'PO-4471')
        expect(order.client_reference).toBe(`${TAG} lounge`)
        expect(order.customer_po_number).toBe('PO-4471')

        // Present on the LIST projection too, not only on the by-id read — the
        // CRM's table shows them, and two queries over one projection is how
        // those drift.
        const listed = (await list(`?reference=${TAG}`)).json().orders
        expect(listed[0].customer_po_number).toBe('PO-4471')
      })

      it('clears to NULL rather than to an empty string', async () => {
        const order = await placeWith(`${TAG} clear-me`, 'PO-9')

        // null is what the CRM sends when a field is explicitly emptied...
        const nulled = await patch(order.id, { client_reference: null })
        expect(nulled.json().order.client_reference).toBeNull()

        // ...and '' is what a text input sends when a person deletes what they
        // typed. Both mean absent; a stored '' is an absence every IS NULL read
        // misses and every search matches.
        const blanked = await patch(order.id, { customer_po_number: '' })
        expect(blanked.json().order.customer_po_number).toBeNull()

        const { rows } = await pool.query(
          'SELECT client_reference, customer_po_number FROM orders WHERE id = $1',
          [order.id]
        )
        expect(rows[0]).toEqual({ client_reference: null, customer_po_number: null })
      })

      it('leaves both alone when the patch does not mention them', async () => {
        const order = await placeWith(`${TAG} untouched`, 'PO-KEEP')
        const response = await patch(order.id, { notes: 'Something else.' })
        expect(response.json().order.customer_po_number).toBe('PO-KEEP')
      })

      // The whole reason these two columns exist is that the number arrives
      // late — often in an email after the client has already paid. A guard
      // that refuses it past `pending_payment` would make the feature unusable at
      // exactly the moment it is needed.
      it('records a PO number on a paid order, but still refuses a line edit', async () => {
        const order = await placeWith(`${TAG} pays-first`)
        await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'pending_payment', xero_invoice_ref: 'INV-LATE-PO' })
        await inject('POST', `/admin/orders/${order.id}/status`, backofficeCookie, { status: 'paid' })

        const late = await patch(order.id, { customer_po_number: 'PO-LATE-1' })
        expect(late.statusCode).toBe(200)
        expect(late.json().order.status).toBe('paid')
        expect(late.json().order.customer_po_number).toBe('PO-LATE-1')

        // An annotation is not a licence to edit the commercial terms: money,
        // lines and the reservation stay frozen once an order is paid. (A note
        // on its own IS allowed past pending_payment — A4, covered above — so the
        // frozen half is proved with a line edit, which is the half that moves
        // money.)
        const lines = await patch(order.id, {
          lines: [{ id: order.lines[0].id, unit_price_cents: 12345 }],
        })
        expect(lines.statusCode).toBe(409)
      })
    })

    describe('filters', () => {
      it('finds an order by the client reference', async () => {
        const wanted = await placeWith(`${TAG} Hutchinson lounge`)
        await placeWith(`${TAG} Ponsonby apartment`)

        const response = await list(`?reference=${encodeURIComponent('Hutchinson')}`)
        expect(response.statusCode).toBe(200)
        const ids = response.json().orders.map((o) => o.id)
        expect(ids).toEqual([wanted.id])
      })

      // The reason this module does not reuse src/reports/filters.js. A slug is
      // [a-z0-9-] by construction; a reference is whatever a person typed, so an
      // unescaped `%` would match every order in the table and `_` any single
      // character.
      it('matches a reference containing % and _ LITERALLY', async () => {
        const literal = await placeWith(`${TAG} 100%_A`)
        // Differs from the above only where the metacharacters are: a wildcard
        // search for "100%_A" would return this one too.
        await placeWith(`${TAG} 100XYA`)

        const response = await list(`?reference=${encodeURIComponent('100%_A')}`)
        const ids = response.json().orders.map((o) => o.id)
        expect(ids).toEqual([literal.id])
      })

      it('finds an order by the customer PO number', async () => {
        const wanted = await placeWith(`${TAG} po-order`, 'PO-4471')
        await placeWith(`${TAG} other-order`, 'PO-9999')

        const ids = (await list('?po_number=4471')).json().orders.map((o) => o.id)
        expect(ids).toEqual([wanted.id])
      })

      it('finds a guest order by client, which has no account row at all', async () => {
        const guest = await placeWith(`${TAG} guest`)
        const ids = (await list('?client=buyer%40example.com')).json().orders.map((o) => o.id)
        expect(ids).toContain(guest.id)
      })

      it('finds an order under an account by the account name or email', async () => {
        const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [
          testEmail('shopper'),
        ])
        const created = await inject('POST', '/admin/orders', backofficeCookie, {
          user_id: rows[0].id,
          lines: [
            { colourway_id: colourwayId.get(SKU.inStock), qty: 1, unit_price_cents: 100 },
          ],
        })
        const id = created.json().order.id

        const ids = (await list('?client=admin-ord-test.example.com'))
          .json()
          .orders.map((o) => o.id)
        expect(ids).toContain(id)
      })

      it('searches the order number, the reference and the client from one box', async () => {
        const order = await placeWith(`${TAG} freetext`)

        const byNumber = (await list(`?q=${order.order_number}`)).json().orders
        expect(byNumber.map((o) => o.id)).toEqual([order.id])

        const byReference = (await list(`?q=${TAG}%20freetext`)).json().orders
        expect(byReference.map((o) => o.id)).toEqual([order.id])
      })

      it('filters by a date range that includes today', async () => {
        // Read the date from the database, not from the test process: `to` is
        // resolved in the session's timezone and a transcribed UTC date is a day
        // out in New Zealand for half of every day.
        const { rows } = await pool.query('SELECT current_date::text AS today')
        const today = rows[0].today
        const order = await placeWith(`${TAG} dated`)

        const inRange = (await list(`?reference=${TAG}&from=${today}&to=${today}`)).json()
        expect(inRange.orders.map((o) => o.id)).toEqual([order.id])

        const before = (await list(`?reference=${TAG}&to=2020-01-01`)).json()
        expect(before.orders).toHaveLength(0)
      })

      it('400s an unusable filter value rather than answering with an empty list', async () => {
        expect((await list('?from=yesterday')).statusCode).toBe(400)
        expect((await list('?from=2026-08-31&to=2026-08-01')).statusCode).toBe(400)
      })

      it('narrows with status at the same time', async () => {
        const order = await placeWith(`${TAG} statused`)
        expect(
          (await list(`?reference=${TAG}&status=quote_requested`)).json().orders.map((o) => o.id)
        ).toEqual([order.id])
        expect(
          (await list(`?reference=${TAG}&status=shipped`)).json().orders
        ).toHaveLength(0)
      })
    })

    describe('pagination', () => {
      it('returns one page and the total of the whole filtered population', async () => {
        await placeWith(`${TAG} page-one`)
        await placeWith(`${TAG} page-two`)
        await placeWith(`${TAG} page-three`)

        const first = (await list(`?reference=${TAG}&limit=2`)).json()
        expect(first.orders).toHaveLength(2)
        // The total is the population, not the page — a total that counted only
        // what is on screen agrees with everything visible and is wrong.
        expect(first.meta).toEqual({ total: 3, page: 1, limit: 2 })

        const second = (await list(`?reference=${TAG}&limit=2&page=2`)).json()
        expect(second.orders).toHaveLength(1)
        expect(second.meta.total).toBe(3)
        // Disjoint pages, from one deterministic ORDER BY.
        const ids = [...first.orders, ...second.orders].map((o) => o.id)
        expect(new Set(ids).size).toBe(3)
      })

      it('defaults the page and the limit', async () => {
        await placeWith(`${TAG} defaulted`)
        const { meta } = (await list(`?reference=${TAG}`)).json()
        expect(meta).toEqual({ total: 1, page: 1, limit: 50 })
      })

      it('400s an over-large limit rather than silently clamping it', async () => {
        expect((await list('?limit=5000')).statusCode).toBe(400)
        expect((await list('?limit=0')).statusCode).toBe(400)
        expect((await list('?page=0')).statusCode).toBe(400)
      })
    })
  })

  describe('sales rep attribution (A6 groundwork)', () => {
    // The rep is an ANNOTATION: staff-asserted, movable at any status —
    // back-filling a shipped order is exactly the ask — and never derived from
    // the legacy owner column (72% shared logins).
    let repId

    beforeAll(async () => {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, name, role)
         VALUES ($1, 'x', 'Rebecca Rep', 'backoffice')
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [testEmail('rep')]
      )
      repId = rows[0].id
    })

    it('sets, serves and clears the rep on a quote', async () => {
      const order = await placeRequest()
      const patched = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        sales_rep_user_id: repId,
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().order.sales_rep_user_id).toBe(repId)
      expect(patched.json().order.sales_rep_name).toBe('Rebecca Rep')

      const cleared = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        sales_rep_user_id: null,
      })
      expect(cleared.json().order.sales_rep_user_id).toBeNull()
      expect(cleared.json().order.sales_rep_name).toBeNull()
    })

    it('is assignable on a SHIPPED order — the annotation posture', async () => {
      const order = await placeRequest()
      await pool.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [order.id])
      const patched = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        sales_rep_user_id: repId,
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().order.sales_rep_user_id).toBe(repId)
    })

    it('refuses a non-staff id and an unknown one as a 422, not an FK 500', async () => {
      const order = await placeRequest()
      const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
        testEmail('shopper'),
      ])
      const customer = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        sales_rep_user_id: rows[0].id,
      })
      expect(customer.statusCode).toBe(422)

      const unknown = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        sales_rep_user_id: 99999999,
      })
      expect(unknown.statusCode).toBe(422)
    })

    it('travels on a manual order create; a storefront request stays unassigned', async () => {
      const created = await inject('POST', '/admin/orders', backofficeCookie, {
        contact: { name: 'Walk-in' },
        lines: [{ colourway_id: colourwayId.get(SKU.inStock), qty: 2, unit_price_cents: 5000 }],
        sales_rep_user_id: repId,
      })
      expect(created.statusCode).toBe(201)
      expect(created.json().order.sales_rep_user_id).toBe(repId)

      const request = await placeRequest()
      const read = await inject('GET', `/admin/orders/${request.id}`, backofficeCookie)
      expect(read.json().order.sales_rep_user_id).toBeNull()
    })
  })

  describe('price type (trade or retail)', () => {
    // The basis the order was priced off. A commercial term, not an annotation:
    // it sits behind the LINE_EDIT_STATUSES guard like a price edit does.
    it('defaults to retail and is patched to trade', async () => {
      const order = await placeRequest()
      const read = await inject('GET', `/admin/orders/${order.id}`, backofficeCookie)
      expect(read.json().order.price_type).toBe('retail')

      const patched = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        price_type: 'trade',
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().order.price_type).toBe('trade')
    })

    it('travels on a manual order create', async () => {
      const created = await inject('POST', '/admin/orders', backofficeCookie, {
        contact: { name: 'Walk-in' },
        lines: [{ colourway_id: colourwayId.get(SKU.inStock), qty: 2, unit_price_cents: 5000 }],
        price_type: 'trade',
      })
      expect(created.statusCode).toBe(201)
      expect(created.json().order.price_type).toBe('trade')
    })

    // Anything off the vocabulary is a 400 from the schema's enum, never a
    // CHECK violation surfacing as a 500 — and never a null, which the NOT NULL
    // column would answer with a 23502.
    it('refuses a value off the list, and a null', async () => {
      const order = await placeRequest()
      const bad = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        price_type: 'wholesale',
      })
      expect(bad.statusCode).toBe(400)

      const nulled = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        price_type: null,
      })
      expect(nulled.statusCode).toBe(400)
    })

    // The commercial-term posture: frozen once the invoice is out, exactly like
    // a unit price. The annotations (rep, PO number, notes) stay editable.
    it('is refused on a paid order', async () => {
      const order = await placeRequest()
      await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [order.id])
      const patched = await inject('PATCH', `/admin/orders/${order.id}`, backofficeCookie, {
        price_type: 'trade',
      })
      expect(patched.statusCode).toBe(409)
    })
  })

  describe('a status filter that is a set', () => {
    // The dashboard's Open-orders tile means three statuses at once
    // (HELD_STATUSES), so `status` accepts a repeated param as well as a single
    // value. Fastify's default querystring parser turns repeats into an array,
    // which the schema's anyOf admits and the module binds as `= ANY(...)`.
    it('returns exactly the named statuses, with a total that agrees', async () => {
      const first = await placeRequest()
      const second = await placeRequest()
      const third = await placeRequest()
      await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [first.id])
      await pool.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [second.id])
      await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [third.id])

      const response = await inject(
        'GET',
        '/admin/orders?status=paid&status=shipped',
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.orders.map((order) => order.status).sort()).toEqual(['paid', 'shipped'])
      expect(body.meta.total).toBe(2)
    })

    it('still takes a single status as before', async () => {
      const order = await placeRequest()
      await pool.query(`UPDATE orders SET status = 'pending_payment' WHERE id = $1`, [order.id])
      const response = await inject('GET', '/admin/orders?status=pending_payment', backofficeCookie)
      expect(response.json().orders.map((row) => row.status)).toEqual(['pending_payment'])
    })

    it('refuses an unknown member of the set', async () => {
      const response = await inject(
        'GET',
        '/admin/orders?status=paid&status=pending',
        backofficeCookie
      )
      expect(response.statusCode).toBe(400)
    })
  })

  describe('not found', () => {
    it('returns 404 for an unknown order id', async () => {
      const response = await inject('GET', '/admin/orders/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    it('returns 404 when moving an unknown order id', async () => {
      const response = await inject(
        'POST',
        '/admin/orders/99999999/status',
        backofficeCookie,
        { status: 'pending_payment', xero_invoice_ref: 'INV-Z' }
      )
      expect(response.statusCode).toBe(404)
    })
  })
})
