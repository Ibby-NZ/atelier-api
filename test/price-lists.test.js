import { readFile } from 'node:fs/promises'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { importPriceLists, validatePriceListItems } from '../src/seed/price-lists.js'

const SUPPLIER = 'PL Test Supplier'

const item = (overrides = {}) => ({
  supplier: SUPPLIER,
  product_range: 'PL Test Range',
  category: 'fabric',
  code: 'PLT-001',
  code_normalized: 'PLT-001',
  description: 'Test Weave',
  contents: '100% Linen',
  unit: 'metre',
  width: '140',
  repeat: '0',
  vertical_repeat: '32',
  duty_class: null,
  wholesale_rate: 65,
  currency: 'EUR',
  freight_class: 'A',
  date_effective: '2026-02-18',
  source_file: 'PL TEST FABRIC PL 2026.csv',
  ...overrides,
})

const countRows = async (pool) => {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM price_list_items WHERE supplier = $1', [
    SUPPLIER,
  ])
  return rows[0].n
}

describe('price list import', () => {
  let pool

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
    await pool.query('DELETE FROM price_list_items WHERE supplier = $1', [SUPPLIER])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM price_list_items WHERE supplier = $1', [SUPPLIER])
    await pool.end()
  })

  it('inserts items and reports a summary', async () => {
    const summary = await importPriceLists(pool, [
      item(),
      item({ code: 'PLT-002', category: 'wallpaper', unit: 'roll', wholesale_rate: 49.14 }),
    ])
    expect(summary.items).toBe(2)
    expect(summary.suppliers).toBe(1)
    expect(await countRows(pool)).toBe(2)
  })

  it('is idempotent on re-import', async () => {
    await importPriceLists(pool, [item(), item({ code: 'PLT-002', category: 'wallpaper', unit: 'roll' })])
    expect(await countRows(pool)).toBe(2)
  })

  it('updates the stored price when a re-import carries a new rate', async () => {
    await importPriceLists(pool, [item({ wholesale_rate: 72.5, freight_class: 'B' })])
    const { rows } = await pool.query(
      'SELECT wholesale_rate, freight_class FROM price_list_items WHERE supplier = $1 AND category = $2 AND code = $3',
      [SUPPLIER, 'fabric', 'PLT-001']
    )
    expect(Number(rows[0].wholesale_rate)).toBe(72.5)
    expect(rows[0].freight_class).toBe('B')
  })

  it('keeps the same code in different categories as separate rows', async () => {
    await importPriceLists(pool, [
      item({ code: 'PLT-SHARED' }),
      item({ code: 'PLT-SHARED', category: 'trimming', unit: 'yard', wholesale_rate: 8.1 }),
    ])
    const { rows } = await pool.query(
      'SELECT category FROM price_list_items WHERE supplier = $1 AND code = $2 ORDER BY category',
      [SUPPLIER, 'PLT-SHARED']
    )
    expect(rows.map((r) => r.category)).toEqual(['fabric', 'trimming'])
  })

  it('rejects invalid items and inserts nothing from the batch', async () => {
    const before = await countRows(pool)
    await expect(
      importPriceLists(pool, [item({ code: 'PLT-BAD-1' }), item({ code: 'PLT-BAD-2', category: 'sofa' })])
    ).rejects.toThrow(/category/)
    expect(await countRows(pool)).toBe(before)
  })

  it.each([
    ['empty code', { code: '   ' }, /code/],
    ['missing normalized code', { code_normalized: null }, /code_normalized/],
    ['zero price', { wholesale_rate: 0 }, /wholesale_rate/],
    ['negative price', { wholesale_rate: -5 }, /wholesale_rate/],
    ['unknown currency', { currency: 'NZD' }, /currency/],
    ['unknown unit', { unit: 'bolt' }, /unit/],
    ['a multi-character freight class', { freight_class: 'AB' }, /freight_class/],
    ['a lower-case duty class', { duty_class: 'a' }, /duty_class/],
  ])('validation rejects %s', (_label, overrides, pattern) => {
    expect(() => validatePriceListItems([item(overrides)])).toThrow(pattern)
  })

  it.each(['A', 'E', 'F', 'Z'])('validation accepts %s as a class letter', (letter) => {
    // The validator used to stop at 'E' for freight and at 'A' for duty, long
    // after the column CHECKs widened to any single uppercase letter.
    expect(() => validatePriceListItems([item({ freight_class: letter, duty_class: letter })]))
      .not.toThrow()
  })

  it('validates against the converter vocabularies, so hide and panel units pass', () => {
    expect(() => validatePriceListItems([
      item({ code: 'PLT-HIDE', unit: 'hide' }),
      item({ code: 'PLT-PANEL', unit: 'panel' }),
    ])).not.toThrow()
  })

  it('imports a freight class the old set would have rejected', async () => {
    // End to end: validator and column CHECK now agree on the same shape.
    await importPriceLists(pool, [item({ code: 'PLT-CLASS', freight_class: 'F', duty_class: 'B' })])
    const { rows } = await pool.query(
      'SELECT freight_class, duty_class FROM price_list_items WHERE supplier = $1 AND code = $2',
      [SUPPLIER, 'PLT-CLASS']
    )
    expect(rows[0]).toEqual({ freight_class: 'F', duty_class: 'B' })
  })
})

