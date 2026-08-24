// C18 — sample lines on purchase orders, and the value that flows into the
// register when they are receipted.
//
// The claims under test, each with a way of being quietly false:
//
//   1. A sample line ROUND-TRIPS: `is_sample` and `sample_barcode` survive the
//      create, the read and the PATCH. Ajv's removeAdditional strips an
//      undeclared key silently, so a schema gap here does not error — every
//      sample line just lands as goods.
//   2. RECEIPTING FLOWS THE VALUE BY BARCODE, with the NULL-vs-0 semantics
//      intact end to end: a priced line writes its price INCLUDING 0 (the
//      zero-cost free hanger), a NULL-priced line writes NOTHING (no-cost
//      stays NULL). `Number(null)` is 0, so the bug this pins is an unpriced
//      hanger becoming a recorded gift the moment anything sums the register.
//   3. AN UNMATCHED BARCODE IS REPORTED, NEVER MINTED. The tag is often
//      registered after the hanger arrives, so the receipt only updates an
//      existing register row and answers with the barcodes it could not match —
//      staff register the tag and key the value by hand (the manual field on
//      the sample is the fallback).
//   4. A SAMPLE LINE NEVER ALLOCATES SALES DEMAND. The derivation cannot
//      produce one (its lines come from open demand), the manual allocate
//      route is refused, and a goods line already covering demand cannot be
//      flipped into a sample.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'po-sampleval-test'
const DOMAIN = 'po-sampleval-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const SKU = {
  cloth: `${PREFIX}-CLOTH`,
  hanger: `${PREFIX}-HANGER`,
}

