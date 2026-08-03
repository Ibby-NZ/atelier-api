// Houses Atelier represents that carry NO catalogue rows yet — SEED-OWNED, not
// a vendored atelier-app snapshot (a re-copy of ./data must not overwrite this
// file).
//
// realCatalogue.js only knows houses that have products or designs behind them,
// so a house we represent but hold nothing from could never reach the brands
// table. The client's roster (4 Aug 2026) names fourteen of them, and the
// storefront needs them for the same reason the client asked: /brands is the
// list of houses we represent, not the list of houses currently in stock.
//
// Each renders a complete brand page with no collections section — that gate is
// house-level in the storefront (lib/collections.js: no products under the
// house, no section, heading included), so an empty house degrades to its
// facts list and its "Visit {name}" button rather than to an empty grid.
//
// `currency` is the SUPPLIER's invoicing currency, not the country's — the same
// rule suppliers.js follows, which is why Jim Thompson (Thailand) is USD. None
// of these houses has a supplier record yet and none has a product, so nothing
// renders this value today; it is the default a first product inherits, and
// staff correct it in the CRM when the trading terms are known. Hamam is the
// one entry taken from its region rather than from a known invoice.
//
// Country spellings follow realCatalogue.js — "England", never "United
// Kingdom".

export const REPRESENTED_HOUSES = Object.freeze([
  // Estonian alpaca-wool interior accessories (rugs, cushions, throws).
  Object.freeze({ name: 'Alpaka', slug: 'alpaka', country: 'Estonia', currency: 'EUR' }),
  // Giorgio Armani's interior textiles line, Milan. suppliers.js already files
  // "Armani" under a EUR supplier group.
  Object.freeze({
    name: 'Armani Casa',
    slug: 'armani-casa',
    country: 'Italy',
    currency: 'EUR',
  }),
  Object.freeze({
    name: 'Filippo Uecher',
    slug: 'filippo-uecher',
    country: 'Italy',
    currency: 'EUR',
  }),
  // Upholstery and decorative cloth, Mils, Austria.
  Object.freeze({ name: 'Fine', slug: 'fine', country: 'Austria', currency: 'EUR' }),
  // Upholstery leather, Buffalo NY. Spelt "Garrett" — the client's list wrote
  // "Garret", but the house's own name and domain carry the double T.
  Object.freeze({
    name: 'Garrett Leather',
    slug: 'garrett-leather',
    country: 'USA',
    currency: 'USD',
  }),
  // Turkish cotton bath and bed linen. Currency is the least certain here: no
  // invoice on file, and the site quotes no price.
  Object.freeze({ name: 'Hamam', slug: 'hamam', country: 'Turkey', currency: 'EUR' }),
  Object.freeze({
    name: 'Jean Monro',
    slug: 'jean-monro',
    country: 'England',
    currency: 'GBP',
  }),
  // Métaphores group house (horsehair), sold off the Métaphores site.
  Object.freeze({ name: 'Le Crin', slug: 'le-crin', country: 'France', currency: 'EUR' }),
  Object.freeze({ name: 'Madeaux', slug: 'madeaux', country: 'England', currency: 'GBP' }),
  // Outdoor cloth — "filatori, tessitori, editori di tessuti per esterni".
  Object.freeze({
    name: 'Maria Flora',
    slug: 'maria-flora',
    country: 'Italy',
    currency: 'EUR',
  }),
  Object.freeze({ name: 'Sette', slug: 'sette', country: 'Spain', currency: 'EUR' }),
  Object.freeze({
    name: 'The Vale London',
    slug: 'the-vale-london',
    country: 'England',
    currency: 'GBP',
  }),
  Object.freeze({
    name: 'Timney Fowler',
    slug: 'timney-fowler',
    country: 'England',
    currency: 'GBP',
  }),
  // Métaphores group house (Lyon silks), sold off the Métaphores site.
  Object.freeze({
    name: 'Verel de Belval',
    slug: 'verel-de-belval',
    country: 'France',
    currency: 'EUR',
  }),
])
