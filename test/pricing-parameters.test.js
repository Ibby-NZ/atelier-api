// The platform's own pricing parameters (W-pricing, Sept 2026):
//   1. the schema — one scope per row, one row per scope
//   2. the module — PUT semantics, the resolver's precedence and sources
//   3. the routes — finance-gated reads and writes, the waterfall preview
//   4. the Dynamics backfill — fill-only-NULL, injected parameters
//
// Real Postgres, prefixed fixtures. Sessions are registered once per suite
// (register and login share a 10-per-15-min bucket).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  INPUT_SOURCES,
  PARAMETER_COLUMNS,
  deleteBrandParameters,
  getBrandParameters,
  getSupplierParameters,
  previewWaterfall,
  resolveWaterfallInputs,
  upsertBrandParameters,
  upsertFxRate,
  upsertSupplierParameters,
} from '../src/pricing/pricing-parameters.js'
import {
  backfillPricingParameters,
  planParametersBackfill,
} from '../src/pricing/parameters-backfill.js'

const PREFIX = 'w-pricing-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'
// ISO 4217 reserves XTS for testing.
const CURRENCY = 'XTS'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM supplier_freight_rates
      WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  // parameters and terms CASCADE from both brands and suppliers
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM fx_rates WHERE currency = $1`, [CURRENCY])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

const insertSupplier = (pool, suffix, currency = CURRENCY) =>
  pool
    .query(`INSERT INTO suppliers (name, slug, currency) VALUES ($1, $2, $3) RETURNING id`, [
      `${PREFIX} ${suffix}`,
      `${PREFIX}-${suffix}`,
      currency,
    ])
    .then(({ rows }) => rows[0].id)

const insertBrand = (pool, suffix, supplierId = null) =>
  pool
    .query(
      `INSERT INTO brands (name, slug, currency, trade_only, supplier_id)
       VALUES ($1, $2, 'NZD', false, $3) RETURNING id`,
      [`${PREFIX} ${suffix}`, `${PREFIX}-${suffix}`, supplierId]
    )
    .then(({ rows }) => rows[0].id)

const insertTerms = (pool, { supplierId, brandId, discount = null, chain = null, markup = null }) =>
  pool.query(
    `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount, discount_chain, markup)
     VALUES ($1, $2, $3, COALESCE($4::numeric(6,4)[], '{}'::numeric(6,4)[]), $5)`,
    [supplierId, brandId, discount, chain, markup]
  )

const insertFreight = (pool, { supplierId, rate, basis = 'dollar', unit = 'metre', on = '2020-01-01' }) =>
  pool.query(
    `INSERT INTO supplier_freight_rates (supplier_id, category, basis, rate, unit, effective_from)
     VALUES ($1, NULL, $2, $3, $4, $5)`,
    [supplierId, basis, rate, basis === 'dollar' ? unit : null, on]
  )

// --------------------------------------------------------------------------
// 1. Schema
// --------------------------------------------------------------------------

describe('supplier_pricing_parameters schema', () => {
  let pool
  let supplierId
  let brandId

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    supplierId = await insertSupplier(pool, 'schema-supplier')
    brandId = await insertBrand(pool, 'schema-house', supplierId)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM supplier_pricing_parameters WHERE supplier_id = $1 OR brand_id = $2`, [
      supplierId,
      brandId,
    ])
  })

  it('a row is exactly one scope — a supplier default OR a house override', async () => {
    await expect(
      pool.query(`INSERT INTO supplier_pricing_parameters (supplier_id, brand_id) VALUES ($1, $2)`, [
        supplierId,
        brandId,
      ])
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(`INSERT INTO supplier_pricing_parameters (clearance_percent) VALUES (10)`)
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('one row per scope', async () => {
    await pool.query(`INSERT INTO supplier_pricing_parameters (supplier_id) VALUES ($1)`, [supplierId])
    await expect(
      pool.query(`INSERT INTO supplier_pricing_parameters (supplier_id) VALUES ($1)`, [supplierId])
    ).rejects.toMatchObject({ code: '23505' })
    await pool.query(`INSERT INTO supplier_pricing_parameters (brand_id) VALUES ($1)`, [brandId])
    await expect(
      pool.query(`INSERT INTO supplier_pricing_parameters (brand_id) VALUES ($1)`, [brandId])
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('refuses a negative parameter and a rate of zero', async () => {
    await expect(
      pool.query(`INSERT INTO supplier_pricing_parameters (supplier_id, duty_percent_a) VALUES ($1, -1)`, [
        supplierId,
      ])
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      pool.query(`INSERT INTO fx_rates (currency, rate) VALUES ($1, 0)`, [CURRENCY])
    ).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO fx_rates (currency, rate) VALUES ('eur', 1)`)).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('goes with its scope', async () => {
    const houseId = await insertBrand(pool, 'schema-goner', supplierId)
    await pool.query(`INSERT INTO supplier_pricing_parameters (brand_id, handling) VALUES ($1, 1)`, [houseId])
    await pool.query(`DELETE FROM brands WHERE id = $1`, [houseId])
    const { rows } = await pool.query(`SELECT 1 FROM supplier_pricing_parameters WHERE brand_id = $1`, [houseId])
    expect(rows).toEqual([])
  })
})

// --------------------------------------------------------------------------
// 2. Module — PUT semantics and the resolver
// --------------------------------------------------------------------------

describe('pricing parameters — the module and the resolver', () => {
  let pool
  let supplierId
  let houseId // linked, with terms
  let bareId // linked, no terms
  let averagedId // linked, no terms of its own — on the supplier's averaged rate
  let orphanId // no supplier

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    supplierId = await insertSupplier(pool, 'module-supplier')
    houseId = await insertBrand(pool, 'module-house', supplierId)
    bareId = await insertBrand(pool, 'module-bare', supplierId)
    averagedId = await insertBrand(pool, 'module-averaged', supplierId)
    orphanId = await insertBrand(pool, 'module-orphan', null)
    await insertTerms(pool, { supplierId, brandId: houseId, discount: 0.25, markup: 1.3 })
    await insertTerms(pool, { supplierId, brandId: bareId, chain: [0.4, 0.4] })
    await insertFreight(pool, { supplierId, rate: 30 })
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM supplier_pricing_parameters WHERE supplier_id = $1 OR brand_id = ANY($2::int[])`,
      [supplierId, [houseId, bareId, averagedId, orphanId]]
    )
    await pool.query(`DELETE FROM fx_rates WHERE currency = $1`, [CURRENCY])
    await pool.query(`UPDATE suppliers SET default_discount = NULL WHERE id = $1`, [supplierId])
  })

  it('exports the column whitelist the routes and the upsert both build from', () => {
    expect(PARAMETER_COLUMNS).toContain('trade_markup_percent')
    expect(PARAMETER_COLUMNS).not.toContain('supplier_id')
    expect(INPUT_SOURCES).toContain('missing')
  })

  it('PUT replaces the whole set: an omitted field is cleared, not kept', async () => {
    const first = await upsertSupplierParameters(pool, supplierId, {
      duty_percent_a: 5,
      clearance_percent: 10,
      trade_markup_percent: 85,
    })
    expect(first).toMatchObject({ supplier_id: supplierId, brand_id: null, duty_percent_a: 5, clearance_percent: 10 })

    const second = await upsertSupplierParameters(pool, supplierId, { clearance_percent: 12 })
    expect(second).toMatchObject({ id: first.id, clearance_percent: 12, duty_percent_a: null, trade_markup_percent: null })
    expect(await getSupplierParameters(pool, supplierId)).toEqual(second)
  })

  it('404s a scope that does not exist and 422s a negative parameter', async () => {
    await expect(upsertBrandParameters(pool, 999999999, { handling: 1 })).rejects.toMatchObject({ statusCode: 404 })
    await expect(upsertSupplierParameters(pool, supplierId, { handling: -1 })).rejects.toMatchObject({
      statusCode: 422,
    })
  })

  it('names every input missing when nothing is set — never zero', async () => {
    const { inputs } = await resolveWaterfallInputs(pool, { brandId: bareId, dutyClass: 'A' })
    for (const key of ['fx_rate', 'fx_margin_percent', 'duty_percent', 'clearance_percent', 'handling', 'trade_markup_percent', 'retail_markup']) {
      expect(inputs[key]).toMatchObject({ value: null, source: 'missing' })
    }
  })

  it('reads the house override over the supplier default, and the supplier default where the house is silent', async () => {
    await upsertSupplierParameters(pool, supplierId, { duty_percent_a: 5, clearance_percent: 10, trade_markup_percent: 85 })
    await upsertBrandParameters(pool, houseId, { trade_markup_percent: 89 })

    const { inputs, parameters } = await resolveWaterfallInputs(pool, { brandId: houseId, dutyClass: 'A' })
    expect(inputs.trade_markup_percent).toMatchObject({ value: 89, source: 'house' })
    expect(inputs.clearance_percent).toMatchObject({ value: 10, source: 'supplier' })
    expect(inputs.duty_percent).toMatchObject({ value: 5, source: 'supplier', detail: { duty_class: 'A' } })
    expect(parameters.house.trade_markup_percent).toBe(89)
    expect(parameters.supplier.clearance_percent).toBe(10)
  })

  it('a blank duty class is no duty (a fact about the line), an unset band is missing', async () => {
    await upsertSupplierParameters(pool, supplierId, { duty_percent_a: 5 })
    const none = await resolveWaterfallInputs(pool, { brandId: houseId })
    expect(none.inputs.duty_percent).toMatchObject({ value: 0, source: 'none' })
    const bandB = await resolveWaterfallInputs(pool, { brandId: houseId, dutyClass: 'b' })
    expect(bandB.inputs.duty_percent).toMatchObject({ value: null, source: 'missing', detail: { duty_class: 'B' } })
  })

  it('takes the discount and the retail markup from the terms, and nets a chain multiplicatively', async () => {
    const flat = await resolveWaterfallInputs(pool, { brandId: houseId })
    expect(flat.inputs.discount_percent).toMatchObject({ value: 25, source: 'terms', detail: { shape: 'flat' } })
    expect(flat.inputs.retail_markup).toMatchObject({ value: 1.3, source: 'terms' })

    // {0.4, 0.4} is x0.36 — a 64% discount, not 80%.
    const chained = await resolveWaterfallInputs(pool, { brandId: bareId })
    expect(chained.inputs.discount_percent).toMatchObject({ value: 64, source: 'terms', detail: { shape: 'chain' } })
    expect(chained.inputs.retail_markup).toMatchObject({ value: null, source: 'missing' })
  })

  it('falls back to the supplier’s averaged rate where a house has no terms of its own', async () => {
    await pool.query(`UPDATE suppliers SET default_discount = 0.05 WHERE id = $1`, [supplierId])

    // The 9 Jul rule: one averaged rate for every house this supplier invoices.
    // Before the column existed this resolved MISSING and the landed cost could
    // not be previewed at all.
    const averaged = await resolveWaterfallInputs(pool, { brandId: averagedId })
    expect(averaged.inputs.discount_percent).toMatchObject({
      value: 5,
      source: 'supplier',
      detail: { shape: 'supplier-default' },
    })

    // A house negotiated brand by brand keeps its own rate — the two are never
    // added together (25%, not 30%).
    const exception = await resolveWaterfallInputs(pool, { brandId: houseId })
    expect(exception.inputs.discount_percent).toMatchObject({ value: 25, source: 'terms' })
  })

  it('keeps a supplier rate of 0 distinct from none — already-net prices are an answer', async () => {
    await pool.query(`UPDATE suppliers SET default_discount = 0 WHERE id = $1`, [supplierId])
    const net = await resolveWaterfallInputs(pool, { brandId: averagedId })
    expect(net.inputs.discount_percent).toMatchObject({ value: 0, source: 'supplier' })

    await pool.query(`UPDATE suppliers SET default_discount = NULL WHERE id = $1`, [supplierId])
    const unset = await resolveWaterfallInputs(pool, { brandId: averagedId })
    expect(unset.inputs.discount_percent).toMatchObject({ value: null, source: 'missing' })
  })

  it('takes freight from the ledger at supplier scope and the exchange rate from the supplier currency', async () => {
    await upsertFxRate(pool, CURRENCY, { rate: 0.5, set_on: '2026-01-01' })
    const { inputs, currency } = await resolveWaterfallInputs(pool, { brandId: houseId })
    expect(currency).toBe(CURRENCY)
    expect(inputs.freight).toMatchObject({ value: 30, source: 'freight-ledger', detail: { basis: 'dollar', unit: 'metre', scope: 'supplier' } })
    expect(inputs.fx_rate).toMatchObject({ value: 0.5, source: 'fx', detail: { currency: CURRENCY } })
  })

  it("takes the house's own freight rate ahead of the supplier-wide one", async () => {
    await pool.query(
      `INSERT INTO supplier_freight_rates (range_name, basis, rate, unit, effective_from)
       VALUES ($1, 'dollar', 45, 'roll', '2020-01-01')`,
      [`${PREFIX} module-house`.toUpperCase()]
    )
    try {
      const { inputs } = await resolveWaterfallInputs(pool, { brandId: houseId })
      expect(inputs.freight).toMatchObject({ value: 45, detail: { unit: 'roll', scope: 'range' } })
    } finally {
      await pool.query(`DELETE FROM supplier_freight_rates WHERE lower(range_name) = lower($1)`, [
        `${PREFIX} module-house`,
      ])
    }
  })

  it('a house with no supplier has no freight, no rate and no supplier defaults, and says so', async () => {
    const resolved = await resolveWaterfallInputs(pool, { brandId: orphanId })
    expect(resolved.supplier).toBe(null)
    expect(resolved.inputs.freight).toMatchObject({ value: null, source: 'missing' })
    expect(resolved.inputs.discount_percent).toMatchObject({ value: null, source: 'missing' })
  })

  it('computes the whole waterfall once every input has a source', async () => {
    await upsertFxRate(pool, CURRENCY, { rate: 0.5 })
    await upsertSupplierParameters(pool, supplierId, {
      duty_percent_a: 5,
      clearance_percent: 10,
      fx_margin_percent: 0,
      handling: 3,
      trade_markup_percent: 80,
    })
    const preview = await previewWaterfall(pool, { brandId: houseId, wholesaleRate: 100, dutyClass: 'A' })
    expect(preview.waterfall.missing).toEqual([])
    // 100 -25% = 75; / 0.5 = 150; +5% duty = 157.5; +30 freight, x1.10 clearance = 206.25;
    // +3 handling = 209.25; +80% = 376.65 trade; x1.3 = 272.025 retail.
    expect(preview.waterfall.landed).toBeCloseTo(209.25, 2)
    expect(preview.waterfall.trade_sell).toBeCloseTo(376.65, 2)
    expect(preview.waterfall.retail_sell).toBeCloseTo(272.03, 1)
    expect(preview.wholesale_rate).toBe(100)
  })

  it('a what-if override stands in for one preview, says what it replaced, and writes nothing', async () => {
    await upsertSupplierParameters(pool, supplierId, { trade_markup_percent: 80, clearance_percent: 10 })
    const preview = await previewWaterfall(pool, {
      brandId: houseId,
      wholesaleRate: 100,
      overrides: { trade_markup_percent: 95, freight: 12, handling: '', clearance_percent: -1 },
    })
    expect(preview.inputs.trade_markup_percent).toMatchObject({
      value: 95,
      source: 'manual',
      detail: { replaced: { value: 80, source: 'supplier' } },
    })
    expect(preview.inputs.freight).toMatchObject({ value: 12, source: 'manual', detail: { basis: 'dollar' } })
    // Blank and negative what-ifs are ignored, not applied as zero.
    expect(preview.inputs.handling).toMatchObject({ value: null, source: 'missing' })
    expect(preview.inputs.clearance_percent).toMatchObject({ value: 10, source: 'supplier' })
    expect((await getSupplierParameters(pool, supplierId)).trade_markup_percent).toBe(80)
  })

  it('deleting the override falls back to the supplier default on the next read', async () => {
    await upsertSupplierParameters(pool, supplierId, { handling: 2 })
    await upsertBrandParameters(pool, houseId, { handling: 9 })
    expect(await deleteBrandParameters(pool, houseId)).toBe(true)
    expect(await getBrandParameters(pool, houseId)).toBe(null)
    const { inputs } = await resolveWaterfallInputs(pool, { brandId: houseId })
    expect(inputs.handling).toMatchObject({ value: 2, source: 'supplier' })
    expect(await deleteBrandParameters(pool, houseId)).toBe(false)
  })
})

// --------------------------------------------------------------------------
// 3. Routes
// --------------------------------------------------------------------------

describe('/admin/pricing routes', () => {
  let pool
  let app
  let financeCookie
  let plainCookie
  let supplierId
  let houseId

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }
  const inject = (method, url, { cookie = financeCookie, payload } = {}) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    supplierId = await insertSupplier(pool, 'route-supplier')
    houseId = await insertBrand(pool, 'route-house', supplierId)
    await insertTerms(pool, { supplierId, brandId: houseId, discount: 0.25, markup: 1.3 })

    for (const [key, finance] of [
      ['finance', true],
      ['plain', false],
    ]) {
      const email = `${PREFIX}-${key}@example.test`
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: PASSWORD, name: key },
      })
      const cookie = sessionCookieFrom(res)
      await pool.query(`UPDATE users SET role = 'backoffice', can_view_finance = $2 WHERE email = $1`, [
        email,
        finance,
      ])
      if (key === 'finance') financeCookie = cookie
      else plainCookie = cookie
    }
  })

  afterAll(async () => {
    await app.close()
    await cleanup(pool)
    await pool.end()
  })

  it('refuses every read and write to a back-office login without finance visibility', async () => {
    for (const [method, url, payload] of [
      ['GET', `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100`],
      ['GET', `/admin/pricing/parameters/suppliers/${supplierId}`],
      ['PUT', `/admin/pricing/parameters/suppliers/${supplierId}`, { handling: 1 }],
      ['GET', '/admin/pricing/fx-rates'],
      ['PUT', `/admin/pricing/fx-rates/${CURRENCY}`, { rate: 0.5 }],
    ]) {
      const res = await inject(method, url, { cookie: plainCookie, payload })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().message).toMatch(/finance visibility/)
    }
    const anon = await inject('GET', '/admin/pricing/fx-rates', { cookie: null })
    expect(anon.statusCode).toBe(401)
  })

  it('PUT writes the set, strips unknown keys, and rejects a negative or a wrong type', async () => {
    const res = await inject('PUT', `/admin/pricing/parameters/suppliers/${supplierId}`, {
      payload: { duty_percent_a: 5, clearance_percent: 10, trade_markup_percent: 85, supplier_id: 1, evil: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().parameters).toMatchObject({ supplier_id: supplierId, duty_percent_a: 5, clearance_percent: 10 })

    const negative = await inject('PUT', `/admin/pricing/parameters/brands/${houseId}`, { payload: { handling: -2 } })
    expect(negative.statusCode).toBe(400)
    const wrongType = await inject('PUT', `/admin/pricing/parameters/brands/${houseId}`, { payload: { handling: 'two' } })
    expect(wrongType.statusCode).toBe(400)
    const missing = await inject('PUT', `/admin/pricing/parameters/brands/999999999`, { payload: { handling: 1 } })
    expect(missing.statusCode).toBe(404)
  })

  it('sets an exchange rate and lists it', async () => {
    const put = await inject('PUT', `/admin/pricing/fx-rates/${CURRENCY}`, { payload: { rate: 0.5, set_on: '2026-01-01' } })
    expect(put.statusCode).toBe(200)
    expect(put.json().rate).toMatchObject({ currency: CURRENCY, rate: 0.5, set_on: '2026-01-01' })
    const bad = await inject('PUT', `/admin/pricing/fx-rates/eur`, { payload: { rate: 0.5 } })
    expect(bad.statusCode).toBe(400)
    const list = await inject('GET', '/admin/pricing/fx-rates')
    expect(list.json().rates).toContainEqual(expect.objectContaining({ currency: CURRENCY, rate: 0.5 }))
  })

  it('previews the waterfall with every input naming its source', async () => {
    await inject('PUT', `/admin/pricing/parameters/brands/${houseId}`, { payload: { trade_markup_percent: 89 } })
    const res = await inject('GET', `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100&duty_class=A`)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.brand).toMatchObject({ id: houseId })
    expect(body.inputs.discount_percent).toMatchObject({ value: 25, source: 'terms' })
    expect(body.inputs.trade_markup_percent).toMatchObject({ value: 89, source: 'house' })
    expect(body.inputs.clearance_percent).toMatchObject({ value: 10, source: 'supplier' })
    expect(body.inputs.freight).toMatchObject({ source: 'missing' })
    expect(body.waterfall.steps.map((s) => s.step)).toContain('landed')
    expect(body.waterfall.missing).toContain('freight')

    const whatIf = await inject('GET', `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100&trade_markup_percent=95&freight=12`)
    expect(whatIf.statusCode).toBe(200)
    expect(whatIf.json().inputs.trade_markup_percent).toMatchObject({ value: 95, source: 'manual' })
    expect(whatIf.json().inputs.freight).toMatchObject({ value: 12, source: 'manual' })
    expect((await inject('GET', `/admin/pricing/parameters/brands/${houseId}`)).json().parameters.trade_markup_percent).toBe(89)
    const badWhatIf = await inject('GET', `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100&freight=-1`)
    expect(badWhatIf.statusCode).toBe(400)

    const gone = await inject('GET', `/admin/pricing/waterfall?brand_id=999999999&wholesale_rate=100`)
    expect(gone.statusCode).toBe(404)
    const noRate = await inject('GET', `/admin/pricing/waterfall?brand_id=${houseId}`)
    expect(noRate.statusCode).toBe(400)
  })
})

