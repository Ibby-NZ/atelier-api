// The Dynamics product prices, re-imported and priced through their houses
// (Sept 2026 — "the price calculation … shown on products in the CRM"):
//   1. reading the uploaded workbook — the narrow sixteen-column view
//   2. pricing a row through its house — the client's worked example, to the cent
//   3. /admin/product-prices/* — the gate, dry run then apply, re-import, reads
//
// Real Postgres, prefixed fixtures, one app per suite (register and login share
// a 10-per-15-min bucket per instance).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { upsertBrandParameters } from '../src/pricing/pricing-parameters.js'
import { createProductPricer } from '../src/pricing/product-prices.js'
import { withChangeContext } from '../src/pricing/price-history.js'
import {
  currencyCode,
  inferDutyClass,
  readProductPricesWorkbook,
} from '../src/pricing/product-prices-import.js'
import { slugify } from '../src/seed/slugify.js'
import { d365Workbook, trackingRow } from './helpers/d365-workbook-fixture.js'

const PREFIX = 'w-product-prices-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'
const FILENAME = 'Active Product Prices 25-09-2026 12-07-28 PM.xlsx'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ENTITY = 'atelier_productprices'

/** The product-price view's columns, in the order the client's export has them. */
const PRODUCT_PRICE_COLUMNS = Object.freeze([
  ['atelier_productpricesid', '(Do Not Modify) Product Prices'],
  ['checksumLogicalName', '(Do Not Modify) Row Checksum'],
  ['modifiedon', '(Do Not Modify) Modified On'],
  ['atelier_description', 'Description'],
  ['fulmxero_trackingoption1id', 'Range'],
  ['atelier_code', 'Code'],
  ['fulmxero_trackingoption2id', 'Type'],
  ['atelier_tradesellpricenz', 'Trade Sell Price over 5m'],
  ['atelier_dateeffective', 'Date Effective'],
  ['transactioncurrencyid', 'Currency'],
  ['atelier_wholesalerate', 'Wholesale Rate'],
  ['atelier_verticalrepeat', 'Vertical Repeat'],
  ['atelier_repeat', 'Repeat'],
  ['atelier_priceexdutynz', 'Price  ex Duty ($NZ)'],
  ['atelier_priceincldutynz', 'Price Incl Duty ($NZ)'],
  ['atelier_freightrate', 'Freight Rate'],
])

// Fixture GUIDs: a fixed prefix no real Dynamics id uses, so cleanup is exact.
const guid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** One row in PRODUCT_PRICE_COLUMNS order. */
const priceRow = (n, values = {}) => {
  const {
    code = `CODE ${n}`,
    description = code,
    range = 'MADEAUX',
    type = 'Fabrics',
    trade = null,
    currency = 'Pound Sterling',
    wholesale = 10,
    exDuty = null,
    inclDuty = exDuty,
    letter = 'A',
  } = values
  return [guid(n), 'checksum==', 46055.2767361111, description, range, code, type, trade, 46048, currency, wholesale, '46H', null, exDuty, inclDuty, letter]
}

const productWorkbook = (rows, columns = PRODUCT_PRICE_COLUMNS) => d365Workbook(rows, { entity: ENTITY, columns })

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

const houseName = (suffix) => `${PREFIX} ${suffix}`.toUpperCase()

// --------------------------------------------------------------------------
// 1. The workbook
// --------------------------------------------------------------------------

