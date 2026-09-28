// The cost-plus pricing waterfall (W16 US-006). Pure: no database, no config,
// no I/O.
//
// THIS IS A RE-IMPLEMENTATION OF `src/seed/data/pricing.js`, NOT AN IMPORT, and
// that is the same standing rule `src/suppliers/discount-chain.js` states in its
// own header: `src/seed/data/` is a vendored snapshot of the demo app, re-copied
// whenever the demo catalogue changes, and re-copying it must never be able to
// change what this API computes.
//
// TWO THINGS THE DEMO GETS WRONG, NEITHER OF WHICH MAY BE COPIED.
//
//  1. ITS STEP ORDER IS WRONG. It computes
//     `supplierDiscounted x (1 + clearance) + freight`, and applies duty AFTER
//     both. The incumbent's engine, reconstructed from the client's own
//     parameters and checked against the D365 export's stored figures on 19,197
//     of 19,201 rows, is
//
//         Landed = (Price incl Duty + FREIGHT$) x (1 + Clearance%)
//
//     duty BEFORE freight, clearance over BOTH. Clearance multiplies the
//     duty-paid value plus the freight, not the goods alone — proved by
//     GARRETT LEATHER, which lands 42 hides of zero wholesale value at $11.00
//     on freight $10 and clearance 10: (0 + 10) x 1.10. The demo's order is a
//     different number on every row.
//
//  2. ITS CONSTANTS ARE WRONG. Freight 8% is right on 632 of 19,159 rows
//     (3.3%) — the real dollar freight expressed as a percentage of duty-paid
//     value has a median of 27% and a maximum of 2,186%, so a flat percentage
//     under-charges cheap goods by an order of magnitude and over-charges
//     expensive ones. And duty 7% appears NOWHERE, in any band, on any range:
//     54 of 58 ranges are 5%, one is 10% and one (the domestic supplier) is 0%.
//     So this module has NO default rate of any kind. Every rate is an input.
//
// A PARTIAL RESULT NAMES ITS MISSING INPUTS AND NEVER SUBSTITUTES ZERO.
// `{ steps, landed: null, missing: ['fx_rate', 'handling', 'trade_markup'] }` —
// the `net_multiplier: null` + `invalid_reason` posture `listSupplierBrandTerms`
// already uses. A landed cost that silently treats four missing inputs as zero
// looks exactly as authoritative as one that is right and is wrong by a factor.
// Of the seven inputs, three still have no source at all (FX rate and margin,
// handling $/unit, the retail markup); duty, clearance and the trade markup
// arrived with the parameter export on 12 August; freight has this table and no
// rows in it until F1 is answered.
//
// BLANK IS NOT ZERO HERE. Where a blank legitimately means zero — a blank
// supplier discount, a blank duty letter, both verified over the whole corpus —
// that resolution belongs to the read model that knows the evidence
// (`src/pricing/tracking-parameters.js`). By the time a value reaches this
// function, null means "nobody has told us", full stop.

/** Every input this waterfall can take, in the order the steps consume them. */
export const WATERFALL_INPUTS = Object.freeze([
  'wholesale_rate',
  'discount',
  'fx_rate',
  'fx_margin',
  'duty',
  'freight',
  'clearance',
  'handling',
  'trade_markup',
  'retail_markup',
])

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100

// A number, or null. `''`, null, undefined and NaN are all "nobody has told us";
// 0 is a real rate and survives.
const stated = (value) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const STEP_LABELS = Object.freeze({
  wholesale: 'Wholesale rate',
  export_price: 'Export price (after supplier discount)',
  price_ex_duty: 'Price ex duty, NZ$',
  price_incl_duty: 'Price incl duty, NZ$',
  freight_amount: 'Freight, NZ$ per unit',
  landed_ex_handling: 'Landed cost before handling, NZ$',
  landed: 'Landed cost, NZ$',
  trade_sell: 'Trade sell, NZ$',
  retail_sell: 'Retail sell, NZ$',
})

/** The step keys, in waterfall order. The preview route renders them as rows. */
export const WATERFALL_STEPS = Object.freeze(Object.keys(STEP_LABELS))

/**
 * Compute what can be computed and name what is missing.
 *
 * Inputs are in the parameter table's own units: percentages as 5 (not 0.05),
 * `freight` in dollars per unit under the default `dollar` basis.
 * `retail_markup_percent` is on the TRADE sell (30 = trade × 1.30);
 * `retail_markup` is the older MULTIPLIER on landed, read only without it.
 *
 * @param {{
 *   wholesale_rate?: number|string|null, currency?: string|null,
 *   discount_percent?: number|string|null,
 *   fx_rate?: number|string|null, fx_margin_percent?: number|string|null,
 *   duty_percent?: number|string|null,
 *   freight?: number|string|null, freight_basis?: 'dollar'|'percent',
 *   freight_unit?: string|null,
 *   clearance_percent?: number|string|null, clearance_basis?: 'percent'|'dollar'|null,
 *   handling?: number|string|null,
 *   trade_markup_percent?: number|string|null,
 *   retail_markup_percent?: number|string|null,
 *   retail_markup?: number|string|null,
 * }} input
 * @returns {Readonly<{ steps: object[], landed: number|null, trade_sell: number|null,
 *                      retail_sell: number|null, missing: string[] }>}
 */