// --------------------------------------------------------------------------
// 4. The Dynamics backfill
// --------------------------------------------------------------------------

describe('pricing-parameter backfill from the Dynamics export', () => {
  let pool
  let supplierId
  let houseId
  let keptId
  let termedId
  let orphanId

  const range = (name, over = {}) => ({
    name,
    supplier: `${PREFIX} Supplier Ltd`,
    duty_rate_a: 5,
    duty_rate_b: 5,
    duty_rate_c: 10,
    clearance_percent: 10,
    trade_markup_percent: 85,
    discount_percent: 25,
    discount_stated: true,
    ...over,
  })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    supplierId = await insertSupplier(pool, 'bf-supplier')
    houseId = await insertBrand(pool, 'bf-house', supplierId)
    keptId = await insertBrand(pool, 'bf-kept', supplierId)
    termedId = await insertBrand(pool, 'bf-termed', supplierId)
    orphanId = await insertBrand(pool, 'bf-orphan', null)
    // A parameter the office already saved, with one band still blank.
    await upsertBrandParameters(pool, keptId, { clearance_percent: 7, trade_markup_percent: 90 })
    await insertTerms(pool, { supplierId, brandId: termedId, chain: [0.4, 0.4] })
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  const rangeParameters = () => [
    range(`${PREFIX} BF-HOUSE`),
    range(`${PREFIX} BF-KEPT`, { duty_rate_a: 5, clearance_percent: 99, trade_markup_percent: 99 }),
    range(`${PREFIX} BF-TERMED`),
    range(`${PREFIX} BF-ORPHAN`, { discount_percent: 0, discount_stated: false }),
    range(`${PREFIX} NOBODY`),
  ]

  it('plans purely: a set per matched house, a flat discount per linked house, and reports the rest', () => {
    const plan = planParametersBackfill({
      parameters: rangeParameters(),
      brands: [
        { id: 1, name: `${PREFIX} bf-house`, slug: `${PREFIX}-bf-house`, supplier_id: 7 },
        { id: 2, name: `${PREFIX} bf-orphan`, slug: `${PREFIX}-bf-orphan`, supplier_id: null },
      ],
      existing: [],
      terms: [],
    })
    expect(plan.summary).toMatchObject({ ranges: 5, parameter_inserts: 2, terms_inserts: 1, ranges_without_brand: 3 })
    expect(plan.inserts[0]).toMatchObject({ brand_id: 1, duty_percent_a: 5, duty_percent_c: 10, clearance_percent: 10, trade_markup_percent: 85 })
    expect(plan.termsInserts).toEqual([
      expect.objectContaining({ brand_id: 1, supplier_id: 7, discount: 0.25, discount_stated: true }),
    ])
    expect(plan.reports.brandsWithoutSupplier).toEqual([expect.objectContaining({ brand: `${PREFIX} bf-orphan` })])
    expect(plan.reports.rangesWithoutBrand.map((r) => r.range)).toContain(`${PREFIX} NOBODY`)
  })

  // 30 Sep 2026: Dynamics charged freight per range × letter from a table no
  // export carries; its archived prices say what each letter paid.
  it('fills a freight class per letter from what Dynamics’ prices paid, where most of them agree', () => {
    const sources = {
      parameters: [range('FABRICUT', { freight_per_unit: 23 })],
      brands: [{ id: 1, name: 'Fabricut', slug: 'fabricut', supplier_id: 7 }],
      freight: [{ range_name: 'Fabricut', basis: 'dollar', rate: 23, unit: 'yard', effective_from: '2026-01-01', freight_class: null }],
      classRates: [{ range_name: 'Fabricut', freight_class: 'C', basis: 'dollar', rate: 4, unit: 'yard', effective_from: '2026-01-01' }],
      letterFreights: [
        { range_name: 'FABRICUT', letter: 'A', rate: 30, rows: 1500 },
        { range_name: 'FABRICUT', letter: 'A', rate: 26, rows: 10 },
        { range_name: 'FABRICUT', letter: 'B', rate: 3, rows: 204 },
        { range_name: 'FABRICUT', letter: 'C', rate: 5, rows: 262 },
        // The every-class rate already charges it: no class needed.
        { range_name: 'FABRICUT', letter: 'D', rate: 23, rows: 40 },
        // Typed prices: no majority.
        { range_name: 'FABRICUT', letter: 'E', rate: 13, rows: 3 },
        { range_name: 'FABRICUT', letter: 'E', rate: 40, rows: 3 },
      ],
    }
    const classesOf = (plan) =>
      plan.freightInserts.filter((row) => row.freight_class).map(({ freight_class: letter, rate, unit }) => ({ letter, rate, unit }))

    const plan = planParametersBackfill(sources, { on: '2026-09-30' })
    expect(classesOf(plan)).toEqual([
      { letter: 'A', rate: 30, unit: 'yard' },
      { letter: 'B', rate: 3, unit: 'yard' },
    ])
    expect(plan.changes.filter((line) => line.field.startsWith('freight_class_'))).toEqual([
      expect.objectContaining({ field: 'freight_class_A', from: null, to: 30, kind: 'fill', unit: 'yard' }),
      expect.objectContaining({ field: 'freight_class_B', from: null, to: 3, kind: 'fill' }),
      expect.objectContaining({ field: 'freight_class_C', from: 4, to: 5, kind: 'kept' }),
    ])
    expect(plan.reports.freightClassUnclear).toEqual([expect.objectContaining({ brand: 'Fabricut', letter: 'E', rows: 6 })])

    // A class the house already has is re-dated only when asked.
    const replaced = planParametersBackfill(sources, { on: '2026-09-30', overwrite: true })
    expect(classesOf(replaced)).toContainEqual({ letter: 'C', rate: 5, unit: 'yard' })
  })

  it('applies: creates the sets, fills only what was blank, writes the discount, leaves existing terms alone', async () => {
    const summary = await backfillPricingParameters(pool, { rangeParameters: rangeParameters() })
    expect(summary).toMatchObject({ parameters_inserted: 3, parameters_filled: 1, terms_inserted: 2 })

    const house = await getBrandParameters(pool, houseId)
    expect(house).toMatchObject({ duty_percent_a: 5, duty_percent_c: 10, clearance_percent: 10, trade_markup_percent: 85 })
    expect(house.note).toMatch(/Dynamics/)

    // The saved clearance and markup stand; the blank duty band was filled.
    const kept = await getBrandParameters(pool, keptId)
    expect(kept).toMatchObject({ clearance_percent: 7, trade_markup_percent: 90, duty_percent_a: 5 })

    const { rows: terms } = await pool.query(
      `SELECT brand_id, discount, discount_chain, note FROM supplier_brand_terms
        WHERE brand_id = ANY($1::int[]) ORDER BY brand_id`,
      [[houseId, keptId, termedId, orphanId]]
    )
    const byBrand = Object.fromEntries(terms.map((row) => [row.brand_id, row]))
    expect(Number(byBrand[houseId].discount)).toBe(0.25)
    expect(Number(byBrand[keptId].discount)).toBe(0.25)
    // The chain the office recorded is untouched.
    expect(byBrand[termedId].discount).toBe(null)
    expect(byBrand[termedId].discount_chain.map(Number)).toEqual([0.4, 0.4])
    // No supplier to hang terms on.
    expect(byBrand[orphanId]).toBeUndefined()
    expect(await getBrandParameters(pool, orphanId)).toMatchObject({ clearance_percent: 10 })

    expect(summary.reports.termsAlreadyOnFile).toEqual([expect.objectContaining({ brand: `${PREFIX} bf-termed` })])
    expect(summary.reports.brandsWithoutSupplier).toEqual([expect.objectContaining({ brand: `${PREFIX} bf-orphan` })])
  })

  it('changes nothing on a second run', async () => {
    const summary = await backfillPricingParameters(pool, { rangeParameters: rangeParameters() })
    expect(summary).toMatchObject({ parameters_inserted: 0, parameters_filled: 0, terms_inserted: 0 })
  })
})
