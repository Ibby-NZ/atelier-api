/**
 * Larsen 2024 leads the featured collections, and carries the client's own copy
 * (Userback, 25 Aug 2026).
 *
 * Two changes, one instruction. The /brands "Featured collection" band shows
 * the first collection the office has featured, and the client asked for that
 * band to showcase Larsen 2024 with the paragraph below. Featuring it is
 * therefore the change — NOT pinning the band in the storefront, which would
 * take the choice out of the CRM and hand it to a developer.
 *
 * Known and accepted: the home page follows the same list, so it leads with
 * Larsen 2024 and its featured band switches to it as well — that band's
 * commissioned portrait was shot for exactly this collection. The office can
 * reorder the whole list in the CRM at any time.
 *
 * The copy is the description that band prints, and the vendored snapshot's
 * one-line version read as a caption rather than as the paragraph the band is
 * built around.
 *
 * A migration as well as a seed change, for the same reason the house roster
 * and the house descriptions needed one: a deployed database is not necessarily
 * reseeded. `src/seed/data/realCatalogue.js` carries the same text for a fresh
 * seed; this applies it to the databases already carrying the old line.
 *
 * The text is inlined rather than imported from `src/seed/data/` — a migration
 * is a record of what ran, and one importing a file that later changes would
 * rewrite its own past. The two are expected to drift; the seed file is the
 * live source.
 *
 * **A collection is addressed by the (house, collection) PAIR, never by slug
 * alone.** `collections_brand_id_slug_unique` is per brand, so a slug-only
 * UPDATE would rewrite another maison's identically-slugged collection as well
 * as, or instead of, this one.
 *
 * Idempotent, and it never overwrites an edit: the WHERE pins the OLD text, so
 * a re-run matches nothing and a description staff corrected in the CRM in the
 * meantime is left alone. (The seed itself does not honour that — `upsertCollections`
 * writes `description = EXCLUDED.description` unconditionally, so a CRM edit is
 * already lost on the next reseed. Pre-existing for every collection the
 * snapshot describes, and not changed here.)
 */

const BRAND_SLUG = 'larsen'
const COLLECTION_SLUG = 'larsen-2024'

const OLD_DESCRIPTION =
  'Decorative collections using African motifs as initial inspiration; handcrafted character and bold, visually captivating patterns with an inherent elegance.'

const NEW_DESCRIPTION =
  'The latest decorative collections from Larsen have used African motifs as an initial inspiration, paying homage to traditions while infusing a contemporary touch. Each design within the collection reflects a handcrafted character, offering a fresh perspective on time-honoured techniques and fabrics.'

/**
 * Prepends Larsen 2024 to the featured list by SHIFTING what is already there,
 * rather than writing a list of its own.
 *
 * The ranks in the database are the office's, not the ones
 * 1786593600000_featured-rank.js seeded — the CRM's reorder clears every rank
 * and re-applies the submitted list, and the office has since cut it from seven
 * collections to three. A migration restating a list would silently undo that
 * edit, so this one only makes room at the top and leaves the order below it
 * exactly as the office left it.
 *
 * Idempotent through the NOT EXISTS guard: once Larsen 2024 is featured, a
 * re-run shifts nothing. Both statements run in the migration's transaction, so
 * the list is never left with two collections at rank 1.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
const featureLarsen = async (pgm) => {
  const alreadyFeatured = `EXISTS (
    SELECT 1 FROM collections c2 JOIN brands b2 ON b2.id = c2.brand_id
     WHERE b2.slug = $1 AND c2.slug = $2 AND c2.featured_rank IS NOT NULL
  )`

  await pgm.db.query(
    `UPDATE collections SET featured_rank = featured_rank + 1
      WHERE featured_rank IS NOT NULL AND NOT ${alreadyFeatured}`,
    [BRAND_SLUG, COLLECTION_SLUG]
  )

  await pgm.db.query(
    `UPDATE collections c SET featured_rank = 1
       FROM brands b
      WHERE c.brand_id = b.id AND b.slug = $1 AND c.slug = $2 AND c.featured_rank IS NULL`,
    [BRAND_SLUG, COLLECTION_SLUG]
  )
}

/**
 * Drops Larsen 2024 back out of the list and closes the gap it left.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
const unfeatureLarsen = async (pgm) => {
  const { rowCount } = await pgm.db.query(
    `UPDATE collections c SET featured_rank = NULL
       FROM brands b
      WHERE c.brand_id = b.id AND b.slug = $1 AND c.slug = $2 AND c.featured_rank = 1`,
    [BRAND_SLUG, COLLECTION_SLUG]
  )
  if (rowCount > 0) {
    await pgm.db.query(
      `UPDATE collections SET featured_rank = featured_rank - 1 WHERE featured_rank > 1`
    )
  }
}

const setDescription = (pgm, from, to) =>
  pgm.db.query(
    `UPDATE collections c SET description = $3
       FROM brands b
      WHERE c.brand_id = b.id
        AND b.slug = $1
        AND c.slug = $2
        AND c.description = $4`,
    [BRAND_SLUG, COLLECTION_SLUG, to, from]
  )

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = async (pgm) => {
  await setDescription(pgm, OLD_DESCRIPTION, NEW_DESCRIPTION)
  await featureLarsen(pgm)
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = async (pgm) => {
  await unfeatureLarsen(pgm)
  await setDescription(pgm, NEW_DESCRIPTION, OLD_DESCRIPTION)
}