describe('reading the product-prices export', () => {
  it('reads rows by their D365 logical names, one line per code, with the export stamp', () => {
    const read = readProductPricesWorkbook(
      productWorkbook([
        priceRow(1, { code: '\nELLA STRIPE\n', trade: 360.52, wholesale: 47.6, exDuty: 125.26 }),
        priceRow(2, { code: 'TWO\nLINES', currency: 'New Zealand Dollar', wholesale: 20, exDuty: 20, inclDuty: 21, letter: 'b' }),
        priceRow(3, { currency: 'Euro', exDuty: null, type: 'W/P' }),
      ]),
      FILENAME
    )
    expect(read.rows_read).toBe(3)
    expect(read.exported_at).toBe('2026-09-25T12:07:28')
    expect(read.rows[0]).toMatchObject({
      guid: guid(1),
      code: 'ELLA STRIPE',
      description: 'ELLA STRIPE',
      range_name: 'MADEAUX',
      item_type: 'Fabrics',
      currency: 'GBP',
      wholesale_rate: 47.6,
      date_effective: '2026-01-26',
      vertical_repeat: '46H',
      horizontal_repeat: null,
      freight_letter: 'A',
      duty_class: null,
      dynamics_price_ex_duty: 125.26,
      dynamics_price_incl_duty: 125.26,
      dynamics_trade_sell: 360.52,
      dynamics_modified_on: '2026-02-02 06:38:29',
    })
    // A line break inside a code is noise; NZ$ is the home currency; duty is
    // read off Dynamics' two prices; the letter is upper-cased.
    expect(read.rows[1]).toMatchObject({ code: 'TWO LINES', currency: 'NZD', duty_class: 'A', freight_letter: 'B' })
    expect(read.rows[2]).toMatchObject({ currency: 'EUR', duty_class: null, item_type: 'W/P' })
  })

  it('maps the export’s currency names and infers duty only where Dynamics charged it', () => {
    expect(['Euro', 'US Dollar', 'Pound Sterling', 'New Zealand Dollar', ' pound  sterling '].map(currencyCode)).toEqual([
      'EUR', 'USD', 'GBP', 'NZD', 'GBP',
    ])
    expect(currencyCode('Swiss Franc')).toBeNull()
    expect(inferDutyClass(100, 105)).toBe('A')
    expect(inferDutyClass(125.26, 125.26)).toBeNull()
    expect(inferDutyClass(null, 105)).toBeNull()
    expect(inferDutyClass(0, 0)).toBeNull()
  })

  it('refuses what is not the export — and a file with any bad row — in words the office can act on', () => {
    const refusal = (buffer) => {
      try {
        readProductPricesWorkbook(buffer, FILENAME)
      } catch (error) {
        return error
      }
      throw new Error('expected a refusal')
    }
    expect(refusal(Buffer.alloc(0)).message).toMatch(/empty/)
    expect(refusal(Buffer.from('code,range\n')).message).toMatch(/not an Excel workbook/)
    // The ranges export belongs on the house page.
    expect(refusal(d365Workbook([trackingRow('g1', 'MADEAUX')])).message).toMatch(/tracking options \(ranges\)/)
    // A view without a column the prices need.
    const narrow = PRODUCT_PRICE_COLUMNS.filter(([logical]) => logical !== 'atelier_wholesalerate')
    const noWholesale = refusal(productWorkbook([priceRow(1).filter((_, index) => index !== 10)], narrow))
    expect(noWholesale.message).toMatch(/atelier_wholesalerate/)

    const bad = refusal(
      productWorkbook([
        priceRow(1),
        priceRow(2, { currency: 'Swiss Franc' }),
        priceRow(3, { wholesale: 'POA' }),
        priceRow(1, { code: 'AGAIN' }),
      ])
    )
    expect(bad.statusCode).toBe(422)
    expect(bad.error_count).toBe(3)
    expect(bad.errors.join('\n')).toMatch(/row 3 \(CODE 2\): a currency this platform does not price in \("Swiss Franc"\)/)
    expect(bad.errors.join('\n')).toMatch(/row 4: wholesale rate: non-numeric value "POA"/)
    expect(bad.errors.join('\n')).toMatch(/row 5 \(AGAIN\): the same Dynamics record as row 2/)
  })
})

// --------------------------------------------------------------------------
// 2 + 3. Pricing, and the routes
// --------------------------------------------------------------------------

