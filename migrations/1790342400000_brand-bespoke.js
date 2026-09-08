/**
 * Adds brands.bespoke — whether the house takes made-to-measure commissions.
 *
 * The storefront's /bespoke page used to carry its own list of the five
 * commissioning houses (the client's brief of 10 Aug 2026), so adding or
 * removing one was a code change. The flag moves that decision into the CRM's
 * Houses screen: a bespoke house appears on /bespoke, and its own page
 * (/brands/<slug>) carries the quote enquiry form beside the house copy.
 *
 * Defaults to FALSE — most maisons sell by the bolt. Data step below flags the
 * five houses the brief named so an already-seeded database keeps its bespoke
 * page; the seed sets it on INSERT only (like trade_only) so a CRM change
 * survives every reseed.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('brands', {
    bespoke: { type: 'boolean', notNull: true, default: false },
  })
  pgm.sql(
    `UPDATE brands SET bespoke = true
      WHERE slug IN ('pierre-frey', 'cc-milano', 'loro-piana', 'maria-flora', 'de-le-cuona')`
  )
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('brands', 'bespoke')
}
