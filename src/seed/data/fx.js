// Annual FX rate table (A9 — closed 9 Jul 2026). Client convention: FOREIGN units per NZ$1.
// `actual` = the annually-set supplier strike rate; `crm` = the published margin-adjusted rate
// (actual ÷ 1.1, rounded to 2 dp) with the +10% forex margin baked in.
// The engine always computes from `actual` and applies the margin explicitly; `crm` is display/reference.

export const FX_SET_ON = '01 Apr 2026'
export const FX_REVIEW_NOTE = 'Set annually · reviewed annually'
export const FOREX_MARGIN = 0.1 // P1 — the genuine +10% forex buffer

export const fxTable = {
  EUR: { currency: 'EUR', symbol: '€', label: 'Euro', actual: 0.49, crm: 0.45 },
  GBP: { currency: 'GBP', symbol: '£', label: 'Pound sterling', actual: 0.42, crm: 0.38 },
  USD: { currency: 'USD', symbol: 'US$', label: 'US dollar', actual: 0.56, crm: 0.51 },
}

export const fxCurrencies = Object.keys(fxTable)

// Row lookup; unknown/absent currency falls back to EUR so display code never crashes.
// Boundary code (the import engine) must check isKnownCurrency BEFORE relying on this.
export function fxInfo(currency) {
  return fxTable[String(currency || '').toUpperCase()] || fxTable.EUR
}

export function isKnownCurrency(currency) {
  return Boolean(fxTable[String(currency || '').toUpperCase()])
}

// NZ$ per 1 unit of foreign currency. Default INCLUDES the +10% margin (≈ 1 / crm).
// computeWaterfall passes { withMargin: false } because the margin is its own editable step.
export function nzdMultiplier(currency, { withMargin = true } = {}) {
  return (1 / fxInfo(currency).actual) * (withMargin ? 1 + FOREX_MARGIN : 1)
}

export function toNzd(amount, currency, opts) {
  return amount * nzdMultiplier(currency, opts)
}

// Both conventions on one line, e.g. '€0.49 per NZ$1 · NZ$2.2449 / €1 incl. margin (CRM €0.45)'
export function fxLine(currency) {
  const f = fxInfo(currency)
  return `${f.symbol}${f.actual} per NZ$1 · NZ$${nzdMultiplier(f.currency).toFixed(4)} / ${f.symbol}1 incl. margin (CRM ${f.symbol}${f.crm})`
}
