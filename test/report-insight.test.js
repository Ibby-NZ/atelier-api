import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  FILTER_COLUMNS,
  REPORT_FILTER_NAMES,
  parseReportFilters,
  buildReportFilters,
} from '../src/reports/filters.js'
import { defineColumns } from '../src/reports/access.js'
import {
  INSIGHT,
  INSIGHT_SECTIONS,
  RECENT_ORDERS_LIMIT,
  insightReport,
  maskInsight,
  sectionsFor,
  subjectKind,
} from '../src/reports/insight.js'
import {
  COLOURWAY_PERFORMANCE,
  COLOURWAY_PERFORMANCE_COLUMNS,
  COLOURWAY_PERFORMANCE_TITLE,
  CATALOGUE_FILTERS,
  colourwayPerformanceReport,
} from '../src/reports/colourway-performance.js'
import {
  productPerformanceReport,
  PRODUCT_PERFORMANCE_GROUPINGS,
  PRODUCT_PERFORMANCE_HOUSE_COLUMNS,
  PRODUCT_PERFORMANCE_COLLECTION_COLUMNS,
  PRODUCT_PERFORMANCE_MONTH_COLUMNS,
  PRODUCT_PERFORMANCE_CLIENT_COLUMNS,
  PRODUCT_PERFORMANCE_STATUS_COLUMNS,
} from '../src/reports/product-performance.js'
import { STOCK_FILTERS } from '../src/reports/stock.js'
import { SCOPE_COLUMNS, REVENUE_STATUSES } from '../src/reports/revenue-lines.js'
import { ORDER_STATUSES } from '../src/orders/admin-orders.js'

