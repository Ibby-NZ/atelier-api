// W16 — freight and landed cost.
//
// The story this suite has to keep true is a negative one: the mechanism ships
// and NO RATE IS WRITTEN ANYWHERE. The grain is unresolved (F1), so the table
// is empty, the recovery report is evidence rather than a source, and every
// resolve is a miss carrying a named reason instead of a zero.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  dutyPercentFor,
  getRangeParameters,
  listRangeParameters,
} from '../src/pricing/tracking-parameters.js'
import { planFreightRecovery } from '../src/pricing/freight-recovery.js'
import {
  NO_RATE_REASONS,
  createFreightRate,
  resolveFreightRate,
  validateFreightRate,
} from '../src/pricing/freight-rates.js'
import { computeWaterfall } from '../src/pricing/waterfall.js'
import {
  FREIGHT_RATE_SHEET_HEADER,
  applyFreightRateSheet,
  parseFreightRateSheet,
  toFreightRateCsv,
  validateFreightRateSheet,
} from '../src/pricing/freight-rate-sheet.js'

const PREFIX = 'w16-freight-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

// The staged parameter rows this suite reads. Never the real 75 — CI runs
// migrations only, so a test that assumed the client's export would pass here
// and fail there, which is the wrong way round for a negative-security suite.
const stageOption = (pool, values) =>
  pool.query(
    `INSERT INTO legacy_tracking_options
       (guid, tracking_category, name, supplier, duty_rate_a, duty_rate_b, duty_rate_c,
        clearance, freight, discount, trade_markup, status, source_file, raw)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Active', $11, '{}'::jsonb)`,
    [
      values.tracking_category ?? 'Range',
      values.name,
      values.supplier ?? null,
      values.duty_rate_a ?? null,
      values.duty_rate_b ?? null,
      values.duty_rate_c ?? null,
      values.clearance ?? null,
      values.freight ?? null,
      values.discount ?? null,
      values.trade_markup ?? null,
      `${PREFIX}.xlsx`,
    ]
  )

