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

// The reserve entity is the real source of reserved quantity — the `Reserve`
// column on the stock item is a free-text staff note. `product_code` arrives from a
// related-entity lookup column whose logical name carries a relationship GUID
// prefix, so the converter matches it on the suffix.
const reserveRecord = (overrides = {}) => ({
  guid: GUID_A,
  name: 'RS0612',
  reserve_number: 'RS0612',
  range_name: 'MADEAUX',
  customer: 'Legacy Test Account Ltd',
  product: 'ELLA STRIPE',
  product_code: 'LEG-TEST-001',
  quantity: 53.5,
  reserved_until: '2026-08-15 00:00:00',
  status_reason: 'Active',
  source_file: 'Active Reserves TEST.xlsx',
  raw: { fulmar_quantity: '53.5' },
  ...overrides,
})

// The parameter table, at both of its interesting extremes. STOCK - INTERWEAVE
// is the domestic supplier: duty 0, clearance 0, freight $2 — real zeros, which
// must survive as zeros rather than collapse into the nulls beside them. HAMAM
// is the opposite reading of a blank: its Freight cell is empty while its price
// rows imply four different rates, so blank there means UNKNOWN, and it is the
// only range whose duty bands differ from each other (A 5, B 10, C 5).
const interweaveRecord = (overrides = {}) => ({
  guid: GUID_A,
  tracking_category: 'Range',
  name: 'STOCK - INTERWEAVE',
  supplier: 'Inter-Weave Ltd',
  duty_rate_a: 0,
  duty_rate_b: 0,
  duty_rate_c: 0,
  clearance: 0,
  freight: 2,
  discount: 0,
  trade_markup: 100,
  status: 'Active',
  modified_on: '2024-12-17 00:00:00',
  source_file: 'Xero Range TEST.xlsx',
  exported_at: '2026-08-12 09:15:00',
  row_checksum: 'trk123',
  raw: { fulmxero_name: 'STOCK - INTERWEAVE', fulmxero_freight: '2' },
  ...overrides,
})

const hamamRecord = (overrides = {}) => ({
  guid: GUID_B,
  tracking_category: 'Range',
  name: 'HAMAM',
  duty_rate_a: 5,
  duty_rate_b: 10,
  duty_rate_c: 5,
  clearance: 10,
  discount: 0,
  trade_markup: 75,
  status: 'Active',
  source_file: 'Xero Range TEST.xlsx',
  raw: { fulmxero_name: 'HAMAM' },
  ...overrides,
})

// Written by the staging migration and never imported, so it is absent from the
// import column map. Declared rather than tolerated: the point of the comparison
// is that a NEW column fails it.
const STAGED_BUT_NOT_IMPORTED = Object.freeze({
  legacy_sales_orders: ['owning_business_unit'],
})

const IMPORT_STAMP = 'imported_at'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const cleanup = async (pool) => {
  for (const { table } of Object.values(LEGACY_TABLES)) {
    await pool.query(`DELETE FROM ${table} WHERE guid = ANY($1::uuid[])`, [FIXTURE_GUIDS])
  }
}

