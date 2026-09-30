// One house's pricing, and the Dynamics tracking-options export applied to
// every house (Sept 2026 — "this information should be added to their
// respective houses with editable fields"):
//   1. reading the uploaded workbook — the D365 envelope, Range rows only
//   2. the planner — fill vs replace vs kept, what is never touched
//   3. /admin/pricing/houses/:id — read and write each figure into its one home
//   4. /admin/pricing/houses/import/* — the upload, dry run then apply
//
// Real Postgres, prefixed fixtures, one app per suite (register and login share
// a 10-per-15-min bucket per instance).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { getBrandParameters, previewWaterfall, upsertBrandParameters } from '../src/pricing/pricing-parameters.js'
import {
  CHANGE_KINDS,
  DISCOUNT_FIELD,
  FREIGHT_FIELD,
  planParametersBackfill,
} from '../src/pricing/parameters-backfill.js'
import { readTrackingOptionsWorkbook } from '../src/pricing/house-pricing-import.js'
import { d365Workbook, trackingRow } from './helpers/d365-workbook-fixture.js'

const PREFIX = 'w-house-pricing-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'
const FILENAME = 'Active Tracking Options 25-09-2026 10-58-14 AM.xlsx'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM supplier_freight_rates WHERE range_name ILIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM price_list_items WHERE supplier LIKE $1`, [`${PREFIX}%`])
  // A product left behind by a failed test would hold its house.
  await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
  // parameters and terms CASCADE from brands and suppliers
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

const insertSupplier = (pool, suffix) =>
  pool
    .query(`INSERT INTO suppliers (name, slug, currency) VALUES ($1, $2, 'EUR') RETURNING id`, [
      `${PREFIX} ${suffix}`,
      `${PREFIX}-${suffix}`,
    ])
    .then(({ rows }) => rows[0].id)

const houseName = (suffix) => `${PREFIX} ${suffix}`.toUpperCase()

const insertBrand = (pool, suffix, supplierId = null) =>
  pool
    .query(
      `INSERT INTO brands (name, slug, currency, trade_only, supplier_id)
       VALUES ($1, $2, 'NZD', false, $3) RETURNING id`,
      [houseName(suffix), `${PREFIX}-${suffix}`, supplierId]
    )
    .then(({ rows }) => rows[0].id)

const insertTerms = (pool, { supplierId, brandId, discount = null, chain = null }) =>
  pool.query(
    `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount, discount_chain)
     VALUES ($1, $2, $3, COALESCE($4::numeric(6,4)[], '{}'::numeric(6,4)[]))`,
    [supplierId, brandId, discount, chain]
  )

// Price lines under a house: `count` lines in `unit`, carrying a freight
// letter when one is given (the classes worth setting).
const insertPriceLines = async (pool, suffix, unit, count = 1, freightClass = null) => {
  for (let at = 0; at < count; at += 1) {
    await pool.query(
      `INSERT INTO price_list_items
         (supplier, category, code, code_normalized, unit, wholesale_rate, currency, source_file, product_range, freight_class)
       VALUES ($1, 'fabric', $2, $2, $3, 10, 'EUR', 'fixture.xlsx', $4, $5)`,
      [`${PREFIX} ${suffix}`, `${suffix}-${unit}-${freightClass ?? 'x'}-${at}`, unit, houseName(suffix), freightClass]
    )
  }
}

const insertFreight = (pool, { rangeName, rate, on = '2020-01-01' }) =>
  pool.query(
    `INSERT INTO supplier_freight_rates (range_name, category, basis, rate, effective_from)
     VALUES ($1, NULL, 'dollar', $2, $3)`,
    [rangeName, rate, on]
  )

const houseFreight = (pool, rangeName) =>
  pool
    .query(
      `SELECT rate::float AS rate, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
         FROM supplier_freight_rates WHERE lower(range_name) = lower($1)
        ORDER BY effective_from DESC, id DESC`,
      [rangeName]
    )
    .then(({ rows }) => rows)

const houseTerms = (pool, brandId) =>
  pool
    .query(
      `SELECT discount::float AS discount, cardinality(discount_chain) AS chain FROM supplier_brand_terms WHERE brand_id = $1`,
      [brandId]
    )
    .then(({ rows }) => rows[0] ?? null)

// --------------------------------------------------------------------------
// 1. The workbook
// --------------------------------------------------------------------------

describe('reading the tracking-options export', () => {
  it('reads Range rows by their D365 logical names, drops Type rows, and keeps a blank freight unknown', () => {
    const read = readTrackingOptionsWorkbook(
      d365Workbook([
        trackingRow('g1', 'BROCHIER', { freight: 50, discount: 0, markup: 92, minQty: 5, surcharge: 20 }),
        trackingRow('g2', 'HAMAM', { duty: [5, 10, 5], markup: 75 }),
        trackingRow('g3', 'Fabric', { category: 'Type', duty: [null, null, null], clearance: null }),
      ]),
      FILENAME
    )
    expect(read.rows).toBe(3)
    expect(read.exported_at).toBe('2026-09-25T10:58:14')
    expect(read.ranges.map((r) => r.name)).toEqual(['BROCHIER', 'HAMAM'])
    expect(read.ranges[0]).toMatchObject({
      duty_rate_a: 5,
      clearance_percent: 10,
      freight_per_unit: 50,
      discount_percent: 0,
      discount_stated: true,
      trade_markup_percent: 92,
      min_qty_to_avoid_surcharge: 5,
      surcharge_per_unit: 20,
    })
    // Blank discount is 0% but says so; blank freight is UNKNOWN, never zero.
    expect(read.ranges[1]).toMatchObject({ duty_rate_b: 10, freight_per_unit: null, discount_percent: 0, discount_stated: false })
  })

  it('refuses what is not the tracking-options export, in words the office can act on', () => {
    const refusal = (buffer) => {
      try {
        readTrackingOptionsWorkbook(buffer)
      } catch (error) {
        return error
      }
      return null
    }
    expect(refusal(Buffer.alloc(0))).toMatchObject({ statusCode: 422, message: 'That file is empty.' })
    expect(refusal(Buffer.from('Name,Duty\nALPAKA,5\n'))).toMatchObject({ statusCode: 422, message: expect.stringMatching(/not an Excel workbook/) })
    expect(
      refusal(d365Workbook([['a1', 'Some Co']], { entity: 'account', columns: [['accountid', 'Account'], ['name', 'Name']] }))
    ).toMatchObject({ statusCode: 422, message: expect.stringMatching(/"account" export, not the tracking options/) })
    expect(
      refusal(d365Workbook([trackingRow('g1', 'X', { category: 'Type' })]))
    ).toMatchObject({ statusCode: 422, message: expect.stringMatching(/no Range rows/) })
  })
})

// --------------------------------------------------------------------------
// 2. The planner (pure)
// --------------------------------------------------------------------------

describe('planning the export onto the houses', () => {
  const range = (name, over = {}) => ({
    name,
    duty_rate_a: 5,
    duty_rate_b: 5,
    duty_rate_c: 5,
    clearance_percent: 10,
    freight_per_unit: 30,
    discount_percent: 25,
    discount_stated: true,
    trade_markup_percent: 85,
    min_qty_to_avoid_surcharge: 5,
    surcharge_per_unit: 20,
    status: 'Active',
    ...over,
  })
  const brands = [
    { id: 1, name: 'NEW HOUSE', slug: 'new-house', supplier_id: 7 },
    { id: 2, name: 'SAVED HOUSE', slug: 'saved-house', supplier_id: 7 },
    { id: 3, name: 'CHAIN HOUSE', slug: 'chain-house', supplier_id: 7 },
    { id: 4, name: 'NO SUPPLIER', slug: 'no-supplier', supplier_id: null },
  ]
  const sources = {
    parameters: [
      range('NEW HOUSE'),
      range('SAVED HOUSE', { clearance_percent: 12, duty_rate_b: null, trade_markup_percent: 90, freight_per_unit: 35 }),
      range('CHAIN HOUSE'),
      range('NO SUPPLIER'),
      range('RETIRED', { status: 'Inactive' }),
    ],
    brands,
    existing: [{ brand_id: 2, duty_percent_a: '5.000', duty_percent_b: '7.000', clearance_percent: '10.000', trade_markup_percent: null }],
    terms: [
      { id: 20, brand_id: 2, supplier_id: 7, discount: 0.1, chain_length: 0, tier_count: 0 },
      { id: 30, brand_id: 3, supplier_id: 7, discount: null, chain_length: 2, tier_count: 0 },
    ],
    freight: [{ range_name: 'Saved House', rate: 30, basis: 'dollar', effective_from: '2026-01-01' }],
  }
  const lines = (plan, brand) => plan.changes.filter((line) => line.brand === brand)
  const line = (plan, brand, field) => lines(plan, brand).find((l) => l.field === field)

  it('fills blanks, keeps what the office saved, and says so line by line', () => {
    const plan = planParametersBackfill(sources, { on: '2026-09-25' })

    // A house with nothing: every stated value is a fill, in all three homes.
    expect(plan.inserts.map((row) => row.brand_id)).toEqual([1, 3, 4])
    expect(plan.inserts[0]).toMatchObject({ surcharge_min_qty: 5, surcharge_per_unit: 20, trade_markup_percent: 85 })
    expect(plan.termsInserts).toEqual([expect.objectContaining({ brand_id: 1, supplier_id: 7, discount: 0.25 })])
    // Freight lands on every house — the chain house too, since only its
    // DISCOUNT is off limits, and one with no supplier or price lines, since a
    // rate needs no unit (1 Oct 2026) — and not on the saved house, whose rate
    // the export disagrees with.
    expect(plan.freightInserts.map((row) => row.brand_id)).toEqual([1, 3, 4])
    expect(plan.freightInserts[0]).toEqual(expect.objectContaining({ range_name: 'NEW HOUSE', rate: 30, effective_from: '2026-09-25' }))
    expect(plan.freightInserts[0]).not.toHaveProperty('unit')
    expect(lines(plan, 'NEW HOUSE').every((l) => l.kind === CHANGE_KINDS.FILL)).toBe(true)

    // The saved house: its blank markup and surcharge fill; the rest is kept.
    expect(plan.fills).toEqual([
      expect.objectContaining({ brand_id: 2, trade_markup_percent: 90, surcharge_min_qty: 5, duty_percent_c: 5 }),
    ])
    expect(plan.overwrites).toEqual([])
    expect(line(plan, 'SAVED HOUSE', 'clearance_percent')).toMatchObject({ from: 10, to: 12, kind: CHANGE_KINDS.KEPT })
    expect(line(plan, 'SAVED HOUSE', DISCOUNT_FIELD)).toMatchObject({ from: 10, to: 25, kind: CHANGE_KINDS.KEPT })
    expect(line(plan, 'SAVED HOUSE', FREIGHT_FIELD)).toMatchObject({ from: 30, to: 35, kind: CHANGE_KINDS.KEPT })
    // A BLANK in the export never clears the saved band.
    expect(line(plan, 'SAVED HOUSE', 'duty_percent_b')).toBeUndefined()
    // An unchanged value is no line at all.
    expect(line(plan, 'SAVED HOUSE', 'duty_percent_a')).toBeUndefined()

    expect(plan.reports.termsAlreadyOnFile).toEqual([expect.objectContaining({ brand: 'CHAIN HOUSE' })])
    expect(plan.reports.brandsWithoutSupplier).toEqual([expect.objectContaining({ brand: 'NO SUPPLIER' })])
    expect(plan.reports).not.toHaveProperty('freightWithoutUnit')
    expect(plan.reports.inactiveRanges).toEqual([{ range: 'RETIRED', status: 'Inactive' }])
    expect(plan.summary).toMatchObject({ houses_matched: 4, values_replaced: 0, values_kept: 3 })
  })

  it('with overwrite, replaces what disagrees — freight as a new dated row — and still never touches a chain', () => {
    const plan = planParametersBackfill(sources, { overwrite: true, on: '2026-09-25' })
    expect(plan.overwrites).toEqual([expect.objectContaining({ brand_id: 2, clearance_percent: 12 })])
    expect(plan.overwrites[0]).not.toHaveProperty('duty_percent_b')
    expect(plan.termsUpdates).toEqual([expect.objectContaining({ terms_id: 20, supplier_id: 7, discount: 0.25, was: 0.1 })])
    expect(plan.freightInserts).toEqual(
      expect.arrayContaining([expect.objectContaining({ brand_id: 2, rate: 35, effective_from: '2026-09-25' })])
    )
    expect(line(plan, 'SAVED HOUSE', FREIGHT_FIELD)).toMatchObject({ from: 30, to: 35, kind: CHANGE_KINDS.REPLACE })
    expect(plan.changes.some((l) => l.kind === CHANGE_KINDS.KEPT)).toBe(false)
    expect(plan.termsUpdates.some((row) => row.brand_id === 3)).toBe(false)
  })

  it('fills the discount on terms that carry none — a markup-only row is a blank, not a saved rate', () => {
    const plan = planParametersBackfill(
      {
        ...sources,
        terms: [...sources.terms, { id: 40, brand_id: 1, supplier_id: 7, discount: null, chain_length: 0, tier_count: 0 }],
      },
      { on: '2026-09-25' }
    )
    expect(plan.termsInserts.some((row) => row.brand_id === 1)).toBe(false)
    expect(plan.termsUpdates).toEqual([expect.objectContaining({ terms_id: 40, discount: 0.25, was: null })])
    expect(line(plan, 'NEW HOUSE', DISCOUNT_FIELD)).toMatchObject({ from: null, to: 25, kind: CHANGE_KINDS.FILL })
  })

  it('does not replace a freight rate already dated today — the ledger holds one per day', () => {
    const plan = planParametersBackfill(
      { ...sources, freight: [{ ...sources.freight[0], effective_from: '2026-09-25' }] },
      { overwrite: true, on: '2026-09-25' }
    )
    expect(plan.freightInserts.some((row) => row.brand_id === 2)).toBe(false)
    expect(plan.reports.freightDatedToday).toEqual([expect.objectContaining({ brand: 'SAVED HOUSE', rate: 35, current: 30 })])
  })
})

// --------------------------------------------------------------------------
// 3 + 4. The routes
// --------------------------------------------------------------------------

describe('/admin/pricing/houses', () => {
  let pool
  let app
  let financeCookie
  let plainCookie
  let supplierId
  let houseId // linked, flat terms
  let chainId // linked, on a chain
  let bareId // no supplier

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }
  const inject = (method, url, { cookie = financeCookie, payload, headers = {} } = {}) =>
    app.inject({ method, url, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload !== undefined ? { payload } : {}) })
  const upload = (step, buffer, query = '') =>
    inject('POST', `/admin/pricing/houses/import/${step}?filename=${encodeURIComponent(FILENAME)}${query}`, {
      payload: buffer,
      headers: { 'content-type': XLSX },
    })

  const fullSet = (over = {}) => ({
    duty_percent_a: 5,
    duty_percent_b: 5,
    duty_percent_c: 5,
    clearance_percent: 10,
    trade_markup_percent: 85,
    fx_margin_percent: null,
    handling: null,
    surcharge_min_qty: 5,
    surcharge_per_unit: 20,
    note: null,
    ...over,
  })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    supplierId = await insertSupplier(pool, 'supplier')
    houseId = await insertBrand(pool, 'house', supplierId)
    chainId = await insertBrand(pool, 'chain', supplierId)
    bareId = await insertBrand(pool, 'bare', null)
    await insertTerms(pool, { supplierId, brandId: chainId, chain: [0.4, 0.4] })
    await insertPriceLines(pool, 'house', 'metre', 3)
    await insertPriceLines(pool, 'house', 'roll', 1)

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
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    const houses = [houseId, chainId, bareId]
    await pool.query(`DELETE FROM supplier_pricing_parameters WHERE brand_id = ANY($1::int[])`, [houses])
    await pool.query(`DELETE FROM supplier_brand_terms WHERE brand_id = ANY($1::int[]) AND brand_id <> $2`, [houses, chainId])
    await pool.query(`DELETE FROM supplier_freight_rates WHERE range_name ILIKE $1`, [`${PREFIX}%`])
  })

  it('is finance-gated, reads included', async () => {
    const book = d365Workbook([trackingRow('g1', houseName('house'))])
    for (const [method, url, payload] of [
      ['GET', `/admin/pricing/houses/${houseId}`],
      ['PUT', `/admin/pricing/houses/${houseId}`, { parameters: fullSet() }],
    ]) {
      expect((await inject(method, url, { cookie: plainCookie, payload })).statusCode).toBe(403)
      expect((await inject(method, url, { cookie: null, payload })).statusCode).toBe(401)
    }
    for (const step of ['validate', 'apply']) {
      const res = await inject('POST', `/admin/pricing/houses/import/${step}`, {
        cookie: plainCookie,
        payload: book,
        headers: { 'content-type': XLSX },
      })
      expect(res.statusCode).toBe(403)
    }
  })

  it('reads a house with nothing set: every figure blank, the discount writable', async () => {
    const res = await inject('GET', `/admin/pricing/houses/${houseId}`)
    expect(res.statusCode).toBe(200)
    const { pricing } = res.json()
    expect(pricing.house).toMatchObject({ id: houseId, supplier_id: supplierId, supplier_name: `${PREFIX} supplier` })
    expect(pricing.parameters).toBe(null)
    expect(pricing.discount).toMatchObject({ percent: null, source: 'missing', editable: true })
    expect(pricing.freight).toBe(null)
    expect(pricing).not.toHaveProperty('freight_unit_hint')
    expect((await inject('GET', '/admin/pricing/houses/999999999')).statusCode).toBe(404)
  })

  it('saves each figure into its one home — parameters, a flat discount on the terms, a dated freight rate', async () => {
    const res = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: {
        parameters: fullSet(),
        discount_percent: 25,
        freight: { rate: 30, effective_from: '2026-01-01' },
      },
    })
    expect(res.statusCode).toBe(200)
    const { pricing } = res.json()
    expect(pricing.parameters).toMatchObject({ duty_percent_a: 5, clearance_percent: 10, surcharge_min_qty: 5, surcharge_per_unit: 20 })
    expect(pricing.discount).toMatchObject({ percent: 25, source: 'house', shape: 'flat', editable: true })
    expect(pricing.freight).toMatchObject({ rate: 30, basis: 'dollar', effective_from: '2026-01-01' })
    expect(pricing.freight).not.toHaveProperty('unit')
    expect(await houseTerms(pool, houseId)).toMatchObject({ discount: 0.25, chain: 0 })

    // The same figures again change nothing: no second ledger row, no 409.
    const again = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: fullSet(), discount_percent: 25, freight: { rate: 30, effective_from: '2026-02-01' } },
    })
    expect(again.statusCode).toBe(200)
    expect(await houseFreight(pool, houseName('house'))).toHaveLength(1)

    // A new rate is a new dated row; the old one stays as history.
    const moved = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: fullSet(), discount_percent: 20, freight: { rate: 32, effective_from: '2026-03-01' } },
    })
    expect(moved.json().pricing).toMatchObject({ discount: { percent: 20 }, freight: { rate: 32 } })
    expect((await houseFreight(pool, houseName('house'))).map((row) => row.rate)).toEqual([32, 30])

    // PUT semantics on the parameter set: an omitted column clears.
    const cleared = await inject('PUT', `/admin/pricing/houses/${houseId}`, { payload: { parameters: { duty_percent_a: 5 } } })
    expect(cleared.json().pricing.parameters).toMatchObject({ duty_percent_a: 5, clearance_percent: null, surcharge_min_qty: null })
    // Absent discount and freight are left alone.
    expect(cleared.json().pricing.discount.percent).toBe(20)
  })

  it('keeps the retail markup and a dollar clearance on the house, and prices by them', async () => {
    const res = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: { ...fullSet(), clearance_percent: 4, clearance_basis: 'dollar', retail_markup_percent: 30 } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().pricing.parameters).toMatchObject({ clearance_percent: 4, clearance_basis: 'dollar', retail_markup_percent: 30 })
    // The house's own figures as the page shows them, then a what-if run of the
    // rest (no rate or freight on the fixture house) to see how they combine.
    const preview = await previewWaterfall(pool, {
      brandId: houseId,
      wholesaleRate: 100,
      dutyClass: 'A',
      overrides: { discount_percent: 0, fx_rate: 0.5, fx_margin_percent: 0, freight: 30, handling: 0 },
    })
    expect(preview.inputs.clearance_percent).toMatchObject({ value: 4, source: 'house', detail: { basis: 'dollar' } })
    expect(preview.inputs.retail_markup_percent).toMatchObject({ value: 30, source: 'house' })
    const { steps, trade_sell: trade, retail_sell: retail } = preview.waterfall
    const at = (name) => steps.find((step) => step.step === name).amount
    // $4 on top of duty-paid plus freight, not 4% of it; retail is trade × 1.30.
    expect(at('landed_ex_handling')).toBeCloseTo(at('price_incl_duty') + at('freight_amount') + 4, 2)
    expect(trade).not.toBeNull()
    expect(retail).toBeCloseTo(trade * 1.3, 1)
    expect((await inject('PUT', `/admin/pricing/houses/${houseId}`, { payload: { parameters: { clearance_basis: 'pounds' } } })).statusCode).toBe(400)
    await inject('PUT', `/admin/pricing/houses/${houseId}`, { payload: { parameters: fullSet() } })
  })

  it('refuses a discount it cannot write as one transaction — nothing else is saved either', async () => {
    const chain = await inject('PUT', `/admin/pricing/houses/${chainId}`, {
      payload: { parameters: fullSet(), discount_percent: 10 },
    })
    expect(chain.statusCode).toBe(422)
    expect(chain.json().message).toMatch(/compounded chain/)
    expect(await getBrandParameters(pool, chainId)).toBe(null)
    expect(await houseTerms(pool, chainId)).toMatchObject({ discount: null, chain: 2 })

    const read = (await inject('GET', `/admin/pricing/houses/${chainId}`)).json().pricing
    expect(read.discount).toMatchObject({ shape: 'chain', editable: false, percent: 64 })

    const orphan = await inject('PUT', `/admin/pricing/houses/${bareId}`, {
      payload: { parameters: fullSet(), discount_percent: 10 },
    })
    expect(orphan.statusCode).toBe(422)
    expect(orphan.json().message).toMatch(/Link this house to the supplier/)
    expect(await getBrandParameters(pool, bareId)).toBe(null)
  })

  it('sets a freight rate per class — the letters the price lines carry — and the waterfall prices a line by its letter', async () => {
    await insertPriceLines(pool, 'house', 'metre', 2, 'A')
    await insertPriceLines(pool, 'house', 'metre', 1, 'B')
    const put = (freightClasses, freight = { rate: 23, effective_from: '2026-01-01' }) =>
      inject('PUT', `/admin/pricing/houses/${houseId}`, {
        payload: { parameters: fullSet(), freight, freight_classes: freightClasses },
      })

    const res = await put([
      { freight_class: 'a', rate: 30, effective_from: '2026-01-01' },
      { freight_class: 'B', rate: 3, effective_from: '2026-01-01' },
    ])
    expect(res.statusCode).toBe(200)
    const { pricing } = res.json()
    expect(pricing.freight).toMatchObject({ rate: 23, freight_class: null })
    expect(pricing.freight_classes).toEqual([
      expect.objectContaining({ freight_class: 'A', rate: 30 }),
      expect.objectContaining({ freight_class: 'B', rate: 3 }),
    ])
    expect(pricing.freight_class_lines).toEqual([
      { freight_class: 'A', lines: 2 },
      { freight_class: 'B', lines: 1 },
    ])

    // The same rates again append nothing; a changed letter is one new dated row.
    await put([{ freight_class: 'A', rate: 30, effective_from: '2026-02-01' }])
    expect(await houseFreight(pool, houseName('house'))).toHaveLength(3)
    await put([{ freight_class: 'B', rate: 4, effective_from: '2026-03-01' }])
    expect(await houseFreight(pool, houseName('house'))).toHaveLength(4)

    // A line is priced by its letter; a letter with no rate takes the house's default.
    const freightFor = async (letter) => {
      const query = `brand_id=${houseId}&wholesale_rate=100&on=2026-06-01${letter ? `&freight_class=${letter}` : ''}`
      return (await inject('GET', `/admin/pricing/waterfall?${query}`)).json().inputs.freight
    }
    expect(await freightFor('b')).toMatchObject({ value: 4, detail: { freight_class: 'B' } })
    expect(await freightFor('A')).toMatchObject({ value: 30 })
    expect(await freightFor('C')).toMatchObject({ value: 23, detail: { freight_class: null } })
    expect(await freightFor(null)).toMatchObject({ value: 23 })

    const twice = await put([
      { freight_class: 'A', rate: 30 },
      { freight_class: 'a', rate: 31 },
    ])
    expect(twice.statusCode).toBe(422)
    expect(twice.json().message).toMatch(/listed twice/)

    // A class can be removed: every row of B goes, its lines pay the house's
    // rate again, and A and the every-class rate are untouched.
    const removed = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: fullSet(), remove_freight_classes: ['b'] },
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().pricing.freight_classes.map((rate) => rate.freight_class)).toEqual(['A'])
    expect((await houseFreight(pool, houseName('house'))).length).toBe(2)
    expect(await freightFor('B')).toMatchObject({ value: 23, detail: { freight_class: null } })
    expect(await freightFor('A')).toMatchObject({ value: 30 })
    const clash = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: fullSet(), remove_freight_classes: ['A'], freight_classes: [{ freight_class: 'A', rate: 9 }] },
    })
    expect(clash.statusCode).toBe(422)
    expect(clash.json().message).toMatch(/both set and removed/)
  })

  it('keeps discount classes on the house: created with its terms, edited as a set, one default, products counted before a removal', async () => {
    const put = (discountClasses, over = {}) =>
      inject('PUT', `/admin/pricing/houses/${houseId}`, {
        payload: { parameters: fullSet(), discount_classes: discountClasses, ...over },
      })

    const first = await put([
      { label: 'wallpaper', percent: 40 },
      { label: 'All other collections', percent: 50, is_default: true },
    ])
    expect(first.statusCode).toBe(200)
    let discount = first.json().pricing.discount
    expect(discount).toMatchObject({ shape: 'tiers', editable: true, percent: null })
    expect(discount.classes).toEqual([
      expect.objectContaining({ label: 'wallpaper', percent: 40, is_default: false, matches_category: true, products: 0 }),
      expect.objectContaining({ label: 'All other collections', percent: 50, is_default: true, matches_category: false }),
    ])
    const [wallpaper, others] = discount.classes

    // The waterfall picks the class by the line's category, else the default class.
    const discountFor = async (category) =>
      (await inject('GET', `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100&category=${category}`)).json()
        .inputs.discount_percent
    expect(await discountFor('wallpaper')).toMatchObject({ value: 40, detail: { shape: 'tier', label: 'wallpaper' } })
    expect(await discountFor('fabric')).toMatchObject({ value: 50, detail: { label: 'All other collections' } })

    // A product chose the default class; the read counts it.
    const { rows } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency)
       VALUES ($1, $2, $3, 'fabric', 'NZD') RETURNING id`,
      [houseId, `${PREFIX} product`, `${PREFIX}-product`]
    )
    await pool.query(`INSERT INTO product_discount_tiers (product_id, tier_id) VALUES ($1, $2)`, [rows[0].id, others.id])
    discount = (await inject('GET', `/admin/pricing/houses/${houseId}`)).json().pricing.discount
    expect(discount.classes.find((entry) => entry.id === others.id).products).toBe(1)

    // Edit as a set: rename and re-rate one, move the default onto it, drop the
    // other, add a new one — with a flat rate beside them for everything else.
    const second = await put(
      [
        { id: wallpaper.id, label: 'Wallpaper', percent: 42, is_default: true },
        { label: 'New collections', percent: 45 },
      ],
      { discount_percent: 30 }
    )
    expect(second.statusCode).toBe(200)
    discount = second.json().pricing.discount
    expect(discount).toMatchObject({ percent: 30, source: 'house', shape: 'tiers' })
    expect(discount.classes.map((entry) => [entry.label, entry.percent, entry.is_default])).toEqual([
      ['New collections', 45, false],
      ['Wallpaper', 42, true],
    ])
    // The removed class's product fell back — its choice went with the class.
    const { rows: choices } = await pool.query(`SELECT 1 FROM product_discount_tiers WHERE product_id = $1`, [rows[0].id])
    expect(choices).toEqual([])
    await pool.query(`DELETE FROM products WHERE id = $1`, [rows[0].id])

    // An empty set removes them all; the flat rate stays.
    const none = await put([])
    expect(none.json().pricing.discount).toMatchObject({ percent: 30, shape: 'flat', classes: [] })
  })

  it('refuses discount classes it cannot write, and writes nothing else', async () => {
    const refusal = async (id, discountClasses) => {
      const res = await inject('PUT', `/admin/pricing/houses/${id}`, {
        payload: { parameters: fullSet({ clearance_percent: 99 }), discount_classes: discountClasses },
      })
      expect(res.statusCode).toBe(422)
      expect(await getBrandParameters(pool, id)).toBe(null)
      return res.json().message
    }
    expect(await refusal(houseId, [{ label: 'A', percent: 10 }, { label: ' a ', percent: 20 }])).toMatch(/Two discount classes/)
    expect(
      await refusal(houseId, [
        { label: 'A', percent: 10, is_default: true },
        { label: 'B', percent: 20, is_default: true },
      ])
    ).toMatch(/Only one discount class/)
    expect(await refusal(houseId, [{ id: 2147483646, label: 'A', percent: 10 }])).toMatch(/not one of this house/)
    expect(await refusal(chainId, [{ label: 'A', percent: 10 }])).toMatch(/compounded chain/)
    expect(await refusal(bareId, [{ label: 'A', percent: 10 }])).toMatch(/Link this house to the supplier/)
  })

  // 1 Oct 2026: the unit is the product's. An older page still sending one
  // is not refused for it; the rate lands as the figure it is.
  it('takes a freight rate as a figure, with no unit, and refuses a discount of 100%', async () => {
    const figure = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: fullSet(), freight: { rate: 30, unit: 'bolt', effective_from: '2026-01-01' } },
    })
    expect(figure.statusCode).toBe(200)
    expect(await houseFreight(pool, houseName('house'))).toEqual([{ rate: 30, effective_from: '2026-01-01' }])
    const whole = await inject('PUT', `/admin/pricing/houses/${houseId}`, {
      payload: { parameters: fullSet(), discount_percent: 100 },
    })
    expect(whole.statusCode).toBe(400)
  })

  it('validates an upload without writing, applies it, fills only blanks, and replaces only when asked', async () => {
    // The office had already saved a clearance on the house.
    await upsertBrandParameters(pool, houseId, { clearance_percent: 12 })
    const book = d365Workbook([
      trackingRow('g1', houseName('house'), { freight: 30, discount: 25, markup: 85, minQty: 5, surcharge: 20 }),
      trackingRow('g2', houseName('chain'), { freight: 40, discount: 10, markup: 70 }),
      trackingRow('g3', houseName('bare'), { freight: 50, discount: 5, markup: 60 }),
      trackingRow('g4', `${PREFIX} NOBODY`, { freight: 1 }),
    ])

    const dry = await upload('validate', book)
    expect(dry.statusCode).toBe(200)
    const plan = dry.json()
    expect(plan).toMatchObject({ dry_run: true, exported_at: '2026-09-25T10:58:14', houses_matched: 3 })
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ brand_id: houseId, field: 'clearance_percent', from: 12, to: 10, kind: 'kept' }),
        expect.objectContaining({ brand_id: houseId, field: 'freight', to: 30, kind: 'fill' }),
        expect.objectContaining({ brand_id: houseId, field: 'discount_percent', to: 25, kind: 'fill' }),
      ])
    )
    expect(plan.reports.rangesWithoutBrand).toEqual([expect.objectContaining({ range: `${PREFIX} NOBODY` })])
    expect(plan.reports.brandsWithoutSupplier).toEqual([expect.objectContaining({ brand: houseName('bare') })])
    // The dry run wrote nothing.
    expect(await getBrandParameters(pool, houseId)).toMatchObject({ clearance_percent: 12, trade_markup_percent: null })
    expect(await houseFreight(pool, houseName('house'))).toEqual([])

    const applied = await upload('apply', book)
    expect(applied.statusCode).toBe(200)
    expect(applied.json()).toMatchObject({ dry_run: false, terms_inserted: 1, freight_inserted: 3 })
    expect(await getBrandParameters(pool, houseId)).toMatchObject({
      clearance_percent: 12,
      trade_markup_percent: 85,
      surcharge_min_qty: 5,
      surcharge_per_unit: 20,
    })
    expect(await houseTerms(pool, houseId)).toMatchObject({ discount: 0.25 })
    expect(await houseFreight(pool, houseName('house'))).toEqual([expect.objectContaining({ rate: 30 })])
    // The chain house kept its chain; every house got its freight — a house
    // with no price lines to take a unit from included (1 Oct 2026).
    expect(await houseTerms(pool, chainId)).toMatchObject({ discount: null, chain: 2 })
    expect((await houseFreight(pool, houseName('chain'))).map((row) => row.rate)).toEqual([40])
    expect((await houseFreight(pool, houseName('bare'))).map((row) => row.rate)).toEqual([50])

    // Re-running changes nothing but the one kept line.
    const rerun = (await upload('validate', book)).json()
    expect(rerun.changes).toEqual([expect.objectContaining({ field: 'clearance_percent', kind: 'kept' })])

    // With overwrite the export wins the clearance.
    const replaced = await upload('apply', book, '&overwrite=true')
    expect(replaced.json()).toMatchObject({ parameters_replaced: 1, values_replaced: 1 })
    expect(await getBrandParameters(pool, houseId)).toMatchObject({ clearance_percent: 10 })
  })

  it('replaces a house’s freight only when asked, as a new dated row', async () => {
    await insertFreight(pool, { rangeName: houseName('house'), rate: 20, on: '2020-01-01' })
    const book = d365Workbook([trackingRow('g1', houseName('house'), { freight: 30 })])

    const kept = (await upload('validate', book)).json()
    expect(kept.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'freight', from: 20, to: 30, kind: 'kept' })])
    )

    const applied = await upload('apply', book, '&overwrite=true')
    expect(applied.json()).toMatchObject({ freight_inserted: 1 })
    const rates = await houseFreight(pool, houseName('house'))
    expect(rates.map((row) => row.rate)).toEqual([30, 20])
  })

  it('refuses a file that is not the export with the per-cell reasons, and writes nothing', async () => {
    const res = await upload('apply', Buffer.from('Name,Duty\n'))
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ message: expect.stringMatching(/not an Excel workbook/), errors: [], error_count: 0 })

    const bad = d365Workbook([trackingRow('g1', houseName('house'), { markup: 'eighty-five' })])
    const cells = await upload('validate', bad)
    expect(cells.statusCode).toBe(422)
    expect(cells.json().errors).toEqual([expect.stringMatching(/trade_markup/)])
    expect(await getBrandParameters(pool, houseId)).toBe(null)
  })
})
