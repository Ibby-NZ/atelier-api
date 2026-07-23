// P2 — supplier discount resolution. Discounts are CHAINS of sequential rates so compounded
// structures (JV Fabrics 40+40) work: each rate applies to the RESULT of the one before it,
// so [0.40, 0.40] nets to ×0.36 — not −80%. A single flat rate is just a one-entry chain,
// and discount-inclusive suppliers (Loro Piana) resolve to an empty chain (P2 skipped).

import { supplierByName } from './suppliers.js'

export function applyDiscountChain(price, chain = []) {
  return (chain || []).reduce((p, d) => p * (1 - (d || 0)), price)
}

const pctLabel = (d) => `−${Math.round(d * 100)}%`

export const chainLabel = (chain = []) =>
  chain.length === 0 ? 'No discount step' : chain.map(pctLabel).join(' then ')

// Resolve which discount chain applies for a supplier / brand / category. First match wins:
//  1. unknown supplier       → no chain
//  2. discount-inclusive     → empty chain (Loro Piana — price already net)
//  3. brand.discountChain    → compounded sequence (JV Fabrics 40+40)
//  4. brand.discountTiers    → tier matched by category label, else the 'All other collections' fallback
//  5. brand.discount         → flat per-brand rate (JV sister brands −50%)
//  6. terms.net              → the 9 Jul default: averaged supplier-level rate
export function resolveDiscount({ supplier, brand, category } = {}) {
  const none = { chain: [], source: 'none', label: 'No supplier terms on file' }
  const s = supplierByName(supplier)
  if (!s) return none
  if (s.terms.discountIncluded) {
    return { chain: [], source: 'inclusive', label: 'Discount included in supplied price' }
  }
  const b = brand ? s.brands.find((x) => x.name === brand) : null
  if (b && Array.isArray(b.discountChain)) {
    return { chain: [...b.discountChain], source: 'brand', label: `${b.name} — ${chainLabel(b.discountChain)} (compounded)` }
  }
  if (b && Array.isArray(b.discountTiers)) {
    const wanted = String(category || '').toLowerCase()
    const tier =
      b.discountTiers.find((t) => t.label.toLowerCase() === wanted) ||
      b.discountTiers.find((t) => t.label === 'All other collections') ||
      b.discountTiers[0]
    return { chain: [tier.pct], source: 'brand-tier', label: tier.label }
  }
  if (b && b.discount != null) {
    return { chain: [b.discount], source: 'brand', label: `${b.name} — ${pctLabel(b.discount)}` }
  }
  if (s.terms.net != null) {
    return { chain: [s.terms.net], source: 'supplier-average', label: 'Averaged supplier rate' }
  }
  return none
}
