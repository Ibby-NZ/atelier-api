/**
 * Adds brands.logo_url — the maison's own mark (a PNG with transparency, white
 * on nothing) that the storefront's house tiles centre over the house image in
 * place of the typeset name. Same shape and rules as brands.image_url: a full
 * http(s) URL to a file hosted elsewhere, validated at the write boundary so a
 * javascript: URL can never reach a public `src`. Nullable — a house with no
 * logo on file keeps showing its name, which is what every tile showed before.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('brands', {
    logo_url: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumn('brands', 'logo_url')
}
