/**
 * `featured_rank` on brands and collections — the office's own ordering of what
 * the storefront leads with, replacing the hand-edited slug arrays that live in
 * the storefront's homepage frontmatter today.
 *
 * A NULLABLE INTEGER, NOT A BOOLEAN. The homepage needs three hero slides *in a
 * chosen order*, and a boolean produces a set with no order. NULL means "not
 * featured" and sorts last for free under
 * `ORDER BY featured_rank ASC NULLS LAST, name ASC, id ASC`.
 *
 * NO UNIQUE INDEX, deliberately. That ORDER BY is already deterministic when
 * two rows share a rank, whereas a partial unique index would turn every step
 * of a reorder into a potential 409 — swapping ranks 1 and 2 collides halfway
 * through unless the whole list is rewritten in one statement.
 *
 * The CHECK is "null or positive". Rank 0 would sort ahead of rank 1 while
 * reading as "unset" to anyone skimming the row, which is exactly the ambiguity
 * NULL already covers. (A Postgres CHECK passes on NULL anyway; the `IS NULL`
 * arm is written out because the intent is the point.)
 *
 * No index on either column: `brands` is 41 rows and `collections` a few dozen,
 * and both are read whole by the public endpoints.
 *
 * ## Seeding
 *
 * This migration carries the storefront's CURRENT hand-picked choice across, so
 * nothing on the site moves the day the pages start reading the column. The
 * values are inlined rather than imported from the storefront (a different repo)
 * or from the seed: a migration is a record of what ran, and one that imported a
 * file which later changed would rewrite its own past. Same posture as
 * `1786060800000_client-house-roster.js`.
 *
 * The collection seeding matches on (brand_slug, slug) PAIRS. A collection slug
 * is unique per brand and never globally (`collections_brand_id_slug_unique`),
 * so a slug-only UPDATE would feature another house's identically-slugged
 * collection as well — or instead.
 *
 * Both statements simply match nothing on an unseeded database, which is what
 * every fresh install and every CI run is. `featured_rank` is absent from the
 * seed entirely, so it stays NULL through a reseed and an office decision
 * outlives one — the same posture as `trade_only`, inventory and shipping rates.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

const RANK_CHECK = 'featured_rank IS NULL OR featured_rank > 0'

// The homepage's three hero collections, in the order `FEATURED_COLLECTIONS`
// lists them, then the four of its "latest collections" row in the order
// `LATEST_SLUGS` lists them. One ordered list, because the DATABASE OWNS THE
// ORDER AND THE PAGE OWNS THE COMPOSITION — "the first three are the hero" is a
// decision the homepage makes, and encoding it here would freeze the layout into
// the schema.
export const FEATURED_COLLECTIONS = Object.freeze([
  Object.freeze({ brand_slug: 'de-le-cuona', slug: 'nature-s-opera', rank: 1 }),
  Object.freeze({ brand_slug: 'larsen', slug: 'larsen-2024', rank: 2 }),
  Object.freeze({ brand_slug: 'manuel-canovas', slug: 'manuel-canovas-2024', rank: 3 }),
  Object.freeze({ brand_slug: 'manuel-canovas', slug: 'manuel-canovas-giverny', rank: 4 }),
  Object.freeze({ brand_slug: 'no-9-thompson', slug: 'no-9-thompson-mazan-outdoor', rank: 5 }),
  Object.freeze({ brand_slug: 'pierre-frey', slug: 'pierre-frey-cappuccino', rank: 6 }),
  Object.freeze({ brand_slug: 'no-9-thompson', slug: 'no-9-thompson-feuillage', rank: 7 }),
])

// The houses behind the three hero collections, in the same order.
//
// Unlike the collections, the storefront has never hand-picked houses: the
// `/brands` "in focus" strip DERIVES its three from `is_international` plus a
// design count plus whether any editorial photography exists — and the last of
// those lives in the storefront's own content, so no statement here can
// reproduce it. The hero houses are the closest thing to a stated choice the
// client has made, and they make the two surfaces agree instead of the homepage
// leading with one set of maisons and the directory with another. A human
// should look at `/brands` once US-007 lands and reorder it in the CRM if this
// is not what the office wants — which is the entire point of the column.
export const FEATURED_BRANDS = Object.freeze([
  Object.freeze({ slug: 'de-le-cuona', rank: 1 }),
  Object.freeze({ slug: 'larsen', rank: 2 }),
  Object.freeze({ slug: 'manuel-canovas', rank: 3 }),
])

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Every value below is interpolated into SQL rather than bound, because a
// migration builder takes statements and not parameters. So each one is checked
// first: a typo'd slug or a rank that is not a positive integer throws while the
// file is being loaded, which stops the migration rather than reaching the
// database. Same posture as `assertEntity` in `src/lifecycle/`.
const assertSlug = (value, label) => {
  if (typeof value !== 'string' || !SLUG_PATTERN.test(value)) {
    throw new Error(`featured seed: ${label} must be a slug, got ${JSON.stringify(value)}`)
  }
  return value
}

const assertRank = (value) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`featured seed: rank must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return value
}

const assertEntries = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('featured seed: expected a non-empty list of entries')
  }
  return entries
}

/** `UPDATE brands` featuring each named slug. An unknown slug matches nothing. */
export const brandFeatureSql = (entries) => `
UPDATE brands b
   SET featured_rank = v.rank
  FROM (VALUES
${assertEntries(entries)
  .map((entry) => `         ('${assertSlug(entry.slug, 'brand slug')}', ${assertRank(entry.rank)})`)
  .join(',\n')}
       ) AS v(slug, rank)
 WHERE b.slug = v.slug`

/**
 * `UPDATE collections` featuring each (brand slug, collection slug) PAIR.
 * The join to `brands` is what makes it a pair rather than a slug: two houses
 * may hold a collection of the same slug, and only the named one is featured.
 */
export const collectionFeatureSql = (entries) => `
UPDATE collections c
   SET featured_rank = v.rank
  FROM (VALUES
${assertEntries(entries)
  .map(
    (entry) =>
      `         ('${assertSlug(entry.brand_slug, 'brand slug')}', ` +
      `'${assertSlug(entry.slug, 'collection slug')}', ${assertRank(entry.rank)})`
  )
  .join(',\n')}
       ) AS v(brand_slug, slug, rank)
  JOIN brands b ON b.slug = v.brand_slug
 WHERE c.brand_id = b.id
   AND c.slug = v.slug`

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('brands', { featured_rank: { type: 'integer', check: RANK_CHECK } })
  pgm.addColumns('collections', { featured_rank: { type: 'integer', check: RANK_CHECK } })
  pgm.sql(brandFeatureSql(FEATURED_BRANDS))
  pgm.sql(collectionFeatureSql(FEATURED_COLLECTIONS))
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('collections', ['featured_rank'])
  pgm.dropColumns('brands', ['featured_rank'])
}