const cleanup = async (pool) => {
  // Rates first: `supplier_id` is RESTRICT, so the supplier delete 23503s
  // inside the cleanup otherwise — the same order `brands` before `suppliers`
  // already takes.
  await pool.query(`DELETE FROM supplier_freight_rates WHERE range_name LIKE $1`, [`${PREFIX}%`])
  await pool.query(
    `DELETE FROM supplier_freight_rates
      WHERE supplier_id IN (SELECT id FROM suppliers WHERE slug LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM legacy_tracking_options WHERE source_file = $1`, [`${PREFIX}.xlsx`])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

// ---------------------------------------------------------------------------
// US-004 — the schema, and what it deliberately does not carry
// ---------------------------------------------------------------------------

describe('W16-US-004 — supplier_freight_rates (schema only, no rate)', () => {
  let pool
  let supplierId

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${PREFIX} supplier`, `${PREFIX}-supplier`]
    )
    supplierId = rows[0].id
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM supplier_freight_rates WHERE supplier_id = $1 OR range_name LIKE $2`,
      [supplierId, `${PREFIX}%`]
    )
  })

  const insert = (values) =>
    pool.query(
      `INSERT INTO supplier_freight_rates
         (supplier_id, range_name, category, basis, rate, unit, effective_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        values.supplier_id ?? null,
        values.range_name ?? null,
        values.category ?? null,
        values.basis ?? 'dollar',
        values.rate,
        values.unit ?? null,
        values.effective_from ?? '2026-01-01',
      ]
    )

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    expect(await runMigrations(config.databaseUrl)).toEqual([])
  })

  // FR-198. The whole epic ships a mechanism with nothing in it, and this is
  // the assertion that says so: if a later commit seeds a rate from the
  // exported Freight column or from the recovered table, this fails.
  it('ships EMPTY — no migration, seed or backfill writes a rate', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total FROM supplier_freight_rates
        WHERE supplier_id <> $1 AND (range_name IS NULL OR range_name NOT LIKE $2)`,
      [supplierId, `${PREFIX}%`]
    )
    expect(rows[0].total).toBe(0)
  })

  // FR-194. `supplier_brand_terms` is per-brand and somebody will copy that
  // shape by reflex; freight is a property of who ships and what is in the box.
  it('carries no brand reference of any kind', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'supplier_freight_rates'`
    )
    const columns = rows.map((row) => row.column_name)
    expect(columns.filter((name) => /brand/i.test(name))).toEqual([])
    expect(columns).toContain('supplier_id')
    expect(columns).toContain('range_name')
    expect(columns).toContain('effective_from')
  })

  // FR-195. The letters are the only surviving evidence of what D365 charged.
  it('leaves price_list_items.freight_class exactly where it was', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'price_list_items'
          AND column_name = 'freight_class'`
    )
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }])
    // ...and nothing in this table is keyed by one.
    const { rows: freightColumns } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'supplier_freight_rates'
          AND column_name LIKE '%class%'`
    )
    expect(freightColumns).toEqual([])
  })

  it('accepts a supplier-scoped rate and a range-scoped rate', async () => {
    await insert({ supplier_id: supplierId, rate: 30, unit: 'metre' })
    await insert({ range_name: `${PREFIX} RANGE`, rate: 50, unit: 'roll' })
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total FROM supplier_freight_rates
        WHERE supplier_id = $1 OR range_name LIKE $2`,
      [supplierId, `${PREFIX}%`]
    )
    expect(rows[0].total).toBe(2)
  })

  it('refuses a rate with both scopes, and one with neither', async () => {
    await expect(
      insert({ supplier_id: supplierId, range_name: `${PREFIX} X`, rate: 30, unit: 'metre' })
    ).rejects.toThrow(/supplier_freight_rates_scope_check/)
    await expect(insert({ rate: 30, unit: 'metre' })).rejects.toThrow(
      /supplier_freight_rates_scope_check/
    )
  })

  it('defaults the basis to dollar and requires a dollar rate to state its unit', async () => {
    await insert({ supplier_id: supplierId, rate: 30, unit: 'metre' })
    const { rows } = await pool.query(
      `SELECT basis FROM supplier_freight_rates WHERE supplier_id = $1`,
      [supplierId]
    )
    expect(rows[0].basis).toBe('dollar')

    await expect(insert({ range_name: `${PREFIX} A`, rate: 30 })).rejects.toThrow(
      /supplier_freight_rates_unit_basis_check/
    )
    // ...and a percentage is per nothing.
    await expect(
      insert({ range_name: `${PREFIX} B`, basis: 'percent', rate: 8, unit: 'metre' })
    ).rejects.toThrow(/supplier_freight_rates_unit_basis_check/)
    await insert({ range_name: `${PREFIX} C`, basis: 'percent', rate: 8 })
  })

  it('refuses a basis outside the vocabulary and a negative rate', async () => {
    await expect(
      insert({ range_name: `${PREFIX} D`, basis: 'per-roll', rate: 1, unit: 'roll' })
    ).rejects.toThrow(/supplier_freight_rates_basis_check/)
    await expect(
      insert({ range_name: `${PREFIX} E`, rate: -1, unit: 'roll' })
    ).rejects.toThrow(/supplier_freight_rates_rate_check/)
  })

  // FR-192. Two rates claiming one day would make the resolver pick at random —
  // the same argument the fallback-tier partial unique index already makes.
  it('refuses two rates for one scope, category and day — including on NULLs', async () => {
    await insert({ range_name: `${PREFIX} RANGE`, rate: 30, unit: 'metre' })
    await expect(
      insert({ range_name: `${PREFIX.toLowerCase()} range`, rate: 40, unit: 'metre' })
    ).rejects.toThrow(/supplier_freight_rates_scope_effective_unique/)
    // A different day is the append, and it is allowed.
    await insert({
      range_name: `${PREFIX} RANGE`,
      rate: 40,
      unit: 'metre',
      effective_from: '2027-01-01',
    })
  })

  it('refuses deleting a supplier that a rate points at', async () => {
    await insert({ supplier_id: supplierId, rate: 30, unit: 'metre' })
    await expect(pool.query('DELETE FROM suppliers WHERE id = $1', [supplierId])).rejects.toThrow(
      /supplier_freight_rates/
    )
  })
})

// ---------------------------------------------------------------------------
// US-002 — the parameter read model
// ---------------------------------------------------------------------------

