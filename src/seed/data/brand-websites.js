// Official house websites, keyed by brand slug — SEED-OWNED, not a vendored
// atelier-app snapshot (a re-copy of ./data must not overwrite this file).
// Rendered by the storefront brand page as the outbound "Visit {name}" link.
//
// Each URL was found and then adversarially re-verified against the live site
// (house-website-research workflow, 3 Aug 2026 — every entry fetched and
// confirmed as the house's own site or, for a label with no domain of its own,
// the parent group's canonical page for that house). Absent slug = no
// confirmed site = the storefront renders no button; never guess here.
//
// Seed semantics: fills blanks only — a website staff typed into the CRM wins
// over this map on every reseed (COALESCE in seed.js upsertBrands).

export const BRAND_WEBSITES = Object.freeze({
  'pierre-frey': 'https://www.pierrefrey.com/en/',
  'manuel-canovas': 'https://www.manuelcanovas.com/',
  'rubelli-venezia': 'https://www.rubelli.com/en/',
  // jimthompsonfabrics.com is the fabrics business; jimthompson.com is the
  // separate resort-wear/lifestyle site.
  'jim-thompson': 'https://www.jimthompsonfabrics.com/',
  // Diffusion line with no domain of its own — parent's brand page.
  'no-9-thompson': 'https://www.jimthompsonfabrics.com/our-brands/no-9-thompson',
  'colefax-fowler': 'https://www.colefax.com/',
  'jane-churchill': 'https://www.janechurchill.com/',
  larsen: 'https://www.larsenfabrics.com/',
  'de-le-cuona': 'https://delecuona.com/',
  // Parent's dedicated Interiors page; Loro Piana Interiors has no site of its own.
  'loro-piana': 'https://us.loropiana.com/en/interiors',
  // Liberty's own fabrics domain (interiors fabrics + wallpaper live here).
  'liberty-london': 'https://www.libertyfabric.com/',
  // missonihome.com was unreachable at verification time; the parent's
  // canonical Home Collection page stands in.
  'missoni-home': 'https://www.missoni.com/en-us/home-collection/',
  metaphores: 'https://www.metaphores.com/en',
  // dominiquekieffer.com serves a mismatched *.rubelli.com TLS cert — the
  // parent Rubelli brand page is the working canonical.
  kieffer: 'https://www.rubelli.com/en/kieffer',
  'cc-milano': 'https://www.cec-milano.com/',
  'clarence-house': 'https://clarencehouse.com/',
  // Pierre Frey house brands, no domains of their own.
  'fadini-borghi': 'https://www.pierrefrey.com/en/brands/fadini-borghi',
  braquenie: 'https://www.pierrefrey.com/en/brands/braquenie',
  boussac: 'https://www.pierrefrey.com/en/brands/boussac',
  sahco: 'https://www.sahco.com/',
  // Fabricut family brands: their bare domains 301 onto these pages
  // (vervain.com redirect verified; Trend has no standalone domain).
  stroheim: 'https://fabricut.com/stroheim/',
  's-harris': 'https://fabricut.com/sharris/',
  vervain: 'https://fabricut.com/vervain/',
  trend: 'https://fabricut.com/trend/',
  fabricut: 'https://fabricut.com/',
  // Clerici Tessuto's Home Decoration Division site — not the unrelated Lyon
  // scarf house brochiersoieries.com.
  brochier: 'https://brochier.it/',
  'atelier-textiles-nz': 'https://www.atelier.co.nz/',
})