const TAG = (suffix) => `${PREFIX}-TAG-${suffix}`

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// The purchasing cleanup order (receipts → purchase orders → orders → brands →
// suppliers), with the register rows in front: our samples carry no colourway
// link, so nothing blocks on them, but a barcode is globally unique and a
// surviving tag 23505s the next run's INSERT.
const cleanupFixtures = async (pool) => {
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1 OR label LIKE $1`, [`${PREFIX}%`])
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
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

// One supplier with a currency, one linked house, two colourways — the cloth
// the demand names and the design the hanger is cut from. The currency matters:
// the receipt writes the ORDER's snapshot currency into `cost_currency`, and a
// fixture without one would let a broken write pass as "both null".
const seedFixtures = async (pool) => {
  const { rows: suppliers } = await pool.query(
    `INSERT INTO suppliers (name, slug, country, currency, agent, incoterm, po_email)
     VALUES ($1, $2, 'Italy', 'EUR', 'Test Agent', 'FOB', 'orders@po-sampleval-test.example.com')
     RETURNING id`,
    [`${PREFIX} Supplier`, `${PREFIX}-supplier`]
  )
  const supplierId = suppliers[0].id

  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
     VALUES ($1, $2, 'Italy', 'EUR', true, false, $3)
     RETURNING id`,
    [`${PREFIX} house`, `${PREFIX}-house`, supplierId]
  )
  const brandId = brands[0].id

  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, $2, $3, 'fabric', 'EUR', true)
     RETURNING id`,
    [brandId, `${PREFIX} design`, `${PREFIX}-design`]
  )

  const colourwayIds = {}
  for (const sku of [SKU.cloth, SKU.hanger]) {
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
  return { supplierId, brandId, colourwayIds }
}

describe('C18 sample lines on purchase orders', () => {
  let pool
  let app
  let staffCookie
  let fixtures

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const raise = async (lines) => {
    const response = await inject('POST', '/admin/purchase-orders', staffCookie, {
      brand_id: fixtures.brandId,
      lines,
    })
    expect(response.statusCode).toBe(201)
    return response.json().purchase_order
  }

  // A register row with NO cost recorded — the state most of the standing
  // library is in, and the state the flow exists to fill.
  const registerSample = async (barcode) => {
    const { rows } = await pool.query(
      `INSERT INTO samples (barcode, label) VALUES ($1, $2) RETURNING id`,
      [barcode, `${PREFIX} hanger`]
    )
    return rows[0].id
  }

  const costOf = async (barcode) => {
    const { rows } = await pool.query(
      `SELECT unit_cost, cost_currency FROM samples WHERE barcode = $1`,
      [barcode]
    )
    return rows[0]
  }

  const receipt = (lineId, payload = { qty: 1 }) =>
    inject('POST', `/admin/purchase-order-lines/${lineId}/receipts`, staffCookie, payload)

  // A manual sales order in a state the derivation counts as open demand.
  const placeOrder = async (qty = 10) => {
    const { rows: orders } = await pool.query(
      `INSERT INTO orders (order_number, kind, status, guest_email)
       VALUES ($1, 'manual', 'confirmed', 'buyer@po-sampleval-test.example.com')
       RETURNING id`,
      [`${PREFIX}-SO-${Math.random().toString(36).slice(2, 10)}`]
    )
    const { rows: lines } = await pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, $3, 0) RETURNING id`,
      [orders[0].id, fixtures.colourwayIds[SKU.cloth], qty]
    )
    return { orderId: orders[0].id, orderLineId: lines[0].id }
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

  describe('the schema', () => {
    it('holds the barcode to sample lines with a named CHECK', async () => {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'purchase_order_lines_sample_barcode_check'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].def).toContain('is_sample')
      expect(rows[0].def).toContain('sample_barcode IS NULL')
    })

    it('defaults every line to a goods line, with no third state', async () => {
      const { rows } = await pool.query(
        `SELECT is_nullable, column_default FROM information_schema.columns
          WHERE table_name = 'purchase_order_lines' AND column_name = 'is_sample'`
      )
      // NOT NULL DEFAULT false: every line raised before the migration is a
      // goods line, and "we do not know whether this is a sample" is not a fact
      // anyone holds.
      expect(rows[0].is_nullable).toBe('NO')
      expect(rows[0].column_default).toBe('false')
    })

    it('is a reference by VALUE, not a foreign key to the register', async () => {
      // The whole unmatched flow depends on a dangling barcode being legal: the
      // tag is often registered AFTER the hanger arrives, and an FK would
      // refuse the purchase-order line until the office had registered a sample
      // they do not hold.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE conrelid = 'purchase_order_lines'::regclass
            AND contype = 'f'
            AND pg_get_constraintdef(oid) LIKE '%sample_barcode%'`
      )
      expect(rows[0].n).toBe(0)
    })
  })

  describe('a sample line round-trips', () => {
    it('creates, reads and patches is_sample and sample_barcode', async () => {
      const purchaseOrder = await raise([
        { colourway_id: fixtures.colourwayIds[SKU.cloth], qty_ordered: 40 },
        {
          colourway_id: fixtures.colourwayIds[SKU.hanger],
          qty_ordered: 1,
          unit_price: 12.5,
          is_sample: true,
          sample_barcode: TAG('rt'),
        },
      ])
      const [goods, sample] = purchaseOrder.lines
      expect(goods.is_sample).toBe(false)
      expect(goods.sample_barcode).toBeNull()
      expect(sample.is_sample).toBe(true)
      expect(sample.sample_barcode).toBe(TAG('rt'))

      // A mistyped tag is corrected on the paper, like every snapshot field.
      const patched = await inject(
        'PATCH',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie,
        { lines: [{ id: sample.id, sample_barcode: TAG('rt-fixed') }] }
      )
      expect(patched.statusCode).toBe(200)
      expect(patched.json().purchase_order.lines[1].sample_barcode).toBe(TAG('rt-fixed'))
    })

    it('refuses a barcode on a goods line, at create and at PATCH', async () => {
      // The CHECK's 23514, mapped to a 422 naming the fix rather than a 500.
      const create = await inject('POST', '/admin/purchase-orders', staffCookie, {
        brand_id: fixtures.brandId,
        lines: [
          {
            colourway_id: fixtures.colourwayIds[SKU.cloth],
            qty_ordered: 1,
            sample_barcode: TAG('goods'),
          },
        ],
      })
      expect(create.statusCode).toBe(422)
      expect(create.json().message).toMatch(/sample/i)

      const purchaseOrder = await raise([
        { colourway_id: fixtures.colourwayIds[SKU.cloth], qty_ordered: 1 },
      ])
      const patch = await inject(
        'PATCH',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie,
        { lines: [{ id: purchaseOrder.lines[0].id, sample_barcode: TAG('goods-2') }] }
      )
      expect(patch.statusCode).toBe(422)
    })
  })

  describe('receipting flows the value into the register by barcode', () => {
    it('writes the line price and the order currency onto the matching row', async () => {
      await registerSample(TAG('flow'))
      const purchaseOrder = await raise([
        {
          colourway_id: fixtures.colourwayIds[SKU.hanger],
          qty_ordered: 1,
          unit_price: 48.5,
          is_sample: true,
          sample_barcode: TAG('flow'),
        },
      ])

      const response = await receipt(purchaseOrder.lines[0].id)
      expect(response.statusCode).toBe(201)
      expect(response.json().sample_register).toEqual({
        updated: [TAG('flow')],
        unmatched: [],
      })

      const row = await costOf(TAG('flow'))
      expect(Number(row.unit_cost)).toBe(48.5)
      // The ORDER's snapshot currency, not anything read off the supplier at
      // receipt time — the paper's currency is what the price is denominated in.
      expect(row.cost_currency).toBe('EUR')
    })

    it('flows 0 as 0 — the zero-cost free hanger stays a recorded fact', async () => {
      await registerSample(TAG('free'))
      const purchaseOrder = await raise([
        {
          colourway_id: fixtures.colourwayIds[SKU.hanger],
          qty_ordered: 1,
          unit_price: 0,
          is_sample: true,
          sample_barcode: TAG('free'),
        },
      ])

      const response = await receipt(purchaseOrder.lines[0].id)
      expect(response.json().sample_register.updated).toEqual([TAG('free')])

      const row = await costOf(TAG('free'))
      // NOT null: 0 is "free of charge, and we know it", which is a different
      // fact from "nobody recorded a cost". `Number(null)` is 0, so only the
      // raw column can tell them apart.
      expect(row.unit_cost).not.toBeNull()
      expect(Number(row.unit_cost)).toBe(0)
      expect(row.cost_currency).toBe('EUR')
    })

    it('writes NOTHING for a NULL-priced line — no-cost stays NULL', async () => {
      await registerSample(TAG('unpriced'))
      const purchaseOrder = await raise([
        {
          colourway_id: fixtures.colourwayIds[SKU.hanger],
          qty_ordered: 1,
          is_sample: true,
          sample_barcode: TAG('unpriced'),
        },
      ])

      const response = await receipt(purchaseOrder.lines[0].id)
      expect(response.statusCode).toBe(201)
      // Nothing was attempted, so nothing is "unmatched" either: the register
      // row exists, there was just no value to flow into it.
      expect(response.json().sample_register).toEqual({ updated: [], unmatched: [] })

      const row = await costOf(TAG('unpriced'))
      expect(row.unit_cost).toBeNull()
      expect(row.cost_currency).toBeNull()
    })

    it('never lets an unpriced line erase a value the office already keyed', async () => {
      // The manual field is the FALLBACK, so a receipt that knows nothing must
      // not overwrite what somebody typed: NULL means "nobody priced this",
      // not "clear it".
      await pool.query(
        `INSERT INTO samples (barcode, label, unit_cost, cost_currency)
         VALUES ($1, $2, 33.25, 'NZD')`,
        [TAG('kept'), `${PREFIX} hanger`]
      )
      const purchaseOrder = await raise([
        {
          colourway_id: fixtures.colourwayIds[SKU.hanger],
          qty_ordered: 1,
          is_sample: true,
          sample_barcode: TAG('kept'),
        },
      ])
      await receipt(purchaseOrder.lines[0].id)

      const row = await costOf(TAG('kept'))
      expect(Number(row.unit_cost)).toBe(33.25)
      expect(row.cost_currency).toBe('NZD')
    })

    it('reports an unmatched barcode and creates NOTHING', async () => {
      const purchaseOrder = await raise([
        {
          colourway_id: fixtures.colourwayIds[SKU.hanger],
          qty_ordered: 1,
          unit_price: 19.9,
          is_sample: true,
          sample_barcode: TAG('missing'),
        },
      ])

      const response = await receipt(purchaseOrder.lines[0].id)
      expect(response.statusCode).toBe(201)
      // The actionable answer: the tag is not in the register, so staff
      // register it and key the value by hand — the receipt itself still lands.
      expect(response.json().sample_register).toEqual({
        updated: [],
        unmatched: [TAG('missing')],
      })
      expect(response.json().purchase_order.lines[0].qty_received).toBe(1)

      // Only the office describes a sample. A row minted here would carry a
      // barcode and nothing else, and the register would fill with tags nobody
      // can identify.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM samples WHERE barcode = $1`,
        [TAG('missing')]
      )
      expect(rows[0].n).toBe(0)
    })

    it('answers an empty report for an ordinary goods receipt', async () => {
      const purchaseOrder = await raise([
        { colourway_id: fixtures.colourwayIds[SKU.cloth], qty_ordered: 40 },
      ])
      const response = await receipt(purchaseOrder.lines[0].id, { qty: 40 })
      // One response shape whether or not the line was a sample, so the CRM
      // reads it without a conditional.
      expect(response.json().sample_register).toEqual({ updated: [], unmatched: [] })
    })
  })

  describe('a sample line never allocates sales demand', () => {
    it('refuses a manual allocation against a sample line', async () => {
      const { orderLineId } = await placeOrder(25)
      const purchaseOrder = await raise([
        {
          colourway_id: fixtures.colourwayIds[SKU.cloth],
          qty_ordered: 40,
          is_sample: true,
          sample_barcode: TAG('alloc'),
        },
      ])
      const response = await inject(
        'POST',
        `/admin/purchase-order-lines/${purchaseOrder.lines[0].id}/allocations`,
        staffCookie,
        { order_line_id: orderLineId, qty: 25 }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/sample/i)

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM purchase_order_line_allocations
          WHERE purchase_order_line_id = $1`,
        [purchaseOrder.lines[0].id]
      )
      expect(rows[0].n).toBe(0)
    })

    it('refuses flipping a goods line that already covers demand into a sample', async () => {
      // The other door to the same invariant: the allocations would sit
      // untouched on a line nothing may allocate against any more.
      await placeOrder(25)
      const generated = await inject(
        'POST',
        '/admin/purchase-orders/generate',
        staffCookie,
        { brand_ids: [fixtures.brandId] }
      )
      const purchaseOrder = generated.json().purchase_orders[0]
      const response = await inject(
        'PATCH',
        `/admin/purchase-orders/${purchaseOrder.id}`,
        staffCookie,
        { lines: [{ id: purchaseOrder.lines[0].id, is_sample: true }] }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/sample/i)
    })

    it('the derivation only ever produces goods lines', async () => {
      // By construction — the planner's lines come from open sales demand and a
      // sample is added by hand — but the construction is what this pins.
      await placeOrder(25)
      const generated = await inject(
        'POST',
        '/admin/purchase-orders/generate',
        staffCookie,
        { brand_ids: [fixtures.brandId] }
      )
      expect(generated.statusCode).toBe(201)
      const lines = generated.json().purchase_orders.flatMap((po) => po.lines)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(line.is_sample).toBe(false)
        expect(line.sample_barcode).toBeNull()
      }
    })
  })
})
