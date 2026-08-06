import { describe, it, expect } from 'vitest'
import {
  TEMPLATES, mapV1, mapV2, matchTemplate, normaliseHeader, acceptedHeaders,
  CATEGORIES, UNITS, CURRENCIES, CATEGORY_BY_ITEM_TYPE, UNIT_BY_PACK, CURRENCY_MAP,
  assertStorable, isClassLetter,
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

// v2 is v1 plus four appended columns — same fourteen first, same order.
const V2_HEADER = [...V1_HEADER, 'Supplier', 'Brand', 'Pattern Match', 'Duty Percent']

const V2_ROW = [...V1_ROW, 'Pierre Frey Paris', 'Braquenié', 'V x 70H', '7.5']

const V2_KEYS = [...V1_KEYS, 'brand_name', 'pattern_match', 'duty_percent', 'template_version']

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

describe('shared vocabularies', () => {
  it('stores exactly the values the column CHECKs accept', () => {
    expect([...CATEGORIES]).toEqual(['fabric', 'wallpaper', 'trimming', 'accessory'])
    expect([...UNITS]).toEqual(['metre', 'yard', 'roll', 'piece', 'hide', 'panel'])
    expect([...CURRENCIES]).toEqual(['EUR', 'USD', 'GBP'])
  })

  it.each([
    ['item type', CATEGORY_BY_ITEM_TYPE, CATEGORIES],
    ['pack type', UNIT_BY_PACK, UNITS],
    ['currency', CURRENCY_MAP, CURRENCIES],
  ])('maps every %s cell onto a stored value', (what, map, stored) => {
    expect(() => assertStorable(map, stored, what)).not.toThrow()
  })

  it('refuses an input map that reaches outside the stored set', () => {
    // The guard that stops an alias quietly widening storage: adding
    // ['yen', 'JPY'] would pass the converter and fail the column CHECK.
    const rogue = new Map([...CURRENCY_MAP, ['yen', 'JPY']])
    expect(() => assertStorable(rogue, CURRENCIES, 'currency')).toThrow(/"JPY"/)
  })

  it('accepts p/hide and p/panel, units the CHECK has always allowed', () => {
    expect(UNIT_BY_PACK.get('p/hide')).toBe('hide')
    expect(UNIT_BY_PACK.get('p/panel')).toBe('panel')
  })

  it('takes an ISO currency code as an input alias for the long name', () => {
    for (const [alias, name] of [['eur', 'euro'], ['usd', 'us dollar'], ['gbp', 'pound sterling']]) {
      expect(CURRENCY_MAP.get(alias)).toBe(CURRENCY_MAP.get(name))
    }
    // Input aliases only — the stored set is not widened by them.
    expect(new Set(CURRENCY_MAP.values())).toEqual(CURRENCIES)
  })

  it('leaves every previously mapped cell mapping to what it always did', () => {
    // The byte-pin argument for adding aliases, asserted rather than reasoned:
    // the new keys are new, so no cell that used to map changes meaning.
    expect(CURRENCY_MAP.get('euro')).toBe('EUR')
    expect(CURRENCY_MAP.get('us dollar')).toBe('USD')
    expect(CURRENCY_MAP.get('pound sterling')).toBe('GBP')
    expect(UNIT_BY_PACK.get('p/m')).toBe('metre')
    expect(UNIT_BY_PACK.get('p/y')).toBe('yard')
    expect(UNIT_BY_PACK.get('p/roll')).toBe('roll')
    expect(UNIT_BY_PACK.get('p/p')).toBe('piece')
  })

  it.each(['A', 'E', 'F', 'Z'])('treats %s as a class letter', (letter) => {
    expect(isClassLetter(letter)).toBe(true)
  })

  it.each(['a', 'AB', '1', '', null, undefined, 5])('refuses %j as a class letter', (value) => {
    expect(isClassLetter(value)).toBe(false)
  })
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

  it('declares v2 as a strict superset — v1 first, then the four new columns', () => {
    const v2 = TEMPLATES.find((template) => template.version === 'v2')
    expect(v2.header).toEqual(normaliseHeader(V2_HEADER))
    expect(v2.header.slice(0, V1_HEADER.length)).toEqual(normaliseHeader(V1_HEADER))
    expect(v2.header.slice(V1_HEADER.length))
      .toEqual(['supplier', 'brand', 'pattern match', 'duty percent'])
    expect(v2.map).toBe(mapV2)
  })
})

describe('matchTemplate', () => {
  it('matches the v1 header a real drop carries', () => {
    expect(matchTemplate(V1_HEADER).version).toBe('v1')
  })

  it('matches the v2 header, and never mistakes it for v1', () => {
    expect(matchTemplate(V2_HEADER).version).toBe('v2')
  })

  it('refuses a header that is v1 plus SOME of v2 — a half-migrated file', () => {
    expect(matchTemplate([...V1_HEADER, 'Supplier', 'Brand'])).toBe(null)
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
      [13, 'ZZ', /unknown freight class/],
      [10, 'Q1', /unknown duty class/],
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

  it.each([
    ['p/hide', 'hide'],
    ['p/panel', 'panel'],
  ])('maps the %s pack type onto %s', (pack, unit) => {
    const row = [...V1_ROW]
    row[5] = pack
    expect(mapV1(row, contextOf()).unit).toBe(unit)
  })

  it.each([['EUR', 'EUR'], ['usd', 'USD'], ['GBP', 'GBP']])(
    'reads the ISO code %s as the currency %s',
    (cell, stored) => {
      const row = [...V1_ROW]
      row[12] = cell
      expect(mapV1(row, contextOf()).currency).toBe(stored)
    }
  )

  it.each([['F', 'Z'], ['Z', 'B']])(
    'takes any single uppercase letter as a class (freight %s, duty %s)',
    (freight, duty) => {
      // The letters stay raw and uninterpreted; the broker's table is still
      // owed, so refusing an 'F' would reject the client's own file.
      const row = [...V1_ROW]
      row[13] = freight
      row[10] = duty
      const item = mapV1(row, contextOf())
      expect(item.freight_class).toBe(freight)
      expect(item.duty_class).toBe(duty)
    }
  )

  it('skips an unpriced row instead of failing the whole run', () => {
    const row = [...V1_ROW]
    row[11] = '0'
    const context = contextOf()
    expect(mapV1(row, context)).toBe(null)
    expect(context.errors).toEqual([])
    expect(context.skipped[0]).toMatch(/has no wholesale rate/)
  })

  it('omits every v2-only key rather than writing it as null', () => {
    // Nulls here would grow all 19.5k committed records and make the next
    // regeneration a total diff — the omission is the point, not an oversight.
    const item = mapV1(V1_ROW, contextOf())
    for (const key of ['brand_name', 'pattern_match', 'duty_percent', 'template_version']) {
      expect(Object.hasOwn(item, key)).toBe(false)
    }
  })

  it('reads only the first fourteen cells, so a v2 row maps identically', () => {
    expect(mapV1(V2_ROW, contextOf())).toEqual(mapV1(V1_ROW, contextOf()))
  })
})

describe('mapV2', () => {
  it('emits v1 keys first, then the four appended ones', () => {
    expect(Object.keys(mapV2(V2_ROW, contextOf()))).toEqual(V2_KEYS)
  })

  it('lets the Supplier cell win over the filename', () => {
    expect(mapV2(V2_ROW, contextOf()).supplier).toBe('Pierre Frey Paris')
  })

  it('falls back to the filename supplier when the cell is blank', () => {
    const row = [...V2_ROW]
    row[14] = ''
    expect(mapV2(row, contextOf()).supplier).toBe('Pierre Frey')
  })

  it('fails the row when neither the cell nor the filename names a supplier', () => {
    const row = [...V2_ROW]
    row[14] = ''
    const context = contextOf({ supplier: null })
    expect(mapV2(row, context)).toBe(null)
    expect(context.errors[0]).toMatch(/^PIERRE FREY PL\.csv:2: empty supplier/)
  })

  it('maps the shared fourteen columns exactly as v1 does', () => {
    const { brand_name, pattern_match, duty_percent, template_version, ...shared }
      = mapV2(V2_ROW, contextOf())
    expect(shared).toEqual({ ...mapV1(V1_ROW, contextOf()), supplier: 'Pierre Frey Paris' })
    expect({ brand_name, pattern_match, duty_percent, template_version }).toEqual({
      brand_name: 'Braquenié',
      pattern_match: 'V x 70H',
      duty_percent: 7.5,
      template_version: 'v2',
    })
  })

  it('records the version the header declared, never a cell', () => {
    expect(mapV2(V2_ROW, contextOf()).template_version).toBe('v2')
  })

  it('leaves the new optional cells null rather than empty strings', () => {
    const row = [...V2_ROW]
    row[15] = ''
    row[16] = ''
    row[17] = ''
    const item = mapV2(row, contextOf())
    expect(item.brand_name).toBe(null)
    expect(item.pattern_match).toBe(null)
    expect(item.duty_percent).toBe(null)
  })

  it('rounds duty percent to the column scale, so JSON and database agree', () => {
    const row = [...V2_ROW]
    row[17] = '7.12345'
    expect(mapV2(row, contextOf()).duty_percent).toBe(7.123)
  })

  it('reports a non-numeric duty percent as file:line and writes no row', () => {
    const row = [...V2_ROW]
    row[17] = '7%'
    const context = contextOf()
    expect(mapV2(row, context)).toBe(null)
    expect(context.errors[0]).toMatch(/^PIERRE FREY PL\.csv:2: non-numeric duty percent "7%"/)
  })

  it('keeps every v1 row-level rule, reported once', () => {
    const row = [...V2_ROW]
    row[12] = 'Yen'
    const context = contextOf()
    expect(mapV2(row, context)).toBe(null)
    expect(context.errors).toHaveLength(1)
    expect(context.errors[0]).toMatch(/unmappable currency/)
  })

  it('skips an unpriced v2 row the way v1 does', () => {
    const row = [...V2_ROW]
    row[11] = '0'
    const context = contextOf()
    expect(mapV2(row, context)).toBe(null)
    expect(context.errors).toEqual([])
    expect(context.skipped[0]).toMatch(/has no wholesale rate/)
  })
})