describe('W16-US-002 — the incumbent pricing parameters', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    // A range that states everything, one that leaves freight blank (the HAMAM
    // shape), and a Type row, which carries no parameter at all.
    await stageOption(pool, {
      name: `${PREFIX} FULL`,
      supplier: 'A Supplier Ltd',
      duty_rate_a: 5,
      duty_rate_b: 10,
      duty_rate_c: 5,
      clearance: 10,
      freight: 28,
      discount: 30,
      trade_markup: 85,
    })
    await stageOption(pool, {
      name: `${PREFIX} BLANKS`,
      duty_rate_a: 5,
      clearance: 10,
      // freight and discount blank on purpose — they mean two different things.
    })
    await stageOption(pool, { tracking_category: 'Type', name: `${PREFIX} Fabrics` })
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  it('reads Range rows only — a Type row is a vocabulary entry, not a rate', async () => {
    const { parameters } = await listRangeParameters(pool, { q: PREFIX })
    expect(parameters.map((row) => row.name).sort()).toEqual([
      `${PREFIX} BLANKS`,
      `${PREFIX} FULL`,
    ])
  })

  it('names clearance as the percentage it is and freight as dollars per unit', async () => {
    const row = await getRangeParameters(pool, `${PREFIX} FULL`)
    expect(row.clearance_percent).toBe(10)
    expect(row.freight_per_unit).toBe(28)
    expect(row.trade_markup_percent).toBe(85)
    // Coerced out of pg's numeric strings, not left as text.
    expect(typeof row.clearance_percent).toBe('number')
  })

  it('resolves the range by name case-insensitively — the name is the join key', async () => {
    expect((await getRangeParameters(pool, `${PREFIX} full`.toUpperCase())).name).toBe(
      `${PREFIX} FULL`
    )
    expect(await getRangeParameters(pool, `${PREFIX} nothing`)).toBeNull()
  })

  // The one rule that is three rules. Blank discount is a verified zero; blank
  // freight is UNKNOWN and must never become one.
  it('reads a blank discount as zero and a blank freight as unknown', async () => {
    const row = await getRangeParameters(pool, `${PREFIX} BLANKS`)
    expect(row.discount_percent).toBe(0)
    expect(row.discount_stated).toBe(false)
    expect(row.freight_per_unit).toBeNull()

    const stated = await getRangeParameters(pool, `${PREFIX} FULL`)
    expect(stated.discount_percent).toBe(30)
    expect(stated.discount_stated).toBe(true)
  })

  describe('dutyPercentFor — the letter is on the price row, the rate is on the range', () => {
    let full
    let blanks
    beforeAll(async () => {
      full = await getRangeParameters(pool, `${PREFIX} FULL`)
      blanks = await getRangeParameters(pool, `${PREFIX} BLANKS`)
    })

    it('reads a blank letter as 0%', () => {
      expect(dutyPercentFor(full, null)).toEqual({ percent: 0, reason: null })
      expect(dutyPercentFor(full, '  ')).toEqual({ percent: 0, reason: null })
    })

    it('keys each letter on its own band', () => {
      expect(dutyPercentFor(full, 'A').percent).toBe(5)
      expect(dutyPercentFor(full, 'b').percent).toBe(10)
      expect(dutyPercentFor(full, 'C').percent).toBe(5)
    })

    // A row pointing at a blank band has NO DEFINED duty rather than no duty.
    it('refuses to read a blank band as zero duty', () => {
      expect(dutyPercentFor(blanks, 'B')).toEqual({ percent: null, reason: 'duty_band_not_set' })
      expect(dutyPercentFor(full, 'D')).toEqual({ percent: null, reason: 'unknown_duty_class' })
      expect(dutyPercentFor(null, 'A')).toEqual({ percent: null, reason: 'no_parameters' })
    })
  })
})

// ---------------------------------------------------------------------------
// US-003 — the recovery planner. Pure, so it needs no database at all.
// ---------------------------------------------------------------------------

