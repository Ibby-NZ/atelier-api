/**
 * Supplier price-list ledger — one row per supplier item, imported from the
 * per-brand price-list templates via `npm run import:pricing`. Wholesale rates
 * stay in the supplier's currency; the pricing waterfall converts them to NZD
 * downstream. Upsert key: (supplier, category, code) — a re-import refreshes
 * prices in place.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('price_list_items', {
    id: 'id',
    supplier: { type: 'text', notNull: true },
    product_range: { type: 'text' },
    category: {
      type: 'text',
      notNull: true,
      check: "category IN ('fabric','wallpaper','trimming','accessory')",
    },
    code: { type: 'text', notNull: true },
    // Uniform code format (platform decision 6, 15 Jul): uppercase, non-alphanumeric
    // runs collapsed to '-'. Raw `code` stays the upsert key so Xero/supplier
    // mismatches remain traceable.
    code_normalized: { type: 'text', notNull: true },
    description: { type: 'text' },
    contents: { type: 'text' },
    // Unit vocabulary matches the platform's ratified descriptors (decision 7,
    // atelier-app units.js UNITS) — hide/panel have no template rows yet but are in use.
    unit: {
      type: 'text',
      notNull: true,
      check: "unit IN ('metre','yard','roll','piece','hide','panel')",
    },
    width: { type: 'text' },
    repeat: { type: 'text' },
    vertical_repeat: { type: 'text' },
    duty_class: { type: 'text' },
    wholesale_rate: { type: 'numeric(12,4)', notNull: true, check: 'wholesale_rate > 0' },
    currency: { type: 'text', notNull: true, check: "currency IN ('EUR','USD','GBP')" },
    freight_class: { type: 'text', check: "freight_class IN ('A','B','C','D','E')" },
    date_effective: { type: 'date' },
    source_file: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('price_list_items', 'price_list_items_supplier_category_code_key', {
    unique: ['supplier', 'category', 'code'],
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('price_list_items')
}
