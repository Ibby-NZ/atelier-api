/**
 * Three houses the client's 4 Aug 2026 roster omitted but whose brand-page copy
 * the client has now written: Fox Linton, Houlès and Jannelli & Volpi.
 *
 * A DATA migration as well as a seed change, for the same reason
 * 1786060800000_client-house-roster needed one: a deployed database is not
 * necessarily reseeded, and `realCatalogue.js` only knows houses with products
 * or designs behind them, so a represented-only house can never reach the
 * brands table any other way. `src/seed/data/represented-houses.js` covers
 * fresh seeds; this covers the rest.
 *
 * Without a brands row the storefront cannot show the copy properly: /brands is
 * driven off the API's own list, and /brands/<slug> falls back to the markdown
 * file's id for its heading, so the page would render under "fox-linton".
 *
 * `website_url` is left NULL for all three: no roster link was supplied, and
 * the brand page turns a URL into a "Visit website" action, so a guessed one
 * ships a possibly-dead link. Staff add it in the CRM.
 *
 * `trade_only` is left at the column default (true) — the closed posture every
 * represented house carries.
 *
 * The rows are inlined rather than imported from `src/seed/data/`: a migration
 * is a record of what ran, and one importing a file that later changes would
 * rewrite its own past. The two are expected to drift — the seed is the live
 * source.
 *
 * Idempotent: ON CONFLICT (slug) DO NOTHING, and the story UPDATE fills blanks
 * only, so a description staff wrote in the CRM is left alone.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

// [name, slug, country, currency, story]. `currency` is the SUPPLIER's
// invoicing currency defaulted from the house's region — none of the three has
// a supplier record or a product, so nothing renders it today; it is the
// default a first product inherits.
const HOUSES = [
  [
    'Fox Linton',
    'fox-linton',
    'England',
    'GBP',
    'British house founded by designer Mary Fox Linton, weaving indoor and outdoor cloth and throws in wool, linen, silk and velvet at specialist mills across Britain and Europe.',
  ],
  [
    'Houlès',
    'houles',
    'France',
    'EUR',
    'Founded 1928 in Paris, a fourth-generation maison of passementerie — tassels, fringes, cords, braids and tiebacks — and of curtain poles, finials and fittings.',
  ],
  [
    'Jannelli & Volpi',
    'jannelli-volpi',
    'Italy',
    'EUR',
    'Founded 1961, a family-run Milanese wallpaper house, maker of the licensed Armani/Casa and Missoni wallcovering collections.',
  ],
]

export const up = async (pgm) => {
  for (const [name, slug, country, currency, story] of HOUSES) {
    await pgm.db.query(
      `INSERT INTO brands (name, slug, story, country, currency, is_international)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slug, story, country, currency]
    )
    // Covers the case where the slug already existed (created in the CRM
    // ahead of this) with no description of its own.
    await pgm.db.query(
      `UPDATE brands SET story = $2
        WHERE slug = $1 AND (story IS NULL OR btrim(story) = '')`,
      [slug, story]
    )
  }
}

/**
 * Removes only the houses this migration created, and only while they are still
 * empty — once staff have hung a collection or a product off one, dropping it
 * would cascade real catalogue rows away.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = async (pgm) => {
  const slugs = HOUSES.map(([, slug]) => slug)
  await pgm.db.query(
    `DELETE FROM brands b
      WHERE b.slug = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM products p WHERE p.brand_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.brand_id = b.id)`,
    [slugs]
  )
}
