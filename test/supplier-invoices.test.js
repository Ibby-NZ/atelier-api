// W14 — consolidated supplier invoices, end to end.
//
// The case the whole epic exists for is the one this file spends most of its
// fixtures on: ONE supplier sends ONE invoice covering purchase orders raised
// for TWO of its houses. W13 groups purchase orders by brand, so that is the
// ordinary shape of every bill, not an edge case — `covers two houses of one
// supplier on one bill` is the load-bearing test here.
//
// Blocks are ordered by what they protect: the guard, then the schema
// invariants (the ones a later story cannot re-derive), then the supplier
// agreement, the one-invoice-per-purchase-order rule, the derived variance, the
// matching search, the delete refusals and the finance gate.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { LIFECYCLE_ENTITY_NAMES } from '../src/lifecycle/registry.js'
import { SUPPLIER_INVOICE_STATUSES } from '../src/purchasing/supplier-invoices.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'si-test'
const DOMAIN = 'si-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const SKU = {
  alpha: `${PREFIX}-ALPHA`,
  beta: `${PREFIX}-BETA`,
  other: `${PREFIX}-OTHER`,
}

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Both edges out of `supplier_invoice_allocations` are RESTRICT, so the join
// rows go FIRST — before the invoices and before the purchase orders. After
// that it is W13's order: receipts before purchase orders, purchase orders
// before orders (the sales-order allocations are RESTRICT), orders before
// brands (`order_lines.colourway_id` is RESTRICT), brands before suppliers.
// One wrong step and the CLEANUP itself 23503s in the next beforeEach.
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
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

