/**
 * Applies the client's September house instructions to an already-seeded
 * database (Userback 8287655, 8287611, 8287607).
 *
 * Two halves, both of which the seed cannot reach on its own:
 *
 * 1. Five houses Atelier no longer represents — Sahco, Le Crin, Timney Fowler,
 *    The Vale London and Brochier — are ARCHIVED. The seed data no longer
 *    creates them, which covers a fresh database; a live one still holds the
 *    rows, and `runSeed` only ever upserts, so nothing there would remove them.
 *
 *    Archived rather than deleted. `src/lifecycle/registry.js` refuses a house
 *    that still has products or collections behind it (Sahco and Brochier each
 *    carry a seeded cushion, and le-crin/the-vale-london/timney-fowler were
 *    created by 1786060800000_client-house-roster.js and may have acquired
 *    catalogue rows since), and archiving is already what takes a house off the
 *    public storefront: `listBrands` filters `archived_at IS NULL` and
 *    `src/catalogue/products.js` hides every product under an archived house.
 *
 * 2. One product slug moves. "Dominique Kieffer by Rubelli" is renamed to
 *    "Kieffer" in the seed data, and a fabric's slug is `slugify(brand name +
 *    design)` (`src/seed/catalogue-data.js`), so the next reseed would INSERT
 *    `kieffer-rigatto` beside the existing `dominique-kieffer-by-rubelli-rigatto`
 *    and move its two colourways onto the new row — leaving a live, website-
 *    visible design with no SKUs behind it. Moving the slug first makes the
 *    reseed land on the row that is already there. The brand renames themselves
 *    need no statement here: `upsertBrands` writes `name = EXCLUDED.name`, so
 *    `npm run seed` carries all three.
 *
 * Run order is therefore `npm run migrate && npm run seed`, as ever.
 *
 * The slugs are inlined rather than imported from `src/seed/data/`: a migration
 * is a record of what ran, and one importing a file that later changes would
 * rewrite its own past.
 *
 * Idempotent in both directions — every statement is a fixed value set behind a
 * WHERE that stops matching once it has run.
 */

const DEPARTED_HOUSE_SLUGS = [
  'sahco',
  'le-crin',
  'timney-fowler',
  'the-vale-london',
  'brochier',
]

const OLD_KIEFFER_PRODUCT_SLUG = 'dominique-kieffer-by-rubelli-rigatto'
const NEW_KIEFFER_PRODUCT_SLUG = 'kieffer-rigatto'

const moveProductSlug = (pgm, from, to) =>
  pgm.db.query(`UPDATE products SET slug = $2 WHERE slug = $1`, [from, to])

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = async (pgm) => {
  await pgm.db.query(
    `UPDATE brands SET archived_at = now()
      WHERE slug = ANY($1) AND archived_at IS NULL`,
    [DEPARTED_HOUSE_SLUGS]
  )
  await moveProductSlug(pgm, OLD_KIEFFER_PRODUCT_SLUG, NEW_KIEFFER_PRODUCT_SLUG)
}

/**
 * Puts the five houses back on the public storefront and the design back under
 * its old slug.
 *
 * A house someone archived in the CRM for a reason of their own is un-archived
 * along with them — the column records no reason, so the five slugs are all
 * this can go on.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = async (pgm) => {
  await moveProductSlug(pgm, NEW_KIEFFER_PRODUCT_SLUG, OLD_KIEFFER_PRODUCT_SLUG)
  await pgm.db.query(
    `UPDATE brands SET archived_at = NULL
      WHERE slug = ANY($1) AND archived_at IS NOT NULL`,
    [DEPARTED_HOUSE_SLUGS]
  )
}
