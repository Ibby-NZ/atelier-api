/**
 * The platform's own pricing parameters — the inputs to the cost-plus waterfall
 * (src/pricing/waterfall.js) that had no home of their own.
 *
 * Until now the landed-cost preview read duty, clearance and the trade markup
 * off the Dynamics staging mirror (`legacy_tracking_options`) and took FX,
 * handling and the retail markup from the query string. The client's brief of
 * September 2026 is that pricing runs on OUR waterfall, with parameters the
 * office sets per supplier and per house; Dynamics is a reference, not the
 * source. Two tables:
 *
 *   fx_rates — one row per currency: how many units of it NZ$1 buys, and the
 *   day it was set. The demo's fx.js modelled exactly this as an annual table.
 *   The margin that softens the rate is a SUPPLIER parameter, not a currency
 *   one, so it lives on the other table.
 *
 *   supplier_pricing_parameters — one row per SCOPE: a supplier's default
 *   (supplier_id set, brand_id NULL) or a house's override (brand_id set,
 *   supplier_id NULL). Exactly one of the two — the CHECK the freight ledger
 *   already uses for its supplier-or-range scope. Every parameter column is
 *   nullable on purpose: an override states only the fields it overrides, and
 *   the resolver (src/pricing/pricing-parameters.js) reads the house, then the
 *   house's supplier, then reports the input MISSING — never zero, which on a
 *   duty band or a markup is a wrong number that looks right.
 *
 * Discount and retail markup are NOT here: they already live on
 * supplier_brand_terms (with the multiplicative chain and the tiers). Freight
 * lives on the dated supplier_freight_rates ledger. This table holds the rest.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('fx_rates', {
    currency: { type: 'text', primaryKey: true, check: "currency ~ '^[A-Z]{3}$'" },
    // Foreign units per NZ$1 — the direction the waterfall divides by.
    rate: { type: 'numeric(12,6)', notNull: true, check: 'rate > 0' },
    set_on: { type: 'date', notNull: true, default: pgm.func('current_date') },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable(
    'supplier_pricing_parameters',
    {
      id: 'id',
      supplier_id: { type: 'integer', references: 'suppliers', onDelete: 'CASCADE' },
      brand_id: { type: 'integer', references: 'brands', onDelete: 'CASCADE' },
      // Percentages as the office writes them: 5 is 5%, not 0.05.
      duty_percent_a: { type: 'numeric(6,3)', check: 'duty_percent_a >= 0' },
      duty_percent_b: { type: 'numeric(6,3)', check: 'duty_percent_b >= 0' },
      duty_percent_c: { type: 'numeric(6,3)', check: 'duty_percent_c >= 0' },
      clearance_percent: { type: 'numeric(6,3)', check: 'clearance_percent >= 0' },
      trade_markup_percent: { type: 'numeric(8,3)', check: 'trade_markup_percent >= 0' },
      fx_margin_percent: { type: 'numeric(6,3)', check: 'fx_margin_percent >= 0' },
      // NZ$ per unit, added after landing.
      handling: { type: 'numeric(10,2)', check: 'handling >= 0' },
      note: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    {
      constraints: {
        check: '(supplier_id IS NULL) <> (brand_id IS NULL)',
      },
    }
  )
  pgm.createIndex('supplier_pricing_parameters', 'supplier_id', {
    name: 'supplier_pricing_parameters_supplier_unique',
    unique: true,
    where: 'supplier_id IS NOT NULL',
  })
  pgm.createIndex('supplier_pricing_parameters', 'brand_id', {
    name: 'supplier_pricing_parameters_brand_unique',
    unique: true,
    where: 'brand_id IS NOT NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('supplier_pricing_parameters')
  pgm.dropTable('fx_rates')
}
