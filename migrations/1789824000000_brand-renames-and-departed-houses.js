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
 * 2. Three product slugs move, all of them Kieffer's. "Dominique Kieffer by
 *    Rubelli" is renamed to "Kieffer" in the seed data, and a product's slug is
 *    derived from that name — `slugify(brand name + design)` for a fabric,
 *    `slugify(product name)` for a finished good, whose title carries the house
 *    (`src/seed/catalogue-data.js`). So the next reseed would INSERT each new
 *    slug beside the old row and move its colourways onto it, leaving a live,
 *    website-visible product with no SKUs behind it. Moving the slugs first
 *    makes the reseed land on the rows that are already there, renaming them.
 *    The brand renames themselves need no statement here: `upsertBrands` writes
 *    `name = EXCLUDED.name`, so `npm run seed` carries all three — and the
 *    products' own names ride the same `DO UPDATE` once the slug matches.
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

// [from, to] — the fabric design, then the two cushion covers whose titles spell
// the house out in full.
const KIEFFER_PRODUCT_SLUG_MOVES = [
  ['dominique-kieffer-by-rubelli-rigatto', 'kieffer-rigatto'],
  [
    'dominique-kieffer-by-rubelli-rigatto-cushion-cover-blanc',
    'kieffer-rigatto-cushion-cover-blanc',
  ],
  [
    'dominique-kieffer-by-rubelli-rigatto-cushion-cover-mahogany',
    'kieffer-rigatto-cushion-cover-mahogany',
  ],
]

// The NOT EXISTS is what keeps a deploy alive when someone runs the seed BEFORE
// the migration: the reseed has already inserted the destination slug, so an
// unguarded UPDATE hits products_slug_key and stops the deploy half-seeded.
// Skipping the move leaves the duplicate the wrong run order created — which is
// what `migrate && seed` exists to avoid — but the deploy finishes.
const moveProductSlugs = async (pgm, moves) => {
  for (const [from, to] of moves) {
    await pgm.db.query(
      `UPDATE products SET slug = $2
        WHERE slug = $1 AND NOT EXISTS (SELECT 1 FROM products WHERE slug = $2)`,
      [from, to]
    )
  }
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = async (pgm) => {
  await pgm.db.query(
    `UPDATE brands SET archived_at = now()
      WHERE slug = ANY($1) AND archived_at IS NULL`,
    [DEPARTED_HOUSE_SLUGS]
  )
  await moveProductSlugs(pgm, KIEFFER_PRODUCT_SLUG_MOVES)
}

/**
 * Puts the five houses back on the public storefront and the three designs back
 * under their old slugs.
 *
 * A house someone archived in the CRM for a reason of their own is un-archived
 * along with them — the column records no reason, so the five slugs are all
 * this can go on.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = async (pgm) => {
  await moveProductSlugs(
    pgm,
    KIEFFER_PRODUCT_SLUG_MOVES.map(([from, to]) => [to, from])
  )
  await pgm.db.query(
    `UPDATE brands SET archived_at = NULL
      WHERE slug = ANY($1) AND archived_at IS NOT NULL`,
    [DEPARTED_HOUSE_SLUGS]
  )
}