describe('W16-US-003 — the freight-letter recovery planner', () => {
  const parameters = [
    // The Fabricut shape: one exported number, three very different letters.
    { name: 'FABRICUT', supplier: 'Fabricut Inc', clearance_percent: 10, freight_per_unit: 23 },
    // The HAMAM shape: exported column blank, letters implying four rates.
    { name: 'HAMAM', supplier: 'Veritas', clearance_percent: 10, freight_per_unit: null },
    // The agreeing shape.
    { name: 'DE LE CUONA', supplier: 'de Le Cuona', clearance_percent: 10, freight_per_unit: 50 },
  ]

  // landed = (inclDuty + freight) x 1.10, then rounded to cents as the export
  // stores it — which is exactly the 1-cent spread the planner has to survive.
  const priced = (range, letter, inclDuty, freight) => ({
    range_name: range,
    freight_rate: letter,
    price_incl_duty_nz: inclDuty.toFixed(2),
    landed_cost_nz: ((inclDuty + freight) * 1.1).toFixed(2),
  })

  const priceRows = [
    priced('FABRICUT', 'A', 100.11, 30),
    priced('FABRICUT', 'A', 87.37, 30),
    priced('FABRICUT', 'A', 12.05, 30),
    priced('FABRICUT', 'B', 40.01, 3),
    priced('FABRICUT', 'C', 22.22, 5),
    priced('HAMAM', 'A', 33.33, 50),
    priced('HAMAM', 'B', 44.44, 17),
    priced('HAMAM', 'B', 91.19, 17),
    priced('HAMAM', 'B', 15.05, 17),
    priced('DE LE CUONA', 'A', 210.75, 50),
    priced('DE LE CUONA', null, 12.5, 50),
    { range_name: 'BOUSSAC', freight_rate: 'A', price_incl_duty_nz: '10', landed_cost_nz: '44' },
  ]

  const plan = planFreightRecovery({ parameters, priceRows })

  it('recovers the letter rate by arithmetic, to the cent', () => {
    const fabricut = plan.recovered.filter((entry) => entry.range === 'FABRICUT')
    expect(fabricut.map((entry) => [entry.letter, entry.freight])).toEqual([
      ['A', 30],
      ['B', 3],
      ['C', 5],
    ])
    // Every row in a bucket agrees with it — that is what "constant per
    // (range x letter)" means, and it is the claim the whole story rests on.
    expect(fabricut.every((entry) => entry.agreeing === entry.rows)).toBe(true)
  })

  // The regression this cost: 17.01 and 16.99 are the same $17.00 seen through
  // 2dp rounding, and `Math.abs(17.01 - 16.99) <= 0.02` is FALSE in floating
  // point. Compared in cents it is one rate on three rows.
  it('holds a bucket together across the export own 1-cent rounding', () => {
    const hamamB = plan.recovered.find(
      (entry) => entry.range === 'HAMAM' && entry.letter === 'B'
    )
    expect(hamamB.freight).toBe(17)
    expect(hamamB.agreeing).toBe(hamamB.rows)
  })

  it('gives a blank letter its own bucket rather than folding it into A', () => {
    const blank = plan.recovered.find(
      (entry) => entry.range === 'DE LE CUONA' && entry.letter === null
    )
    expect(blank.freight).toBe(50)
  })

  // THE DELIVERABLE. Two shapes of disagreement, named apart.
  it('names every disagreement with the exported Freight column', () => {
    expect(plan.disagreements.map((entry) => entry.range).sort()).toEqual(['FABRICUT', 'HAMAM'])

    const fabricut = plan.disagreements.find((entry) => entry.range === 'FABRICUT')
    expect(fabricut.exported_freight).toBe(23)
    expect(fabricut.reason).toMatch(/matches no letter/)

    const hamam = plan.disagreements.find((entry) => entry.range === 'HAMAM')
    expect(hamam.exported_freight).toBeNull()
    expect(hamam.reason).toMatch(/blank/)
  })

  it('agrees where the column equals SOME letter rate', () => {
    const cuona = plan.ranges.find((entry) => entry.range === 'DE LE CUONA')
    expect(cuona.agrees).toBe(true)
    expect(cuona.reason).toBeNull()
  })

  it('skips a range with no parameter row and says why, rather than assuming one', () => {
    expect(plan.skipped).toEqual([{ reason: 'no parameter row for the range', rows: 1 }])
    expect(plan.ranges.some((entry) => entry.range === 'BOUSSAC')).toBe(false)
  })

  it('counts the ranges that use more than one letter — why range alone is not the key', () => {
    // FABRICUT (A/B/C), HAMAM (A/B) and DE LE CUONA (A and a blank letter).
    expect(plan.summary.ranges_multi_letter).toBe(3)
    expect(plan.summary.ranges_disagreeing).toBe(2)
    expect(plan.summary.rows_bucketed + plan.summary.rows_skipped).toBe(priceRows.length)
  })

  it('is pure — the same inputs produce the same plan', () => {
    expect(planFreightRecovery({ parameters, priceRows })).toEqual(plan)
  })
})

// ---------------------------------------------------------------------------
// US-006 — the waterfall
// ---------------------------------------------------------------------------

describe('W16-US-006 — the pricing waterfall', () => {
  const complete = {
    wholesale_rate: 100,
    discount_percent: 0,
    fx_rate: 1,
    fx_margin_percent: 0,
    duty_percent: 5,
    freight: 30,
    clearance_percent: 10,
    handling: 0,
    trade_markup_percent: 85,
    retail_markup: 1.3,
  }

  const stepOf = (result, step) => result.steps.find((entry) => entry.step === step).amount

  // The demo applies clearance before freight and duty after both, which is a
  // different number on every row. This is the incumbent's order, verified
  // against the export's own figures on 19,197 of 19,201 rows.
  it('applies duty BEFORE freight and clearance over BOTH', () => {
    const result = computeWaterfall(complete)
    expect(stepOf(result, 'price_incl_duty')).toBe(105)
    // (105 + 30) x 1.10 — not 105 x 1.10 + 30 (145.5), and not the demo order.
    expect(stepOf(result, 'landed_ex_handling')).toBe(148.5)
    expect(result.landed).toBe(148.5)
    expect(result.missing).toEqual([])
  })

  // The row that settles the percent argument on its own: a percentage of zero
  // is zero, and the export says $11.00.
  it('reproduces Garrett Leather — 42 hides of zero value landing at 11.00', () => {
    const result = computeWaterfall({
      ...complete,
      wholesale_rate: 0,
      freight: 10,
      clearance_percent: 10,
    })
    expect(result.landed).toBe(11)
  })

  it('carries no default rate of any kind — nothing is 8% and nothing is 7%', () => {
    const result = computeWaterfall({ wholesale_rate: 100 })
    expect(result.landed).toBeNull()
    expect(result.steps.find((entry) => entry.step === 'freight_amount').amount).toBeNull()
    expect(result.missing).toContain('freight')
    expect(result.missing).toContain('duty')
    expect(result.missing).toContain('clearance')
  })

  // FR-191. Four missing inputs silently treated as zero look authoritative.
  it('returns a partial result naming every missing input, and never substitutes zero', () => {
    const result = computeWaterfall({
      ...complete,
      fx_rate: null,
      handling: null,
      trade_markup_percent: null,
    })
    expect(result.landed).toBeNull()
    expect(result.trade_sell).toBeNull()
    expect(result.missing).toEqual(['fx_rate', 'handling', 'trade_markup'])
    // The steps before the break still resolved, so a reader can see WHERE it
    // stopped rather than inferring it from a short list.
    expect(stepOf(result, 'export_price')).toBe(100)
    expect(stepOf(result, 'price_ex_duty')).toBeNull()
  })

  it('separates the incumbent landed cost from the platform own, which owes handling', () => {
    const result = computeWaterfall({ ...complete, handling: null })
    expect(stepOf(result, 'landed_ex_handling')).toBe(148.5)
    expect(result.landed).toBeNull()
    expect(result.missing).toEqual(['handling'])
  })

  it('treats a real zero as a rate and an absent value as missing', () => {
    const result = computeWaterfall({ ...complete, freight: 0 })
    expect(result.missing).toEqual([])
    expect(result.landed).toBe(115.5)
    expect(computeWaterfall({ ...complete, freight: null }).missing).toEqual(['freight'])
  })

  it('supports a percent basis without making it the default', () => {
    const result = computeWaterfall({ ...complete, freight: 8, freight_basis: 'percent' })
    // 8% of the duty-paid 105, not of the wholesale.
    expect(stepOf(result, 'freight_amount')).toBe(8.4)
    expect(computeWaterfall({ ...complete, freight: 8 }).steps.find((s) => s.step === 'freight_amount').amount).toBe(8)
  })

  it('applies the trade markup to landed, and the retail markup as a multiplier', () => {
    const result = computeWaterfall(complete)
    expect(result.trade_sell).toBe(274.73)
    expect(result.retail_sell).toBe(193.05)
  })
})