// The insight view is a composition of the library's own builders, so what this
// suite proves is (a) the two new pins and grains answer correctly against real
// orders and stock, and (b) the composition — which sections a pin omits, what
// the subject resolves to, that masking runs per section — holds. Everything
// each underlying report already proves stays in test/admin-reports.test.js.
//
// Fixtures are prefix-namespaced and cleaned by prefix. Orders are cleaned
// BEFORE brands (order_lines.colourway_id is RESTRICT), inventory before
// colourways for the same reason.
const PREFIX = 'w5-insight-test'
const ORDER_PREFIX = 'W5-INSIGHT-TEST'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'
const GUEST = `${PREFIX}-guest@example.test`

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const clean = async (db) => {
  await db.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${ORDER_PREFIX}-%`])
  await db.query(
    `DELETE FROM inventory WHERE colourway_id IN (SELECT id FROM colourways WHERE sku LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await db.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await db.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

// One house with a collected design (four colourways in every sold/held
// combination), an uncollected design whose one colour is over-allocated, and a
// second house so the pins have something to exclude. One account client and
// one guest, so the client grain has both kinds of row.
const insertFixture = async (db) => {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0].id
  const brand = (slug, name) =>
    one(
      `INSERT INTO brands (name, slug, currency, is_international, trade_only)
       VALUES ($1, $2, 'NZD', false, false) RETURNING id`,
      [name, slug]
    )
  const product = (brandId, slug, name, collectionId = null, category = null) =>
    one(
      `INSERT INTO products (brand_id, collection_id, name, slug, product_type, category, currency, show_on_website)
       VALUES ($1, $2, $3, $4, 'fabric', $5, 'NZD', true) RETURNING id`,
      [brandId, collectionId, name, slug, category]
    )
  const colourway = (productId, sku, name, hex) =>
    one(
      `INSERT INTO colourways (product_id, name, sku, hex_tones) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [productId, name, sku, hex ? JSON.stringify([hex, '#000000']) : null]
    )
  const stock = (colourwayId, available, reserved) =>
    db.query(
      `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit) VALUES ($1, $2, $3, 'metres')`,
      [colourwayId, available, reserved]
    )
  const order = (suffix, kind, status, createdAt, { userId = null, archived = false } = {}) =>
    one(
      `INSERT INTO orders (order_number, kind, status, guest_email, user_id, created_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7) RETURNING id`,
      [
        `${ORDER_PREFIX}-${suffix}`,
        kind,
        status,
        userId ? null : GUEST,
        userId,
        createdAt,
        archived ? new Date() : null,
      ]
    )
  const line = (orderId, colourwayId, qty, unitPriceCents) =>
    db.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents) VALUES ($1, $2, $3, $4)`,
      [orderId, colourwayId, qty, unitPriceCents]
    )

  const clientId = await one(
    `INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'not-a-real-hash', 'Insight Client', 'customer') RETURNING id`,
    [`${PREFIX}-client@example.test`]
  )

  const houseId = await brand(`${PREFIX}-house`, `${PREFIX} House`)
  const otherId = await brand(`${PREFIX}-other`, `${PREFIX} Other`)
  const collectionId = await one(
    `INSERT INTO collections (brand_id, name, slug) VALUES ($1, 'Season', $2) RETURNING id`,
    [houseId, `${PREFIX}-season`]
  )
  const designId = await product(houseId, `${PREFIX}-design`, `${PREFIX} Design`, collectionId, 'fabric')
  const looseId = await product(houseId, `${PREFIX}-loose`, `${PREFIX} Loose`)
  const otherDesignId = await product(otherId, `${PREFIX}-other-design`, `${PREFIX} Other Design`, null, 'wallpaper')

  // A: sold and held. B: held, never sold. C: neither (a zero inventory row).
  // D: sold, no inventory row at all. E (of Loose): sold unpriced, over-allocated.
  const a = await colourway(designId, `${PREFIX}-SKU-A`, 'Ivory', '#EFE7D8')
  const b = await colourway(designId, `${PREFIX}-SKU-B`, 'Ash', '#9A9690')
  const c = await colourway(designId, `${PREFIX}-SKU-C`, 'Noir', null)
  const d = await colourway(designId, `${PREFIX}-SKU-D`, 'Wheat', '#D9C08A')
  const e = await colourway(looseId, `${PREFIX}-SKU-E`, 'Leaf', '#7E8E5C')
  const f = await colourway(otherDesignId, `${PREFIX}-SKU-F`, 'Ciel', '#A8C6DE')
  await stock(a, '10.00', '2.00')
  await stock(b, '5.00', '0.00')
  await stock(c, '0.00', '0.00')
  await stock(e, '0.00', '3.00')

  const paid = await order('CHK', 'checkout', 'paid', '2026-03-15 12:00:00', { userId: clientId })
  await line(paid, a, '2.00', 10000)
  await line(paid, d, '1.00', 5000)
  const shipped = await order('SHP', 'order_request', 'shipped', '2026-04-02 12:00:00')
  await line(shipped, e, '3.00', 0)
  const requested = await order('REQ', 'order_request', 'quote_requested', '2026-04-10 12:00:00')
  await line(requested, a, '5.00', 0)
  const declined = await order('DEC', 'order_request', 'cancelled', '2026-04-11 12:00:00')
  await line(declined, a, '9.00', 0)
  const archived = await order('ARC', 'checkout', 'paid', '2026-03-15 12:00:00', { archived: true })
  await line(archived, a, '7.00', 10000)
  const otherPaid = await order('OTH', 'checkout', 'paid', '2026-03-15 12:00:00')
  await line(otherPaid, f, '4.00', 25000)

  return Object.freeze({ houseId, otherId, collectionId, clientId })
}

const HOUSE = `${PREFIX}-house`
const HOUSES = Object.freeze([HOUSE, `${PREFIX}-other`])
const scoped = (query = {}) => parseReportFilters({ brand: HOUSE, ...query })
const skuOf = (rows) => rows.map((row) => row.sku.replace(`${PREFIX}-`, ''))
const keysOf = (sections) => sections.map((section) => section.key)
// pg hands a timestamptz back as a Date; over HTTP it is an ISO string. One
// month-of-year reading serves both, and the fixture's midday stamps keep it
// off a timezone boundary.
const monthOf = (value) => new Date(value).toISOString().slice(0, 7)

// ---- pure ---------------------------------------------------------------------

