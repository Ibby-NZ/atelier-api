// Who may see which houses' products — the catalogue's OTHER gate.
//
// There are two independent gates on the public catalogue and confusing them is
// the easy mistake:
//
//   - PRICE (FR-3, `includeTrade`): who may see `trade_price_cents`. Approved
//     trade only. Staff deliberately do NOT get it (see guards.js) — a back
//     office login is not a trade customer.
//   - VISIBILITY (this module, `includeTradeOnly`): whose products appear at
//     all. A public visitor browses the house's own workroom; everything
//     Atelier represents is reserved for approved trade — and for staff, who
//     have to be able to check the real storefront against what they published.
//
// The two are separate on purpose: staff see the whole library without ever
// being served trade pricing.
//
// The flag itself lives on `brands.trade_only` (migration
// 1786161600000_brand-trade-only), defaulting closed, so a house added in the
// CRM is never accidentally public.

import { effectiveRole } from '../auth/guards.js'

// Roles that may browse represented houses. `effectiveRole` collapses an
// unapproved trade application to `customer`, so a pending applicant sees
// exactly what a signed-out visitor sees.
const TRADE_CATALOGUE_ROLES = Object.freeze(['trade', 'backoffice', 'director'])

/**
 * May this viewer see products from the houses Atelier represents?
 *
 * @param {{ role?: string, trade_approved?: boolean }|null|undefined} user
 *   the /auth/me user, or null when signed out
 * @returns {boolean}
 */
export const canSeeTradeCatalogue = (user) =>
  !!user && TRADE_CATALOGUE_ROLES.includes(effectiveRole(user))

/**
 * May this viewer be QUOTED and CHARGED `trade_price_cents`? Approved trade
 * only — staff are excluded, exactly as on the catalogue read models (FR-3).
 * The catalogue routes, the checkout and the webhook all derive their price
 * basis from this one predicate: a figure shown on a product card and the
 * amount Stripe takes have to come from the same rule.
 *
 * @param {{ role?: string, trade_approved?: boolean }|null|undefined} user
 * @returns {boolean}
 */
export const canSeeTradePricing = (user) => !!user && effectiveRole(user) === 'trade'

// THE ONE CURRENCY A CUSTOMER IS EVER QUOTED, and it is the CUSTOMER'S, not the
// supplier's. Every public figure — a card, a product page, a cart line, a
// Stripe line item — is denominated here.
//
// `products.currency` is the SUPPLIER's currency (EUR for Pierre Frey, USD for
// Trend). It describes what Atelier PAYS, and nothing else: both price columns
// are already stored in New Zealand cents whatever it says. `trade_price_cents`
// is precomputed through the pricing waterfall, which computes in NZ$
// throughout; `retail_price_cents` comes from the office, the seed, or the D365
// merge — and that merge only ever fills a price from a line whose currency IS
// New Zealand (`src/legacy/merge.js`). So the supplier currency has never
// described either figure, and publishing it beside them is what put "US$429"
// on one card and "NZ$389" on the next one down.
//
// ONE SELLING REGION PER DEPLOYMENT. New Zealand: the shipping tiers price only
// NZ zones, GST is 15%, and one Stripe session charges in one currency. A second
// selling region is therefore not a formatting change — it needs a rate source,
// a rounding rule and a Stripe account that settles in it — so this is a
// constant rather than config that could be set to a currency nothing converts
// into.
export const STORE_REGION = 'NZ'
export const STORE_CURRENCY = 'NZD'

// SQL predicate for "a house a signed-out visitor may browse". Every public
// read model that reaches products has to apply this when the viewer is not
// entitled — the listing, the detail lookup, the collection counts, and the two
// SKU-resolving transactional paths (checkout, order request). `b` is the
// brands alias every one of those queries already uses.
export const PUBLIC_BRAND_CONDITION = 'b.trade_only = false'

// SQL predicate for "a SKU still on the storefront", mirroring what the public
// read models filter on (`products.js`, `product-detail.js`). The two
// SKU-resolving transactional paths must apply it as well or they sell what the
// storefront 404s: archiving a BRAND does not cascade `show_on_website = false`
// onto its products, so a departed house's designs stay flagged visible and
// only `b.archived_at` closes them — and the same holds for a colourway
// archived on its own, whose SKU vanishes from the detail page and the swatch
// strip while still resolving here. `c`/`p`/`b` are the colourways/products/
// brands aliases both of those queries already use.
export const LISTED_SKU_CONDITION =
  'p.show_on_website = true AND p.archived_at IS NULL AND b.archived_at IS NULL AND c.archived_at IS NULL'