// ---------------------------------------------------------------------------
// US-005 / US-008 / US-009 — the resolver, the ledger and the sheet
// ---------------------------------------------------------------------------

describe('W16-US-005 — the freight rate resolver', () => {
  let pool
  let supplierId

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${PREFIX} resolver`, `${PREFIX}-resolver`]
    )
    supplierId = rows[0].id
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM supplier_freight_rates WHERE supplier_id = $1`, [supplierId])
  })

  // The whole point of the story: `Number(null)` is 0, and a zero freight rate
  // reads as free shipping from Italy.
  it('returns null with a named reason, never zero', async () => {
    const miss = await resolveFreightRate(pool, { supplier_id: supplierId, on: '2026-08-13' })
    expect(miss.rate).toBeNull()
    expect(miss.reason).toBe(NO_RATE_REASONS.NO_RATE_FOR_SCOPE)
    expect(Number(miss.rate)).toBe(0) // ...which is exactly why nobody may coerce it
  })

  it('refuses to choose between a supplier scope and a range scope', async () => {
    expect(
      (await resolveFreightRate(pool, { supplier_id: supplierId, range_name: 'X' })).reason
    ).toBe(NO_RATE_REASONS.NO_SCOPE)
    expect((await resolveFreightRate(pool, {})).reason).toBe(NO_RATE_REASONS.NO_SCOPE)
  })

  it('tells "nobody set one" apart from "it starts later"', async () => {
    await createFreightRate(pool, {
      supplier_id: supplierId,
      rate: 30,
      unit: 'metre',
      effective_from: '2027-01-01',
    })
    const early = await resolveFreightRate(pool, { supplier_id: supplierId, on: '2026-08-13' })
    expect(early.rate).toBeNull()
    expect(early.reason).toBe(NO_RATE_REASONS.NOT_YET_EFFECTIVE)
  })

  it('picks the newest rate at or before the day — the append is the change', async () => {
    await createFreightRate(pool, {
      supplier_id: supplierId,
      rate: 30,
      unit: 'metre',
      effective_from: '2025-01-01',
    })
    await createFreightRate(pool, {
      supplier_id: supplierId,
      rate: 33,
      unit: 'metre',
      effective_from: '2026-01-01',
    })
    expect((await resolveFreightRate(pool, { supplier_id: supplierId, on: '2025-06-01' })).rate.rate).toBe(30)
    expect((await resolveFreightRate(pool, { supplier_id: supplierId, on: '2026-06-01' })).rate.rate).toBe(33)
  })

  it('prefers the line own category over the catch-all, and asks for the catch-all by default', async () => {
    await createFreightRate(pool, {
      supplier_id: supplierId,
      rate: 30,
      unit: 'metre',
      effective_from: '2025-01-01',
    })
    await createFreightRate(pool, {
      supplier_id: supplierId,
      category: 'wallpaper',
      rate: 50,
      unit: 'roll',
      effective_from: '2025-01-01',
    })
    const wallpaper = await resolveFreightRate(pool, {
      supplier_id: supplierId,
      category: 'wallpaper',
      on: '2026-06-01',
    })
    expect(wallpaper.rate.rate).toBe(50)
    expect(wallpaper.rate.unit).toBe('roll')

    // A caller naming no category is asking for the catch-all and gets only it.
    expect((await resolveFreightRate(pool, { supplier_id: supplierId, on: '2026-06-01' })).rate.rate).toBe(30)
    // A category with no rate of its own falls through to the catch-all.
    expect(
      (await resolveFreightRate(pool, { supplier_id: supplierId, category: 'fabric', on: '2026-06-01' }))
        .rate.rate
    ).toBe(30)
  })

  it('resolves a range scope by spelling, case-insensitively', async () => {
    await createFreightRate(pool, {
      range_name: `${PREFIX} PIERRE FREY`,
      rate: 28,
      unit: 'metre',
      effective_from: '2025-01-01',
    })
    const hit = await resolveFreightRate(pool, {
      range_name: `${PREFIX} pierre frey`.toLowerCase(),
      on: '2026-06-01',
    })
    expect(hit.rate.rate).toBe(28)
    await pool.query(`DELETE FROM supplier_freight_rates WHERE range_name LIKE $1`, [`${PREFIX}%`])
  })
})

