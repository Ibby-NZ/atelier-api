// The category workbooks' pure half. The corpus they actually run over lives in
// `incoming/` (gitignored, main checkout only), so nothing here reads it — these
// are hand-made rows shaped like the D365 exports, which is also what lets the
// suite run in CI at all.
import { describe, expect, it } from 'vitest'
import { buildCategorySheets, codeVersion, DATASETS, FILTERS } from '../scripts/export-category-sheets.js'
import { CATEGORIES } from '../scripts/lib/price-template.js'

const stockRow = (over = {}) => ({
  guid: 'g-1',
  range_name: 'ALPAKA',
  item_code: 'PL100',
  name: 'Plaid Exclusive',
  supplier: 'Alpaka SRL',
  item_type: 'Fabrics',
  item_measure: 'P/M',
  stock_on_hand: 0,
  stock_available: 0,
  status: 'Active',
  ...over,
})

describe('the stock filters', () => {
  const active = FILTERS['--active'].keep
  const inStock = FILTERS['--in-stock'].keep

  it('keeps Active and drops Inactive', () => {
    expect(active(stockRow())).toBe(true)
    expect(active(stockRow({ status: 'Inactive' }))).toBe(false)
  })

  it('counts an item held but committed as in stock', () => {
    // available 0 with 5 on hand is stock somebody still has to categorise; an
    // AND here would drop it, which is why the rule is OR.
    expect(inStock(stockRow({ stock_on_hand: 5, stock_available: 0 }))).toBe(true)
    expect(inStock(stockRow({ stock_on_hand: 0, stock_available: 3 }))).toBe(true)
    expect(inStock(stockRow())).toBe(false)
  })

  it('treats an absent quantity as no stock, not as NaN', () => {
    expect(inStock(stockRow({ stock_on_hand: null, stock_available: undefined }))).toBe(false)
  })

  it('is declared by the dataset, so prices cannot be filtered by any of them', () => {
    expect(DATASETS.prices.filters).toEqual([])
    expect(DATASETS.stock.filters).toEqual(['--active', '--in-stock', '--latest'])
  })
})

describe('codeVersion', () => {
  it('reads the pricing year and supplier token off a stock code', () => {
    expect(codeVersion('F3518-003 23PF', 26)).toEqual({ base: 'F3518-003', year: 23, token: 'PF' })
    expect(codeVersion('2104 21TR', 26)).toEqual({ base: '2104', year: 21, token: 'TR' })
  })

  it('reads a code with no suffix as unversioned', () => {
    expect(codeVersion('CUSH*SPEC40X40', 26)).toBeNull()
    expect(codeVersion('FLYISHOLI', 26)).toBeNull()
  })

  it('does NOT read a size as a year', () => {
    // Live rows, and the reason the token must be letters: "CUSH**MDC 55X55" has
    // 40 on hand. Reading 55 as a year supersedes real stock off the sheet.
    expect(codeVersion('CUSH**MDC 55X55', 26)).toBeNull()
    expect(codeVersion('CUSH**WDL 60X60', 26)).toBeNull()
    expect(codeVersion('CLASSY ORGANIC Bath towel 76X142', 26)).toBeNull()
  })

  it('refuses a year outside the window, and the window ends at THIS year', () => {
    expect(codeVersion('X 40CM', 26)).toBeNull() // 2040 is not a pricing year
    expect(codeVersion('X 09AB', 26)).toBeNull() // before the corpus begins
    expect(codeVersion('X 27AB', 26)).toBeNull() // next year, from this year
    expect(codeVersion('X 27AB', 27)).toEqual({ base: 'X', year: 27, token: 'AB' })
  })
})

