// W13 — purchase orders, end to end.
//
// The blocks are ordered by what they protect rather than by route: the schema
// invariants first (they are the ones a later story cannot re-derive), then the
// supplier derivation, the numbering, the grouping, the two aggregate rules the
// database cannot hold, the append-only ledger, the inventory boundary, the
// delete refusals and the finance gate.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { LIFECYCLE_ENTITY_NAMES } from '../src/lifecycle/registry.js'
import { PURCHASE_ORDER_STATUSES } from '../src/purchasing/po-states.js'
import { generatePurchaseOrders } from '../src/purchasing/admin-purchase-orders.js'
import { setHouseDiscount } from '../src/pricing/pricing-parameters.js'
import { RESERVING_KINDS, HELD_STATUSES } from '../src/orders/order-states.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'po-test'
const DOMAIN = 'po-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const SKU = {
  alpha: `${PREFIX}-ALPHA`,
  alphaTwo: `${PREFIX}-ALPHA-2`,
  beta: `${PREFIX}-BETA`,
  orphan: `${PREFIX}-ORPHAN`,
}

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Receipts are RESTRICT from the lines, so they go before the purchase orders
// (which cascade to lines and allocations); the allocations are RESTRICT from
// `order_lines`, so the purchase orders go before the orders; and
// `order_lines.colourway_id` is RESTRICT, so the orders go before the brands.
// One wrong step here and the CLEANUP itself 23503s in the next beforeEach.
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
    `DELETE FROM purchase_orders
      WHERE brand_id IN (SELECT id FROM brands WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(
    `DELETE FROM orders
      WHERE id IN (
        SELECT ol.order_id FROM order_lines ol
          JOIN colourways c ON c.id = ol.colourway_id
         WHERE c.sku LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  // Freight rates are RESTRICT from their supplier.
  await pool.query(
    `DELETE FROM supplier_freight_rates WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

// Two houses under ONE supplier — the case that must correctly produce two
// purchase orders — plus a third house with no supplier at all, which is the
// state most of the real catalogue is in until `backfill:suppliers` catches up.
const seedFixtures = async (pool) => {
  const { rows: suppliers } = await pool.query(
    `INSERT INTO suppliers (name, slug, country, currency, agent, incoterm, po_email)
     VALUES ($1, $2, 'Italy', 'EUR', 'Test Agent', 'FOB', 'orders@po-test.example.com')
     RETURNING id`,
    [`${PREFIX} Supplier`, `${PREFIX}-supplier`]
  )
  const supplierId = suppliers[0].id

  const brandIds = {}
  const colourwayIds = {}
  for (const [key, supplier] of [
    ['alpha', supplierId],
    ['beta', supplierId],
    ['orphan', null],
  ]) {
    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
       VALUES ($1, $2, 'Italy', 'EUR', true, false, $3)
       RETURNING id`,
      [`${PREFIX} ${key}`, `${PREFIX}-${key}`, supplier]
    )
    brandIds[key] = brands[0].id
    const { rows: products } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, $2, $3, 'fabric', 'EUR', true)
       RETURNING id`,
      [brands[0].id, `${PREFIX} ${key} design`, `${PREFIX}-${key}-design`]
    )
    const skus =
      key === 'alpha' ? [SKU.alpha, SKU.alphaTwo] : [key === 'beta' ? SKU.beta : SKU.orphan]
    for (const sku of skus) {
      const { rows } = await pool.query(
        `INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3) RETURNING id`,
        [products[0].id, sku, sku]
      )
      colourwayIds[sku] = rows[0].id
      await pool.query(
        `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
         VALUES ($1, 100, 0, 'metres')`,
        [rows[0].id]
      )
    }
  }
  return { supplierId, brandIds, colourwayIds }
}

describe('W13 purchase orders', () => {
  let pool
  let app
  let staffCookie
  let customerCookie
  let fixtures

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  // A manual sales order in a state the derivation counts as open demand.
  const placeOrder = async (sku, qty = 10, orderNumber = `${PREFIX}-SO`) => {
    const { rows: orders } = await pool.query(
      `INSERT INTO orders (order_number, kind, status, guest_email)
       VALUES ($1, 'manual', 'pending_payment', 'buyer@po-test.example.com')
       RETURNING id`,
      [`${orderNumber}-${Math.random().toString(36).slice(2, 10)}`]
    )
    const { rows: lines } = await pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, $3, 0) RETURNING id`,
      [orders[0].id, fixtures.colourwayIds[sku], qty]
    )
    return { orderId: orders[0].id, orderLineId: lines[0].id }
  }

  const generate = (payload) =>
    inject('POST', '/admin/purchase-orders/generate', staffCookie, payload ?? {})

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
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered ONCE: register shares a 10-per-15-min per-IP bucket, so a
    // per-test registration 429s and yields no cookie.
    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('staff'), password: PASSWORD, name: 'Buyer' },
    })
    staffCookie = cookieOf(staff)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('staff'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = cookieOf(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    fixtures = await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  // -------------------------------------------------------------------------

  describe('the guard covers the whole surface', () => {
    // Every payload is schema-VALID: Fastify validates before it runs a
    // preHandler, so a malformed body would assert a 400 and pass with the guard
    // deleted.
    const surface = [
      ['GET', '/admin/purchase-orders', undefined],
      ['POST', '/admin/purchase-orders', { brand_id: 1, lines: [{ colourway_id: 1, qty_ordered: 1 }] }],
      ['POST', '/admin/purchase-orders/plan', {}],
      ['POST', '/admin/purchase-orders/generate', {}],
      ['GET', '/admin/purchase-orders/1', undefined],
      ['PATCH', '/admin/purchase-orders/1', { notes: 'x' }],
      ['POST', '/admin/purchase-orders/1/status', { status: 'paid' }],
      ['POST', '/admin/purchase-orders/1/email', { letter: 'details' }],
      ['GET', '/admin/purchase-orders/bulk', undefined],
      ['GET', '/admin/purchase-orders/bulk/1', undefined],
      ['POST', '/admin/purchase-orders/bulk', { purchase_order_ids: [1] }],
      ['POST', '/admin/purchase-orders/pdf', { purchase_order_ids: [1] }],
      ['POST', '/admin/purchase-orders/statement', { purchase_order_ids: [1] }],
      ['DELETE', '/admin/purchase-orders/1', undefined],
      ['POST', '/admin/purchase-order-lines/1/allocations', { order_line_id: 1, qty: 1 }],
      ['POST', '/admin/purchase-order-lines/1/receipts', { qty: 1 }],
    ]

    it.each(surface)('%s %s is 401 for an anonymous caller', async (method, url, payload) => {
      expect((await inject(method, url, null, payload)).statusCode).toBe(401)
    })

    it.each(surface)('%s %s is 403 for a customer', async (method, url, payload) => {
      expect((await inject(method, url, customerCookie, payload)).statusCode).toBe(403)
    })
  })

  describe('schema invariants', () => {
    let columns

    beforeAll(async () => {
      const { rows } = await pool.query(
        `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name LIKE 'purchase\\_%'`
      )
      columns = rows
    })

    it('carries NO integer-cents column anywhere in purchasing', () => {
      // Cents is the STOREFRONT's money type. A purchase is foreign, fractional
      // and unconverted, and a cents column beside a numeric(12,4) turns
      // €48.0000 into 48 cents with nothing in the schema objecting.
      const offenders = columns.filter((column) => /_cents$/.test(column.column_name))
      expect(offenders.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([])
      // The scan found the tables at all, so a silent zero cannot pass this.
      expect(columns.length).toBeGreaterThan(20)
    })

    it('prices in numeric(12,4) — price_list_items.wholesale_rate exactly', async () => {
      const unitPrice = columns.find(
        (column) =>
          column.table_name === 'purchase_order_lines' && column.column_name === 'unit_price'
      )
      expect(unitPrice.data_type).toBe('numeric')
      // Asserted against the LIVE wholesale_rate rather than a transcribed
      // literal: that ledger is where a purchase price comes from, and the two
      // drifting apart is the failure this pins.
      const { rows } = await pool.query(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_name = 'price_list_items' AND column_name = 'wholesale_rate'`
      )
      expect(unitPrice.numeric_precision).toBe(rows[0].numeric_precision)
      expect(unitPrice.numeric_scale).toBe(rows[0].numeric_scale)
      // NULLABLE: nothing in this schema can derive a purchase price for a
      // colourway, and `Number(null)` is 0 — a zero price reads as free.
      expect(unitPrice.numeric_scale).toBe(4)
    })

    it('stores no received quantity — receipt state is derived, always', () => {
      const stored = columns.filter((column) =>
        /qty_received|received_qty|receipt_state|is_received/.test(column.column_name)
      )
      expect(stored.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([])
    })

    it('checks a receipt quantity is NON-ZERO, not positive', async () => {
      // `> 0` would make a mistake uncorrectable: a receipt is never edited and
      // never deleted, so a reversal has to be a negative row.
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'purchase_order_receipts_qty_check'`
      )
      expect(rows[0].def).toContain('<>')
      expect(rows[0].def).not.toMatch(/qty > /)
    })

    it('holds the one-purchase-order-per-sales-line rule as a PARTIAL unique index', async () => {
      const { rows } = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE indexname = 'purchase_order_line_allocations_open_unique'`
      )
      expect(rows[0].indexdef).toContain('UNIQUE')
      expect(rows[0].indexdef).toContain('order_line_id')
      // PARTIAL, or a line cancelled by mistake could never be ordered again.
      expect(rows[0].indexdef).toMatch(/WHERE \(released_at IS NULL\)/)
    })

    it('makes the allocation RESTRICT from order_lines', async () => {
      const { rows } = await pool.query(
        `SELECT confdeltype FROM pg_constraint
          WHERE conname = 'purchase_order_line_allocations_order_line_id_fkey'`
      )
      // 'r' = RESTRICT. 'c' (cascade) would let an order delete silently destroy
      // the record that it was bought against.
      expect(rows[0].confdeltype).toBe('r')
    })

    it('agrees with the live status CHECK on the vocabulary', async () => {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'purchase_orders_status_check'`
      )
      const inTheCheck = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
      expect(new Set(inTheCheck)).toEqual(new Set(PURCHASE_ORDER_STATUSES))
    })

    it('keeps the purchasing tables OUT of the reserved legacy_ namespace', async () => {
      // `legacy_purchase_orders` and `purchase_orders` are DIFFERENT TABLES and
      // neither feeds the other: the staging mirror is what D365 held, this is
      // what Atelier is buying now. The `legacy_` prefix is reserved — three
      // suites assert the count of live `legacy_%` tables equals
      // `Object.keys(LEGACY_TABLES).length`, so a `legacy_`-prefixed name here
      // would turn them red on the migration alone.
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name LIKE '%purchase%'
          ORDER BY table_name`
      )
      const names = rows.map((row) => row.table_name)
      expect(names).toEqual(
        expect.arrayContaining([
          'purchase_order_line_allocations',
          'purchase_order_lines',
          'purchase_order_receipts',
          'purchase_orders',
        ])
      )
      // The staging mirrors are still there and still separate. Every
      // `legacy_`-prefixed hit must be one of THEIRS, never one of these four.
      expect(names).toContain('legacy_purchase_orders')
      for (const name of names.filter((entry) => entry.startsWith('legacy_'))) {
        expect(name).toMatch(/^legacy_purchase_(orders|invoices)$/)
      }
    })

    it('numbers from a sequence rather than max + 1', async () => {
      const { rows } = await pool.query(
        `SELECT sequence_name FROM information_schema.sequences
          WHERE sequence_name = 'purchase_orders_number_seq'`
      )
      expect(rows).toHaveLength(1)
    })
  })

  describe('the supplier is DERIVED from the brand and never accepted', () => {
    it('snapshots the house onto the document at create', async () => {
      const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 40 }],
      })
      expect(response.statusCode).toBe(201)
      const purchaseOrder = response.json().purchase_order
      expect(purchaseOrder.supplier_id).toBe(fixtures.supplierId)
      expect(purchaseOrder).toMatchObject({
        supplier_name: `${PREFIX} Supplier`,
        currency: 'EUR',
        agent: 'Test Agent',
        incoterm: 'FOB',
        po_email: 'orders@po-test.example.com',
      })
    })

    it('keeps the snapshot when the brand is later re-pointed at another house', async () => {
      // A purchase order is a document addressed to a house at a moment.
      // Re-pointing a brand next year must not rewrite who last year's orders
      // were addressed to — the sample_loans.holder_name argument.
      const created = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 10 }],
      })
      const id = created.json().purchase_order.id

      const { rows } = await pool.query(
        `INSERT INTO suppliers (name, slug, currency) VALUES ($1, $2, 'GBP') RETURNING id`,
        [`${PREFIX} New Distributor`, `${PREFIX}-new-distributor`]
      )
      await pool.query('UPDATE brands SET supplier_id = $2 WHERE id = $1', [
        fixtures.brandIds.alpha,
        rows[0].id,
      ])

      const reread = await inject('GET', `/admin/purchase-orders/${id}`, staffCookie)
      expect(reread.json().purchase_order.supplier_name).toBe(`${PREFIX} Supplier`)
      expect(reread.json().purchase_order.currency).toBe('EUR')
    })

    it('answers 422 naming the house when it has no supplier linked', async () => {
      const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.orphan,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.orphan], qty_ordered: 5 }],
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain(`${PREFIX} orphan`)
    })

    it('refuses a supplier_id that does not invoice the house', async () => {
      const { rows } = await pool.query(
        `INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`,
        [`${PREFIX} Wrong House`, `${PREFIX}-wrong-house`]
      )
      const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        supplier_id: rows[0].id,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 5 }],
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain('does not invoice this house')
    })

    it('addresses the purchase order to an additional supplier the caller names', async () => {
      const { rows } = await pool.query(
        `INSERT INTO suppliers (name, slug, currency, po_email) VALUES ($1, $2, 'USD', 'orders@second.example')
         RETURNING id`,
        [`${PREFIX} Second House`, `${PREFIX}-second-house`]
      )
      await pool.query(
        'INSERT INTO brand_additional_suppliers (brand_id, supplier_id) VALUES ($1, $2)',
        [fixtures.brandIds.alpha, rows[0].id]
      )
      const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        supplier_id: rows[0].id,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 5 }],
      })
      expect(response.statusCode).toBe(201)
      const order = response.json().purchase_order
      expect(order.supplier_id).toBe(rows[0].id)
      expect(order.supplier_name).toBe(`${PREFIX} Second House`)
      expect(order.po_email).toBe('orders@second.example')

      // Naming none still means the main supplier.
      const fallback = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 5 }],
      })
      expect(fallback.json().purchase_order.supplier_id).toBe(fixtures.supplierId)
    })

    it('mints PO-NNNNNN numbers that climb', async () => {
      const body = {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 1 }],
      }
      const first = await inject('POST', '/admin/purchase-orders', staffCookie, body)
      const second = await inject('POST', '/admin/purchase-orders', staffCookie, body)
      const a = first.json().purchase_order.po_number
      const b = second.json().purchase_order.po_number
      expect(a).toMatch(/^PO-\d{6}$/)
      expect(b > a).toBe(true)
    })
  })

  describe('the derivation', () => {
    it('candidates are reserves(kind) x HELD_STATUSES, so a checkout is excluded', async () => {
      // A card checkout arrived paid with stock already decremented, so it is
      // not demand to buy against — excluded by CONSTRUCTION rather than by a
      // second list somebody has to remember to update.
      expect(RESERVING_KINDS).not.toContain('checkout')
      expect(HELD_STATUSES).not.toContain('shipped')

      const { rows: orders } = await pool.query(
        `INSERT INTO orders (order_number, kind, status, guest_email)
         VALUES ($1, 'checkout', 'paid', 'buyer@po-test.example.com') RETURNING id`,
        [`${PREFIX}-CHK-${Math.random().toString(36).slice(2, 10)}`]
      )
      await pool.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
         VALUES ($1, $2, 12, 100)`,
        [orders[0].id, fixtures.colourwayIds[SKU.alpha]]
      )

      const plan = await inject('POST', '/admin/purchase-orders/plan', staffCookie, {
        brand_ids: [fixtures.brandIds.alpha],
      })
      expect(plan.json().plan.groups).toEqual([])
    })

    it('plans without writing anything', async () => {
      await placeOrder(SKU.alpha, 25)
      const before = await pool.query('SELECT count(*)::int AS n FROM purchase_orders')
      const plan = await inject('POST', '/admin/purchase-orders/plan', staffCookie, {
        brand_ids: [fixtures.brandIds.alpha],
      })
      expect(plan.statusCode).toBe(200)
      expect(plan.json().plan.groups).toHaveLength(1)
      const after = await pool.query('SELECT count(*)::int AS n FROM purchase_orders')
      expect(after.rows[0].n).toBe(before.rows[0].n)
    })

    it('groups by BRAND: one supplier, two houses, two purchase orders', async () => {
      await placeOrder(SKU.alpha, 25)
      await placeOrder(SKU.beta, 15)
      const response = await generate({
        brand_ids: [fixtures.brandIds.alpha, fixtures.brandIds.beta],
      })
      expect(response.statusCode).toBe(201)
      const created = response.json().purchase_orders
      expect(created).toHaveLength(2)
      expect(new Set(created.map((po) => po.supplier_id))).toEqual(
        new Set([fixtures.supplierId])
      )
      expect(new Set(created.map((po) => po.brand_id))).toEqual(
        new Set([fixtures.brandIds.alpha, fixtures.brandIds.beta])
      )
    })

    it('covers two sales orders from one line, each allocation carrying its share', async () => {
      const first = await placeOrder(SKU.alpha, 25)
      const second = await placeOrder(SKU.alpha, 15)
      const response = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      const [line] = response.json().purchase_orders[0].lines
      expect(line.qty_ordered).toBe(40)
      expect(line.allocated_qty).toBe(40)
      expect(new Set(line.allocations.map((a) => a.order_line_id))).toEqual(
        new Set([first.orderLineId, second.orderLineId])
      )
      expect(line.allocations.map((a) => a.qty).sort((x, y) => x - y)).toEqual([15, 25])
    })

    // The order page's "Create purchase order" (24 Sep 2026): the run narrowed
    // to named sales orders, each moved to back_order through the one
    // transition — unless the machine will not move it.
    it('narrows a run to named orders and moves each to back_order, with an audit row', async () => {
      const named = await placeOrder(SKU.alpha, 25)
      const other = await placeOrder(SKU.alpha, 15)

      const response = await generate({ order_ids: [named.orderId] })
      expect(response.statusCode).toBe(201)
      const [line] = response.json().purchase_orders[0].lines
      expect(line.allocations.map((a) => a.order_line_id)).toEqual([named.orderLineId])
      expect(response.json().not_moved).toEqual([])

      const { rows } = await pool.query(`SELECT id, status FROM orders WHERE id = ANY($1)`, [
        [named.orderId, other.orderId],
      ])
      const statusOf = new Map(rows.map((row) => [row.id, row.status]))
      expect(statusOf.get(named.orderId)).toBe('back_order')
      // The order nobody named is untouched and still open demand.
      expect(statusOf.get(other.orderId)).toBe('pending_payment')

      const { rows: events } = await pool.query(
        `SELECT from_status, to_status, actor_kind FROM order_events WHERE order_id = $1`,
        [named.orderId]
      )
      expect(events).toEqual([
        { from_status: 'pending_payment', to_status: 'back_order', actor_kind: 'staff' },
      ])
    })

    it('raises the purchase order for a paid order but leaves it paid, and says so', async () => {
      const paid = await placeOrder(SKU.alpha, 5)
      await pool.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [paid.orderId])

      const response = await generate({ order_ids: [paid.orderId] })
      expect(response.statusCode).toBe(201)
      expect(response.json().purchase_orders).toHaveLength(1)
      expect(response.json().not_moved).toEqual([
        { order_number: expect.any(String), status: 'paid' },
      ])
      const { rows } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [paid.orderId])
      expect(rows[0].status).toBe('paid')
    })

    it('counts a quote nobody has priced as demand to buy against', async () => {
      const quote = await placeOrder(SKU.alpha, 5)
      await pool.query(`UPDATE orders SET status = 'quote_requested' WHERE id = $1`, [quote.orderId])
      const response = await generate({ order_ids: [quote.orderId] })
      expect(response.json().purchase_orders).toHaveLength(1)
      const { rows } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [quote.orderId])
      expect(rows[0].status).toBe('back_order')
    })

    it('reports a house with no supplier instead of guessing one', async () => {
      await placeOrder(SKU.orphan, 5)
      const response = await generate()
      expect(response.statusCode).toBe(201)
      const blocked = response.json().blocked.find(
        (entry) => entry.brand_id === fixtures.brandIds.orphan
      )
      expect(blocked.reason).toBe('no_supplier')
      expect(blocked.message).toContain(`${PREFIX} orphan`)
    })

    it('answers 422 when the CALLER named the unlinked house', async () => {
      await placeOrder(SKU.orphan, 5)
      const response = await generate({ brand_ids: [fixtures.brandIds.orphan] })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain(`${PREFIX} orphan`)
    })

    it('re-running the derivation is a no-op, not a second purchase order', async () => {
      await placeOrder(SKU.alpha, 25)
      const first = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      expect(first.json().purchase_orders).toHaveLength(1)
      const second = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      expect(second.json().purchase_orders).toEqual([])
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM purchase_orders WHERE brand_id = $1`,
        [fixtures.brandIds.alpha]
      )
      expect(rows[0].n).toBe(1)
    })

    it('answers 409 naming the purchase order that already covers the line', async () => {
      // The candidate query's NOT EXISTS is what makes the DRY RUN honest; the
      // 23505 on `purchase_order_line_allocations_open_unique` is the guard, and
      // this is the path that reaches it — a second claim on a sales-order line
      // that is already covered.
      const { orderLineId } = await placeOrder(SKU.alpha, 25)
      const first = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      const poNumber = first.json().purchase_orders[0].po_number

      const stockBuy = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 40 }],
      })
      const clash = await inject(
        'POST',
        `/admin/purchase-order-lines/${stockBuy.json().purchase_order.lines[0].id}/allocations`,
        staffCookie,
        { order_line_id: orderLineId, qty: 5 }
      )
      expect(clash.statusCode).toBe(409)
      expect(clash.json().message).toContain(poNumber)
    })

    it('two concurrent derivations produce ONE purchase order and one 409', async () => {
      // The derivation is exactly what two staff run at once at 5pm. The guard
      // is the PARTIAL UNIQUE INDEX — a read-then-insert pre-check reads rows
      // the other transaction is about to write.
      await placeOrder(SKU.alpha, 25)
      const results = await Promise.allSettled([
        generatePurchaseOrders(pool, { brandIds: [fixtures.brandIds.alpha] }),
        generatePurchaseOrders(pool, { brandIds: [fixtures.brandIds.alpha] }),
      ])
      const created = results.filter(
        (result) => result.status === 'fulfilled' && result.value.purchase_orders.length > 0
      )
      // One run wins outright. The loser either lost the INSERT race (409) or
      // read the winner's committed allocation and had nothing to plan.
      expect(created).toHaveLength(1)
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM purchase_orders WHERE brand_id = $1`,
        [fixtures.brandIds.alpha]
      )
      expect(rows[0].n).toBe(1)
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason.statusCode).toBe(409)
      }
    })

    it('leaves the derived line unpriced rather than free', async () => {
      await placeOrder(SKU.alpha, 25)
      await pool.query(`UPDATE users SET can_view_finance = true WHERE email = $1`, [
        testEmail('staff'),
      ])
      const response = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      const [line] = response.json().purchase_orders[0].lines
      expect(line.unit_price).toBeNull()
      expect(line.line_cost).toBeNull()
      await pool.query(`UPDATE users SET can_view_finance = false WHERE email = $1`, [
        testEmail('staff'),
      ])
    })

    // 24 Sep 2026: "purchase orders should use wholesale price ... supplier
    // freight rates and supplier discounts". The pricing engine's own steps.
    it('prices a line from the wholesale rate less the supplier\'s discount, with its freight', async () => {
      await pool.query(
        `UPDATE products SET wholesale_rate = 50
          WHERE id = (SELECT product_id FROM colourways WHERE id = $1)`,
        [fixtures.colourwayIds[SKU.alpha]]
      )
      // A fraction off list on the supplier row: 40%. The house SELLS at its own
      // 0%; the purchase order still buys at the supplier's 40% (1 Oct 2026).
      await pool.query(`UPDATE suppliers SET default_discount = 0.4 WHERE id = $1`, [fixtures.supplierId])
      await setHouseDiscount(pool, fixtures.brandIds.alpha, 0)
      // Terms of the house's own say 10%; a house has no purchase-order
      // discount of its own, so the supplier's 40% still buys it.
      await pool.query(
        `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount) VALUES ($1, $2, 0.1)
         ON CONFLICT (brand_id) DO UPDATE SET discount = 0.1, discount_chain = '{}'`,
        [fixtures.supplierId, fixtures.brandIds.alpha]
      )
      await pool.query(
        `INSERT INTO supplier_freight_rates (supplier_id, basis, rate, effective_from)
         VALUES ($1, 'dollar', 3.25, '2026-01-01')`,
        [fixtures.supplierId]
      )
      await placeOrder(SKU.alpha, 10)
      await pool.query(`UPDATE users SET can_view_finance = true WHERE email = $1`, [
        testEmail('staff'),
      ])
      const response = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      const [purchaseOrder] = response.json().purchase_orders
      expect(purchaseOrder.lines[0]).toMatchObject({
        unit_price: 30,
        line_cost: 300,
        freight_per_unit: 3.25,
        freight_cost: 32.5,
      })
      expect(purchaseOrder.total_freight).toBe(32.5)

      // A typed price is the override; the freight estimate still comes along.
      const typed = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 2, unit_price: 27.5 }],
      })
      expect(typed.json().purchase_order.lines[0]).toMatchObject({ unit_price: 27.5, freight_per_unit: 3.25 })
      await pool.query(`UPDATE users SET can_view_finance = false WHERE email = $1`, [
        testEmail('staff'),
      ])
    })
  })

  describe('SUM(allocations.qty) <= qty_ordered', () => {
    const raise = async (qtyOrdered) => {
      const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: qtyOrdered }],
      })
      return response.json().purchase_order
    }

    it('accepts an allocation that leaves a remainder — <=, not =', async () => {
      // The unallocated remainder is a DELIBERATE STOCK BUY: a full roll bought
      // to cover a 25 m order is how this trade works.
      const purchaseOrder = await raise(40)
      const { orderLineId } = await placeOrder(SKU.alpha, 25)
      const response = await inject(
        'POST',
        `/admin/purchase-order-lines/${purchaseOrder.lines[0].id}/allocations`,
        staffCookie,
        { order_line_id: orderLineId, qty: 25 }
      )
      expect(response.statusCode).toBe(201)
      expect(response.json().purchase_order.lines[0].allocated_qty).toBe(25)
    })

    it('refuses an allocation that would over-commit the line', async () => {
      const purchaseOrder = await raise(40)
      const first = await placeOrder(SKU.alpha, 25)
      const second = await placeOrder(SKU.alpha, 25)
      const lineId = purchaseOrder.lines[0].id
      await inject('POST', `/admin/purchase-order-lines/${lineId}/allocations`, staffCookie, {
        order_line_id: first.orderLineId,
        qty: 25,
      })
      const response = await inject(
        'POST',
        `/admin/purchase-order-lines/${lineId}/allocations`,
        staffCookie,
        { order_line_id: second.orderLineId, qty: 25 }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/over-commit/)
    })

    it('refuses a qty_ordered edit that would drop below what is allocated', async () => {
      // The other way the sum breaks, and the easy one to miss: the allocations
      // are untouched and the line quietly stops covering them.
      const purchaseOrder = await raise(40)
      const { orderLineId } = await placeOrder(SKU.alpha, 25)
      await inject(
        'POST',
        `/admin/purchase-order-lines/${purchaseOrder.lines[0].id}/allocations`,
        staffCookie,
        { order_line_id: orderLineId, qty: 25 }
      )
      const response = await inject(
        'PATCH',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie,
        { lines: [{ id: purchaseOrder.lines[0].id, qty_ordered: 10 }] }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/already allocated/)
    })
  })

  describe('transitions, and what cancel gives back', () => {
    const raise = async () => {
      await placeOrder(SKU.alpha, 25)
      const response = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      return response.json().purchase_orders[0]
    }

    it('stamps each move and refuses an illegal one', async () => {
      const purchaseOrder = await raise()
      expect(purchaseOrder.status).toBe('draft')

      const closeEarly = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'completed' }
      )
      expect(closeEarly.statusCode).toBe(409)

      const sent = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'pending_payment' }
      )
      expect(sent.json().purchase_order.status).toBe('pending_payment')
      expect(sent.json().purchase_order.sent_at).not.toBeNull()

      // Pending payment cannot complete: the house is paid, or the goods
      // arrive, first.
      const tooSoon = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'completed' }
      )
      expect(tooSoon.statusCode).toBe(409)
      const paid = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'paid' }
      )
      expect(paid.json().purchase_order.paid_at).not.toBeNull()

      const closed = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'completed' }
      )
      expect(closed.json().purchase_order.status).toBe('completed')
      expect(closed.json().purchase_order.closed_at).not.toBeNull()
      // `completed` is a DECISION, not arithmetic: nothing was received.
      expect(closed.json().purchase_order.receipt_state).toBe('none')
    })

    it('cancel releases the allocations so the demand can be re-derived', async () => {
      const purchaseOrder = await raise()
      const cancelled = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'cancelled' }
      )
      expect(cancelled.json().purchase_order.status).toBe('cancelled')
      expect(cancelled.json().purchase_order.lines[0].allocated_qty).toBe(0)
      // The ROW survives — it records that this order was once on that purchase
      // order — and only drops out of the partial index.
      expect(cancelled.json().purchase_order.lines[0].allocations).toHaveLength(1)

      const again = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      expect(again.json().purchase_orders).toHaveLength(1)
    })

    it('completing does NOT release the allocations', async () => {
      // The goods that did arrive were bought against those sales orders;
      // handing the demand back would have the next derivation buy it twice.
      const purchaseOrder = await raise()
      for (const status of ['pending_payment', 'paid']) {
        await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, staffCookie, { status })
      }
      const closed = await inject(
        'POST',
        `/admin/purchase-orders/${purchaseOrder.id}/status`,
        staffCookie,
        { status: 'completed' }
      )
      expect(closed.json().purchase_order.lines[0].allocated_qty).toBe(25)
      const again = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      expect(again.json().purchase_orders).toEqual([])
    })
  })

  describe('the receipt ledger', () => {
    let purchaseOrder

    beforeEach(async () => {
      const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 40 }],
      })
      purchaseOrder = response.json().purchase_order
    })

    const receipt = (payload) =>
      inject(
        'POST',
        `/admin/purchase-order-lines/${purchaseOrder.lines[0].id}/receipts`,
        staffCookie,
        payload
      )

    it('derives received, outstanding and the state from the ledger', async () => {
      const first = await receipt({ qty: 25, consignment_ref: 'CONS-1' })
      expect(first.statusCode).toBe(201)
      const line = first.json().purchase_order.lines[0]
      expect(line.qty_received).toBe(25)
      expect(line.qty_outstanding).toBe(15)
      expect(line.receipt_state).toBe('part')
      expect(first.json().purchase_order.receipt_state).toBe('part')

      const second = await receipt({ qty: 15 })
      expect(second.json().purchase_order.lines[0].receipt_state).toBe('full')
      // `full` is arithmetic; the STATUS is still what a person did.
      expect(second.json().purchase_order.status).toBe('draft')
    })

    it('never clamps an over-receipt', async () => {
      const response = await receipt({ qty: 42 })
      const line = response.json().purchase_order.lines[0]
      expect(line.qty_received).toBe(42)
      // Legitimately negative: suppliers over-ship rolls, and hiding it destroys
      // the discrepancy the office has to take up with the house.
      expect(line.qty_outstanding).toBe(-2)
      expect(line.receipt_state).toBe('over')
    })

    it('reverses a mistake with a negative row rather than an edit', async () => {
      await receipt({ qty: 42 })
      const reversal = await receipt({ qty: -2, notes: 'Two rolls returned' })
      const line = reversal.json().purchase_order.lines[0]
      expect(line.qty_received).toBe(40)
      expect(line.receipt_state).toBe('full')
      // Both movements survive, in order. An edit would leave a corrected number
      // nobody can date.
      expect(line.receipts.map((r) => r.qty)).toEqual([42, -2])
    })

    it('refuses a zero receipt', async () => {
      expect((await receipt({ qty: 0 })).statusCode).toBe(422)
    })

    it('offers no way to edit or delete a receipt', async () => {
      await receipt({ qty: 10 })
      const { rows } = await pool.query(
        `SELECT r.id FROM purchase_order_receipts r
           JOIN purchase_order_lines l ON l.id = r.purchase_order_line_id
          WHERE l.purchase_order_id = $1`,
        [purchaseOrder.id]
      )
      for (const method of ['PATCH', 'DELETE']) {
        const response = await inject(
          method,
          `/admin/purchase-order-receipts/${rows[0].id}`,
          staffCookie,
          method === 'PATCH' ? { qty: 1 } : undefined
        )
        expect(response.statusCode).toBe(404)
      }
      // The real protection is ABSENCE from the registry: requireEntity throws a
      // plain Error for an unknown name, so no DELETE route can be registered.
      expect(LIFECYCLE_ENTITY_NAMES).not.toContain('purchase_order_receipt')
      expect(LIFECYCLE_ENTITY_NAMES).toContain('purchase_order')
    })

    it('refuses a receipt against a cancelled purchase order', async () => {
      await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, staffCookie, { status: 'cancelled' })
      const response = await receipt({ qty: 10 })
      expect(response.statusCode).toBe(409)
    })
  })

  describe('receipts move stock — qty_available only, through the inventory module', () => {
    // A goods receipt joins the shelf and a reversal takes it off (24 Sep 2026:
    // "purchase order should also update the stock once received"). The
    // movement lives in src/inventory/admin-inventory.js (`receiveStock`), so
    // this domain still carries no stock SQL of its own, and `qty_reserved`
    // stays `moveReservation`'s alone: a second writer breaks the reservation
    // arithmetic SILENTLY.
    const SRC = new URL('../src/', import.meta.url).pathname
    const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname

    // A comment may still EXPLAIN how receipts reach stock; what is banned is
    // the table in a SQL position and the two quantity columns in any
    // position, so comments are stripped before the scan.
    const stripComments = (source) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

    const files = [
      // `.js` only: the domain guide beside them is prose, and prose is exactly
      // where the reason stock moves through the inventory module has to be
      // written down. Same split the samples scan draws.
      ...readdirSync(join(SRC, 'purchasing'))
        .filter((file) => file.endsWith('.js'))
        .map((file) => join(SRC, 'purchasing', file)),
      join(SRC, 'routes', 'admin-purchase-orders.js'),
      // W14's route file is in the same boundary: a supplier invoice records
      // what arrived commercially and still writes no stock.
      join(SRC, 'routes', 'admin-supplier-invoices.js'),
      ...readdirSync(MIGRATIONS)
        .filter((file) => /purchase-order|supplier-invoice/.test(file))
        .map((file) => join(MIGRATIONS, file)),
    ]

    it('found the files at all, so a scan matching nothing cannot pass vacuously', () => {
      expect(files.length).toBeGreaterThanOrEqual(7)
    })

    it.each(files)('%s names no inventory quantity', (file) => {
      const source = stripComments(readFileSync(file, 'utf8'))
      expect(source).not.toMatch(/(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i)
      expect(source).not.toMatch(/qty_available|qty_reserved/)
    })

    const stockOf = async (sku) =>
      (
        await pool.query(
          `SELECT qty_available, qty_reserved FROM inventory WHERE colourway_id = $1`,
          [fixtures.colourwayIds[sku]]
        )
      ).rows[0]

    // A purchase order for one colourway, sent, so goods can be booked in.
    const sentOrderFor = async (sku, qty = 40) => {
      const created = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[sku], qty_ordered: qty }],
      })
      const purchaseOrder = created.json().purchase_order
      await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/status`, staffCookie, { status: 'pending_payment' })
      return purchaseOrder
    }
    const receive = (lineId, qty) =>
      inject('POST', `/admin/purchase-order-lines/${lineId}/receipts`, staffCookie, { qty })

    it('adds a goods receipt to what is on hand and leaves the reservation alone', async () => {
      const before = await stockOf(SKU.alpha)
      const purchaseOrder = await sentOrderFor(SKU.alpha)

      const received = await receive(purchaseOrder.lines[0].id, 40)
      expect(received.statusCode).toBe(201)
      expect(received.json().stock).toMatchObject({
        qty_available: Number(before.qty_available) + 40,
        unit: 'metres',
      })
      const after = await stockOf(SKU.alpha)
      expect(Number(after.qty_available)).toBe(Number(before.qty_available) + 40)
      expect(after.qty_reserved).toBe(before.qty_reserved)

      // The ledger's reversal takes it back off the shelf.
      expect((await receive(purchaseOrder.lines[0].id, -40)).statusCode).toBe(201)
      expect(await stockOf(SKU.alpha)).toEqual(before)
    })

    it('moves the purchase order to received when its last line is booked in full', async () => {
      const purchaseOrder = await sentOrderFor(SKU.alpha, 40)
      const part = await receive(purchaseOrder.lines[0].id, 15)
      expect(part.json().purchase_order.status).toBe('pending_payment')
      const rest = await receive(purchaseOrder.lines[0].id, 25)
      expect(rest.json().purchase_order).toMatchObject({ status: 'received', receipt_state: 'full' })
      expect(rest.json().purchase_order.received_at).not.toBeNull()
    })

    it('refuses a reversal that would take stock below zero, and books nothing', async () => {
      const purchaseOrder = await sentOrderFor(SKU.alpha)
      const lineId = purchaseOrder.lines[0].id
      await receive(lineId, 40)
      // Most of it has gone out since.
      await pool.query(`UPDATE inventory SET qty_available = 10 WHERE colourway_id = $1`, [
        fixtures.colourwayIds[SKU.alpha],
      ])

      const refused = await receive(lineId, -40)
      expect(refused.statusCode).toBe(422)
      expect(refused.json().message).toMatch(/below zero/)
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM purchase_order_receipts WHERE purchase_order_line_id = $1`,
        [lineId]
      )
      expect(rows[0].n).toBe(1)
      expect(Number((await stockOf(SKU.alpha)).qty_available)).toBe(10)
    })

    it('gives a never-stocked colourway its row, reserving what its open orders already hold', async () => {
      // With no row, the open order on it reserved nothing; once a row exists
      // the order desk reads that order as holding — so the row must start there.
      await pool.query(`DELETE FROM inventory WHERE colourway_id = $1`, [
        fixtures.colourwayIds[SKU.alphaTwo],
      ])
      await placeOrder(SKU.alphaTwo, 7)
      const purchaseOrder = await sentOrderFor(SKU.alphaTwo, 10)

      expect((await receive(purchaseOrder.lines[0].id, 10)).statusCode).toBe(201)
      const { rows } = await pool.query(
        `SELECT qty_available, qty_reserved, unit FROM inventory WHERE colourway_id = $1`,
        [fixtures.colourwayIds[SKU.alphaTwo]]
      )
      expect(rows[0]).toEqual({ qty_available: '10.00', qty_reserved: '7.00', unit: 'metres' })
    })
  })

  // The receive screen's per-sales-order button (24 Sep 2026): "confirm stock
  // availability for client email".
  describe('confirming stock has arrived for a sales order', () => {
    const arrived = (orderId, note) =>
      inject('POST', `/admin/orders/${orderId}/stock-arrived`, staffCookie, note ? { note } : {})

    it('moves a back-ordered order on to processing, with the arrival on its timeline', async () => {
      const { orderId } = await placeOrder(SKU.alpha, 5)
      await pool.query(`UPDATE orders SET status = 'back_order' WHERE id = $1`, [orderId])

      const response = await arrived(orderId, 'Stock arrived on PO-000123.')
      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('processing')
      expect(response.json().email).toEqual({ sent: [], failed: [] })
      const { rows } = await pool.query(
        `SELECT from_status, to_status, note FROM order_events WHERE order_id = $1`,
        [orderId]
      )
      expect(rows).toEqual([
        { from_status: 'back_order', to_status: 'processing', note: 'Stock arrived on PO-000123.' },
      ])
    })

    it('moves nothing at any other status, and still answers', async () => {
      const { orderId } = await placeOrder(SKU.alpha, 5)
      const response = await arrived(orderId)
      expect(response.statusCode).toBe(200)
      expect(response.json().order.status).toBe('pending_payment')
      expect((await inject('POST', '/admin/orders/99999999/stock-arrived', staffCookie, {})).statusCode).toBe(404)
    })
  })

  describe('delete refusals', () => {
    it('deletes a draft purchase order nothing hangs off', async () => {
      const created = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 10 }],
      })
      const response = await inject(
        'DELETE',
        `/admin/purchase-orders/${created.json().purchase_order.id}`,
        staffCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().deleted.entity).toBe('purchase_order')
    })

    it('refuses one carrying receipts, naming the relation and its count', async () => {
      const created = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 10 }],
      })
      const purchaseOrder = created.json().purchase_order
      await inject(
        'POST',
        `/admin/purchase-order-lines/${purchaseOrder.lines[0].id}/receipts`,
        staffCookie,
        { qty: 4 }
      )
      const response = await inject(
        'DELETE',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        { relation: 'purchase_order_receipts', label: 'goods receipts', count: 1, capped: false },
      ])
      // No archived_at column, so there is no soft alternative to offer:
      // `cancelled` and `closed` do that job and say why.
      expect(response.json().archivable).toBe(false)
    })

    it('refuses one carrying allocations', async () => {
      await placeOrder(SKU.alpha, 25)
      const generated = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      const response = await inject(
        'DELETE',
        `/admin/purchase-orders/${generated.json().purchase_orders[0].id}`,
        staffCookie
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers.map((b) => b.relation)).toEqual([
        'purchase_order_line_allocations',
      ])
    })

    it('gives the ORDER delete a fourth blocker', async () => {
      // An order already ordered from a supplier is no longer a mis-key anyone
      // can delete: somebody's money is committed against it at a house.
      const { orderId } = await placeOrder(SKU.alpha, 25)
      await generate({ brand_ids: [fixtures.brandIds.alpha] })
      const response = await inject('DELETE', `/admin/orders/${orderId}`, staffCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        {
          relation: 'purchase_order_line_allocations',
          label: 'supplier purchase-order allocations',
          count: 1,
          capped: false,
        },
      ])
      // The reservation must NOT have been handed back by beforeDelete: the
      // refusal rolls the whole transaction back.
      const { rows } = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId])
      expect(rows[0].status).toBe('pending_payment')
    })

    it('still blocks the order delete after the purchase order is cancelled', async () => {
      // A released allocation is still the record that this order was once
      // bought against; deleting the order destroys the other half of it.
      const { orderId } = await placeOrder(SKU.alpha, 25)
      const generated = await generate({ brand_ids: [fixtures.brandIds.alpha] })
      await inject(
        'POST',
        `/admin/purchase-orders/${generated.json().purchase_orders[0].id}/status`,
        staffCookie,
        { status: 'cancelled' }
      )
      const response = await inject('DELETE', `/admin/orders/${orderId}`, staffCookie)
      expect(response.statusCode).toBe(409)
    })

    it('refuses deleting the house and the supplier a purchase order names', async () => {
      await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [{ colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 10 }],
      })
      const brand = await inject(
        'DELETE',
        `/admin/brands/${fixtures.brandIds.alpha}`,
        staffCookie
      )
      expect(brand.statusCode).toBe(409)
      expect(brand.json().blockers.map((b) => b.relation)).toContain('purchase_orders')

      const supplier = await inject(
        'DELETE',
        `/admin/suppliers/${fixtures.supplierId}`,
        staffCookie
      )
      expect(supplier.statusCode).toBe(409)
      expect(supplier.json().blockers.map((b) => b.relation)).toContain('purchase_orders')
    })
  })

  describe('cost figures are finance-gated', () => {
    let purchaseOrderId

    beforeEach(async () => {
      const created = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [
          {
            colourway_id: fixtures.colourwayIds[SKU.alpha],
            qty_ordered: 40,
            unit_price: 48.5,
          },
        ],
      })
      purchaseOrderId = created.json().purchase_order.id
    })

    const setFinance = (value) =>
      pool.query(`UPDATE users SET can_view_finance = $2 WHERE email = $1`, [
        testEmail('staff'),
        value,
      ])

    it('DELETES the cost keys from a backoffice login without the grant', async () => {
      // Deleted, not nulled: a key that survives with an empty value still tells
      // the reader which figures exist and is one grep away from being counted.
      await setFinance(false)
      const response = await inject(
        'GET',
        `/admin/purchase-orders/${purchaseOrderId}`,
        staffCookie
      )
      const purchaseOrder = response.json().purchase_order
      expect(purchaseOrder.lines[0]).not.toHaveProperty('unit_price')
      expect(purchaseOrder.lines[0]).not.toHaveProperty('line_cost')
      expect(purchaseOrder).not.toHaveProperty('total_cost')
      // Timestamps out first: a created_at of "…T20:07:48.575Z" carries the
      // figure by chance and failed this once a few hundred runs.
      expect(response.body.replace(/"\d{4}-\d{2}-\d{2}T[^"]*"/g, '""')).not.toContain('48.5')
      // The quantities are NOT costs and stay visible: the showroom needs to
      // know what is outstanding without seeing what it cost.
      expect(purchaseOrder.lines[0].qty_ordered).toBe(40)
    })

    it('serves them to a login that carries it', async () => {
      await setFinance(true)
      const response = await inject(
        'GET',
        `/admin/purchase-orders/${purchaseOrderId}`,
        staffCookie
      )
      const purchaseOrder = response.json().purchase_order
      expect(purchaseOrder.lines[0].unit_price).toBe(48.5)
      expect(purchaseOrder.lines[0].line_cost).toBe(1940)
      expect(purchaseOrder.total_cost).toBe(1940)
      await setFinance(false)
    })

    it('withholds a total the population cannot support', async () => {
      await setFinance(true)
      const created = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandIds.alpha,
        lines: [
          { colourway_id: fixtures.colourwayIds[SKU.alpha], qty_ordered: 10, unit_price: 5 },
          { colourway_id: fixtures.colourwayIds[SKU.alphaTwo], qty_ordered: 10 },
        ],
      })
      const purchaseOrder = created.json().purchase_order
      // A figure that cannot be added is ABSENT rather than summed into one that
      // reads as the whole order's cost while describing part of it.
      expect(purchaseOrder.total_cost).toBeNull()
      expect(purchaseOrder.unpriced_lines).toBe(1)
      await setFinance(false)
    })
  })
})