const V2_SUPPLIER = 'PL Template Test Supplier'

// Raw SQL rather than importPriceLists: the importer does not write the v2
// columns yet (that is a later story), and these assertions are about the
// schema the migration left behind.
const RAW_INSERT = `
  INSERT INTO price_list_items
    (supplier, category, code, code_normalized, unit, wholesale_rate, currency, source_file,
     freight_class, duty_class, brand_name, pattern_match, duty_percent)
  VALUES ($1, 'fabric', $2, $2, 'metre', 42, 'EUR', 'PL TEMPLATE TEST.csv', $3, $4, $5, $6, $7)
  RETURNING *`

describe('price_list_items template v2 columns', () => {
  let pool
  let config

  const insertRow = (code, overrides = {}) => {
    const row = {
      freight_class: null,
      duty_class: null,
      brand_name: null,
      pattern_match: null,
      duty_percent: null,
      ...overrides,
    }
    return pool.query(RAW_INSERT, [
      V2_SUPPLIER,
      code,
      row.freight_class,
      row.duty_class,
      row.brand_name,
      row.pattern_match,
      row.duty_percent,
    ])
  }

  beforeAll(async () => {
    config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
    await pool.query('DELETE FROM price_list_items WHERE supplier = $1', [V2_SUPPLIER])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM price_list_items WHERE supplier = $1', [V2_SUPPLIER])
    await pool.end()
  })

  it('re-running the migrations is a no-op', async () => {
    const applied = await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
    expect(applied).toEqual([])
  })

  it('defaults template_version to v1 and writes no duty or freight placeholder', async () => {
    const { rows } = await insertRow('PLT-V2-DEFAULT')
    expect(rows[0].template_version).toBe('v1')
    expect(rows[0].duty_percent).toBeNull()
    expect(rows[0].duty_class).toBeNull()
    expect(rows[0].freight_class).toBeNull()
  })

  it('stores brand_name, pattern_match and duty_percent', async () => {
    const { rows } = await insertRow('PLT-V2-FIELDS', {
      // A house spelling that matches no `brands` row — brand_name is text, not
      // an FK, precisely so a naming difference cannot fail a whole import.
      brand_name: 'Colefax and Fowler (no such brands row)',
      pattern_match: 'V x 70H',
      duty_percent: 7.125,
    })
    expect(rows[0].brand_name).toBe('Colefax and Fowler (no such brands row)')
    expect(rows[0].pattern_match).toBe('V x 70H')
    expect(Number(rows[0].duty_percent)).toBe(7.125)
  })

  it.each([
    ['freight_class', 'F'],
    ['freight_class', 'Z'],
    ['duty_class', 'B'],
    ['duty_class', 'Z'],
  ])('accepts any single uppercase letter as %s (%s)', async (field, letter) => {
    const { rows } = await insertRow(`PLT-V2-OK-${field}-${letter}`, { [field]: letter })
    expect(rows[0][field]).toBe(letter)
  })

  it.each([
    ['freight_class', 'a'],
    ['freight_class', 'AB'],
    ['freight_class', '1'],
    ['duty_class', 'a'],
    ['duty_class', 'AB'],
    ['duty_class', ''],
  ])('rejects %s %j', async (field, value) => {
    await expect(insertRow(`PLT-V2-BAD-${field}-${value}`, { [field]: value })).rejects.toThrow(
      new RegExp(`price_list_items_${field}_check`)
    )
  })
})

const IMPORT_SUPPLIER = 'PL Import V2 Supplier'

// What mapV2 emits on top of a v1 row. Kept as a spread so the v1 case below is
// literally "the same item without these keys", which is the whole contract.
const V2_FIELDS = {
  brand_name: 'Pattern House',
  pattern_match: 'V x 70H',
  duty_percent: 7.125,
  template_version: 'v2',
}

