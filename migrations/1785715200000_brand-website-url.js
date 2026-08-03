/**
 * Adds brands.website_url — the house's own site, shown on the storefront brand
 * page as an outbound "Visit {name}" link. Nullable: many houses simply have no
 * URL on file, and the storefront omits the link when unset. Stored as entered
 * (staff-typed in the CRM); the API validates http(s) at the write boundary so a
 * javascript: URL can never reach a public href.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('brands', {
    website_url: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('brands', 'website_url')
}
