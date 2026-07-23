// Single source of truth for the Atelier cost-plus pricing waterfall.
// Every screen (Pricing Engine, Sales Order, Catalogue, Journal, storefront) derives its
// figures from here, so the demo stays internally consistent. All figures are INDICATIVE.
//
// Implements the pricing/discount logic from the workshop diagram:
//  · P1 — Wholesale = foreign price ÷ annual actual rate (foreign per NZ$1) × (1 + forex margin) ≈ ÷ CRM rate
//  · P2 — Supplier discount CHAIN — sequential/compounded; empty for discount-inclusive suppliers
//  · P4 — Price incl. duty = COGS
//  · P6 — Retail markup (× multiplier)
//  · P7 — Trade markup taken from cost: percentage OR flat dollar value add
//  · D3 — Client discount tiers: Tier 1 −10%, Tier 2 −5%
//
// FX authority lives in ./fx.js (the annual per-currency table, both conventions); supplier terms
// and per-brand discount structures live in ./suppliers.js, resolved to chains by ./discounts.js.

import { nzdMultiplier } from './fx.js'
import { applyDiscountChain, resolveDiscount } from './discounts.js'

// The editable inputs that drive the waterfall. Percentages are fractions; markups are multipliers.
export const pricingInputs = {
  wholesaleForeign: 48.0, // supplier list price / m in `currency` (Pierre Frey quotes EUR)
  currency: 'EUR', // selects the FX row from the annual table (fx.js)
  forexMargin: 0.1, // P1 — 10% FX buffer, genuinely applied on top of the actual rate
  discountChain: resolveDiscount({ supplier: 'Pierre Frey' }).chain, // P2 — [0.05] averaged supplier rate
  freight: 0.08, // P-ex-duty — freight as a fraction of the supplier-discounted price (percent mode)
  freightDollar: 30, // decision 1 (15 Jul) — flat $/unit add when freightMode is 'dollar'
  freightMode: 'percent', // 'percent' | 'dollar' — user preference toggle (Pricing Engine)
  clearance: 0.02,
  duty: 0.07, // P3 — variable per range/product; not all products are dutiable
  handling: 0.65, // warehouse handling ($/m)
  retailMarkup: 2.2, // P6 — × multiplier (Fabrics)
  tradeMarkup: 0.55, // P7 — +55% markup on cost (percentage mode)
  tradeMarkupDollar: 60, // P7 — flat $/m add (dollar mode)
  tradeMarkupMode: 'percent', // 'percent' | 'dollar'
  tiers: [
    { name: 'Tier 1', pct: 0.1 }, // D3 — Tier 1 clients −10%
    { name: 'Tier 2', pct: 0.05 }, // D3 — Tier 2 clients −5%
  ],
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// Pure cost-plus waterfall. `i` carries the (possibly overridden) inputs; returns raw numbers so
// callers can format or cascade them. `duty` may be null/undefined for non-dutiable products (P3).
export function computeWaterfall(i) {
  // P1 — FX per currency: NZ$ = foreign ÷ actual rate; the +10% margin is applied explicitly here.
  const wholesale =
    (i.wholesaleForeign ?? i.wholesaleEur ?? 0) *
    nzdMultiplier(i.currency || 'EUR', { withMargin: false }) *
    (1 + (i.forexMargin || 0))
  // P2 — sequential discount chain; legacy single supplierDiscount still honoured; [] ⇒ inclusive, step skipped.
  const chain = Array.isArray(i.discountChain) ? i.discountChain : i.supplierDiscount ? [i.supplierDiscount] : []
  const supplierDiscounted = applyDiscountChain(wholesale, chain)
  // Decision 1 (15 Jul): freight is a $ value OR a % of the supplier-discounted price, per preference.
  // Percent mode is algebraically identical to the previous single line, so `canonical` is unchanged.
  const freightCost =
    i.freightMode === 'dollar' ? (i.freightDollar || 0) : supplierDiscounted * (i.freight || 0)
  const priceExDuty = supplierDiscounted * (1 + (i.clearance || 0)) + freightCost
  const duty = i.duty || 0 // P3 — absent duty ⇒ 0 (product carries no duty)
  const cogs = priceExDuty * (1 + duty) // P4 — Price incl. duty = COGS
  const landed = cogs + (i.handling || 0)
  // P6 — retail markup is optional per product; a null multiplier ⇒ no retail price (trade-only).
  const retail = i.retailMarkup ? landed * i.retailMarkup : null
  // P7 — trade markup taken from cost, either as a percentage or a flat dollar add.
  const trade =
    i.tradeMarkupMode === 'dollar'
      ? landed + (i.tradeMarkupDollar || 0)
      : landed * (1 + (i.tradeMarkup || 0))
  const tier1 = trade * (1 - i.tiers[0].pct) // D3
  const tier2 = trade * (1 - i.tiers[1].pct) // D3
  return {
    wholesale: round2(wholesale),
    supplierDiscounted: round2(supplierDiscounted),
    priceExDuty: round2(priceExDuty),
    cogs: round2(cogs),
    landed: round2(landed),
    retail: retail == null ? null : round2(retail),
    trade: round2(trade),
    tier1: round2(tier1),
    tier2: round2(tier2),
  }
}

// The canonical Pierre Frey · Atlas figures the rest of the demo hangs off.
export const canonical = computeWaterfall(pricingInputs)

// ---- formatting helpers (shared) -------------------------------------------
export const nzd = (n) =>
  'NZ$' + Number(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const plain = (n) =>
  Number(n).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const pct = (f) => `${Math.round(f * 100)}%`
export const mult = (m) => `×${m}`

// Trade $/m for a design. Atlas uses the live canonical figure; other designs carry a small,
// stable indicative offset so the catalogue reads plausibly without a full per-brand waterfall.
const DESIGN_OFFSET = { Atlas: 0, Madina: 0.2, Wright: 1.85, Rigatto: 15.6, Peacock: 3.1 }
export const tradeUnit = (design) => round2(canonical.trade + (DESIGN_OFFSET[design] || 0))
