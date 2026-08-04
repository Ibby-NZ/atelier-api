/**
 * Adds brands.trade_only — the gate that decides whether a signed-out visitor
 * may browse a house's products at all.
 *
 * The storefront shows a public visitor ONLY the house's own workroom (Atelier
 * Textiles NZ); every maison Atelier represents is reserved for approved trade
 * accounts (and staff). The gate is per HOUSE rather than per product because
 * that is the shape of the underlying agreement with each maison, and because a
 * per-product flag would let one colourway of a represented house leak into the
 * public grid.
 *
 * Defaults to TRUE — closed. A house created later in the CRM is trade-only
 * until someone deliberately opens it, so the failure mode is "not published
 * yet", never "accidentally published". The seed sets it on INSERT only, so a
 * reseed can never re-close a house the office opened (same posture as
 * inventory / shipping rates); this migration is what applies the initial
 * values to databases that were seeded before the column existed.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('brands', {
    trade_only: { type: 'boolean', notNull: true, default: true },
  })
  pgm.sql(`UPDATE brands SET trade_only = false WHERE slug = 'atelier-textiles-nz'`)
  // No index: `brands` is 41 rows and every catalogue query already joins it
  // from `products`, so the planner filters a handful of rows it has in memory.
  // An index here would be cargo cult.
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('brands', 'trade_only')
}