describe('the --latest filter', () => {
  const select = FILTERS['--latest'].select
  const codes = (records) => select(records).map((r) => r.item_code).sort()

  it('keeps the newest year per colour code and drops the rest', () => {
    expect(
      codes([
        stockRow({ item_code: 'S508 20GA' }),
        stockRow({ item_code: 'S508 23GA' }),
        stockRow({ item_code: 'S508 21GA' }),
      ])
    ).toEqual(['S508 23GA'])
  })

  it('collapses a product whose supplier token moved, because the house did', () => {
    // Colefax & Fowler and Jane Churchill are one supplier: F4685-05 is the same
    // Albeck 05 Beige as 22CF, 24JC and 26CF. Grouping by base+token would keep
    // all three, which is the older versions this filter exists to drop.
    expect(
      codes([
        stockRow({ item_code: 'F4685-05 22CF' }),
        stockRow({ item_code: 'F4685-05 24JC' }),
        stockRow({ item_code: 'F4685-05 26CF' }),
      ])
    ).toEqual(['F4685-05 26CF'])
  })

  it('keeps every code that carries no year', () => {
    const rows = [stockRow({ item_code: 'CUSH*SPEC40X40' }), stockRow({ item_code: 'FLYISHOLI' })]
    expect(codes(rows)).toEqual(['CUSH*SPEC40X40', 'FLYISHOLI'])
  })

  it('NEVER drops a superseded row that still holds stock', () => {
    // The one failure here that costs money rather than time: hiding stock on
    // the shelf behind an old code.
    expect(
      codes([
        stockRow({ item_code: 'A1 20TR', stock_on_hand: 6 }),
        stockRow({ item_code: 'A1 25TR' }),
        stockRow({ item_code: 'B2 20TR', stock_available: 2 }),
        stockRow({ item_code: 'B2 25TR' }),
        stockRow({ item_code: 'C3 20TR' }),
        stockRow({ item_code: 'C3 25TR' }),
      ])
    ).toEqual(['A1 20TR', 'A1 25TR', 'B2 20TR', 'B2 25TR', 'C3 25TR'])
  })

  it('does not confuse two different bases', () => {
    expect(codes([stockRow({ item_code: 'A 20TR' }), stockRow({ item_code: 'B 19TR' })])).toEqual([
      'A 20TR',
      'B 19TR',
    ])
  })
})

describe('buildCategorySheets', () => {
  const records = [
    stockRow({ guid: 'g-1', range_name: 'ZEBRA', item_code: 'B', item_type: 'W/P' }),
    stockRow({ guid: 'g-2', range_name: 'ALPAKA', item_code: 'A', stock_on_hand: 4 }),
    // 'Leather' is one of the types the vocabulary still has no word for —
    // Towels stopped being one when CATEGORIES grew to nine.
    stockRow({ guid: 'g-3', range_name: undefined, item_code: 'C', item_type: 'Leather' }),
  ]

  it('puts every row on the All tab and again on its house tab', () => {
    const [all, ...houses] = buildCategorySheets(DATASETS.stock, records)
    expect(all.name).toBe('All Stock')
    expect(all.rows).toHaveLength(4) // header + 3
    expect(houses.map((sheet) => sheet.name)).toEqual(['(No house)', 'ALPAKA', 'ZEBRA'])
    expect(houses.reduce((total, sheet) => total + sheet.rows.length - 1, 0)).toBe(records.length)
  })

  it('maps a row to the header, quantities as numbers and Category blank', () => {
    const [all] = buildCategorySheets(DATASETS.stock, [records[1]])
    expect(DATASETS.stock.header).toEqual([
      'GUID', 'Range', 'Item Code', 'Name', 'Supplier', 'Item Type', 'Measure',
      'On Hand', 'Available', 'Status', 'Suggested Category', 'Category',
    ])
    expect(all.rows[1]).toEqual([
      'g-2', 'ALPAKA', 'A', 'Plaid Exclusive', 'Alpaka SRL', 'Fabrics', 'P/M',
      4, 0, 'Active', 'fabric', '',
    ])
  })

  it('suggests nothing for an item type the vocabulary has no word for', () => {
    const [all] = buildCategorySheets(DATASETS.stock, [records[2]])
    expect(all.rows[1][10]).toBe('') // Leather
  })

  it('leaves a missing quantity null rather than 0', () => {
    const [all] = buildCategorySheets(DATASETS.stock, [stockRow({ stock_on_hand: null })])
    expect(all.rows[1][7]).toBeNull()
  })

  it('--one-sheet drops the house tabs and keeps every row', () => {
    const sheets = buildCategorySheets(DATASETS.stock, records, { oneSheet: true })
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows).toHaveLength(4)
  })

  it('puts the dropdown on the Category column, spanning the data rows only', () => {
    const [all] = buildCategorySheets(DATASETS.stock, records)
    expect(all.validations[0].ref).toBe('L2:L4')
    // The stored vocabulary, not a copy of it: the dropdown's whole job is to
    // make an unstorable category a value the office cannot type, which a
    // hand-maintained list stops doing the day the vocabulary grows.
    expect(all.validations[0].values).toEqual([...CATEGORIES])
  })

  it('gives an empty sheet no dropdown, because L2:L1 is not a range', () => {
    const [all] = buildCategorySheets(DATASETS.stock, [])
    expect(all.rows).toHaveLength(1)
    expect(all.validations).toEqual([])
  })
})
