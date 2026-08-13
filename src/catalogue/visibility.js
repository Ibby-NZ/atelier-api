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

// Trade prices are precomputed through the pricing waterfall and stored in
// integer NZD cents, whatever `products.currency` (the SUPPLIER's currency,
// which belongs to the retail figure) says. A line priced off the trade figure
// is therefore always quoted in NZD.
export const TRADE_CURRENCY = 'NZD'

// SQL predicate for "a house a signed-out visitor may browse". Every public
// read model that reaches products has to apply this when the viewer is not
// entitled — the listing, the detail lookup, the collection counts, and the two
// SKU-resolving transactional paths (checkout, order request). `b` is the
// brands alias every one of those queries already uses.
export const PUBLIC_BRAND_CONDITION = 'b.trade_only = false'