export const computeWaterfall = (input = {}) => {
  const missing = []
  const need = (name, value) => {
    if (value === null) missing.push(name)
    return value
  }

  const wholesale = need('wholesale_rate', stated(input.wholesale_rate))
  const discount = need('discount', stated(input.discount_percent))
  const fxRate = need('fx_rate', stated(input.fx_rate))
  const fxMargin = need('fx_margin', stated(input.fx_margin_percent))
  const duty = need('duty', stated(input.duty_percent))
  const freightRate = need('freight', stated(input.freight))
  const clearance = need('clearance', stated(input.clearance_percent))
  const handling = need('handling', stated(input.handling))
  const tradeMarkup = need('trade_markup', stated(input.trade_markup_percent))
  // The retail markup is the one input the corpus proves is NOT a constant:
  // Retail / Trade is 1.30 on 92% of rows but 1.35, 1.40, 1.50 or 1.80 on
  // thirteen ranges. It cannot be inferred and has to be asked for. The house's
  // PERCENTAGE on the trade sell is Dynamics' own rule; the older multiplier on
  // landed (supplier terms) stands in only where no percentage is set.
  const retailPercent = stated(input.retail_markup_percent)
  const retailMarkup = retailPercent === null ? need('retail_markup', stated(input.retail_markup)) : null

  // P2 — one resolved rate off list. The multiplicative CHAIN a supplier may
  // quote instead ("40% then 40%" is x0.36) is resolved upstream by
  // `src/suppliers/discount-chain.js`; this step takes the net percentage.
  const exportPrice = wholesale === null || discount === null ? null : wholesale * (1 - discount / 100)

  // P1/P3 — the PRICE exchange rate is the actual rate softened by the margin,
  // which is what makes NZ$ cost more rather than less. Divided, not
  // multiplied: `fx_rate` is foreign currency per NZ$1.
  const priceFx =
    fxRate === null || fxMargin === null || fxRate === 0 ? null : fxRate / (1 + fxMargin / 100)
  const priceExDuty = exportPrice === null || priceFx === null ? null : exportPrice / priceFx

  // P4 — the duty LETTER is on the price row and the RATE is on the range;
  // resolving the pair is `dutyPercentFor`'s job, and a row whose band is blank
  // arrives here as null, which is no defined duty rather than no duty.
  const priceInclDuty = priceExDuty === null || duty === null ? null : priceExDuty * (1 + duty / 100)

  // Dollars is the default and the recommendation; percent stays computable
  // because the client's own team set the current 8%, and it is a percentage of
  // the duty-paid value — the quantity §6 of the analysis measured.
  const freightAmount =
    freightRate === null
      ? null
      : input.freight_basis === 'percent'
        ? priceInclDuty === null
          ? null
          : priceInclDuty * (freightRate / 100)
        : freightRate

  // The verified incumbent figure: duty before freight, clearance over both.
  // Clearance is a percentage of that by default; a house may state it in
  // dollars per unit instead (`clearance_basis: 'dollar'`, 28 Sep 2026).
  const landedExHandling =
    priceInclDuty === null || freightAmount === null || clearance === null
      ? null
      : input.clearance_basis === 'dollar'
        ? priceInclDuty + freightAmount + clearance
        : (priceInclDuty + freightAmount) * (1 + clearance / 100)

  // Warehouse handling has no source anywhere in this schema, so the platform's
  // OWN landed cost stays null while the incumbent's reconstruction above is
  // reported beside it. Two figures, honestly labelled, rather than one that
  // quietly means whichever the reader assumed.
  const landed = landedExHandling === null || handling === null ? null : landedExHandling + handling

  const tradeSell = landed === null || tradeMarkup === null ? null : landed * (1 + tradeMarkup / 100)
  const retailSell =
    retailPercent !== null
      ? tradeSell === null ? null : tradeSell * (1 + retailPercent / 100)
      : landed === null || retailMarkup === null ? null : landed * retailMarkup

  const amounts = {
    wholesale,
    export_price: exportPrice,
    price_ex_duty: priceExDuty,
    price_incl_duty: priceInclDuty,
    freight_amount: freightAmount,
    landed_ex_handling: landedExHandling,
    landed,
    trade_sell: tradeSell,
    retail_sell: retailSell,
  }

  return Object.freeze({
    currency: input.currency ?? null,
    freight_unit: input.freight_unit ?? null,
    // Every step is present whether or not it resolved, so a reader can see
    // WHERE the chain stopped rather than inferring it from a short list.
    // Rounding happens here and nowhere earlier: rounding each intermediate
    // instead costs about 60% of the exact matches against the export's own
    // figures and reads as a broken formula.
    steps: Object.freeze(
      WATERFALL_STEPS.map((step) =>
        Object.freeze({
          step,
          label: STEP_LABELS[step],
          amount: amounts[step] === null ? null : round2(amounts[step]),
        })
      )
    ),
    landed: landed === null ? null : round2(landed),
    trade_sell: tradeSell === null ? null : round2(tradeSell),
    retail_sell: retailSell === null ? null : round2(retailSell),
    missing: Object.freeze(missing),
  })
}