describe('/admin/product-prices', () => {
  let pool
  let app
  let financeCookie
  let plainCookie
  let madeauxId
  let savedGbp

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }
  const inject = (method, url, { cookie = financeCookie, payload, headers = {} } = {}) =>
    app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) })
  const upload = (step, buffer, options = {}) =>
    inject('POST', `/admin/product-prices/import/${step}?filename=${encodeURIComponent(FILENAME)}`, {
      payload: buffer,
      headers: { 'content-type': XLSX },
      ...options,
    })

  const cleanup = async () => {
    await pool.query(`DELETE FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-8000-%'`)
    await pool.query(
      `DELETE FROM product_price_imports WHERE imported_by_user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`${PREFIX}-%`]
    )
    await pool.query(`DELETE FROM legacy_product_prices WHERE guid::text LIKE '00000000-0000-4000-8000-%'`)
    await pool.query(`DELETE FROM supplier_freight_rates WHERE range_name ILIKE $1`, [`${PREFIX}%`])
    // Price moves are RESTRICT on the product: the history goes first.
    await pool.query(`DELETE FROM product_price_history WHERE product_id IN (SELECT id FROM products WHERE slug LIKE $1)`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM fx_rates WHERE currency = 'XTS'`)
  }

  // The client's worked example, as the house holds it after the ranges import:
  // MADEAUX — clearance 10, trade markup 87, duty 5 on every band, freight $50,
  // discount 0 (flat, on the supplier's terms).
  const raiseMadeaux = async () => {
    const { rows: supplier } = await pool.query(
      `INSERT INTO suppliers (name, slug, currency) VALUES ($1, $2, 'GBP') RETURNING id`,
      [`${PREFIX} Madeaux`, `${PREFIX}-madeaux`]
    )
    const { rows: brand } = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only, supplier_id)
       VALUES ($1, $2, 'NZD', true, $3) RETURNING id`,
      [houseName('madeaux'), `${PREFIX}-madeaux`, supplier[0].id]
    )
    await upsertBrandParameters(pool, brand[0].id, {
      duty_percent_a: 5,
      duty_percent_b: 5,
      duty_percent_c: 5,
      clearance_percent: 10,
      trade_markup_percent: 87,
      surcharge_min_qty: 5,
      surcharge_per_unit: 20,
    })
    await pool.query(
      `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount) VALUES ($1, $2, 0)`,
      [supplier[0].id, brand[0].id]
    )
    await pool.query(
      `INSERT INTO supplier_freight_rates (range_name, category, basis, rate, unit, effective_from)
       VALUES ($1, NULL, 'dollar', 50, 'metre', '2020-01-01')`,
      [houseName('madeaux')]
    )
    return brand[0].id
  }

  const ella = (overrides = {}) => ({
    guid: guid(1),
    code: 'ELLA STRIPE',
    description: 'ELLA STRIPE',
    range_name: houseName('madeaux'),
    item_type: 'Fabrics',
    currency: 'XTS',
    wholesale_rate: 47.6,
    duty_class: null,
    freight_letter: 'A',
    dynamics_price_ex_duty: 125.26,
    dynamics_price_incl_duty: 125.26,
    dynamics_trade_sell: 360.52,
    ...overrides,
  })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    const { rows } = await pool.query(`SELECT currency, rate, set_on, note FROM fx_rates WHERE currency = 'GBP'`)
    savedGbp = rows[0] ?? null
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
    await cleanup()
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    madeauxId = await raiseMadeaux()
    await pool.query(`INSERT INTO fx_rates (currency, rate) VALUES ('XTS', 0.38)`)

    for (const [key, finance] of [
      ['finance', true],
      ['plain', false],
    ]) {
      const email = `${PREFIX}-${key}@example.test`
      const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD, name: key } })
      const cookie = sessionCookieFrom(res)
      await pool.query(`UPDATE users SET role = 'backoffice', can_view_finance = $2 WHERE email = $1`, [email, finance])
      if (key === 'finance') financeCookie = cookie
      else plainCookie = cookie
    }
  })

  afterAll(async () => {
    await app.close()
    await cleanup()
    // The one shared row this suite touches: the GBP rate goes back as it was.
    await pool.query(`DELETE FROM fx_rates WHERE currency = 'GBP'`)
    if (savedGbp) {
      await pool.query(`INSERT INTO fx_rates (currency, rate, set_on, note) VALUES ($1, $2, $3, $4)`, [
        savedGbp.currency, savedGbp.rate, savedGbp.set_on, savedGbp.note,
      ])
    }
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
    await pool.end()
  })

  beforeEach(async () => {
    // Each test's catalogue products are its own — a product left by one would
    // be matched (and priced) by the next.
    await pool.query(`DELETE FROM product_price_history WHERE product_id IN (SELECT id FROM products WHERE slug LIKE $1)`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-8000-%'`)
    await pool.query(
      `DELETE FROM product_price_imports WHERE imported_by_user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
      [`${PREFIX}-%`]
    )
  })

  describe('pricing a row through its house', () => {
    it('reproduces the office’s ELLA STRIPE example to the cent, every step naming its source', async () => {
      const pricing = await createProductPricer(pool).price(ella())
      expect(pricing.status).toBe('priced')
      expect(pricing.house).toMatchObject({ id: madeauxId, name: houseName('madeaux') })
      const amounts = Object.fromEntries(pricing.steps.map((step) => [step.step, step.amount]))
      expect(amounts).toMatchObject({
        wholesale: 47.6,
        export_price: 47.6,
        price_ex_duty: 125.26,
        price_incl_duty: 125.26,
        freight_amount: 50,
        landed: 192.79,
        trade_sell: 360.52,
      })
      expect(pricing.trade_sell).toBe(360.52)
      expect(pricing.difference).toBe(0)
      expect(pricing.agrees).toBe(true)
      expect(pricing.missing).toEqual([])
      expect(pricing.inputs.fx_rate).toMatchObject({ value: 0.38, source: 'fx' })
      expect(pricing.inputs.freight).toMatchObject({ value: 50, source: 'freight-ledger' })
      expect(pricing.inputs.clearance_percent).toMatchObject({ value: 10, source: 'house' })
      expect(pricing.inputs.trade_markup_percent).toMatchObject({ value: 87, source: 'house' })
      expect(pricing.inputs.discount_percent).toMatchObject({ value: 0, source: 'terms' })
      // Not steps of the range formula, and it says so rather than going missing.
      expect(pricing.inputs.duty_percent).toMatchObject({ value: 0, source: 'none' })
      expect(pricing.inputs.fx_margin_percent).toMatchObject({ value: 0, source: 'none' })
      expect(pricing.inputs.handling).toMatchObject({ value: 0, source: 'none' })
      expect(pricing.surcharge).toMatchObject({ min_qty: 5, per_unit: 20, source: 'house' })
    })

    it('applies the house’s duty band on a dutied row, and a margin or handling finance HAS set', async () => {
      const dutied = await createProductPricer(pool).price(ella({ duty_class: 'A', dynamics_trade_sell: 378.28 }))
      // 47.60 ÷ 0.38 = 125.263…; × 1.05, + 50, × 1.10, × 1.87 = 373.40
      expect(dutied.inputs.duty_percent).toMatchObject({ value: 5, source: 'house' })
      expect(dutied.trade_sell).toBe(373.4)
      expect(dutied.agrees).toBe(false)
      expect(dutied.difference).toBe(-4.88)

      await upsertBrandParameters(pool, madeauxId, {
        duty_percent_a: 5, duty_percent_b: 5, duty_percent_c: 5,
        clearance_percent: 10, trade_markup_percent: 87, handling: 2,
      })
      try {
        const handled = await createProductPricer(pool).price(ella())
        expect(handled.inputs.handling).toMatchObject({ value: 2, source: 'house' })
        // (125.26 + 50) × 1.10 + 2 = 194.79; × 1.87 = 364.26
        expect(handled.trade_sell).toBe(364.26)
      } finally {
        await upsertBrandParameters(pool, madeauxId, {
          duty_percent_a: 5, duty_percent_b: 5, duty_percent_c: 5,
          clearance_percent: 10, trade_markup_percent: 87, surcharge_min_qty: 5, surcharge_per_unit: 20,
        })
      }
    })

    it('finds a range’s house by the ranges import’s own rule — the newest of a shared name, then the slug', async () => {
      const insertHouse = (name, slug) =>
        pool
          .query(`INSERT INTO brands (name, slug, currency, trade_only) VALUES ($1, $2, 'NZD', true) RETURNING id`, [name, slug])
          .then(({ rows }) => rows[0].id)
      const older = await insertHouse(`${PREFIX} Twin`, `${PREFIX}-twin-a`)
      const newer = await insertHouse(`${PREFIX} TWIN`, `${PREFIX}-twin-b`)
      const ramm = await insertHouse(`${PREFIX} Ramm Son Crocker`, slugify(`${PREFIX} RAMM, SON & CROCKER`))
      const pricer = createProductPricer(pool)
      expect(older).toBeLessThan(newer)
      expect((await pricer.houseFor(`${PREFIX} twin`)).id).toBe(newer)
      expect((await pricer.houseFor(`${PREFIX} RAMM, SON & CROCKER`)).id).toBe(ramm)
      expect(await pricer.houseFor(`${PREFIX} nobody`)).toBeNull()
    })

    it('names what stops a price — no house for the range, no exchange rate — and never prices at zero', async () => {
      const pricer = createProductPricer(pool)
      const orphan = await pricer.price(ella({ range_name: `${PREFIX} BOUSSAC` }))
      expect(orphan).toMatchObject({ status: 'no_house', house: null, trade_sell: null })
      expect(orphan.reason).toMatch(/No house is named/)

      const noRate = await pricer.price(ella({ currency: 'XXX' }))
      expect(noRate.status).toBe('incomplete')
      expect(noRate.missing).toEqual(['fx_rate'])
      expect(noRate.trade_sell).toBeNull()

      const home = await pricer.price(ella({ currency: 'NZD', wholesale_rate: 100 }))
      expect(home.inputs.fx_rate).toMatchObject({ value: 1, source: 'none' })
      // (100 + 50) × 1.10 × 1.87
      expect(home.trade_sell).toBe(308.55)
    })
  })

  describe('the routes', () => {
    it('is finance-gated, reads included', async () => {
      const book = productWorkbook([priceRow(1, { range: houseName('madeaux') })])
      for (const [method, url, payload] of [
        ['GET', '/admin/product-prices'],
        ['GET', '/admin/product-prices/ranges'],
        ['GET', '/admin/product-prices/imports'],
        ['GET', '/admin/product-prices/1'],
        ['POST', '/admin/product-prices/import/validate', book],
        ['POST', '/admin/product-prices/import/apply', book],
      ]) {
        const headers = payload ? { 'content-type': XLSX } : {}
        const anonymous = await inject(method, url, { cookie: null, payload, headers })
        expect(anonymous.statusCode, `${method} ${url} anonymous`).toBe(401)
        const plain = await inject(method, url, { cookie: plainCookie, payload, headers })
        expect(plain.statusCode, `${method} ${url} without finance`).toBe(403)
      }
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM product_prices WHERE guid = $1`, [guid(1)])
      expect(rows[0].n).toBe(0)
    })

    it('validates without writing, applies in one go, fills only a missing exchange rate, and leaves the archive alone', async () => {
      await pool.query(`DELETE FROM fx_rates WHERE currency = 'GBP'`)
      // The archive's copy of the same Dynamics record, with the columns the
      // narrow export does not carry.
      await pool.query(
        `INSERT INTO legacy_product_prices
           (guid, source_file, raw, code, range_name, wholesale_rate, export_price, landed_cost_nz, trade_sell_price_nz)
         VALUES ($1, 'Product Prices 12-08-2026.xlsx', '{"atelier_code": "ELLA STRIPE"}', 'ELLA STRIPE', 'MADEAUX',
                 47.6, 47.6, 192.79, 360.52)`,
        [guid(1)]
      )
      const archiveBefore = (await pool.query(`SELECT * FROM legacy_product_prices WHERE guid = $1`, [guid(1)])).rows[0]

      const range = houseName('madeaux')
      const book = productWorkbook([
        priceRow(1, { code: 'ELLA STRIPE', range, wholesale: 47.6, exDuty: 125.26, trade: 360.52 }),
        priceRow(2, { code: 'HAREBELL', range, wholesale: 52.5, exDuty: 138.16, trade: 387.04 }),
        priceRow(3, { code: 'WALLPAPER B', range, type: 'W/P', wholesale: 38, exDuty: 100, trade: 287.98, letter: 'B' }),
        priceRow(4, { code: 'ORPHAN', range: `${PREFIX} BOUSSAC`, wholesale: 10, exDuty: 26.32 }),
      ])

      const dry = await upload('validate', book)
      expect(dry.statusCode).toBe(200)
      const plan = dry.json()
      expect(plan).toMatchObject({ rows_read: 4, rows_new: 4, rows_changed: 0, rows_unchanged: 0, exported_at: '2026-09-25T12:07:28' })
      expect(plan.fx).toEqual([expect.objectContaining({ currency: 'GBP', implied: 0.38, current: null, action: 'fill', share: 1 })])
      expect(plan.ranges_without_house).toEqual([{ range_name: `${PREFIX} BOUSSAC`, products: 1 }])
      // Priced with the rate it is about to fill: ELLA and HAREBELL agree with
      // Dynamics; the wallpaper does not (Dynamics used letter B's $40 freight).
      expect(plan.comparison).toMatchObject({ products: 4, priced: 3, agree: 2, differ: 1 })
      expect(plan.writes).toBeUndefined()
      const written = await pool.query(`SELECT count(*)::int AS n FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-8000-%'`)
      expect(written.rows[0].n).toBe(0)
      expect((await pool.query(`SELECT 1 FROM fx_rates WHERE currency = 'GBP'`)).rows).toHaveLength(0)

      const applied = await upload('apply', book)
      expect(applied.statusCode).toBe(200)
      expect(applied.json()).toMatchObject({ rows_new: 4, fx_filled: ['GBP'] })
      const gbp = (await pool.query(`SELECT rate::float AS rate, note FROM fx_rates WHERE currency = 'GBP'`)).rows[0]
      expect(gbp.rate).toBe(0.38)
      expect(gbp.note).toMatch(/Dynamics product prices export/)

      // The archive row is exactly as it was.
      const archiveAfter = (await pool.query(`SELECT * FROM legacy_product_prices WHERE guid = $1`, [guid(1)])).rows[0]
      expect(archiveAfter).toEqual(archiveBefore)

      // The same file again: nothing changed, and a rate now set is kept.
      await pool.query(`UPDATE fx_rates SET rate = 0.4 WHERE currency = 'GBP'`)
      const again = await upload('validate', book)
      expect(again.json()).toMatchObject({ rows_new: 0, rows_changed: 0, rows_unchanged: 4 })
      expect(again.json().fx[0]).toMatchObject({ currency: 'GBP', implied: 0.38, current: 0.4, action: 'differs' })
      const reapplied = await upload('apply', book)
      expect(reapplied.json().fx_filled).toEqual([])
      expect((await pool.query(`SELECT rate::float AS rate FROM fx_rates WHERE currency = 'GBP'`)).rows[0].rate).toBe(0.4)
      await pool.query(`UPDATE fx_rates SET rate = 0.38 WHERE currency = 'GBP'`)

      const imports = await inject('GET', '/admin/product-prices/imports')
      expect(imports.json().imports.slice(0, 2)).toEqual([
        expect.objectContaining({ filename: FILENAME, rows_read: 4, rows_unchanged: 4, exported_at: '2026-09-25T12:07:28' }),
        expect.objectContaining({ rows_new: 4 }),
      ])
      expect(imports.json().imports[0].imported_by).toMatchObject({ email: `${PREFIX}-finance@example.test` })
    })

    it('lists each row with its price, filters, and keeps a row a later export dropped — flagged, not deleted', async () => {
      const range = houseName('madeaux')
      const first = productWorkbook([
        priceRow(1, { code: 'ELLA STRIPE', range, wholesale: 47.6, exDuty: 125.26, trade: 360.52 }),
        priceRow(2, { code: 'HAREBELL', range, wholesale: 52.5, exDuty: 138.16, trade: 387.04 }),
      ])
      expect((await upload('apply', first)).statusCode).toBe(200)
      // The next export: HAREBELL is gone, ELLA's rate moved.
      const second = productWorkbook([priceRow(1, { code: 'ELLA STRIPE', range, wholesale: 50, exDuty: 131.58, trade: 360.52 })])
      const plan = (await upload('validate', second)).json()
      expect(plan).toMatchObject({ rows_changed: 1, wholesale_change_count: 1 })
      // Counts every stored row the file leaves out — HAREBELL here, plus any
      // real rows a dev database already holds.
      expect(plan.rows_not_in_file).toBeGreaterThanOrEqual(1)
      expect(plan.wholesale_changes[0]).toMatchObject({ code: 'ELLA STRIPE', from: 47.6, to: 50 })
      expect((await upload('apply', second)).statusCode).toBe(200)

      const list = (await inject('GET', `/admin/product-prices?range=${encodeURIComponent(range)}`)).json()
      expect(list.meta.total).toBe(1)
      expect(list.product_prices[0]).toMatchObject({
        code: 'ELLA STRIPE',
        wholesale_rate: 50,
        in_latest_export: true,
        pricing: { status: 'priced', house: { id: madeauxId }, freight: 50, agrees: false },
      })
      // (131.58 + 50) × 1.10 × 1.87
      expect(list.product_prices[0].pricing.trade_sell).toBe(373.51)

      const all = (await inject('GET', `/admin/product-prices?range=${encodeURIComponent(range)}&include_previous=true`)).json()
      expect(all.product_prices.map((row) => [row.code, row.in_latest_export])).toEqual([
        ['ELLA STRIPE', true],
        ['HAREBELL', false],
      ])

      // Paged by `page`, 1-based — what the CRM's list kit sends.
      const pageTwo = (await inject('GET', `/admin/product-prices?range=${encodeURIComponent(range)}&include_previous=true&limit=1&page=2`)).json()
      expect(pageTwo.meta).toMatchObject({ total: 2, page: 2, limit: 1 })
      expect(pageTwo.product_prices.map((row) => row.code)).toEqual(['HAREBELL'])

      // A catalogue product finds its row by house and name.
      const byProduct = (await inject('GET', `/admin/product-prices?brand_id=${madeauxId}&design=${encodeURIComponent(' ella stripe ')}`)).json()
      expect(byProduct.product_prices.map((row) => row.code)).toEqual(['ELLA STRIPE'])
      // `q` reaches the range too; the prefix keeps real rows out of the count.
      const search = (extra) => inject('GET', `/admin/product-prices?q=${encodeURIComponent(PREFIX)}${extra}`)
      expect((await search('')).json().meta.total).toBe(1)
      expect((await search('&include_previous=true')).json().meta.total).toBe(2)

      const ranges = (await inject('GET', '/admin/product-prices/ranges')).json().ranges
      expect(ranges.find((entry) => entry.range_name === range)).toMatchObject({ products: 1, house: { id: madeauxId } })
    })

    it('reads one row with its full waterfall and the catalogue product it names', async () => {
      const range = houseName('madeaux')
      await upload('apply', productWorkbook([priceRow(1, { code: 'ELLA STRIPE', range, wholesale: 47.6, exDuty: 125.26, trade: 360.52 })]))
      await pool.query(
        `INSERT INTO products (brand_id, name, slug, product_type, currency) VALUES ($1, 'Ella Stripe', $2, 'fabric', 'NZD')`,
        [madeauxId, `${PREFIX}-ella-stripe`]
      )
      const { rows } = await pool.query(`SELECT id FROM product_prices WHERE guid = $1`, [guid(1)])
      const detail = (await inject('GET', `/admin/product-prices/${rows[0].id}`)).json().product_price
      expect(detail).toMatchObject({ code: 'ELLA STRIPE', currency: 'GBP', in_latest_export: true })
      expect(detail.pricing.steps.map((step) => step.step)).toEqual([
        'wholesale', 'export_price', 'price_ex_duty', 'price_incl_duty', 'freight_amount',
        'landed_ex_handling', 'landed', 'trade_sell', 'retail_sell',
      ])
      expect(detail.pricing.trade_sell).toBe(360.52)
      expect(detail.catalogue_products).toEqual([expect.objectContaining({ name: 'Ella Stripe', slug: `${PREFIX}-ella-stripe` })])
      expect((await inject('GET', '/admin/product-prices/999999999')).statusCode).toBe(404)
    })

    it('writes the range price onto the catalogue product — fill-only on import, replaced only when asked, every move in the price history', async () => {
      const range = houseName('madeaux')
      // A priced insert is a price move, so it is declared like any other.
      const insertProduct = (name, slug, { currency = 'GBP', trade = null } = {}) =>
        withChangeContext(pool, { source: 'import', sourceFile: 'fixture' }, (client) =>
          client
            .query(
              `INSERT INTO products (brand_id, name, slug, product_type, currency, trade_price_cents)
               VALUES ($1, $2, $3, 'fabric', $4, $5) RETURNING id`,
              [madeauxId, name, `${PREFIX}-${slug}`, currency, trade]
            )
            .then(({ rows }) => rows[0].id)
        )
      // Blank (as the colours upload creates it), typed by the office, and in
      // another currency than the price row.
      const blank = await insertProduct('ELLA STRIPE', 'ella')
      const typed = await insertProduct('HAREBELL', 'harebell', { trade: 40000 })
      const euro = await insertProduct('Linen Taffeta', 'taffeta', { currency: 'EUR' })

      const applied = await upload(
        'apply',
        productWorkbook([
          priceRow(1, { code: 'ELLA STRIPE', range, wholesale: 47.6, exDuty: 125.26, trade: 360.52 }),
          priceRow(2, { code: 'HAREBELL', range, wholesale: 52.5, exDuty: 138.16, trade: 387.04 }),
          priceRow(3, { code: 'LINEN TAFFETA', range, wholesale: 46.9, exDuty: 123.42, trade: 356.73 }),
        ])
      )
      expect(applied.statusCode).toBe(200)
      expect(applied.json().catalogue).toMatchObject({
        products_matched: 3,
        trade_filled: 2,
        trade_replaced: 0,
        wholesale_filled: 2,
        kept_count: 1,
        kept: [{ product_id: typed, trade_price_cents: { from: 40000, to: 38704, action: 'kept' } }],
        currency_mismatch: [{ product_id: euro, product_currency: 'EUR', price_currency: 'GBP' }],
      })
      const product = async (id) =>
        (await pool.query(`SELECT trade_price_cents, wholesale_rate::float AS wholesale, category FROM products WHERE id = $1`, [id])).rows[0]
      expect(await product(blank)).toEqual({ trade_price_cents: 36052, wholesale: 47.6, category: 'fabric' })
      expect(await product(typed)).toMatchObject({ trade_price_cents: 40000, wholesale: 52.5 })
      // A product in EUR is not given a GBP wholesale rate, converted or not.
      expect(await product(euro)).toMatchObject({ trade_price_cents: 35673, wholesale: null })
      const fill = (await pool.query(`SELECT source, source_file, new_trade_price_cents FROM product_price_history WHERE product_id = $1`, [blank])).rows
      expect(fill).toEqual([{ source: 'import', source_file: FILENAME, new_trade_price_cents: 36052 }])

      // The product page's "Set as the trade price": a person's replace, with a reason.
      const { rows: priceIds } = await pool.query(`SELECT id FROM product_prices WHERE guid = $1`, [guid(2)])
      const replaced = await inject('POST', `/admin/product-prices/${priceIds[0].id}/apply-to-product`, { payload: { product_id: typed } })
      expect(replaced.statusCode).toBe(200)
      expect(replaced.json().catalogue).toMatchObject({ trade_replaced: 1 })
      expect(await product(typed)).toMatchObject({ trade_price_cents: 38704 })
      const manual = (await pool.query(
        `SELECT source, reason, old_trade_price_cents, new_trade_price_cents FROM product_price_history WHERE product_id = $1 AND source = 'manual'`,
        [typed]
      )).rows
      expect(manual).toEqual([{ source: 'manual', reason: `Set to the price from its range (HAREBELL, ${range})`, old_trade_price_cents: 40000, new_trade_price_cents: 38704 }])

      // A price row and a product that do not name each other.
      expect((await inject('POST', `/admin/product-prices/${priceIds[0].id}/apply-to-product`, { payload: { product_id: blank } })).statusCode).toBe(404)
      // Re-applying the same file changes nothing on the catalogue.
      expect((await upload('apply', productWorkbook([priceRow(1, { code: 'ELLA STRIPE', range, wholesale: 47.6, exDuty: 125.26, trade: 360.52 })]))).json().catalogue)
        .toMatchObject({ products_changing: 0 })
    })

    it('refuses a bad file with the per-row reasons and writes nothing', async () => {
      const response = await upload('apply', productWorkbook([priceRow(1), priceRow(2, { currency: 'Swiss Franc' })]))
      expect(response.statusCode).toBe(422)
      expect(response.json()).toMatchObject({ error_count: 1 })
      expect(response.json().errors[0]).toMatch(/Swiss Franc/)
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-8000-%'`)
      expect(rows[0].n).toBe(0)
    })
  })
})
