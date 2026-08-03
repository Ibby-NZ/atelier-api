// Official house websites, keyed by brand slug — SEED-OWNED, not a vendored
// atelier-app snapshot (a re-copy of ./data must not overwrite this file).
// Rendered by the storefront brand page as the outbound "Visit {name}" link.
//
// SOURCE: the client's own roster of 39 houses and links (4 Aug 2026). It
// supersedes the earlier researched map wholesale — where the two disagreed,
// the client's link won, including where ours was arguably better sourced
// (Kieffer, Liberty, Loro Piana, Missoni, Braquenié, Fadini Borghi). Do not
// "correct" an entry back to a researched URL; if one looks wrong, raise it.
//
// Three normalisations were applied to the supplied list, and nothing else:
//  - http:// → https:// (Pierre Frey, Rubelli, Garrett Leather). Same
//    destination, and all three redirect to TLS anyway; a plaintext outbound
//    link from a live storefront is not worth preserving verbatim.
//  - Stripped `?srsltid=…` from The Vale London — a Google Shopping click-
//    tracking token that expires and is meaningless outside that click.
//  - Trailing slash added to Jane Churchill, to match every other root URL here.
//
// Two entries are NOT on the client's roster and are kept: `sahco` (a stocked
// house they did not mention) and `atelier-textiles-nz` (Atelier's own site).
//
// Absent slug = no link on file = the storefront renders no button. Never
// guess here.
//
// Seed semantics: fills blanks only — a website staff typed into the CRM wins
// over this map on every reseed (COALESCE in seed.js upsertBrands). That is why
// the roster change also ships as a data migration: on an already-seeded
// database every one of these slugs already held a URL, so a reseed alone would
// have kept all the old ones.

export const BRAND_WEBSITES = Object.freeze({
  alpaka: 'https://alpaka-shop.com/interior/',
  'armani-casa': 'https://www.armani.com/en-nz/armani-casa/experience/textiles/',
  boussac: 'https://www.pierrefrey.com/en/brands/boussac',
  braquenie: 'https://www.pierrefrey.com/en/collections?brand=braquenie',
  brochier: 'https://brochier.it/',
  'cc-milano': 'https://www.cec-milano.com/',
  'clarence-house': 'https://clarencehouse.com/',
  'colefax-fowler': 'https://www.colefax.com/',
  'de-le-cuona': 'https://delecuona.com/',
  fabricut: 'https://fabricut.com/',
  'fadini-borghi': 'https://www.pierrefrey.com/en/collections?brand=fadini-borghi',
  'filippo-uecher': 'https://filippouecher.it/',
  fine: 'https://www.fine.at/',
  'garrett-leather': 'https://www.garrettleather.com/',
  hamam: 'https://www.hamam.com/en-intl/',
  'jane-churchill': 'https://www.janechurchill.com/',
  'jean-monro': 'https://www.jeanmonro.com/',
  // jimthompsonfabrics.com is the fabrics business; jimthompson.com is the
  // separate resort-wear/lifestyle site.
  'jim-thompson': 'https://www.jimthompsonfabrics.com/',
  kieffer: 'https://www.kieffertextiles.com/',
  larsen: 'https://www.larsenfabrics.com/',
  // Métaphores group house, no domain of its own.
  'le-crin': 'https://www.metaphores.com/en',
  'liberty-london': 'https://www.libertyfabric.com/product-category/fabrics/',
  'loro-piana': 'https://www.loropiana.com/interiors/?lang=en',
  madeaux: 'https://www.madeaux.com/',
  'manuel-canovas': 'https://www.manuelcanovas.com/',
  'maria-flora': 'https://mariaflora.com/',
  metaphores: 'https://www.metaphores.com/?_locale=en',
  'missoni-home': 'https://www.missonihome-wallcoverings.com/en/',
  // Diffusion line with no domain of its own — parent's brand page.
  'no-9-thompson': 'https://www.jimthompsonfabrics.com/our-brands/no-9-thompson',
  'pierre-frey': 'https://www.pierrefrey.com/',
  'rubelli-venezia': 'https://rubelli.com/',
  's-harris': 'https://fabricut.com/sharris/',
  sette: 'https://sette7.es/',
  stroheim: 'https://fabricut.com/stroheim/',
  'the-vale-london': 'https://thevalelondon.com/',
  'timney-fowler': 'https://timneyfowler.com/',
  trend: 'https://fabricut.com/trend/',
  // Métaphores group house, no domain of its own.
  'verel-de-belval': 'https://www.metaphores.com/en/verel-de-belval',
  vervain: 'https://fabricut.com/vervain/',

  // --- Not on the client's roster, kept ---
  // Stocked house the roster does not mention; previously verified.
  sahco: 'https://www.sahco.com/',
  // Atelier's own site.
  'atelier-textiles-nz': 'https://www.atelier.co.nz/',
})
