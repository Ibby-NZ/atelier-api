/**
 * The Dynamics "Active Product Prices" export, re-imported as the platform's
 * own product price list — the rows the CRM prices with each house's range
 * parameters (September 2026, client asked: "the price calculation … shown on
 * products in the CRM").
 *
 * WHY NOT `legacy_product_prices`. The Dynamics archive already holds these
 * designs, with every column the full export carries (export price, landed
 * cost, retail, the tier prices, the manual-override lane …). The office's
 * reimport is a NARROWER view — sixteen columns — and `importLegacyEntity`
 * upserts every mapped column to EXCLUDED on the GUID, so landing it there
 * would null out everything the narrow view does not carry. The client was
 * explicit: the archive is not to be overwritten or removed. So this is its own
 * table, loaded by its own upload (src/pricing/product-prices-import.js), and
 * nothing here references a `legacy_*` table. The name is deliberately not
 * `legacy_`-prefixed either: three suites count that namespace against
 * LEGACY_TABLES, and this table is not a mirror.
 *
 *   product_price_imports  who uploaded which export, when, and how it landed
 *   product_prices         one row per D365 product price (its GUID is the key)
 *
 * WHAT A ROW STORES, AND WHAT IT DOES NOT. The INPUTS the waterfall needs from
 * the product — wholesale rate, currency, range, type, duty class — plus
 * Dynamics' own figures (price ex/incl duty, trade sell) as a REFERENCE the CRM
 * shows beside the platform's number. The computed prices are stored nowhere:
 * they are derived on read from the house's parameters (src/pricing/
 * product-prices.js), so editing a house's clearance or markup reprices every
 * product in the range at once, which is the relationship the client
 * described.
 *
 * The range is kept as TEXT and matched to its house by name on read
 * (case-insensitive, trimmed) — the rule the freight ledger and `houseUnits`
 * already use. A stored brand_id would go stale the day the office raises the
 * missing house for BOUSSAC or KVADRAT MAHARAM, both of which carry prices and
 * no range row today.
 *
 * `duty_class` is INFERRED, not read: the narrow export has no Duty Rate
 * column. Dynamics' two prices say whether it charged duty (incl > ex on 1,490
 * of 21,102 rows, always 5%), and the only duty letter the corpus has ever used
 * is A — so a dutied row is class A and every other row has none.
 *
 * `freight_letter` is kept for reference only. Dynamics priced freight by it
 * (A/B/C/D per range); the client answered F1 in September 2026 — freight is
 * per HOUSE — so the platform's price reads the house's rate and the letter
 * explains why Dynamics' number differs.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('product_price_imports', {
    id: 'id',
    imported_by_user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    filename: { type: 'text', notNull: true },
    // Read from the filename ("… 25-09-2026 12-07-28 PM.xlsx"): naive local
    // time, the staging tables' rule — tagging it UTC would shift it a day.
    exported_at: { type: 'timestamp' },
    // They balance: rows_read = rows_new + rows_changed + rows_unchanged.
    rows_read: { type: 'integer', notNull: true },
    rows_new: { type: 'integer', notNull: true },
    rows_changed: { type: 'integer', notNull: true },
    rows_unchanged: { type: 'integer', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('product_prices', {
    id: 'id',
    // atelier_productpricesid — the upsert key, so a re-import refreshes in place.
    guid: { type: 'uuid', notNull: true, unique: true },
    code: { type: 'text', notNull: true },
    description: { type: 'text' },
    range_name: { type: 'text', notNull: true },
    item_type: { type: 'text' },
    // ISO code. NZD is allowed here (26 rows are priced in NZ$) although the
    // supplier price list's CURRENCIES is not widened for it.
    currency: { type: 'text', notNull: true, check: "currency ~ '^[A-Z]{3}$'" },
    wholesale_rate: { type: 'numeric(12,4)', notNull: true, check: 'wholesale_rate >= 0' },
    date_effective: { type: 'date' },
    horizontal_repeat: { type: 'text' },
    vertical_repeat: { type: 'text' },
    freight_letter: { type: 'text' },
    duty_class: { type: 'text', check: "duty_class ~ '^[A-Z]$'" },
    // What Dynamics computed, as exported. Reference only — never an input.
    dynamics_price_ex_duty: { type: 'numeric(14,2)' },
    dynamics_price_incl_duty: { type: 'numeric(14,2)' },
    dynamics_trade_sell: { type: 'numeric(14,2)' },
    dynamics_modified_on: { type: 'timestamp' },
    row_checksum: { type: 'text' },
    first_import_id: { type: 'integer', references: 'product_price_imports', onDelete: 'SET NULL' },
    // The latest export that carried the row. A row a later export leaves out
    // is kept (it is no longer Active in Dynamics) and the CRM says so.
    last_import_id: { type: 'integer', references: 'product_price_imports', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('product_prices', 'lower(btrim(range_name))', { name: 'product_prices_range_key' })
  pgm.createIndex('product_prices', 'code')
  pgm.createIndex('product_prices', 'last_import_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('product_prices')
  pgm.dropTable('product_price_imports')
}
