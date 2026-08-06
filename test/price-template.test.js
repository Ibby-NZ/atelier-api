import { describe, it, expect } from 'vitest'
import {
  TEMPLATES, mapV1, matchTemplate, normaliseHeader, acceptedHeaders,
} from '../scripts/lib/price-template.js'

// The pricing-template registry is pure: no database, no fixtures on disk.
// v1's mapper was MOVED here from the converter, not rewritten — the committed
// src/seed/data/price-lists.json was produced by it, so a change to what it
// emits (key order included) is an 8 MB diff rather than a bug report.

const V1_HEADER = [
  'Date Effective', 'Product Range', 'Code', 'Description', 'Item Type',
  'Pack Type', 'Contents', 'Width', 'Repeat', 'Vertical Repeat',
  'Duty Rate', 'Wholesale Rate', 'Currency', 'Freight Rate',
]

const V1_ROW = [
  '1/07/2025', 'ATLAS', 'F3518-003', 'Atlas Velvet', 'Fabrics', 'p/m', '100% Linen',
  '140', '64', '256.60000000000002', 'A', '65.5', 'Euro', 'B',
]

const V1_KEYS = [
  'supplier', 'product_range', 'category', 'code', 'code_normalized', 'description',
  'contents', 'unit', 'width', 'repeat', 'vertical_repeat', 'duty_class',
  'wholesale_rate', 'currency', 'freight_class', 'date_effective', 'source_file',
]

const contextOf = (overrides = {}) => ({
  lineNumber: 2,
  source: 'PIERRE FREY PL.csv',
  supplier: 'Pierre Frey',
  fileCategory: null,
  isXlsx: false,
  errors: [],
  skipped: [],
  ...overrides,
})

describe('template registry', () => {
  it('is frozen, so no caller can add a template at runtime', () => {
    expect(Object.isFrozen(TEMPLATES)).toBe(true)
    for (const template of TEMPLATES) expect(Object.isFrozen(template)).toBe(true)
  })

  it('declares each version as { version, header, map }', () => {
    for (const template of TEMPLATES) {
      expect(typeof template.version).toBe('string')
      expect(Array.isArray(template.header)).toBe(true)
      expect(typeof template.map).toBe('function')
    }
    expect(TEMPLATES.map((template) => template.version)).toContain('v1')
  })

  it('keeps v1 as the fourteen columns every existing drop carries', () => {
    const v1 = TEMPLATES.find((template) => template.version === 'v1')
    expect(v1.header).toEqual(normaliseHeader(V1_HEADER))
    expect(v1.map).toBe(mapV1)
  })
})

describe('matchTemplate', () => {
  it('matches the v1 header a real drop carries', () => {
    expect(matchTemplate(V1_HEADER).version).toBe('v1')
  })

  it('normalises case and collapses whitespace before matching', () => {
    const messy = V1_HEADER.map((label) => `  ${label.toUpperCase()}  `)
    messy[9] = 'Vertical\t Repeat'
    expect(matchTemplate(messy).version).toBe('v1')
  })

  it('ignores trailing empty cells — a blank cell declares no column', () => {
    expect(matchTemplate([...V1_HEADER, '', '   ']).version).toBe('v1')
  })

  it('refuses a header with a column missing', () => {
    expect(matchTemplate(V1_HEADER.slice(0, 13))).toBe(null)
  })

  it('refuses a longer header rather than reading its first columns', () => {
    // This is the whole point of matching on length: a superset template must
    // never be mistaken for the one whose columns it starts with.
    expect(matchTemplate([...V1_HEADER, 'Supplier'])).toBe(null)
  })

  it('refuses a header whose labels are right but reordered', () => {
    const swapped = [...V1_HEADER]
    swapped[2] = V1_HEADER[3]
    swapped[3] = V1_HEADER[2]
    expect(matchTemplate(swapped)).toBe(null)
  })

  it('lists every accepted header, so a mismatch says what was expected', () => {
    expect(acceptedHeaders()).toHaveLength(TEMPLATES.length)
    for (const template of TEMPLATES) {
      const line = acceptedHeaders().find((entry) => entry.startsWith(`${template.version} `))
      expect(line).toContain(JSON.stringify(template.header))
    }
  })
})

describe('mapV1', () => {
  it('emits the committed key order — the file is byte-pinned to it', () => {
    expect(Object.keys(mapV1(V1_ROW, contextOf()))).toEqual(V1_KEYS)
  })

  it('normalises the messy cells the way the committed rows were produced', () => {
    expect(mapV1(V1_ROW, contextOf())).toEqual({
      supplier: 'Pierre Frey',
      product_range: 'ATLAS',
      category: 'fabric',
      code: 'F3518-003',
      code_normalized: 'F3518-003',
      description: 'Atlas Velvet',
      contents: '100% Linen',
      unit: 'metre',
      width: '140',
      repeat: '64',
      vertical_repeat: '256.6', // float noise collapsed, not rounded to a number
      duty_class: 'A',
      wholesale_rate: 65.5,
      currency: 'EUR',
      freight_class: 'B',
      date_effective: '2025-07-01',
      source_file: 'PIERRE FREY PL.csv',
    })
  })

  it('reads an Excel serial date only for an xlsx source', () => {
    const row = [...V1_ROW]
    row[0] = '45870'
    expect(mapV1(row, contextOf({ isXlsx: true })).date_effective).toBe('2025-08-01')
  })

  it('falls back to the filename category when the item type is blank', () => {
    const row = [...V1_ROW]
    row[4] = ''
    expect(mapV1(row, contextOf({ fileCategory: 'wallpaper' })).category).toBe('wallpaper')
  })

  it('leaves empty optional cells null rather than empty strings', () => {
    const row = [...V1_ROW]
    row[1] = ''
    row[6] = ''
    row[8] = ''
    row[10] = ''
    row[13] = ''
    const item = mapV1(row, contextOf())
    expect(item.product_range).toBe(null)
    expect(item.contents).toBe(null)
    expect(item.repeat).toBe(null)
    expect(item.duty_class).toBe(null)
    expect(item.freight_class).toBe(null)
  })

  it('reports every unmappable cell as file:line and writes no row', () => {
    const cases = [
      [4, 'Soft Furnishings', /unmappable item type/],
      [5, 'p/box', /unmappable pack type/],
      [12, 'Yen', /unmappable currency/],
      [13, 'Z', /unknown freight class/],
      [10, 'Q', /unknown duty class/],
      [2, '', /empty code/],
      [11, '65,50', /non-numeric wholesale rate/],
      [11, '-3', /negative wholesale rate/],
      [0, '31/02/2025', /bad date/],
    ]
    for (const [index, value, pattern] of cases) {
      const row = [...V1_ROW]
      row[index] = value
      const context = contextOf()
      expect(mapV1(row, context)).toBe(null)
      expect(context.errors).toHaveLength(1)
      expect(context.errors[0]).toMatch(/^PIERRE FREY PL\.csv:2: /)
      expect(context.errors[0]).toMatch(pattern)
    }
  })

  it('skips an unpriced row instead of failing the whole run', () => {
    const row = [...V1_ROW]
    row[11] = '0'
    const context = contextOf()
    expect(mapV1(row, context)).toBe(null)
    expect(context.errors).toEqual([])
    expect(context.skipped[0]).toMatch(/has no wholesale rate/)
  })
})
