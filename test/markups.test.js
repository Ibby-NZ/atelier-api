// The two markups (28 Sep 2026): each house's retail markup on the trade sell,
// filled by the ranges import from Dynamics' own retail ÷ trade; and a product
// price's own markup to trade, read off the "Markup to Trade %" export.
// Pure halves here; the upload runs against Postgres in product-prices.test.js.

import { describe, it, expect } from 'vitest'
import { computeWaterfall } from '../src/pricing/waterfall.js'
import { planParametersBackfill, RETAIL_MARKUP } from '../src/pricing/parameters-backfill.js'
import { isMarkupExport, readProductMarkupsWorkbook } from '../src/pricing/product-prices-import.js'
import { d365Workbook } from './helpers/d365-workbook-fixture.js'

const INPUTS = Object.freeze({
  wholesale_rate: 47.6,
  discount_percent: 0,
  fx_rate: 0.38,
  fx_margin_percent: 0,
  duty_percent: 0,
  freight: 50,
  clearance_percent: 10,
  handling: 0,
  trade_markup_percent: 87,
})

describe('the retail sell', () => {
  it('is the trade sell × (1 + the retail markup), Dynamics\' rule', () => {
    const waterfall = computeWaterfall({ ...INPUTS, retail_markup_percent: 30 })
    expect(waterfall.trade_sell).toBeCloseTo(360.52, 2)
    expect(waterfall.retail_sell).toBeCloseTo(360.5163 * 1.3, 2)
    expect(waterfall.missing).toEqual([])
  })

  it('takes the older multiplier on landed only where no percentage is set', () => {
    expect(computeWaterfall({ ...INPUTS, retail_markup: 2 }).retail_sell).toBeCloseTo(192.7895 * 2, 2)
    expect(computeWaterfall({ ...INPUTS, retail_markup: 2, retail_markup_percent: 30 }).retail_sell).toBeCloseTo(360.5163 * 1.3, 2)
    expect(computeWaterfall(INPUTS).missing).toEqual(['retail_markup'])
  })
})

describe('a clearance in dollars', () => {
  it('is added per unit to the duty-paid value plus freight, where a percentage multiplies it', () => {
    const percent = computeWaterfall({ ...INPUTS, clearance_percent: 10 })
    const dollar = computeWaterfall({ ...INPUTS, clearance_percent: 10, clearance_basis: 'dollar' })
    expect(percent.landed).toBeCloseTo(175.2632 * 1.1, 2)
    expect(dollar.landed).toBeCloseTo(175.2632 + 10, 2)
    expect(dollar.trade_sell).toBeCloseTo((175.2632 + 10) * 1.87, 2)
  })
})

describe('the ranges import fills each house\'s retail markup', () => {
  const brands = [
    { id: 1, name: 'MADEAUX', slug: 'madeaux', supplier_id: 7 },
    { id: 2, name: 'Jannelli & Volpi', slug: 'jannelli-volpi', supplier_id: 7 },
    { id: 3, name: 'SPLIT HOUSE', slug: 'split-house', supplier_id: 7 },
    { id: 4, name: 'ONE ROW', slug: 'one-row', supplier_id: 7 },
  ]
  const parameters = ['MADEAUX', 'Jannelli & Volpi', 'SPLIT HOUSE', 'ONE ROW'].map((name) => ({ name, status: 'Active', discount_percent: 0 }))
  const retailRatios = [
    { range_name: 'MADEAUX', ratio: '1.30', rows: 158 },
    // Two Dynamics ranges merged into one house: the majority decides.
    { range_name: 'Jannelli & Volpi', ratio: '1.30', rows: 2493 },
    { range_name: 'Jannelli & Volpi', ratio: '1.80', rows: 361 },
    { range_name: 'Jannelli & Volpi', ratio: '1.50', rows: 248 },
    { range_name: 'SPLIT HOUSE', ratio: '1.40', rows: 10 },
    { range_name: 'SPLIT HOUSE', ratio: '1.50', rows: 10 },
    { range_name: 'NOT A HOUSE', ratio: '1.30', rows: 99 },
    { range_name: 'ONE ROW', ratio: '1.50', rows: 1 },
  ]
  const sources = { parameters, brands, existing: [], terms: [], retailRatios }

  it('as the ratio most of its rows share, a percentage on trade, and reports a house with no majority', () => {
    const plan = planParametersBackfill(sources, { on: '2026-09-28' })
    const byBrand = new Map(plan.inserts.map((row) => [row.brand_id, row[RETAIL_MARKUP]]))
    expect(byBrand.get(1)).toBe(30)
    expect(byBrand.get(2)).toBe(30)
    expect(byBrand.get(3)).toBeNull()
    expect(byBrand.get(4)).toBeNull()
    expect(plan.reports.retailMarkupUnclear).toEqual([
      { brand: 'SPLIT HOUSE', rows: 20, largest_share: 0.5 },
      { brand: 'ONE ROW', rows: 1, largest_share: 1 },
    ])
  })

  it('fills a blank and keeps a saved value, like every other figure', () => {
    const plan = planParametersBackfill(
      { ...sources, existing: [{ brand_id: 1, [RETAIL_MARKUP]: null }, { brand_id: 2, [RETAIL_MARKUP]: '40' }] },
      { on: '2026-09-28' }
    )
    expect(plan.fills).toEqual([expect.objectContaining({ brand_id: 1, [RETAIL_MARKUP]: 30 })])
    expect(plan.changes.find((line) => line.brand_id === 2 && line.field === RETAIL_MARKUP)).toMatchObject({ from: 40, to: 30, kind: 'kept' })
  })
})

describe('the "Markup to Trade %" export', () => {
  const COLUMNS = [
    ['atelier_productpricesid', '(Do Not Modify) Product Prices'],
    ['checksumLogicalName', '(Do Not Modify) Row Checksum'],
    ['modifiedon', '(Do Not Modify) Modified On'],
    ['atelier_description', 'Description'],
    ['atelier_manualmarkuptotrade', 'Markup to Trade %'],
    ['atelier_code', 'Code'],
    ['fulmxero_trackingoption1id', 'Range'],
  ]
  const G = (n) => `00000000-0000-4000-9200-${String(n).padStart(12, '0')}`
  const book = (rows) => d365Workbook(rows, { entity: 'atelier_productprices', columns: COLUMNS })

  it('is told apart from the prices export, and reads a markup or a blank for each record', () => {
    const file = book([
      [G(1), 'c==', 46055.2, 'Allura full hide', '70', 'Allura 1 hide', 'GARRETT LEATHER'],
      [G(2), 'c==', 46055.2, 'ELLA STRIPE', '', 'ELLA STRIPE', 'MADEAUX'],
    ])
    expect(isMarkupExport(file)).toBe(true)
    expect(readProductMarkupsWorkbook(file).rows).toEqual([
      { guid: G(1), trade_markup_percent: 70 },
      { guid: G(2), trade_markup_percent: null },
    ])
  })

  it('refuses a row it cannot read, naming it', () => {
    let refusal
    try {
      readProductMarkupsWorkbook(book([[G(1), 'c==', 46055.2, 'X', 'seventy', 'X1', 'R'], ['not-a-guid', 'c==', 46055.2, 'Y', '50', 'Y1', 'R']]))
    } catch (error) {
      refusal = error
    }
    expect(refusal.statusCode).toBe(422)
    expect(refusal.errors).toEqual([expect.stringMatching(/row 2 \(X1\): markup to trade/), 'row 3 (Y1): no Dynamics record id'])
  })
})
