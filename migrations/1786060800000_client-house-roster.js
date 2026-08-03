/**
 * Applies the client's house roster (4 Aug 2026) to an already-seeded database:
 * fourteen houses we represent but hold nothing from, and the roster's own
 * website for all thirty-nine.
 *
 * A DATA migration rather than a seed change alone, because the seed cannot
 * reach either half on a live database:
 *  - `upsertBrands` writes `website_url = COALESCE(brands.website_url,
 *    EXCLUDED.website_url)` — deliberately, so a URL staff typed into the CRM
 *    outlives every reseed. Every slug below already held a researched URL, so
 *    a reseed would have kept all the old ones.
 *  - realCatalogue.js only knows houses that have products or designs behind
 *    them, so a represented-only house could never have been created by it.
 *    (`src/seed/data/represented-houses.js` now supplies them for FRESH seeds;
 *    this migration is how existing databases catch up.)
 *
 * The URLs and house metadata are inlined rather than imported from
 * `src/seed/data/`: a migration is a historical record of what ran, and one
 * that imported a file which later changes would silently rewrite its own past.
 * The two lists are expected to drift — the seed files are the live source.
 *
 * The UPDATE deliberately OVERWRITES an existing website_url, including one a
 * staff member typed in the CRM. That is the point of this migration: the
 * client handed us the authoritative roster, and it supersedes both our earlier
 * research and anything entered before it. It is a one-off correction — the
 * COALESCE contract in the seed still stands for every reseed after this.
 *
 * Idempotent: brands upsert on `slug`, and the UPDATE is a fixed value set.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

// Houses represented but not stocked. `currency` is the supplier's invoicing
// currency (the rule suppliers.js follows), defaulted from the house's region
// where no invoice is on file; nothing renders it until a product exists.
const REPRESENTED_HOUSES = [
  ['Alpaka', 'alpaka', 'Estonia', 'EUR'],
  ['Armani Casa', 'armani-casa', 'Italy', 'EUR'],
  ['Filippo Uecher', 'filippo-uecher', 'Italy', 'EUR'],
  ['Fine', 'fine', 'Austria', 'EUR'],
  ['Garrett Leather', 'garrett-leather', 'USA', 'USD'],
  ['Hamam', 'hamam', 'Turkey', 'EUR'],
  ['Jean Monro', 'jean-monro', 'England', 'GBP'],
  ['Le Crin', 'le-crin', 'France', 'EUR'],
  ['Madeaux', 'madeaux', 'England', 'GBP'],
  ['Maria Flora', 'maria-flora', 'Italy', 'EUR'],
  ['Sette', 'sette', 'Spain', 'EUR'],
  ['The Vale London', 'the-vale-london', 'England', 'GBP'],
  ['Timney Fowler', 'timney-fowler', 'England', 'GBP'],
  ['Verel de Belval', 'verel-de-belval', 'France', 'EUR'],
]

// The roster's links. http:// upgraded to https:// (Pierre Frey, Rubelli,
// Garrett Leather — same destination, all three redirect to TLS anyway), and
// The Vale London's expiring `?srsltid=` Google click token stripped.
const BRAND_WEBSITES = [
  ['alpaka', 'https://alpaka-shop.com/interior/'],
  ['armani-casa', 'https://www.armani.com/en-nz/armani-casa/experience/textiles/'],
  ['boussac', 'https://www.pierrefrey.com/en/brands/boussac'],
  ['braquenie', 'https://www.pierrefrey.com/en/collections?brand=braquenie'],
  ['brochier', 'https://brochier.it/'],
  ['cc-milano', 'https://www.cec-milano.com/'],
  ['clarence-house', 'https://clarencehouse.com/'],
  ['colefax-fowler', 'https://www.colefax.com/'],
  ['de-le-cuona', 'https://delecuona.com/'],
  ['fabricut', 'https://fabricut.com/'],
  ['fadini-borghi', 'https://www.pierrefrey.com/en/collections?brand=fadini-borghi'],
  ['filippo-uecher', 'https://filippouecher.it/'],
  ['fine', 'https://www.fine.at/'],
  ['garrett-leather', 'https://www.garrettleather.com/'],
  ['hamam', 'https://www.hamam.com/en-intl/'],
  ['jane-churchill', 'https://www.janechurchill.com/'],
  ['jean-monro', 'https://www.jeanmonro.com/'],
  ['jim-thompson', 'https://www.jimthompsonfabrics.com/'],
  ['kieffer', 'https://www.kieffertextiles.com/'],
  ['larsen', 'https://www.larsenfabrics.com/'],
  ['le-crin', 'https://www.metaphores.com/en'],
  ['liberty-london', 'https://www.libertyfabric.com/product-category/fabrics/'],
  ['loro-piana', 'https://www.loropiana.com/interiors/?lang=en'],
  ['madeaux', 'https://www.madeaux.com/'],
  ['manuel-canovas', 'https://www.manuelcanovas.com/'],
  ['maria-flora', 'https://mariaflora.com/'],
  ['metaphores', 'https://www.metaphores.com/?_locale=en'],
  ['missoni-home', 'https://www.missonihome-wallcoverings.com/en/'],
  ['no-9-thompson', 'https://www.jimthompsonfabrics.com/our-brands/no-9-thompson'],
  ['pierre-frey', 'https://www.pierrefrey.com/'],
  ['rubelli-venezia', 'https://rubelli.com/'],
  ['s-harris', 'https://fabricut.com/sharris/'],
  ['sette', 'https://sette7.es/'],
  ['stroheim', 'https://fabricut.com/stroheim/'],
  ['the-vale-london', 'https://thevalelondon.com/'],
  ['timney-fowler', 'https://timneyfowler.com/'],
  ['trend', 'https://fabricut.com/trend/'],
  ['verel-de-belval', 'https://www.metaphores.com/en/verel-de-belval'],
  ['vervain', 'https://fabricut.com/vervain/'],
]

export const up = async (pgm) => {
  for (const [name, slug, country, currency] of REPRESENTED_HOUSES) {
    await pgm.db.query(
      `INSERT INTO brands (name, slug, country, currency, is_international)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slug, country, currency]
    )
  }

  for (const [slug, url] of BRAND_WEBSITES) {
    await pgm.db.query(`UPDATE brands SET website_url = $2 WHERE slug = $1`, [slug, url])
  }
}

/**
 * Removes only the represented-only houses this migration created, and only
 * while they are still empty — once staff have hung a collection or a product
 * off one, dropping it would cascade real catalogue rows away.
 *
 * website_url is NOT restored: the values it replaced were the previous
 * researched map, which is no longer in the tree, and guessing them back would
 * be worse than leaving the client's own links in place.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = async (pgm) => {
  const slugs = REPRESENTED_HOUSES.map(([, slug]) => slug)
  await pgm.db.query(
    `DELETE FROM brands b
      WHERE b.slug = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM products p WHERE p.brand_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM collections c WHERE c.brand_id = b.id)`,
    [slugs]
  )
}
