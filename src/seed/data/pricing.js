// Single source of truth for the Atelier cost-plus pricing waterfall.
// Every screen (Pricing Engine, Sales Order, Catalogue, Journal, storefront) derives its
// figures from here, so the demo stays internally consistent. All figures are INDICATIVE.
//
// Implements the pricing/discount logic from the workshop diagram:
//  · P1 — Wholesale = foreign price ÷ annual actual rate (foreign per NZ$1) × (1 + forex margin) ≈ ÷ CRM rate
//  · P2 — Supplier discount CHAIN — sequential/compounded; empty for discount-inclusive suppliers
//  · P3 — Duty, struck on the supplier-discounted price
//  · P4 — COGS = (price incl. duty + freight) × (1 + clearance)
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
  // P3 — NO DUTY IS STATED, and the absence is the point.
  //
  // This input used to read `duty: 0.07`, and the 7% was invented. The
  // incumbent's own 19,327-row export says so: `Price Incl Duty ÷ Price ex Duty`
  // is exactly 1.00 on 17,776 rows and 1.05 on 1,218, and 7% appears in no band
  // on any range (docs/d365-export-analysis.md, "Step 4 — duty is a flat 5%,
  // applied only to duty-class rows"). It is DELETED rather than corrected to
  // 0.05 because the real table is per-RANGE — a flat 5% on duty class A with
  // per-range exceptions — so a single constant here is the wrong SHAPE whatever
  // number is in it, and a plausible wrong number is harder to notice than a
  // missing one. `computeWaterfall` reads an absent duty as no duty step
  // (`i.duty || 0`), so the preview now shows the waterfall without a duty
  // parameter until the broker's table (A10) arrives and duty is resolved per
  // range from `price_list_items.duty_class`.
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
  const freightCost =
    i.freightMode === 'dollar' ? (i.freightDollar || 0) : supplierDiscounted * (i.freight || 0)
  // P3/P4 — DUTY FIRST, THEN FREIGHT, THEN CLEARANCE OVER BOTH.
  //
  // This order is measured, not chosen. The incumbent's engine computes
  // `(price incl duty + freight$) × (1 + clearance%)`, and that reproduces
  // 19,197 of the 19,201 usable rows of the D365 Product Prices export. The
  // previous line here did the opposite — clearance and freight on the
  // supplier-discounted price, duty struck last on the total — which strikes
  // duty on freight the office already paid and compounds clearance under duty
  // instead of over it. On the canonical figures the two disagree by about 6%,
  // which is a material margin error on luxury goods and exactly the "1% error
  // compounded across 8 steps" the build spec §3.5 warns against shipping.
  //
  // `duty` is absent by default now (see pricingInputs): an unstated duty is no
  // duty step, so the multiplication is by 1 and the step is a pass-through.
  const duty = i.duty || 0
  const priceInclDuty = supplierDiscounted * (1 + duty)
  const cogs = (priceInclDuty + freightCost) * (1 + (i.clearance || 0))
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
    // Renamed with the step order: this value now INCLUDES duty and excludes
    // freight and clearance, the exact opposite of what `priceExDuty` held.
    // Keeping the old key for the new number is the one change that would be
    // silently wrong on every screen that reads it.
    priceInclDuty: round2(priceInclDuty),
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