describe('the insight pins, declared', () => {
  it('adds product and sku to the whitelist as exact identities on p and c', () => {
    expect(REPORT_FILTER_NAMES).toContain('product')
    expect(REPORT_FILTER_NAMES).toContain('sku')
    expect(FILTER_COLUMNS.product).toBe('p.slug')
    expect(FILTER_COLUMNS.sku).toBe('c.sku')
  })

  it('parses a slug and a SKU, and refuses the shapes they are not', () => {
    expect(parseReportFilters({ product: 'nuage', sku: 'PF-NUA-01' })).toEqual({
      product: 'nuage',
      sku: 'PF-NUA-01',
    })
    expect(() => parseReportFilters({ product: 'Nuage Ciel' })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
    expect(() => parseReportFilters({ sku: 'PF NUA 01' })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
    expect(() => parseReportFilters({ sku: 'PF;DROP' })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })

  it('binds both as placeholders, never as SQL text', () => {
    const built = buildReportFilters({ product: 'nuage', sku: 'PF-NUA-01' })
    expect(built.clauses).toEqual(['p.slug = $1', 'c.sku = $2'])
    expect(built.params).toEqual(['nuage', 'PF-NUA-01'])
  })

  it('reaches the stock report and the colourway report through one list', () => {
    expect(STOCK_FILTERS).toContain('product')
    expect(STOCK_FILTERS).toContain('sku')
    expect(CATALOGUE_FILTERS).toBe(STOCK_FILTERS)
  })

  it('puts the collection id and name in the scope, for the collection grain', () => {
    expect(SCOPE_COLUMNS).toContain('collection_id')
    expect(SCOPE_COLUMNS).toContain('collection_name')
  })
})

describe('the product-performance grains, declared', () => {
  it('registers every non-default grain', () => {
    expect([...PRODUCT_PERFORMANCE_GROUPINGS]).toEqual([
      'category',
      'house',
      'collection',
      'month',
      'client',
      'status',
    ])
  })

  it('leads each grain with the axis it groups by and ends with the four measures', () => {
    const measures = ['orders', 'qty', 'value_cents', 'unpriced_lines']
    const keys = (columns) => columns.map((column) => column.key)
    expect(keys(PRODUCT_PERFORMANCE_HOUSE_COLUMNS)).toEqual([
      'brand_name', 'product_type', 'currency', 'designs', 'colourways', ...measures, 'brand_slug',
    ])
    expect(keys(PRODUCT_PERFORMANCE_COLLECTION_COLUMNS)).toEqual([
      'brand_name', 'collection_name', 'product_type', 'currency', 'designs', ...measures, 'brand_slug', 'collection_slug',
    ])
    expect(keys(PRODUCT_PERFORMANCE_MONTH_COLUMNS)).toEqual(['month', 'product_type', 'currency', ...measures])
    expect(keys(PRODUCT_PERFORMANCE_CLIENT_COLUMNS)).toEqual([
      'client', 'account', 'product_type', 'currency', ...measures, 'last_order_at',
    ])
    expect(keys(PRODUCT_PERFORMANCE_STATUS_COLUMNS)).toEqual([
      'status', 'kind', 'product_type', 'currency', 'lines', ...measures,
    ])
  })

  it('declares no finance column at any grain', () => {
    for (const columns of [
      PRODUCT_PERFORMANCE_HOUSE_COLUMNS,
      PRODUCT_PERFORMANCE_COLLECTION_COLUMNS,
      PRODUCT_PERFORMANCE_MONTH_COLUMNS,
      PRODUCT_PERFORMANCE_CLIENT_COLUMNS,
      PRODUCT_PERFORMANCE_STATUS_COLUMNS,
      COLOURWAY_PERFORMANCE_COLUMNS,
    ]) {
      expect(columns.filter((column) => column.finance)).toEqual([])
    }
  })
})

describe('the colourway report, declared', () => {
  it('names itself and carries sales and stock on one row', () => {
    expect(COLOURWAY_PERFORMANCE).toBe('colourway-performance')
    expect(COLOURWAY_PERFORMANCE_TITLE).toMatch(/colourway/i)
    const keys = COLOURWAY_PERFORMANCE_COLUMNS.map((column) => column.key)
    // Identity, unit, then what sold beside what is held — the reading this
    // table exists for comes first in a table this wide.
    expect(keys).toEqual([
      'sku', 'brand_name', 'product_name', 'colourway_name', 'hex', 'product_type',
      'qty', 'on_hand', 'allocated', 'available',
      'currency', 'value_cents', 'orders', 'unpriced_lines', 'last_sold_at', 'category',
      'brand_slug', 'product_slug',
    ])
  })
})

describe('the insight composition, declared', () => {
  it('draws every section when nothing is pinned', () => {
    expect(keysOf(sectionsFor({}))).toEqual(keysOf(INSIGHT_SECTIONS))
    expect(keysOf(INSIGHT_SECTIONS)).toEqual([
      'by_month', 'by_house', 'by_collection', 'by_design', 'by_category', 'by_colourway',
      'by_client', 'by_rep', 'by_status', 'awaiting_invoice', 'recent_orders',
    ])
  })

  // A pinned grain is one row repeating the header, so the section goes; a
  // deeper pin implies the shallower ones (a design has one house, one
  // collection and one category).
  it('omits the sections a pin makes redundant', () => {
    expect(keysOf(sectionsFor({ brand: ['a'] }))).not.toContain('by_house')
    expect(keysOf(sectionsFor({ brand: ['a', 'b'] }))).toContain('by_house')
    expect(keysOf(sectionsFor({ collection: 'x' }))).toEqual(
      expect.not.arrayContaining(['by_house', 'by_collection'])
    )
    expect(keysOf(sectionsFor({ product: 'x' }))).toEqual([
      'by_month', 'by_colourway', 'by_client', 'by_rep', 'by_status', 'awaiting_invoice', 'recent_orders',
    ])
    expect(keysOf(sectionsFor({ sku: 'x' }))).toEqual(keysOf(sectionsFor({ product: 'x' })))
    expect(keysOf(sectionsFor({ status: 'paid' }))).not.toContain('by_status')
    expect(keysOf(sectionsFor({ rep: 3 }))).not.toContain('by_rep')
    expect(keysOf(sectionsFor({ category: 'fabric' }))).not.toContain('by_category')
  })

  it('names the subject by its deepest pin', () => {
    expect(subjectKind({})).toBe('all')
    expect(subjectKind({ brand: ['a'] })).toBe('house')
    expect(subjectKind({ brand: ['a', 'b'] })).toBe('houses')
    expect(subjectKind({ brand: ['a'], collection: 'c' })).toBe('collection')
    expect(subjectKind({ brand: ['a'], product: 'p' })).toBe('design')
    expect(subjectKind({ product: 'p', sku: 's' })).toBe('colourway')
  })

  it('bounds the orders section to a glance', () => {
    expect(RECENT_ORDERS_LIMIT).toBeLessThanOrEqual(50)
  })

  // Masking is per section: a finance column is deleted from the one section
  // that carries it, and a finance-only section is withheld and NAMED rather
  // than failing the whole view.
  it('masks each section and withholds a finance-only one by name', () => {
    const open = defineColumns([{ key: 'name', label: 'Name' }, { key: 'cost', label: 'Cost', finance: true }])
    const closed = defineColumns([{ key: 'cost', label: 'Landed', finance: true }])
    const insight = {
      report: INSIGHT,
      sections: [
        { key: 'a', report: 'a', columns: open, rows: [{ name: 'x', cost: 1 }], totals: null, meta: {} },
        { key: 'b', report: 'b', columns: closed, rows: [{ cost: 2 }], totals: null, meta: {} },
      ],
      meta: { filters: {} },
    }

    const masked = maskInsight(insight, { finance: false })
    expect(keysOf(masked.sections)).toEqual(['a'])
    expect(masked.sections[0].rows).toEqual([{ name: 'x' }])
    expect(masked.meta.masked_columns).toEqual(['Cost'])
    expect(masked.meta.withheld_sections).toEqual(['b'])

    const finance = maskInsight(insight, { finance: true })
    expect(keysOf(finance.sections)).toEqual(['a', 'b'])
    expect(finance.meta.masked_columns).toEqual([])
    expect(finance.meta.withheld_sections).toEqual([])
  })
})

// ---- against Postgres ----------------------------------------------------------

describe('the insight view against real orders and stock', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }

  const get = (path, cookie = backofficeCookie) =>
    app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    await clean(pool)

    // Registered once each: register shares the login bucket (10 / 15 min).
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-boss@example.test`, password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [`${PREFIX}-boss@example.test`])
    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-shopper@example.test`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)

    await insertFixture(pool)
  })

  afterAll(async () => {
    await clean(pool)
    await app.close()
    await pool.end()
  })

  describe('the colourway report', () => {
    it('lists a colourway that sold or is held, and not one that did neither', async () => {
      const report = await colourwayPerformanceReport(pool, scoped())

      // Value first, then quantity sold, then what is on the shelf.
      expect(skuOf(report.rows)).toEqual(['SKU-A', 'SKU-D', 'SKU-E', 'SKU-B'])
      expect(report.meta).toMatchObject({
        rows_total: 4,
        colourways_sold: 3,
        colourways_held: 3,
        held_unsold: 1,
        over_allocated: 1,
        houses: 1,
        designs: 2,
        truncated: false,
        mixed_units: false,
        mixed_currency: false,
        statuses: REVENUE_STATUSES,
      })
    })

    it('puts the sale and the holding on one row, and the archived order on none', async () => {
      const { rows } = await colourwayPerformanceReport(pool, scoped())
      const a = rows.find((row) => row.sku === `${PREFIX}-SKU-A`)

      expect(a).toMatchObject({
        brand_name: `${PREFIX} House`,
        product_name: `${PREFIX} Design`,
        colourway_name: 'Ivory',
        hex: '#EFE7D8',
        product_type: 'fabric',
        category: 'fabric',
        currency: 'NZD',
        orders: 1,
        qty: 2, // the archived paid order's 7 m is not here
        value_cents: 20000,
        unpriced_lines: 0,
        on_hand: 10,
        allocated: 2,
        available: 8,
        brand_slug: HOUSE,
        product_slug: `${PREFIX}-design`,
      })
      expect(monthOf(a.last_sold_at)).toBe('2026-03')
    })

    it('reads a held colour nobody bought as nil sales, never as absent', async () => {
      const { rows } = await colourwayPerformanceReport(pool, scoped())
      const b = rows.find((row) => row.sku === `${PREFIX}-SKU-B`)

      expect(b).toMatchObject({ orders: 0, qty: 0, value_cents: 0, unpriced_lines: 0, last_sold_at: null, on_hand: 5, available: 5 })
    })

    it('leaves a sold colour with no inventory row without a holding figure, not with a zero', async () => {
      const { rows } = await colourwayPerformanceReport(pool, scoped())
      const d = rows.find((row) => row.sku === `${PREFIX}-SKU-D`)

      expect(d).toMatchObject({ qty: 1, value_cents: 5000, on_hand: null, allocated: null, available: null })
    })

    it('keeps a negative available and counts the unpriced request line', async () => {
      const { rows } = await colourwayPerformanceReport(pool, scoped())
      const e = rows.find((row) => row.sku === `${PREFIX}-SKU-E`)

      expect(e).toMatchObject({ qty: 3, value_cents: 0, unpriced_lines: 1, on_hand: 0, allocated: 3, available: -3 })
    })

    it('totals each figure only while it is one unit, one currency, one type', async () => {
      const { totals } = await colourwayPerformanceReport(pool, scoped())

      expect(totals).toEqual({
        sku: 'All colourways',
        brand_name: 'All houses',
        orders: 2,
        unpriced_lines: 1,
        product_type: 'fabric',
        qty: 6,
        currency: 'NZD',
        value_cents: 25000,
        on_hand: 15,
        allocated: 5,
        available: 10,
      })
    })

    it('narrows to one design with the product pin, and to one colour with the sku pin', async () => {
      const design = await colourwayPerformanceReport(pool, scoped({ product: `${PREFIX}-design` }))
      expect(skuOf(design.rows)).toEqual(['SKU-A', 'SKU-D', 'SKU-B'])
      expect(design.meta.filters).toEqual({ brand: [HOUSE], product: `${PREFIX}-design` })

      const colour = await colourwayPerformanceReport(pool, scoped({ sku: `${PREFIX}-SKU-B` }))
      expect(skuOf(colour.rows)).toEqual(['SKU-B'])
      expect(colour.totals.orders).toBe(0)
    })

    // Two clocks: the window narrows the SALES; the holding is today's.
    it('keeps a held colour in the list when the window holds none of its sales', async () => {
      const report = await colourwayPerformanceReport(pool, scoped({ from: '2026-04-01' }))

      expect(skuOf(report.rows)).toEqual(['SKU-E', 'SKU-A', 'SKU-B'])
      const a = report.rows.find((row) => row.sku === `${PREFIX}-SKU-A`)
      expect(a).toMatchObject({ qty: 0, value_cents: 0, on_hand: 10 })
      expect(report.meta.coverage.requested_from).toBe('2026-04-01')
    })

    it('is served with its export off one declaration', async () => {
      const table = await get(`/admin/reports/colourway-performance?brand=${HOUSE}`)
      expect(table.statusCode).toBe(200)
      expect(table.json().report).toBe('colourway-performance')
      expect(table.headers['x-ratelimit-limit']).toBeDefined()

      const file = await get(`/admin/reports/colourway-performance/export.csv?brand=${HOUSE}`)
      expect(file.statusCode).toBe(200)
      expect(file.headers['content-disposition']).toBe(
        'attachment; filename="atelier-colourway-performance.csv"'
      )
      expect(file.body.split('\r\n')[0]).toBe(
        COLOURWAY_PERFORMANCE_COLUMNS.map((column) => column.label).join(',')
      )
    })
  })

  describe('the new product-performance grains', () => {
    const grouped = (group, query = {}) => productPerformanceReport(pool, scoped(query), { group })

    it('rolls the two houses up with their design and colour counts', async () => {
      const report = await productPerformanceReport(pool, parseReportFilters({ brand: HOUSES }), { group: 'house' })

      expect(report.title).toBe('Sales by house')
      expect(report.columns).toBe(PRODUCT_PERFORMANCE_HOUSE_COLUMNS)
      expect(report.rows).toEqual([
        {
          brand_name: `${PREFIX} Other`, product_type: 'fabric', currency: 'NZD',
          designs: 1, colourways: 1, orders: 1, qty: 4, value_cents: 100000, unpriced_lines: 0,
          brand_slug: `${PREFIX}-other`,
        },
        {
          brand_name: `${PREFIX} House`, product_type: 'fabric', currency: 'NZD',
          designs: 2, colourways: 3, orders: 2, qty: 6, value_cents: 25000, unpriced_lines: 1,
          brand_slug: HOUSE,
        },
      ])
      expect(report.meta).toMatchObject({ grouped_by: 'house', rows_total: 2, statuses: REVENUE_STATUSES })
    })

    it('keeps a house’s uncollected designs as their own collection row', async () => {
      const { rows, totals } = await grouped('collection')

      expect(rows).toEqual([
        {
          brand_name: `${PREFIX} House`, collection_name: 'Season', product_type: 'fabric', currency: 'NZD',
          designs: 1, orders: 1, qty: 3, value_cents: 25000, unpriced_lines: 0,
          brand_slug: HOUSE, collection_slug: `${PREFIX}-season`,
        },
        {
          brand_name: `${PREFIX} House`, collection_name: 'No collection', product_type: 'fabric', currency: 'NZD',
          designs: 1, orders: 1, qty: 3, value_cents: 0, unpriced_lines: 1,
          brand_slug: HOUSE, collection_slug: null,
        },
      ])
      expect(totals).toMatchObject({ brand_name: 'All houses', collection_name: 'All collections', value_cents: 25000 })
    })

    it('buckets the trend by calendar month, oldest first, with no row for a quiet month', async () => {
      const { rows } = await grouped('month')

      expect(rows.map((row) => row.month)).toEqual(['2026-03', '2026-04'])
      expect(rows[0]).toMatchObject({ orders: 1, qty: 3, value_cents: 25000, unpriced_lines: 0 })
      expect(rows[1]).toMatchObject({ orders: 1, qty: 3, value_cents: 0, unpriced_lines: 1 })
    })

    it('names the account and the guest behind the sales, with their last order', async () => {
      const { rows } = await grouped('client')

      expect(rows.map((row) => [row.client, row.account])).toEqual([
        ['Insight Client', 'account'],
        [GUEST, 'guest'],
      ])
      expect(rows[0]).toMatchObject({ orders: 1, qty: 3, value_cents: 25000 })
      expect(monthOf(rows[0].last_order_at)).toBe('2026-03')
    })

    // The one grain that does NOT default to paid/shipped: its question is the
    // whole lifecycle, so every status is in and the archived order still is not.
    it('reports every lifecycle status, replacing the revenue default', async () => {
      const report = await grouped('status')

      expect(report.meta.statuses).toBe(ORDER_STATUSES)
      expect(report.rows.map((row) => [row.status, row.kind, row.lines, row.qty])).toEqual([
        ['cancelled', 'order_request', 1, 9],
        ['paid', 'checkout', 2, 3],
        ['quote_requested', 'order_request', 1, 5],
        ['shipped', 'order_request', 1, 3],
      ])
      expect(report.totals.orders).toBe(4)
    })

    it('still lets a status filter replace even that default', async () => {
      const { rows } = await grouped('status', { status: 'quote_requested' })
      expect(rows.map((row) => row.status)).toEqual(['quote_requested'])
    })

    it('is reachable over HTTP and refuses a grain it does not have', async () => {
      const house = await get(`/admin/reports/product-performance?brand=${HOUSE}&group=house`)
      expect(house.statusCode).toBe(200)
      expect(house.json().meta.grouped_by).toBe('house')
      expect((await get(`/admin/reports/product-performance?brand=${HOUSE}&group=colour`)).statusCode).toBe(400)
    })
  })

  describe('the composite', () => {
    it('answers one house with every section but its own', async () => {
      const insight = await insightReport(pool, scoped())

      expect(insight.report).toBe(INSIGHT)
      expect(keysOf(insight.sections)).toEqual([
        'by_month', 'by_collection', 'by_design', 'by_category', 'by_colourway',
        'by_client', 'by_rep', 'by_status', 'awaiting_invoice', 'recent_orders',
      ])
      expect(insight.meta.omitted_sections).toEqual(['by_house'])
      for (const section of insight.sections) {
        expect(section.columns.length).toBeGreaterThan(0)
        expect(section.meta.filters).toEqual({ brand: [HOUSE] })
      }
    })

    it('resolves the pinned house, design and colour to their names', async () => {
      expect((await insightReport(pool, scoped())).subject).toEqual({
        kind: 'house',
        brands: [{ slug: HOUSE, name: `${PREFIX} House` }],
        product: null,
        colourway: null,
        collections: [],
      })

      const design = (await insightReport(pool, scoped({ product: `${PREFIX}-design` }))).subject
      expect(design.kind).toBe('design')
      expect(design.product).toMatchObject({
        slug: `${PREFIX}-design`,
        name: `${PREFIX} Design`,
        brand_name: `${PREFIX} House`,
        collection_name: 'Season',
        collection_slug: `${PREFIX}-season`,
      })

      const colour = (await insightReport(pool, scoped({ sku: `${PREFIX}-SKU-B` }))).subject
      expect(colour.kind).toBe('colourway')
      expect(colour.colourway).toMatchObject({ sku: `${PREFIX}-SKU-B`, name: 'Ash', hex: '#9A9690', product_name: `${PREFIX} Design` })

      const collection = (await insightReport(pool, scoped({ collection: `${PREFIX}-season` }))).subject
      expect(collection.kind).toBe('collection')
      expect(collection.collections).toEqual([
        { slug: `${PREFIX}-season`, name: 'Season', brand_slug: HOUSE, brand_name: `${PREFIX} House` },
      ])
    })

    it('leaves a mistyped pin unresolved rather than guessing', async () => {
      const { subject } = await insightReport(pool, scoped({ product: 'no-such-design' }))
      expect(subject.kind).toBe('design')
      expect(subject.product).toBeNull()
    })

    it('states the headline figures over the revenue population, plus the shelf and the queue', async () => {
      const { summary } = await insightReport(pool, scoped())

      expect(summary).toMatchObject({
        orders: 2,
        lines: 3,
        qty: 6,
        product_type: 'fabric',
        mixed_units: false,
        value_cents: 25000,
        currency: 'NZD',
        mixed_currency: false,
        unpriced_lines: 1,
        houses: 1,
        designs: 2,
        colourways_sold: 3,
        clients: 2,
        statuses: REVENUE_STATUSES,
        stock: {
          colourways_held: 3,
          held_unsold: 1,
          over_allocated: 1,
          unit: 'metres',
          mixed_units: false,
          on_hand: 15,
          allocated: 5,
          available: 10,
        },
        // The REQ fixture is a quote nobody accepted, so it is not awaiting an
        // invoice (INVOICEABLE_STATUSES).
        awaiting_invoice: { lines: 1 },
      })
      expect(monthOf(summary.first_order_at)).toBe('2026-03')
      expect(monthOf(summary.last_order_at)).toBe('2026-04')
      expect(summary.stock.as_at).toBeTruthy()
    })

    it('narrows every section to a colour under the sku pin', async () => {
      const insight = await insightReport(pool, scoped({ sku: `${PREFIX}-SKU-A` }))

      expect(keysOf(insight.sections)).toEqual([
        'by_month', 'by_colourway', 'by_client', 'by_rep', 'by_status', 'awaiting_invoice', 'recent_orders',
      ])
      const colours = insight.sections.find((section) => section.key === 'by_colourway')
      expect(skuOf(colours.rows)).toEqual(['SKU-A'])
      const status = insight.sections.find((section) => section.key === 'by_status')
      expect(status.rows.map((row) => row.status)).toEqual(['cancelled', 'paid', 'quote_requested'])
      expect(insight.summary).toMatchObject({ orders: 1, qty: 2, value_cents: 20000 })
    })

    it('caps the orders section at the glance limit while its neighbours take the row limit', async () => {
      const insight = await insightReport(pool, scoped(), { limit: 7 })
      const orders = insight.sections.find((section) => section.key === 'recent_orders')
      const colours = insight.sections.find((section) => section.key === 'by_colourway')

      expect(orders.meta.row_limit).toBe(RECENT_ORDERS_LIMIT)
      expect(colours.meta.row_limit).toBe(7)
      expect(insight.meta.row_limit).toBe(7)
    })
  })

  describe('GET /admin/reports/insight', () => {
    const PATH = `/admin/reports/insight?brand=${HOUSE}`

    it('refuses an anonymous caller with 401 and a customer with 403', async () => {
      expect((await get(PATH, null)).statusCode).toBe(401)
      expect((await get(PATH, customerCookie)).statusCode).toBe(403)
    })

    it('serves a back-office caller the masked composite, metered like a table', async () => {
      const response = await get(PATH)

      expect(response.statusCode).toBe(200)
      expect(response.headers['x-ratelimit-limit']).toBeDefined()
      const body = response.json()
      expect(body.report).toBe('insight')
      expect(body.subject.kind).toBe('house')
      expect(body.meta.masked_columns).toEqual([])
      expect(body.meta.withheld_sections).toEqual([])
      for (const section of body.sections) {
        expect(section.meta.masked_columns).toEqual([])
      }
    })

    it('refuses an unusable pin with a 400 naming it', async () => {
      const response = await get(`${PATH}&sku=${encodeURIComponent('PF NUA 01')}`)
      expect(response.statusCode).toBe(400)
      expect(response.json().message).toMatch(/"sku"/)
    })

    it('honours the pins the library’s filter bar cannot spell', async () => {
      const body = (await get(`${PATH}&product=${PREFIX}-loose`)).json()
      expect(body.subject.product.name).toBe(`${PREFIX} Loose`)
      expect(body.summary).toMatchObject({ orders: 1, qty: 3, value_cents: 0, unpriced_lines: 1 })
    })
  })
})