describe('legacy D365 staging import', () => {
  let pool
  let databaseUrl

  beforeAll(async () => {
    const config = loadConfig()
    databaseUrl = config.databaseUrl
    pool = createPool(config.databaseUrl)
    await runMigrations(config.databaseUrl)
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

  it('stores reserved quantity as a number, unlike the stock-item Reserve note', async () => {
    await importLegacyEntity(pool, 'reserves', [reserveRecord()])
    const { rows } = await pool.query(
      'SELECT quantity, reserved_until, product_code FROM legacy_reserves WHERE guid = $1',
      [GUID_A]
    )
    expect(Number(rows[0].quantity)).toBe(53.5)
    expect(rows[0].product_code).toBe('LEG-TEST-001')
    expect(rows[0].reserved_until).toBeInstanceOf(Date)
  })

  it('links a sales invoice to both its sales order and its Xero invoice', async () => {
    await importLegacyEntity(pool, 'sales_invoices', [
      {
        guid: GUID_B,
        number: 'INV-TEST-1',
        customer: 'Legacy Test Account Ltd',
        sales_order: 'SO-07947',
        xero_invoice_id: 'xero-abc-123',
        pricing_type: 'Trade',
        sales_invoice_discount_pct: 8,
        total_ex_gst: 1000,
        source_file: 'Active Sales Invoices TEST.xlsx',
        raw: { fulmxero_title: 'INV-TEST-1' },
      },
    ])
    const { rows } = await pool.query(
      'SELECT sales_order, xero_invoice_id, sales_invoice_discount_pct FROM legacy_sales_invoices WHERE guid = $1',
      [GUID_B]
    )
    expect(rows[0].sales_order).toBe('SO-07947')
    expect(rows[0].xero_invoice_id).toBe('xero-abc-123')
    expect(Number(rows[0].sales_invoice_discount_pct)).toBe(8)
  })

  it('round-trips a tracking option, keeping a real zero apart from a blank', async () => {
    await importLegacyEntity(pool, 'tracking_options', [interweaveRecord(), hamamRecord()])
    const { rows } = await pool.query(
      `SELECT guid, tracking_category, name, supplier, duty_rate_a, duty_rate_b, duty_rate_c,
              clearance, freight, discount, trade_markup, min_qty_to_avoid_surcharge,
              surcharge_per_unit, status, modified_on
       FROM legacy_tracking_options WHERE guid = ANY($1::uuid[]) ORDER BY name`,
      [FIXTURE_GUIDS]
    )
    expect(rows).toHaveLength(2)

    // pg returns numeric as a string — coerce before comparing.
    const [hamam, interweave] = rows
    expect(interweave.name).toBe('STOCK - INTERWEAVE')
    expect(interweave.supplier).toBe('Inter-Weave Ltd')
    expect(interweave.tracking_category).toBe('Range')
    expect(Number(interweave.duty_rate_a)).toBe(0)
    expect(Number(interweave.clearance)).toBe(0)
    // Dollars per unit, not a percentage: 38 + 2 = 40 is what the export's own
    // landed cost says. Stored as the source states it, unscaled and uncented.
    expect(Number(interweave.freight)).toBe(2)
    expect(Number(interweave.trade_markup)).toBe(100)
    expect(interweave.modified_on).toBeInstanceOf(Date)

    // A blank Freight is NULL, not 0 — the two readings differ by $50 a unit.
    expect(hamam.name).toBe('HAMAM')
    expect(hamam.freight).toBeNull()
    expect(hamam.supplier).toBeNull()
    expect(hamam.min_qty_to_avoid_surcharge).toBeNull()
    // The only range whose duty bands disagree with each other.
    expect([hamam.duty_rate_a, hamam.duty_rate_b, hamam.duty_rate_c].map(Number)).toEqual([5, 10, 5])
  })

  it('keeps a fractional freight rate and a $25 surcharge at full precision', async () => {
    // LIBERTY's freight is 51.5 and TIMNEY FOWLER's surcharge is $25 (every
    // other range with one says $20). Rounding either to an integer — or storing
    // it as cents — loses the client's own figure.
    await importLegacyEntity(pool, 'tracking_options', [
      interweaveRecord({ name: 'LIBERTY', freight: 51.5, clearance: 10, duty_rate_a: 5 }),
      hamamRecord({ name: 'TIMNEY FOWLER', min_qty_to_avoid_surcharge: 5, surcharge_per_unit: 25 }),
    ])
    const { rows } = await pool.query(
      `SELECT name, freight, surcharge_per_unit, min_qty_to_avoid_surcharge
       FROM legacy_tracking_options WHERE guid = ANY($1::uuid[]) ORDER BY name`,
      [FIXTURE_GUIDS]
    )
    expect(Number(rows[0].freight)).toBe(51.5)
    expect(Number(rows[1].surcharge_per_unit)).toBe(25)
    expect(Number(rows[1].min_qty_to_avoid_surcharge)).toBe(5)
  })

  it('is a no-op when migrations run again', async () => {
    const applied = await runMigrations(databaseUrl)
    expect(applied).toEqual([])
  })

  it('adds one staging table and no column to any other', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'legacy\\_%'`
    )
    const live = new Map()
    for (const row of rows) {
      if (!live.has(row.table_name)) live.set(row.table_name, [])
      live.get(row.table_name).push(row.column_name)
    }
    // Exactly the declared set: a twelfth table nobody declared, or a declared
    // one the migration forgot, fails here rather than three suites away.
    expect([...live.keys()].sort()).toEqual(
      Object.values(LEGACY_TABLES)
        .map((spec) => spec.table)
        .sort()
    )

    const unexpected = []
    for (const spec of Object.values(LEGACY_TABLES)) {
      const declared = new Set([
        ...Object.keys(spec.columns),
        IMPORT_STAMP,
        ...(STAGED_BUT_NOT_IMPORTED[spec.table] ?? []),
      ])
      for (const column of live.get(spec.table) ?? []) {
        if (!declared.has(column)) unexpected.push(`${spec.table}.${column}`)
      }
    }
    expect(unexpected).toEqual([])
  })

  it('indexes the two lookup keys the analysis measured', async () => {
    // `name` joins legacy_product_prices.range_name on 99.6% of priced rows;
    // `tracking_category` is what separates the 58 parameter-carrying Range rows
    // from the 17 Type rows that carry none.
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'legacy_tracking_options'`
    )
    const definitions = rows.map((row) => row.indexdef).join('\n')
    expect(definitions).toMatch(/\(name\)/)
    expect(definitions).toMatch(/\(tracking_category\)/)
  })

  it('leaves the live commerce and catalogue tables untouched', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM orders')
    await importLegacyEntity(pool, 'accounts', [accountRecord()])
    await importLegacyEntity(pool, 'product_prices', [priceRecord()])
    const after = await pool.query('SELECT count(*)::int AS n FROM orders')
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
