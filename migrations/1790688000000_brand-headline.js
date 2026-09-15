/**
 * `brands.headline` — the one line the storefront's house page opens on, above
 * the story (client feedback, 16 Sep 2026: "a text field that requires a
 * headline and then a story"). Nullable: most houses have a story and no
 * headline yet, and the page simply omits the line until the office writes one.
 *
 * Not seeded and never overwritten by the seed — like `trade_only`, it is the
 * office's own words, not the vendored catalogue's.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('brands', {
    headline: { type: 'text' },
  })
}

export const down = (pgm) => {
  pgm.dropColumn('brands', 'headline')
}
