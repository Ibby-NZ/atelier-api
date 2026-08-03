/**
 * Adds collections.description + collections.image_url — the editorial the
 * vendored atelier.co.nz snapshot already carries per collection (blurb + hero
 * photograph) but the first seed dropped. The storefront brand page renders
 * them on its collection tiles; the CRM edits them; an EmDash brand-page card
 * still overrides both per tile. Nullable — a collection without either renders
 * name-only over the weave placeholder.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('collections', {
    description: { type: 'text' },
    image_url: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('collections', ['description', 'image_url'])
}