describe('price list import — v2 fields', () => {
  let pool

  const v1Item = (overrides = {}) => item({ supplier: IMPORT_SUPPLIER, ...overrides })
  const v2Item = (overrides = {}) => v1Item({ ...V2_FIELDS, ...overrides })

  const readRow = async (code) => {
    const { rows } = await pool.query(
      `SELECT brand_name, pattern_match, duty_percent, template_version, wholesale_rate
       FROM price_list_items WHERE supplier = $1 AND category = 'fabric' AND code = $2`,
      [IMPORT_SUPPLIER, code]
    )
    return rows[0]
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
    await pool.query('DELETE FROM price_list_items WHERE supplier = $1', [IMPORT_SUPPLIER])
  })

  afterAll(async () => {
    await pool.query('DELETE FROM price_list_items WHERE supplier = $1', [IMPORT_SUPPLIER])
    await pool.end()
  })

  it('defaults template_version for a v1 item that carries no such key', async () => {
    // The COALESCE this story exists for: unnest binds an explicit NULL for the
    // missing key, which would defeat the column DEFAULT and violate NOT NULL.
    await importPriceLists(pool, [v1Item({ code: 'PLI-V1' })])
    const row = await readRow('PLI-V1')
    expect(row.template_version).toBe('v1')
    expect(row.brand_name).toBeNull()
    expect(row.pattern_match).toBeNull()
    expect(row.duty_percent).toBeNull()
  })

  it('stores the four v2 fields', async () => {
    await importPriceLists(pool, [v2Item({ code: 'PLI-V2' })])
    const row = await readRow('PLI-V2')
    expect(row.brand_name).toBe('Pattern House')
    expect(row.pattern_match).toBe('V x 70H')
    expect(Number(row.duty_percent)).toBe(7.125)
    expect(row.template_version).toBe('v2')
  })

  it('imports v1 and v2 items together in one batch', async () => {
    // One unnest binds both, so a mixed drop is where a missing-key NULL bites.
    await importPriceLists(pool, [v1Item({ code: 'PLI-MIX-1' }), v2Item({ code: 'PLI-MIX-2' })])
    expect((await readRow('PLI-MIX-1')).template_version).toBe('v1')
    expect((await readRow('PLI-MIX-2')).template_version).toBe('v2')
  })

  it('re-imports on the unchanged (supplier, category, code) key', async () => {
    await importPriceLists(pool, [v2Item({ code: 'PLI-RE' })])
    await importPriceLists(pool, [v2Item({ code: 'PLI-RE', wholesale_rate: 88.25, brand_name: 'Renamed House' })])
    const { rows } = await pool.query(
      'SELECT wholesale_rate, brand_name FROM price_list_items WHERE supplier = $1 AND code = $2',
      [IMPORT_SUPPLIER, 'PLI-RE']
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].wholesale_rate)).toBe(88.25)
    expect(rows[0].brand_name).toBe('Renamed House')
  })

  it('lets a later v1 file clear the v2 fields, as every other column already behaves', async () => {
    await importPriceLists(pool, [v2Item({ code: 'PLI-BACK' })])
    await importPriceLists(pool, [v1Item({ code: 'PLI-BACK' })])
    const row = await readRow('PLI-BACK')
    expect(row.template_version).toBe('v1')
    expect(row.brand_name).toBeNull()
    expect(row.duty_percent).toBeNull()
  })

  it.each([
    ['a non-string brand_name', { brand_name: 42 }, /brand_name/],
    ['a blank pattern_match', { pattern_match: '  ' }, /pattern_match/],
    ['a blank template_version', { template_version: '' }, /template_version/],
    ['a non-numeric duty_percent', { duty_percent: '7.125' }, /duty_percent/],
  ])('validation rejects %s', (_label, overrides, pattern) => {
    expect(() => validatePriceListItems([v2Item(overrides)])).toThrow(pattern)
  })

  it('accepts a template_version the importer has never heard of', () => {
    // The accepted set is the converter's registry, not this validator's — an
    // older API importing a newer converter's file must still store the row.
    expect(() => validatePriceListItems([v2Item({ template_version: 'v9' })])).not.toThrow()
  })
})

describe('universal price list file', () => {
  it('parses, validates and has no duplicate (supplier, category, code)', async () => {
    const raw = await readFile(new URL('../src/seed/data/price-lists.json', import.meta.url), 'utf8')
    const items = JSON.parse(raw)
    expect(items.length).toBeGreaterThan(18000)
    validatePriceListItems(items)
    const keys = new Set(items.map((i) => `${i.supplier} ${i.category} ${i.code}`))
    expect(keys.size).toBe(items.length)
    const suppliers = new Set(items.map((i) => i.supplier))
    expect(suppliers.size).toBeGreaterThanOrEqual(35)
  })
})
