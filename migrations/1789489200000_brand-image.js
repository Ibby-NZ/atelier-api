/**
 * Adds brands.image_url — the house's logo/hero image, set in the CRM's Houses
 * screen. Same shape and rules as collections.image_url: a full http(s) URL to
 * an image already hosted elsewhere (the atelier.co.nz media library is where
 * every catalogue image lives), validated at the write boundary so a
 * javascript: URL can never reach a public `src`. Nullable — most houses have
 * no image on file and consumers omit it when unset.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('brands', {
    image_url: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('brands', 'image_url')
}