// TWO houses under ONE supplier — the shape every consolidated invoice arrives
// in — plus a third house under a DIFFERENT supplier, which is what the
// supplier-agreement 422 is proved against.
const seedFixtures = async (pool) => {
  const supplierIds = {}
  for (const [key, name] of [
    ['main', `${PREFIX} Main Supplier`],
    ['other', `${PREFIX} Other Supplier`],
  ]) {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug, country, currency, po_email)
       VALUES ($1, $2, 'Italy', 'EUR', 'orders@si-test.example.com')
       RETURNING id`,
      [name, `${PREFIX}-${key}`]
    )
    supplierIds[key] = rows[0].id
  }

  const brandIds = {}
  const colourwayIds = {}
  for (const [key, supplier] of [
    ['alpha', supplierIds.main],
    ['beta', supplierIds.main],
    ['other', supplierIds.other],
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
    const { rows } = await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3) RETURNING id`,
      [products[0].id, SKU[key], SKU[key]]
    )
    colourwayIds[SKU[key]] = rows[0].id
    await pool.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
       VALUES ($1, 100, 0, 'metres')`,
      [rows[0].id]
    )
  }
  return { supplierIds, brandIds, colourwayIds }
}

describe('W14 consolidated supplier invoices', () => {
  let pool
  let app
  let staffCookie
  let customerCookie
  let fixtures

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const setFinance = (value) =>
    pool.query(`UPDATE users SET can_view_finance = $2 WHERE email = $1`, [
      testEmail('staff'),
      value,
    ])

  // A purchase order for one house, priced so it has a cost to compare against.
  const raisePurchaseOrder = async (brand, { qty = 40, unitPrice = 48.5 } = {}) => {
    const sku = brand === 'alpha' ? SKU.alpha : brand === 'beta' ? SKU.beta : SKU.other
    const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
      brand_id: fixtures.brandIds[brand],
      lines: [
        {
          colourway_id: fixtures.colourwayIds[sku],
          qty_ordered: qty,
          ...(unitPrice === null ? {} : { unit_price: unitPrice }),
        },
      ],
    })
    expect(response.statusCode).toBe(201)
    return response.json().purchase_order
  }

  const createInvoice = async (overrides = {}) => {
    const response = await inject('POST', '/admin/supplier-invoices', staffCookie, {
      supplier_id: fixtures.supplierIds.main,
      invoice_number: `INV-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      invoice_date: '2026-08-01',
      total_amount: 2200,
      ...overrides,
    })
    expect(response.statusCode).toBe(201)
    return response.json().supplier_invoice
  }

  const attach = (invoiceId, payload) =>
    inject('POST', `/admin/supplier-invoices/${invoiceId}/allocations`, staffCookie, payload)

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
      payload: { email: testEmail('staff'), password: PASSWORD, name: 'Accounts' },
    })
    staffCookie = cookieOf(staff)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = true WHERE email = $1`,
      [testEmail('staff')]
    )

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
    await setFinance(true)
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
    // preHandler, so a malformed body would assert a 400 and pass with the
    // guard deleted.
    const surface = [
      ['GET', '/admin/supplier-invoices', undefined],
      ['GET', '/admin/supplier-invoices/unbilled', undefined],
      [
        'POST',
        '/admin/supplier-invoices',
        {
          supplier_id: 1,
          invoice_number: 'INV-1',
          invoice_date: '2026-08-01',
          total_amount: 10,
        },
      ],
      ['GET', '/admin/supplier-invoices/1', undefined],
      ['PATCH', '/admin/supplier-invoices/1', { notes: 'x' }],
      ['DELETE', '/admin/supplier-invoices/1', undefined],
      ['POST', '/admin/supplier-invoices/1/allocations', { purchase_order_id: 1 }],
      ['DELETE', '/admin/supplier-invoices/1/allocations/1', undefined],
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
          WHERE table_schema = 'public' AND table_name LIKE 'supplier\\_invoice%'`
      )
      columns = rows
    })

    it('holds one-invoice-per-purchase-order as a PLAIN unique constraint', async () => {
      // PLAIN, not partial the way `purchase_order_line_allocations_open_unique`
      // is: there is no released-then-re-claimed state here, and a predicate is
      // exactly what would let two live rows exist for one purchase order —
      // which is the double-counted spend the constraint exists to prevent.
      const { rows } = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE indexname = 'supplier_invoice_allocations_purchase_order_id_key'`
      )
      expect(rows[0].indexdef).toContain('UNIQUE')
      expect(rows[0].indexdef).toContain('purchase_order_id')
      expect(rows[0].indexdef).not.toMatch(/WHERE/)
    })

    it('makes an invoice number unique to its SUPPLIER, case- and space-insensitively', async () => {
      const { rows } = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE indexname = 'supplier_invoices_supplier_number_unique'`
      )
      // Not global: two maisons both numbering from 1001 is ordinary, and a
      // global unique would refuse the second one's paperwork outright.
      expect(rows[0].indexdef).toContain('UNIQUE')
      expect(rows[0].indexdef).toMatch(/supplier_id/)
      expect(rows[0].indexdef).toMatch(/lower\(btrim\(invoice_number\)\)/)
    })

    it('carries NO integer-cents column', () => {
      const offenders = columns.filter((column) => /_cents$/.test(column.column_name))
      expect(offenders.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([])
      expect(columns.length).toBeGreaterThan(15)
    })

    it('prices in numeric(12,4) — purchase_order_lines.unit_price exactly', async () => {
      // A supplier invoice is foreign, fractional and unconverted, exactly as a
      // purchase order is. Asserted against the LIVE purchasing column rather
      // than a transcribed literal, so the two drifting apart fails here.
      const { rows } = await pool.query(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns
          WHERE table_name = 'purchase_order_lines' AND column_name = 'unit_price'`
      )
      for (const name of ['total_amount', 'freight_amount', 'duty_amount']) {
        const column = columns.find(
          (entry) => entry.table_name === 'supplier_invoices' && entry.column_name === name
        )
        expect(column.data_type).toBe('numeric')
        expect(column.numeric_precision).toBe(rows[0].numeric_precision)
        expect(column.numeric_scale).toBe(rows[0].numeric_scale)
      }
      const amount = columns.find(
        (entry) =>
          entry.table_name === 'supplier_invoice_allocations' && entry.column_name === 'amount'
      )
      expect(amount.numeric_scale).toBe(rows[0].numeric_scale)
    })

    it('agrees with the live status CHECK on the vocabulary', async () => {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'supplier_invoices_status_check'`
      )
      const inTheCheck = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
      expect(new Set(inTheCheck)).toEqual(new Set(SUPPLIER_INVOICE_STATUSES))
    })

    it('makes both allocation edges RESTRICT', async () => {
      const { rows } = await pool.query(
        `SELECT conname, confdeltype FROM pg_constraint
          WHERE conname IN ('supplier_invoice_allocations_supplier_invoice_id_fkey',
                            'supplier_invoice_allocations_purchase_order_id_fkey',
                            'supplier_invoices_supplier_id_fkey')`
      )
      expect(rows).toHaveLength(3)
      // 'r' = RESTRICT. A CASCADE anywhere here would let a delete somewhere
      // else silently destroy the record of what was billed.
      for (const row of rows) expect(row.confdeltype).toBe('r')
    })

    it('constrains SUM(amount) against nothing at all', async () => {
      // Deliberate, and the one invariant that is an ABSENCE: the unreconciled
      // difference IS the product, so a CHECK would refuse exactly the
      // half-done state the screen exists to show. (It could not be written
      // either — a CHECK sees one row and this is an aggregate over a set.)
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE contype = 'c'
            AND conrelid IN ('supplier_invoices'::regclass,
                             'supplier_invoice_allocations'::regclass)`
      )
      for (const row of rows) expect(row.def).not.toMatch(/total_amount.*amount|sum/i)
    })
  })

  describe('entering a bill', () => {
    it('snapshots the house onto the document and defaults its currency', async () => {
      const invoice = await createInvoice()
      expect(invoice.supplier_id).toBe(fixtures.supplierIds.main)
      expect(invoice.supplier_name).toBe(`${PREFIX} Main Supplier`)
      expect(invoice.currency).toBe('EUR')
      expect(invoice.status).toBe('received')
      // A calendar day, not an instant dragged across a timezone.
      expect(invoice.invoice_date).toBe('2026-08-01')
      expect(invoice.created_by_name).toBe('Accounts')
    })

    it('refuses the same number from the same house, however it was typed', async () => {
      await createInvoice({ invoice_number: 'INV-2291' })
      const again = await inject('POST', '/admin/supplier-invoices', staffCookie, {
        supplier_id: fixtures.supplierIds.main,
        // Typed off the paper a second time: different case, stray spaces.
        invoice_number: '  inv-2291 ',
        invoice_date: '2026-08-02',
        total_amount: 100,
      })
      expect(again.statusCode).toBe(409)
      // Named from the ROW ON FILE, not echoed back in the caller's own
      // spelling: the collision is usually case or spacing, and echoing "
      // inv-2291 " reads as though the two are unrelated bills.
      expect(again.json().message).toContain('INV-2291')
      expect(again.json().message).toContain('2026-08-01')
    })

    it('allows the same number from a DIFFERENT house', async () => {
      await createInvoice({ invoice_number: 'INV-1001' })
      const other = await inject('POST', '/admin/supplier-invoices', staffCookie, {
        supplier_id: fixtures.supplierIds.other,
        invoice_number: 'INV-1001',
        invoice_date: '2026-08-02',
        total_amount: 100,
      })
      // An invoice number is unique to the house that issued it. Two maisons
      // both numbering from 1001 is the ordinary case.
      expect(other.statusCode).toBe(201)
    })

    it('answers 422 for an unknown supplier and for an impossible date', async () => {
      const unknown = await inject('POST', '/admin/supplier-invoices', staffCookie, {
        supplier_id: 99999999,
        invoice_number: 'INV-X',
        invoice_date: '2026-08-01',
        total_amount: 10,
      })
      expect(unknown.statusCode).toBe(422)

      // The route pattern can only police the SHAPE — Fastify's bundled Ajv has
      // no `format` keywords — so this reaches pg as a 22007.
      const impossible = await inject('POST', '/admin/supplier-invoices', staffCookie, {
        supplier_id: fixtures.supplierIds.main,
        invoice_number: 'INV-Y',
        invoice_date: '2026-02-31',
        total_amount: 10,
      })
      expect(impossible.statusCode).toBe(422)
    })

    it('patches the header but offers no way to move it to another house', async () => {
      const invoice = await createInvoice()
      const patched = await inject(
        'PATCH',
        `/admin/supplier-invoices/${invoice.id}`,
        staffCookie,
        // `supplier_id` is stripped by Ajv's removeAdditional rather than
        // rejected, which is exactly why the WHITELIST is the real gate: moving
        // an invoice to another house would leave every attached purchase order
        // belonging to the old one.
        { status: 'matched', freight_amount: 120, supplier_id: fixtures.supplierIds.other }
      )
      expect(patched.statusCode).toBe(200)
      expect(patched.json().supplier_invoice.status).toBe('matched')
      expect(patched.json().supplier_invoice.freight_amount).toBe(120)
      expect(patched.json().supplier_invoice.supplier_id).toBe(fixtures.supplierIds.main)
    })

    it('filters the list by house, status, date range and invoice number', async () => {
      await createInvoice({ invoice_number: 'INV-AAA', invoice_date: '2026-07-05' })
      const august = await createInvoice({ invoice_number: 'INV-BBB', invoice_date: '2026-08-20' })
      await inject('PATCH', `/admin/supplier-invoices/${august.id}`, staffCookie, {
        status: 'disputed',
      })

      const byHouse = await inject(
        'GET',
        `/admin/supplier-invoices?supplier_id=${fixtures.supplierIds.main}`,
        staffCookie
      )
      expect(byHouse.json().supplier_invoices).toHaveLength(2)
      expect(byHouse.json().meta.total).toBe(2)

      const byStatus = await inject(
        'GET',
        `/admin/supplier-invoices?supplier_id=${fixtures.supplierIds.main}&status=disputed`,
        staffCookie
      )
      expect(byStatus.json().supplier_invoices.map((i) => i.invoice_number)).toEqual(['INV-BBB'])

      const byRange = await inject(
        'GET',
        `/admin/supplier-invoices?supplier_id=${fixtures.supplierIds.main}` +
          '&from=2026-08-01&to=2026-08-31',
        staffCookie
      )
      // `to` is INCLUSIVE on a date column: an invoice dated the 31st is inside
      // a range that ends on the 31st.
      expect(byRange.json().supplier_invoices.map((i) => i.invoice_number)).toEqual(['INV-BBB'])

      const byNumber = await inject(
        'GET',
        `/admin/supplier-invoices?supplier_id=${fixtures.supplierIds.main}&q=aaa`,
        staffCookie
      )
      expect(byNumber.json().supplier_invoices.map((i) => i.invoice_number)).toEqual(['INV-AAA'])
    })
  })

  describe('attaching purchase orders', () => {
    it('covers two houses of ONE supplier on one bill', async () => {
      // THE NORMAL CASE, and the entire reason this epic exists as something
      // separate from W13: the derivation groups by BRAND, so a supplier that
      // sells two houses is billed once for two purchase orders.
      const alpha = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 })
      const beta = await raisePurchaseOrder('beta', { qty: 10, unitPrice: 20 })
      expect(alpha.supplier_id).toBe(beta.supplier_id)
      expect(alpha.brand_id).not.toBe(beta.brand_id)

      const invoice = await createInvoice({ total_amount: 2200 })
      expect((await attach(invoice.id, { purchase_order_id: alpha.id, amount: 1940 })).statusCode)
        .toBe(201)
      const second = await attach(invoice.id, { purchase_order_id: beta.id, amount: 200 })
      expect(second.statusCode).toBe(201)

      const billed = second.json().supplier_invoice
      expect(billed.allocation_count).toBe(2)
      expect(billed.purchase_orders.map((po) => po.po_number).sort()).toEqual(
        [alpha.po_number, beta.po_number].sort()
      )
      // Each line of the bill says WHICH house it is for — the one thing the
      // office cannot work out from the paper.
      expect(new Set(billed.purchase_orders.map((po) => po.brand_name))).toEqual(
        new Set([`${PREFIX} alpha`, `${PREFIX} beta`])
      )
      expect(billed.allocated_amount).toBe(2140)
      expect(billed.purchase_orders_cost).toBe(2140)
    })

    it('answers 409 naming the invoice that already holds it', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const first = await createInvoice({ invoice_number: 'INV-FIRST' })
      const second = await createInvoice({ invoice_number: 'INV-SECOND' })
      expect((await attach(first.id, { purchase_order_id: purchaseOrder.id })).statusCode).toBe(201)

      const clash = await attach(second.id, { purchase_order_id: purchaseOrder.id })
      expect(clash.statusCode).toBe(409)
      // Named by a QUERY, never by parsing error.detail.
      expect(clash.json().message).toContain('INV-FIRST')
      expect(clash.json().message).toContain(purchaseOrder.po_number)
    })

    it('answers 422 naming the purchase order raised for another house', async () => {
      // The supplier agreement: enforced in the module, not in SQL, because
      // saying it in the schema needs two chained composite foreign keys.
      const foreign = await raisePurchaseOrder('other')
      const invoice = await createInvoice()
      const response = await attach(invoice.id, { purchase_order_id: foreign.id })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toContain(foreign.po_number)
      expect(response.json().message).toContain(`${PREFIX} Other Supplier`)
    })

    it('answers 422 for a purchase order that does not exist and 404 for an unknown invoice', async () => {
      const invoice = await createInvoice()
      expect((await attach(invoice.id, { purchase_order_id: 99999999 })).statusCode).toBe(422)
      expect((await attach(99999999, { purchase_order_id: 1 })).statusCode).toBe(404)
    })

    it('detaches, and the purchase order can then go on the right bill', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const wrong = await createInvoice({ invoice_number: 'INV-WRONG' })
      const right = await createInvoice({ invoice_number: 'INV-RIGHT' })
      await attach(wrong.id, { purchase_order_id: purchaseOrder.id })

      const detached = await inject(
        'DELETE',
        `/admin/supplier-invoices/${wrong.id}/allocations/${purchaseOrder.id}`,
        staffCookie
      )
      expect(detached.statusCode).toBe(200)
      expect(detached.json().supplier_invoice.purchase_orders).toEqual([])

      // The correction the whole detach exists for.
      expect((await attach(right.id, { purchase_order_id: purchaseOrder.id })).statusCode).toBe(201)
    })

    it('answers 404 detaching a purchase order that is not on this invoice', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const invoice = await createInvoice()
      const response = await inject(
        'DELETE',
        `/admin/supplier-invoices/${invoice.id}/allocations/${purchaseOrder.id}`,
        staffCookie
      )
      expect(response.statusCode).toBe(404)
    })

    it('shows a purchase order which bill it is on', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const before = await inject(
        'GET',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie
      )
      expect(before.json().purchase_order.supplier_invoice).toBeNull()

      const invoice = await createInvoice({ invoice_number: 'INV-SEEN' })
      await attach(invoice.id, { purchase_order_id: purchaseOrder.id, amount: 1940 })

      const after = await inject('GET', `/admin/purchase-orders/${purchaseOrder.id}`, staffCookie)
      expect(after.json().purchase_order.supplier_invoice).toMatchObject({
        id: invoice.id,
        invoice_number: 'INV-SEEN',
        invoice_date: '2026-08-01',
        status: 'received',
        amount: 1940,
      })
    })
  })

  describe('the derived variance', () => {
    it('reports the two differences and writes neither', async () => {
      const alpha = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 }) // 1940
      const beta = await raisePurchaseOrder('beta', { qty: 10, unitPrice: 20 }) // 200
      const invoice = await createInvoice({ total_amount: 2200 })
      await attach(invoice.id, { purchase_order_id: alpha.id, amount: 1940 })
      // Attached with NO amount: a consolidated bill often does not break its
      // total down per purchase order, and that half-done state is the point.
      await attach(invoice.id, { purchase_order_id: beta.id })

      const read = await inject('GET', `/admin/supplier-invoices/${invoice.id}`, staffCookie)
      const billed = read.json().supplier_invoice
      // How far through the reconciliation the office is …
      expect(billed.allocated_amount).toBe(1940)
      expect(billed.unallocated_amount).toBe(260)
      expect(billed.unstated_allocations).toBe(1)
      // … and the commercial question: did the house bill what it quoted.
      expect(billed.purchase_orders_cost).toBe(2140)
      expect(billed.variance).toBe(60)
      expect(billed.unpriced_purchase_orders).toBe(0)

      // DERIVED, never stored: no column anywhere holds either figure.
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name LIKE 'supplier_invoice%'
            AND column_name ~ 'variance|unallocated|allocated_amount'`
      )
      expect(rows).toEqual([])
    })

    it('withholds a variance the population cannot support', async () => {
      // A variance against a partly-priced purchase order reads as a
      // discrepancy that is really a missing price — the "a figure that cannot
      // be added is ABSENT" rule, one grain up from W13's total_cost.
      const priced = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 })
      const unpriced = await raisePurchaseOrder('beta', { qty: 10, unitPrice: null })
      const invoice = await createInvoice({ total_amount: 2200 })
      await attach(invoice.id, { purchase_order_id: priced.id, amount: 1940 })
      await attach(invoice.id, { purchase_order_id: unpriced.id, amount: 200 })

      const read = await inject('GET', `/admin/supplier-invoices/${invoice.id}`, staffCookie)
      const billed = read.json().supplier_invoice
      expect(billed.purchase_orders_cost).toBeNull()
      expect(billed.variance).toBeNull()
      expect(billed.unpriced_purchase_orders).toBe(1)
      // The apportionment half still adds up — the two questions are separate.
      expect(billed.allocated_amount).toBe(2140)
      expect(billed.unallocated_amount).toBe(60)
    })

    it('records freight and duty and apportions neither', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 })
      const invoice = await createInvoice({
        total_amount: 2200,
        freight_amount: 210,
        duty_amount: 50,
        fx_rate: 0.548210,
      })
      await attach(invoice.id, { purchase_order_id: purchaseOrder.id, amount: 1940 })

      const read = await inject('GET', `/admin/supplier-invoices/${invoice.id}`, staffCookie)
      const billed = read.json().supplier_invoice
      expect(billed.freight_amount).toBe(210)
      expect(billed.duty_amount).toBe(50)
      // Recorded RAW and never multiplied by anything — the FX basis is still
      // owed by the client.
      expect(billed.fx_rate).toBe(0.54821)
      // The variance is against the FULL total. Nothing here decides which part
      // of a total is goods, and the purchase order's own price is untouched:
      // an actual freight cost never writes back to a rate or a sell figure.
      expect(billed.variance).toBe(260)
      expect(billed.purchase_orders[0].purchase_order_cost).toBe(1940)
      const reread = await inject(
        'GET',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie
      )
      expect(reread.json().purchase_order.lines[0].unit_price).toBe(48.5)
      expect(reread.json().purchase_order.total_cost).toBe(1940)
    })

    it('accepts an invoice nobody has finished reconciling', async () => {
      // No CHECK ties SUM(amount) to total_amount, so the half-done state is
      // storable — which is the whole feature.
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const invoice = await createInvoice({ total_amount: 48000 })
      const response = await attach(invoice.id, { purchase_order_id: purchaseOrder.id, amount: 1 })
      expect(response.statusCode).toBe(201)
      expect(response.json().supplier_invoice.unallocated_amount).toBe(47999)
    })
  })

  describe('the matching search', () => {
    it('lists what no bill covers yet, for one house', async () => {
      const alpha = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 })
      const beta = await raisePurchaseOrder('beta', { qty: 10, unitPrice: 20 })
      await raisePurchaseOrder('other')

      const invoice = await createInvoice()
      await attach(invoice.id, { purchase_order_id: alpha.id })

      const response = await inject(
        'GET',
        `/admin/supplier-invoices/unbilled?supplier_id=${fixtures.supplierIds.main}`,
        staffCookie
      )
      expect(response.statusCode).toBe(200)
      // The attached one has gone; the other house's was never in scope.
      expect(response.json().purchase_orders.map((po) => po.id)).toEqual([beta.id])
      expect(response.json().purchase_orders[0].ordered_cost).toBe(200)
    })

    it('matches by amount, because the paper may not quote our numbers', async () => {
      const alpha = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 }) // 1940
      await raisePurchaseOrder('beta', { qty: 10, unitPrice: 20 }) // 200

      const response = await inject(
        'GET',
        `/admin/supplier-invoices/unbilled?supplier_id=${fixtures.supplierIds.main}` +
          '&amount_min=1900&amount_max=2000',
        staffCookie
      )
      expect(response.json().purchase_orders.map((po) => po.id)).toEqual([alpha.id])

      // And by our own number where the house DOES quote it.
      const byNumber = await inject(
        'GET',
        `/admin/supplier-invoices/unbilled?q=${alpha.po_number}`,
        staffCookie
      )
      expect(byNumber.json().purchase_orders.map((po) => po.id)).toEqual([alpha.id])
    })

    it('leaves a cancelled purchase order out of the search', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      await inject('POST', `/admin/purchase-orders/${purchaseOrder.id}/cancel`, staffCookie)
      const response = await inject(
        'GET',
        `/admin/supplier-invoices/unbilled?supplier_id=${fixtures.supplierIds.main}`,
        staffCookie
      )
      // An order the office says never happened is not something a house bills
      // for, and leaving it in would put permanent noise in every search.
      expect(response.json().purchase_orders).toEqual([])
    })

    it('refuses an amount search from a login without finance visibility', async () => {
      await setFinance(false)
      const response = await inject(
        'GET',
        '/admin/supplier-invoices/unbilled?amount_min=100',
        staffCookie
      )
      // Not 200-with-fewer-rows: "no rows" and "you may not see this" are
      // indistinguishable on a screen and only the second is actionable.
      expect(response.statusCode).toBe(403)
      expect(response.json().message).toMatch(/finance visibility/)
    })
  })

  describe('delete refusals', () => {
    it('refuses an invoice while purchase orders are attached, and takes it after a detach', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const invoice = await createInvoice()
      await attach(invoice.id, { purchase_order_id: purchaseOrder.id })

      const blocked = await inject(
        'DELETE',
        `/admin/supplier-invoices/${invoice.id}`,
        staffCookie
      )
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().blockers).toEqual([
        {
          relation: 'supplier_invoice_allocations',
          label: 'purchase orders',
          count: 1,
          capped: false,
        },
      ])
      // No archived_at column: `matched` and `disputed` take an invoice off the
      // working list AND say why, which archiving cannot.
      expect(blocked.json().archivable).toBe(false)

      await inject(
        'DELETE',
        `/admin/supplier-invoices/${invoice.id}/allocations/${purchaseOrder.id}`,
        staffCookie
      )
      const deleted = await inject(
        'DELETE',
        `/admin/supplier-invoices/${invoice.id}`,
        staffCookie
      )
      expect(deleted.statusCode).toBe(200)
      expect(deleted.json().deleted.entity).toBe('supplier_invoice')
    })

    it('gives the purchase-order delete a third blocker', async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha')
      const invoice = await createInvoice()
      await attach(invoice.id, { purchase_order_id: purchaseOrder.id })

      const response = await inject(
        'DELETE',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers.map((b) => b.relation)).toEqual([
        'supplier_invoice_allocations',
      ])
    })

    it('refuses deleting the supplier a bill names', async () => {
      // NOT covered by the purchase-orders probe: an invoice can be keyed
      // before anything has been ordered from the house.
      await createInvoice()
      const response = await inject(
        'DELETE',
        `/admin/suppliers/${fixtures.supplierIds.main}`,
        staffCookie
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers.map((b) => b.relation)).toContain('supplier_invoices')
    })

    it('registers the entity and offers no route against the join table', () => {
      expect(LIFECYCLE_ENTITY_NAMES).toContain('supplier_invoice')
      // Absence IS the protection: requireEntity throws a plain Error for an
      // unknown name, so a DELETE route cannot be registered against the join
      // even by accident. Detaching is its own route for its own reasons.
      expect(LIFECYCLE_ENTITY_NAMES).not.toContain('supplier_invoice_allocation')
    })
  })

  describe('money is finance-gated', () => {
    let invoiceId
    let purchaseOrderId

    beforeEach(async () => {
      const purchaseOrder = await raisePurchaseOrder('alpha', { qty: 40, unitPrice: 48.5 })
      purchaseOrderId = purchaseOrder.id
      const invoice = await createInvoice({ total_amount: 2200, freight_amount: 210 })
      invoiceId = invoice.id
      await attach(invoiceId, { purchase_order_id: purchaseOrderId, amount: 1940 })
    })

    it('DELETES every money key from a backoffice login without the grant', async () => {
      await setFinance(false)
      const response = await inject('GET', `/admin/supplier-invoices/${invoiceId}`, staffCookie)
      const invoice = response.json().supplier_invoice
      for (const key of [
        'total_amount',
        'freight_amount',
        'duty_amount',
        'fx_rate',
        'allocated_amount',
        'unallocated_amount',
        'purchase_orders_cost',
        'variance',
      ]) {
        expect(invoice).not.toHaveProperty(key)
      }
      expect(invoice.purchase_orders[0]).not.toHaveProperty('amount')
      expect(invoice.purchase_orders[0]).not.toHaveProperty('purchase_order_cost')
      expect(response.body).not.toContain('2200')
      expect(response.body).not.toContain('1940')
      // What is NOT money stays: the bill is still navigable, and which houses
      // it covers is not a cost figure.
      expect(invoice.allocation_count).toBe(1)
      expect(invoice.purchase_orders[0].brand_name).toBe(`${PREFIX} alpha`)

      // Same on the list and on the purchase order's own invoice state.
      const list = await inject(
        'GET',
        `/admin/supplier-invoices?supplier_id=${fixtures.supplierIds.main}`,
        staffCookie
      )
      expect(list.json().supplier_invoices[0]).not.toHaveProperty('total_amount')
      const purchaseOrder = await inject(
        'GET',
        `/admin/purchase-orders/${purchaseOrderId}`,
        staffCookie
      )
      expect(purchaseOrder.json().purchase_order.supplier_invoice).not.toHaveProperty('amount')
      expect(purchaseOrder.json().purchase_order.supplier_invoice.invoice_number).toBeTruthy()
    })

    it('serves them to a login that carries it', async () => {
      await setFinance(true)
      const response = await inject('GET', `/admin/supplier-invoices/${invoiceId}`, staffCookie)
      const invoice = response.json().supplier_invoice
      expect(invoice.total_amount).toBe(2200)
      expect(invoice.freight_amount).toBe(210)
      expect(invoice.allocated_amount).toBe(1940)
      expect(invoice.unallocated_amount).toBe(260)
      expect(invoice.variance).toBe(260)
      expect(invoice.purchase_orders[0].amount).toBe(1940)
    })
  })
})
