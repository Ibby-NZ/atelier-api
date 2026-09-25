/**
 * Freight classes: a rate for each freight LETTER a house's price lines carry.
 *
 * Every price line states a freight class (`price_list_items.freight_class`,
 * A–E in the corpus: A 11,879 · B 5,571 · C 1,485 · D 578 · E 1), and the
 * incumbent priced freight per (range × letter) — Fabricut's A is $30 while
 * its B is $3 and its C $5, a full roll by air against a trimming. The ledger
 * held one rate per house, so every line of a house paid the same freight
 * whatever its letter. September 2026: the office asked for freight classes.
 *
 * `freight_class` is the letter a rate applies to; NULL is the house's (or the
 * supplier's) rate for EVERY class — what every existing row already is, so
 * nothing here moves an existing price. The resolver
 * (src/pricing/freight-rates.js) takes a line's letter, prefers the rate
 * stated for it and falls back to the every-class rate.
 *
 * The one-rate-per-scope-per-day unique index gains the class: a house may
 * carry a default and an A rate from the same day, and still never two A
 * rates from one day. Same CHECK as `price_list_items.freight_class`.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('supplier_freight_rates', {
    freight_class: { type: 'text', check: "freight_class ~ '^[A-Z]$'" },
  })
  pgm.sql('DROP INDEX supplier_freight_rates_scope_effective_unique')
  pgm.sql(`
    CREATE UNIQUE INDEX supplier_freight_rates_scope_effective_unique
      ON supplier_freight_rates (
        COALESCE(supplier_id, 0),
        lower(COALESCE(range_name, '')),
        COALESCE(category, ''),
        COALESCE(freight_class, ''),
        effective_from
      )
  `)
}

/**
 * Down refuses to drop a class rate silently: the old index cannot hold a
 * default and a class rate from the same day, so class rows would make it fail
 * to build. They are removed first, which is the honest reading of "down" —
 * the column they live in is going.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.sql('DELETE FROM supplier_freight_rates WHERE freight_class IS NOT NULL')
  pgm.sql('DROP INDEX supplier_freight_rates_scope_effective_unique')
  pgm.sql(`
    CREATE UNIQUE INDEX supplier_freight_rates_scope_effective_unique
      ON supplier_freight_rates (
        COALESCE(supplier_id, 0),
        lower(COALESCE(range_name, '')),
        COALESCE(category, ''),
        effective_from
      )
  `)
  pgm.dropColumns('supplier_freight_rates', ['freight_class'])
}
