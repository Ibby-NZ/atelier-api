// Evaluation of a supplier discount chain. Pure — no DB, no config.
//
// A chain is a SEQUENCE of rates, each applied to what the one before it left,
// because that is how the houses excluded from the averaged rule actually
// quote: JV Fabrics is "40% off, then 40% off the result". So {0.4, 0.4} is
// x0.36, not -80%. Summing a chain is the mistake this module exists to
// prevent; it is also why `supplier_brand_terms.discount_chain` is an array
// rather than a single numeric.

// pg returns `numeric` and `numeric[]` as strings, so every rate is coerced
// before it is used in arithmetic. A rate that is not a fraction off list is a
// data fault, not a number to multiply by: 1 is a free metre and a negative one
// is a surcharge wearing a discount's name.
const rateFrom = (rate, index) => {
  const value = Number(rate)
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`discount chain rate ${index} is not a fraction below 1: ${rate}`)
  }
  return value
}

/**
 * The net multiplier a chain resolves to. An empty or absent chain is x1 —
 * "no chain", which is not the same statement as "no discount" (a
 * discount-inclusive supplier is recorded on the supplier, not here).
 *
 * @param {Array<number|string>} [chain]
 * @returns {number}
 */
export const chainMultiplier = (chain = []) =>
  (chain || []).reduce((multiplier, rate, index) => multiplier * (1 - rateFrom(rate, index)), 1)

/**
 * A price with the chain applied, in the price's own units.
 *
 * @param {number|string} price
 * @param {Array<number|string>} [chain]
 * @returns {number}
 */
export const applyDiscountChain = (price, chain = []) => {
  const value = Number(price)
  if (!Number.isFinite(value)) {
    throw new Error(`price is not a number: ${price}`)
  }
  return value * chainMultiplier(chain)
}

/**
 * The chain a terms row resolves to, in the precedence the seed snapshot's
 * `resolveDiscount` established: a compounded chain, then the tier matching the
 * line's category (falling back to the tier flagged `is_fallback`), then the
 * flat per-brand rate. The database keeps the first two mutually exclusive with
 * the third; this is what picks between a chain and a tier set.
 *
 * @param {{ discount?: number|string|null, discount_chain?: Array<number|string> }} terms
 * @param {Array<{ label: string, pct: number|string, is_fallback?: boolean }>} [tiers]
 * @param {string|null} [category]
 * @returns {{ chain: Array<number|string>, source: 'chain'|'tier'|'flat'|'none', label: string|null }}
 */
export const resolveTermsChain = (terms, tiers = [], category = null) => {
  const chain = terms?.discount_chain || []
  if (chain.length > 0) return { chain: [...chain], source: 'chain', label: null }

  if (tiers.length > 0) {
    const wanted = String(category || '').trim().toLowerCase()
    const tier =
      (wanted && tiers.find((t) => t.label.trim().toLowerCase() === wanted)) ||
      tiers.find((t) => t.is_fallback) ||
      null
    if (tier) return { chain: [tier.pct], source: 'tier', label: tier.label }
  }

  if (terms?.discount != null) return { chain: [terms.discount], source: 'flat', label: null }

  return { chain: [], source: 'none', label: null }
}
