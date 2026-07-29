import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { LEGACY_TABLES, importLegacyEntity, validateLegacyRecords } from '../src/seed/legacy-import.js'

// Fixture GUIDs are namespaced so cleanup can delete exactly these rows without
// touching a real import sitting in the same database.
const GUID_A = '00000000-0000-4000-8000-00000000000a'
const GUID_B = '00000000-0000-4000-8000-00000000000b'
const FIXTURE_GUIDS = [GUID_A, GUID_B]

const priceRecord = (overrides = {}) => ({
  guid: GUID_A,
  code: 'LEG-TEST-001',
  description: 'ELLA STRIPE',
  range_name: 'MADEAUX',
  item_type: 'Fabrics',
  pack_type: 'P/M',
  contents: '100% Linen',
  date_effective: '2026-01-30',
  duty_rate: 'A',
  freight_rate: 'B',
  currency: 'Euro',
  exchange_rate: 0.45,
  price_exchange_rate: 0.45,
  wholesale_rate: 48,
  export_price: 38.4,
  price_ex_duty_nz: 100,
  price_incl_duty_nz: 105,
  landed_cost_nz: 194.88,
  retail_sell_price_nz: 468.68,
  trade_sell_price_nz: 360.52,
  trade_sell_price_under_5m_nz: 360.52,
  sell_price_5pct_nz: 342.49,
  sell_price_10pct_nz: 324.46,
  set_prices_manually: false,
  status: 'Active',
  status_reason: 'Active',
  created_on: '2026-01-30 06:38:29',
  source_file: 'Active Product Prices TEST.xlsx',
  exported_at: '2026-07-29 09:40:36',
  row_checksum: 'abc123',
  raw: { atelier_code: 'LEG-TEST-001', atelier_wholesalerate: '48' },
  ...overrides,
})

const accountRecord = (overrides = {}) => ({
  guid: GUID_B,
  name: 'Legacy Test Account Ltd',
  is_customer: true,
  is_supplier: false,
  customer_type: 'Trade',
  territory: 'Upper North Island',
  province: 'Auckland',
  // D365 polarity: TRUE means "do not contact", even though the export renders
  // false as the word "Allow".
  do_not_email: false,
  do_not_send_marketing_materials: true,
  source_file: 'Customers TEST.xlsx',
  raw: { name: 'Legacy Test Account Ltd' },
  ...overrides,
})

const cleanup = async (pool) => {
  for (const { table } of Object.values(LEGACY_TABLES)) {
    await pool.query(`DELETE FROM ${table} WHERE guid = ANY($1::uuid[])`, [FIXTURE_GUIDS])
  }
}

describe('legacy D365 staging import', () => {
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
    await cleanup(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  it('inserts records and reports a summary', async () => {
    const summary = await importLegacyEntity(pool, 'product_prices', [priceRecord()])
    expect(summary).toEqual({
      entity: 'product_prices',
      table: 'legacy_product_prices',
      records: 1,
    })

    const { rows } = await pool.query('SELECT * FROM legacy_product_prices WHERE guid = $1', [GUID_A])
    expect(rows).toHaveLength(1)
    expect(rows[0].code).toBe('LEG-TEST-001')
    // pg returns numeric as a string — coerce before comparing.
    expect(Number(rows[0].trade_sell_price_nz)).toBe(360.52)
    expect(rows[0].set_prices_manually).toBe(false)
  })

  it('stores raw as jsonb, not a Postgres record', async () => {
    await importLegacyEntity(pool, 'product_prices', [priceRecord()])
    const { rows } = await pool.query(
      "SELECT raw->>'atelier_wholesalerate' AS rate FROM legacy_product_prices WHERE guid = $1",
      [GUID_A]
    )
    expect(rows[0].rate).toBe('48')
  })

  it('is idempotent on re-import and refreshes changed values', async () => {
    await importLegacyEntity(pool, 'product_prices', [priceRecord()])
    await importLegacyEntity(pool, 'product_prices', [priceRecord({ trade_sell_price_nz: 999.99 })])

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n, max(trade_sell_price_nz) AS price FROM legacy_product_prices WHERE guid = $1',
      [GUID_A]
    )
    expect(rows[0].n).toBe(1)
    expect(Number(rows[0].price)).toBe(999.99)
  })

  it('preserves D365 consent polarity verbatim', async () => {
    await importLegacyEntity(pool, 'accounts', [accountRecord()])
    const { rows } = await pool.query(
      'SELECT do_not_email, do_not_send_marketing_materials FROM legacy_accounts WHERE guid = $1',
      [GUID_B]
    )
    expect(rows[0].do_not_email).toBe(false)
    expect(rows[0].do_not_send_marketing_materials).toBe(true)
  })

  it('rejects a batch containing a duplicate GUID before any SQL runs', async () => {
    await expect(
      importLegacyEntity(pool, 'product_prices', [priceRecord(), priceRecord({ code: 'OTHER' })])
    ).rejects.toThrow(/duplicate record GUID/)
  })

  it('rejects unknown columns rather than silently dropping them', () => {
    expect(() => validateLegacyRecords('product_prices', [priceRecord({ nonsense: 1 })])).toThrow(
      /unknown column\(s\): nonsense/
    )
  })

  it('rejects a non-UUID guid and an unknown entity', () => {
    expect(() => validateLegacyRecords('product_prices', [priceRecord({ guid: 'not-a-uuid' })])).toThrow(
      /invalid guid/
    )
    expect(() => validateLegacyRecords('nope', [])).toThrow(/unknown legacy entity/)
  })

  it('leaves the live commerce and catalogue tables untouched', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM orders')
    await importLegacyEntity(pool, 'accounts', [accountRecord()])
    await importLegacyEntity(pool, 'product_prices', [priceRecord()])
    const after = await pool.query('SELECT count(*)::int AS n FROM orders')
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