describe('W16-US-008 — the rate ledger is append-only', () => {
  let pool
  let supplierId

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${PREFIX} ledger`, `${PREFIX}-ledger`]
    )
    supplierId = rows[0].id
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM supplier_freight_rates WHERE supplier_id = $1`, [supplierId])
  })

  it('refuses a second rate for the same scope, category and day', async () => {
    await createFreightRate(pool, {
      supplier_id: supplierId,
      rate: 30,
      unit: 'metre',
      effective_from: '2026-01-01',
    })
    await expect(
      createFreightRate(pool, {
        supplier_id: supplierId,
        rate: 33,
        unit: 'metre',
        effective_from: '2026-01-01',
      })
    ).rejects.toMatchObject({ statusCode: 409 })
    // The old row is untouched — that is what makes an uplift auditable.
    const { rows } = await pool.query(
      `SELECT rate FROM supplier_freight_rates WHERE supplier_id = $1`,
      [supplierId]
    )
    expect(rows.map((row) => Number(row.rate))).toEqual([30])
  })

  it('validates a rate the same way for the form and the file', () => {
    expect(validateFreightRate({ range_name: 'X', rate: 1, unit: 'metre', effective_from: '2026-01-01' })).toBeNull()
    expect(validateFreightRate({ rate: 1, unit: 'metre', effective_from: '2026-01-01' })).toMatch(
      /either a supplier or a range/
    )
    expect(validateFreightRate({ range_name: 'X', rate: 1, effective_from: '2026-01-01' })).toMatch(
      /must state its unit/
    )
    expect(
      validateFreightRate({ range_name: 'X', basis: 'percent', rate: 8, unit: 'metre', effective_from: '2026-01-01' })
    ).toMatch(/per nothing/)
    expect(validateFreightRate({ range_name: 'X', rate: -1, unit: 'metre', effective_from: '2026-01-01' })).toMatch(
      /zero or more/
    )
    expect(validateFreightRate({ range_name: 'X', rate: 1, unit: 'metre', effective_from: '01/01/2026' })).toMatch(
      /YYYY-MM-DD/
    )
  })

  it('reports an unknown supplier as a 422 rather than a 500', async () => {
    await expect(
      createFreightRate(pool, {
        supplier_id: 2147483646,
        rate: 30,
        unit: 'metre',
        effective_from: '2026-01-01',
      })
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('W16-US-009 — the rate CSV round trip', () => {
  let pool
  let supplierId

  const sheet = (rows) =>
    Buffer.from(
      [FREIGHT_RATE_SHEET_HEADER.join(','), ...rows.map((row) => row.join(','))].join('\r\n') +
        '\r\n',
      'utf8'
    )

  const line = ({ id = '', name = '', range = '', category = '', basis = 'dollar', rate = '', unit = '', from = '', note = '' }) =>
    [id, name, range, category, basis, rate, unit, from, note]

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${PREFIX} sheet`, `${PREFIX}-sheet`]
    )
    supplierId = rows[0].id
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM supplier_freight_rates WHERE supplier_id = $1 OR range_name LIKE $2`,
      [supplierId, `${PREFIX}%`]
    )
  })

  // Renaming a label breaks every sheet already on somebody's desk.
  it('publishes exactly this header row', () => {
    expect(FREIGHT_RATE_SHEET_HEADER).toEqual([
      'Supplier ID',
      'Supplier',
      'Range',
      'Category',
      'Basis',
      'Rate',
      'Unit',
      'Effective From',
      'Note',
    ])
  })

  it('exports the header alone while no rate is stored — a true empty sheet', () => {
    expect(toFreightRateCsv({ rates: [], suppliers: new Map() })).toBe(
      `${FREIGHT_RATE_SHEET_HEADER.join(',')}\r\n`
    )
  })

  it('neutralises a formula lead-in in the staff-typed note', () => {
    const csv = toFreightRateCsv({
      rates: [
        {
          supplier_id: null,
          range_name: 'X',
          category: null,
          basis: 'dollar',
          rate: 30,
          unit: 'metre',
          effective_from: '2026-01-01',
          note: '=HYPERLINK("http://evil.test")',
        },
      ],
      suppliers: new Map(),
    })
    expect(csv).toContain("'=HYPERLINK")
  })

  it('refuses a file that is not a rate sheet at all with a 400', () => {
    expect(() => parseFreightRateSheet(Buffer.from('a,b,c\r\n'))).toThrow(/Unexpected header row/)
    expect(() => parseFreightRateSheet(Buffer.from(''))).toThrow(/empty/)
    expect(() => parseFreightRateSheet({})).toThrow(/raw file/)
  })

  it('reports every row failure with its own line number and writes nothing', async () => {
    const report = await validateFreightRateSheet(
      pool,
      sheet([
        line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '2026-01-01' }),
        line({ range: `${PREFIX} B`, rate: '30', from: '2026-01-01' }),
        line({ id: 'abc', rate: '30', unit: 'metre', from: '2026-01-01' }),
        line({ range: `${PREFIX} C`, rate: '30', unit: 'metre', from: 'yesterday' }),
      ])
    )
    expect(report.errors.map((error) => error.row)).toEqual([3, 4, 5])
    expect(report.errors[0].message).toMatch(/must state its unit/)
    expect(report.errors[1].message).toMatch(/not a Supplier ID/)
    expect(report.errors[2].message).toMatch(/not a date/)
  })

  it('accepts the d/m/Y an Excel on a New Zealand desk writes back', async () => {
    const report = await validateFreightRateSheet(
      pool,
      sheet([line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '5/03/2026' })])
    )
    expect(report.errors).toEqual([])
    expect(report.changes[0].effective_from).toBe('2026-03-05')
  })

  it('balances: rows = skipped + repeats + unchanged + created', async () => {
    const file = sheet([
      line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '2026-01-01' }),
      line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '2026-01-01' }),
      line({ id: String(supplierId), name: 'ignored', rate: '8', basis: 'percent', from: '2026-01-01' }),
      line({}),
    ])
    const report = await validateFreightRateSheet(pool, file)
    expect(report.errors).toEqual([])
    const { rows, skipped, repeats, unchanged, created } = report.summary
    expect(rows).toBe(skipped + repeats + unchanged + created)
    expect(report.summary).toEqual({ rows: 4, skipped: 1, repeats: 1, unchanged: 0, created: 2 })
  })

  it('is a dry run: validate writes nothing, apply writes once, re-apply writes nothing', async () => {
    const file = sheet([
      line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '2026-01-01' }),
    ])
    await validateFreightRateSheet(pool, file)
    const before = await pool.query(
      `SELECT count(*)::int AS total FROM supplier_freight_rates WHERE range_name LIKE $1`,
      [`${PREFIX}%`]
    )
    expect(before.rows[0].total).toBe(0)

    const applied = await applyFreightRateSheet(pool, file)
    expect(applied.applied).toBe(1)

    const again = await applyFreightRateSheet(pool, file)
    expect(again.applied).toBe(0)
    expect(again.summary.unchanged).toBe(1)
  })

  // The difference from the product sheet: this one can never overwrite.
  it('refuses a row that would change a rate already on the ledger', async () => {
    await applyFreightRateSheet(
      pool,
      sheet([line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '2026-01-01' })])
    )
    const report = await applyFreightRateSheet(
      pool,
      sheet([line({ range: `${PREFIX} A`, rate: '35', unit: 'metre', from: '2026-01-01' })])
    )
    expect(report.applied).toBe(0)
    expect(report.errors[0].message).toMatch(/append-only/)
    const { rows } = await pool.query(
      `SELECT rate FROM supplier_freight_rates WHERE range_name LIKE $1`,
      [`${PREFIX}%`]
    )
    expect(rows.map((row) => Number(row.rate))).toEqual([30])
  })

  it('refuses the whole file when any row is broken', async () => {
    const report = await applyFreightRateSheet(
      pool,
      sheet([
        line({ range: `${PREFIX} A`, rate: '30', unit: 'metre', from: '2026-01-01' }),
        line({ range: `${PREFIX} B`, rate: 'lots', unit: 'metre', from: '2026-01-01' }),
      ])
    )
    expect(report.applied).toBe(0)
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total FROM supplier_freight_rates WHERE range_name LIKE $1`,
      [`${PREFIX}%`]
    )
    expect(rows[0].total).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// US-007 — the preview route, and the first masking in the platform that bites
// ---------------------------------------------------------------------------

describe('W16-US-007 — the landed-cost preview', () => {
  let pool
  let app
  let financeCookie
  let plainCookie
  let customerCookie

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }

  const RANGE = `${PREFIX} PREVIEW`
  const preview = (query = '', cookie = financeCookie) =>
    app.inject({
      method: 'GET',
      url: `/admin/freight/landed-preview?range=${encodeURIComponent(RANGE)}&wholesale_rate=100${query}`,
      headers: cookie ? { cookie } : {},
    })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await stageOption(pool, {
      name: RANGE,
      supplier: 'A Supplier Ltd',
      duty_rate_a: 5,
      clearance: 10,
      freight: 28,
      discount: 0,
      trade_markup: 85,
    })

    // Registered once — register and login share a 10-per-15-min bucket.
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
      await pool.query(
        `UPDATE users SET role = 'backoffice', can_view_finance = $2 WHERE email = $1`,
        [email, finance]
      )
      if (key === 'finance') financeCookie = cookie
      else plainCookie = cookie
    }
    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `${PREFIX}-shopper@example.test`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  it('refuses an anonymous caller and a customer', async () => {
    expect((await preview('', null)).statusCode).toBe(401)
    expect((await preview('', customerCookie)).statusCode).toBe(403)
  })

  it('serves a back-office login with finance visibility', async () => {
    // fx_rate and its margin are supplied by hand because NOTHING sources them
    // — `src/seed/data/fx.js` is vendored demo data — so without them the chain
    // stops at the export price, which is the point of the next test.
    const res = await preview('&duty_class=A&fx_rate=1&fx_margin_percent=0')
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.report).toBe('landed-cost-preview')
    expect(body.columns.map((column) => column.key)).toEqual(['step', 'label', 'amount'])
    const inclDuty = body.rows.find((row) => row.step === 'price_incl_duty')
    expect(inclDuty.amount).toBe(105)
  })

  // THE FIRST PLACE MASKING DELETES SOMETHING. Every report in Epic 5 declares
  // no finance column, so this assertion is new behaviour rather than a
  // restatement of one.
  it('deletes every amount for a back-office login without the finance grant', async () => {
    const res = await preview('&duty_class=A', plainCookie)
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // The column is GONE — not nulled and not blanked. A key that survives with
    // an empty value still tells the reader which figures exist.
    expect(body.columns.map((column) => column.key)).toEqual(['step', 'label'])
    for (const row of body.rows) {
      expect(Object.hasOwn(row, 'amount')).toBe(false)
    }
    // Labels only: a masked column's KEY is the machine name of a figure this
    // caller may not have.
    expect(body.meta.masked_columns).toEqual(['Amount'])

    // ...and the shape of the waterfall still reads, which is the reason this
    // masks rather than refusing: knowing there is a clearance step is not
    // knowing the clearance.
    expect(body.rows.map((row) => row.step)).toContain('landed')
  })

  it('withholds nothing from a login that has the grant', async () => {
    const body = (await preview('&duty_class=A')).json()
    expect(body.meta.masked_columns).toEqual([])
  })

  it('never carries a cost figure in meta, where masking cannot reach', async () => {
    const body = (await preview('&duty_class=A')).json()
    // Reasons and names only. A number parked in meta survives maskReport.
    const serialised = JSON.stringify(body.meta)
    expect(serialised).not.toMatch(/\d+\.\d\d/)
    expect(body.meta.missing).toContain('freight')
  })

  // The mechanism working: the table is empty, so the resolve is a miss and the
  // preview says so instead of quoting free shipping.
  it('names the missing freight rate rather than treating it as zero', async () => {
    const body = (await preview('&duty_class=A')).json()
    expect(body.meta.freight_reason).toBe(NO_RATE_REASONS.NO_RATE_FOR_SCOPE)
    expect(body.rows.find((row) => row.step === 'freight_amount').amount).toBeNull()
    expect(body.rows.find((row) => row.step === 'landed').amount).toBeNull()
    expect(body.meta.missing).toEqual(
      expect.arrayContaining(['fx_rate', 'fx_margin', 'freight', 'handling', 'retail_markup'])
    )
  })

  it('404s a range with no staged parameters rather than inventing them', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/freight/landed-preview?range=NOSUCHRANGE&wholesale_rate=100',
      headers: { cookie: financeCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('gates the parameter and recovery routes on finance too', async () => {
    expect(
      (await app.inject({
        method: 'GET',
        url: '/admin/freight/parameters',
        headers: { cookie: plainCookie },
      })).statusCode
    ).toBe(403)
    expect(
      (await app.inject({
        method: 'GET',
        url: '/admin/freight/parameters',
        headers: { cookie: financeCookie },
      })).statusCode
    ).toBe(200)
  })

  // There is no PATCH and no DELETE, and that is FR-192 rather than an
  // omission: a correction is a later row.
  it('exposes no way to overwrite a rate over HTTP', async () => {
    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      const res = await app.inject({
        method,
        url: '/admin/freight/rates/1',
        headers: { cookie: financeCookie },
        ...(method === 'DELETE' ? {} : { payload: { rate: 1 } }),
      })
      expect(res.statusCode).toBe(404)
    }
  })
})
