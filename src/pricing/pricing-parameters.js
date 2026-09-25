// The platform's own pricing parameters, and the resolver that turns a house
// into a full set of waterfall inputs.
//
// WHERE EACH INPUT COMES FROM, IN ORDER. A house's override row, then its
// supplier's default row, then "missing" — never zero. The retail markup is
// read from the supplier terms; the DISCOUNT follows the same two-step as
// everything else — the house's own terms (flat, multiplicative chain or
// tiers, resolved by discount-chain.js), then `suppliers.default_discount`,
// the one averaged rate a supplier gives on every house it invoices. The two
// are never summed. Freight comes from the dated `supplier_freight_rates`
// ledger, and the exchange rate
// from `fx_rates` by the supplier's invoicing currency. Every resolved input
// carries its SOURCE, so the screen can say "5% — supplier default" rather than
// "5%", which is the difference between a figure someone set and a figure
// nobody has looked at.
//
// A MISSING INPUT IS NAMED, NOT DEFAULTED. `computeWaterfall` already refuses
// to substitute zero; this module keeps that promise upstream. The one
// deliberate zero is a blank DUTY CLASS: a line with no duty letter carries no
// duty (the rule the D365 corpus proved on all 17,749 such rows), and that is a
// fact about the line, not a missing parameter.
//
// PUT SEMANTICS ON THE PARAMETER ROWS. A row is the whole set for its scope:
// the body carries every column, absent or null clears, and the upsert writes
// them all. A PATCH would let a house override quietly keep a stale duty band
// beside a fresh clearance, and the resolver would have no way to tell.

import { chainMultiplier, resolveTermsChain } from '../suppliers/discount-chain.js'
import { getBrandTerms } from '../suppliers/supplier-terms.js'
import { supplierForBrand } from '../suppliers/brand-suppliers.js'
import { getProductTierId } from '../suppliers/product-tiers.js'
import { resolveFreightRate } from './freight-rates.js'
import { computeWaterfall } from './waterfall.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/** Every column a parameter row carries besides its scope. Frozen: the upsert builds SQL from it. */
export const PARAMETER_COLUMNS = Object.freeze([
  'duty_percent_a',
  'duty_percent_b',
  'duty_percent_c',
  'clearance_percent',
  'trade_markup_percent',
  'fx_margin_percent',
  'handling',
  // The small-order surcharge (migration 1791811200000). Not waterfall inputs
  // — the resolver never reads them — but a house parameter all the same, with
  // the same house-over-supplier precedence and the same PUT semantics.
  'surcharge_min_qty',
  'surcharge_per_unit',
  'note',
])

/** The numeric ones, for coercion; `note` is text. */
export const NUMERIC_PARAMETERS = Object.freeze(PARAMETER_COLUMNS.filter((c) => c !== 'note'))

/** Where a resolved input came from. */
export const INPUT_SOURCES = Object.freeze([
  'house', // the house's own override row
  'supplier', // the supplier's default row
  'terms', // the supplier terms table (discount, retail markup)
  'freight-ledger', // supplier_freight_rates
  'fx', // fx_rates
  'none', // a fact about the line, not a parameter (no duty class => no duty)
  'missing', // nobody has set it
  'manual', // a what-if value the caller supplied for this preview only
])

/** The inputs a preview may override for itself. Nothing here persists. */
export const OVERRIDABLE_INPUTS = Object.freeze([
  'discount_percent',
  'fx_rate',
  'fx_margin_percent',
  'duty_percent',
  'freight',
  'clearance_percent',
  'handling',
  'trade_markup_percent',
  'retail_markup',
])

const DUTY_COLUMN_BY_CLASS = Object.freeze({
  A: 'duty_percent_a',
  B: 'duty_percent_b',
  C: 'duty_percent_c',
})

// pg hands numeric back as a string and Number(null) is 0 — see waterfall.js.
const numeric = (value) => (value == null ? null : Number(value))

const round3 = (value) => Math.round((value + Number.EPSILON) * 1000) / 1000

const SELECT_PARAMETERS = `SELECT id, supplier_id, brand_id, ${PARAMETER_COLUMNS.join(', ')},
  created_at, updated_at FROM supplier_pricing_parameters`

const toParameters = (row) => {
  if (!row) return null
  const values = Object.fromEntries(NUMERIC_PARAMETERS.map((c) => [c, numeric(row[c])]))
  return Object.freeze({
    id: row.id,
    supplier_id: row.supplier_id,
    brand_id: row.brand_id,
    ...values,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })
}

// --- parameter rows ----------------------------------------------------------

/** @returns {Promise<object|null>} the supplier's default set, or null */
export const getSupplierParameters = async (db, supplierId) => {
  const { rows } = await db.query(`${SELECT_PARAMETERS} WHERE supplier_id = $1`, [supplierId])
  return toParameters(rows[0])
}

/** @returns {Promise<object|null>} the house's override set, or null */
export const getBrandParameters = async (db, brandId) => {
  const { rows } = await db.query(`${SELECT_PARAMETERS} WHERE brand_id = $1`, [brandId])
  return toParameters(rows[0])
}

// The scope column is a code literal chosen by the two callers below; the
// values are always placeholders. ON CONFLICT infers the partial unique index
// by repeating its predicate.
const upsertScope = async (db, scopeColumn, scopeId, input) => {
  const values = PARAMETER_COLUMNS.map((column) => input?.[column] ?? null)
  const placeholders = values.map((_, index) => `$${index + 2}`)
  try {
    const { rows } = await db.query(
      `INSERT INTO supplier_pricing_parameters (${scopeColumn}, ${PARAMETER_COLUMNS.join(', ')})
       VALUES ($1, ${placeholders.join(', ')})
       ON CONFLICT (${scopeColumn}) WHERE ${scopeColumn} IS NOT NULL DO UPDATE SET
         ${PARAMETER_COLUMNS.map((column) => `${column} = EXCLUDED.${column}`).join(',\n         ')},
         updated_at = now()
       RETURNING id, supplier_id, brand_id, ${PARAMETER_COLUMNS.join(', ')}, created_at, updated_at`,
      [scopeId, ...values]
    )
    return toParameters(rows[0])
  } catch (error) {
    if (error.code === '23503') {
      throw httpError(404, scopeColumn === 'brand_id' ? 'That house does not exist.' : 'That supplier does not exist.')
    }
    if (error.code === '23514') {
      throw httpError(422, 'A pricing parameter cannot be negative.')
    }
    throw error
  }
}

/** Replace the supplier's default set. */
export const upsertSupplierParameters = (db, supplierId, input) =>
  upsertScope(db, 'supplier_id', supplierId, input)

/** Replace the house's override set. */
export const upsertBrandParameters = (db, brandId, input) =>
  upsertScope(db, 'brand_id', brandId, input)

/** @returns {Promise<boolean>} whether a row was removed */
export const deleteSupplierParameters = async (db, supplierId) => {
  const { rowCount } = await db.query(
    `DELETE FROM supplier_pricing_parameters WHERE supplier_id = $1`,
    [supplierId]
  )
  return rowCount > 0
}

/** @returns {Promise<boolean>} whether a row was removed */
export const deleteBrandParameters = async (db, brandId) => {
  const { rowCount } = await db.query(
    `DELETE FROM supplier_pricing_parameters WHERE brand_id = $1`,
    [brandId]
  )
  return rowCount > 0
}

// --- exchange rates ----------------------------------------------------------

// `set_on` is selected as text (to_char), the freight ledger's rule: pg turns a
// `date` into a JS Date at local midnight, which serialises with a time and a
// zone and no longer reads as the day the office set.
const toFxRate = (row) =>
  row
    ? Object.freeze({
        currency: row.currency,
        rate: Number(row.rate),
        set_on: row.set_on,
        note: row.note,
        updated_at: row.updated_at,
      })
    : null

export const listFxRates = async (db) => {
  const { rows } = await db.query(
    `SELECT currency, rate, to_char(set_on, 'YYYY-MM-DD') AS set_on, note, updated_at FROM fx_rates ORDER BY currency`
  )
  return rows.map(toFxRate)
}

export const getFxRate = async (db, currency) => {
  const { rows } = await db.query(
    `SELECT currency, rate, to_char(set_on, 'YYYY-MM-DD') AS set_on, note, updated_at FROM fx_rates WHERE currency = $1`,
    [currency]
  )
  return toFxRate(rows[0])
}

/** Set (or replace) the rate for one currency. `set_on` defaults to today. */
export const upsertFxRate = async (db, currency, { rate, set_on = null, note = null }) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO fx_rates (currency, rate, set_on, note)
       VALUES ($1, $2, COALESCE($3::date, current_date), $4)
       ON CONFLICT (currency) DO UPDATE SET
         rate = EXCLUDED.rate, set_on = EXCLUDED.set_on, note = EXCLUDED.note, updated_at = now()
       RETURNING currency, rate, to_char(set_on, 'YYYY-MM-DD') AS set_on, note, updated_at`,
      [currency, rate, set_on, note]
    )
    return toFxRate(rows[0])
  } catch (error) {
    if (error.code === '23514') throw httpError(422, 'An exchange rate must be above zero.')
    throw error
  }
}

// --- the resolver --------------------------------------------------------------

const input = (value, source, detail = null) =>
  Object.freeze({ value, source, ...(detail ? { detail } : {}) })

// House override, then supplier default, then missing.
const pickParameter = (column, house, supplierDefaults) => {
  if (house?.[column] != null) return input(house[column], 'house')
  if (supplierDefaults?.[column] != null) return input(supplierDefaults[column], 'supplier')
  return input(null, 'missing')
}

const loadBrand = async (db, brandId) => {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.slug, b.currency AS brand_currency
       FROM brands b
      WHERE b.id = $1 AND b.archived_at IS NULL`,
    [brandId]
  )
  if (rows.length === 0) throw httpError(404, 'That house does not exist.')
  return rows[0]
}

// The house's negotiated terms first, then the supplier's own averaged rate —
// the precedence every other parameter here follows, and the one the 9 Jul rule
// describes: a supplier is rated by one averaged discount UNLESS it was
// excluded and handled brand by brand. The two are never added together.
const discountInput = (terms, category, supplierDefault, tierId) => {
  const resolved = terms ? resolveTermsChain(terms, terms.tiers, category, tierId) : null
  if (resolved && resolved.source !== 'none') {
    // A chain is multiplicative; the waterfall takes the one net percentage.
    const percent = round3((1 - chainMultiplier(resolved.chain)) * 100)
    return input(percent, 'terms', {
      shape: resolved.source, // 'chain' | 'tier' | 'flat'
      label: resolved.label,
      chain: resolved.chain,
    })
  }
  // A fraction off list on the supplier row, reported as the percentage the
  // waterfall subtracts. 0 is a rate that was recorded (prices already net),
  // which is why the test is against null and not falsiness.
  if (supplierDefault != null) {
    return input(round3(Number(supplierDefault) * 100), 'supplier', {
      shape: 'supplier-default',
    })
  }
  return input(null, 'missing')
}

const dutyInput = (dutyClass, house, supplierDefaults) => {
  const letter = typeof dutyClass === 'string' ? dutyClass.trim().toUpperCase() : ''
  if (letter === '') return input(0, 'none', { reason: 'no duty class on the line' })
  const column = DUTY_COLUMN_BY_CLASS[letter]
  if (!column) return input(null, 'missing', { reason: `unknown duty class ${letter}` })
  const picked = pickParameter(column, house, supplierDefaults)
  return input(picked.value, picked.source, { duty_class: letter })
}

const freightInput = async (db, { supplierId, brandName, category, freightClass, on }) => {
  // The HOUSE's own rate first — freight is set per house (a range rate keyed
  // on the house's name, which is also the range name Dynamics used) — then
  // the supplier-wide rate for houses that have none of their own. Within each
  // scope the line's freight CLASS picks the letter's rate over the house's
  // every-class one (resolveFreightRate's precedence).
  const scopes = [
    { range_name: brandName },
    ...(supplierId ? [{ supplier_id: supplierId }] : []),
  ]
  for (const scope of scopes) {
    const found = await resolveFreightRate(db, { ...scope, category, freight_class: freightClass, on })
    if (found.rate) {
      return input(found.rate.rate, 'freight-ledger', {
        basis: found.rate.basis,
        unit: found.rate.unit,
        effective_from: found.rate.effective_from,
        scope: scope.supplier_id ? 'supplier' : 'range',
        // Which rate answered: the letter's own, or every class (null).
        freight_class: found.rate.freight_class,
      })
    }
  }
  return input(null, 'missing', { reason: 'no rate in the freight ledger for this scope' })
}

/**
 * Every waterfall input for one house, each with its source.
 *
 * @param {{ query: Function }} db
 * `supplierId` picks which of the house's suppliers to price through (main when
 * absent, 422 when it does not invoice the house); `productId` brings in the
 * discount tier staff chose for that product (422 when it is another house's).
 * `freightClass` is the line's freight letter (`price_list_items.freight_class`):
 * the house's rate for that letter wins over its every-class rate.
 *
 * @param {{ brandId: number, supplierId?: number|null, productId?: number|null,
 *           category?: string|null, dutyClass?: string|null,
 *           freightClass?: string|null, on?: string|null }} query
 */
export const resolveWaterfallInputs = async (
  db,
  {
    brandId,
    supplierId = null,
    productId = null,
    category = null,
    dutyClass = null,
    freightClass = null,
    on = null,
  }
) => {
  const brand = await loadBrand(db, brandId)
  const supplier = await supplierForBrand(db, brand.id, supplierId)
  const [house, supplierDefaults, terms, tierId] = [
    await getBrandParameters(db, brand.id),
    supplier ? await getSupplierParameters(db, supplier.id) : null,
    await getBrandTerms(db, brand.id),
    productId ? await getProductTierId(db, productId, brand.id) : null,
  ]
  // The supplier's INVOICING currency is what the price list is quoted in; the
  // house's own currency is the seed's stand-in where no supplier is linked.
  const currency = supplier?.currency ?? brand.brand_currency ?? null
  const fx = currency ? await getFxRate(db, currency) : null
  const freight = await freightInput(db, {
    supplierId: supplier?.id ?? null,
    brandName: brand.name,
    category,
    freightClass,
    on,
  })

  const inputs = Object.freeze({
    discount_percent: discountInput(terms, category, supplier?.default_discount ?? null, tierId),
    fx_rate: fx
      ? input(fx.rate, 'fx', { currency, set_on: fx.set_on })
      : input(null, 'missing', { reason: currency ? `no rate set for ${currency}` : 'no currency on the house or its supplier' }),
    fx_margin_percent: pickParameter('fx_margin_percent', house, supplierDefaults),
    duty_percent: dutyInput(dutyClass, house, supplierDefaults),
    freight,
    clearance_percent: pickParameter('clearance_percent', house, supplierDefaults),
    handling: pickParameter('handling', house, supplierDefaults),
    trade_markup_percent: pickParameter('trade_markup_percent', house, supplierDefaults),
    retail_markup: terms?.markup != null ? input(terms.markup, 'terms') : input(null, 'missing'),
  })

  return Object.freeze({
    brand: Object.freeze({ id: brand.id, name: brand.name, slug: brand.slug, supplier_id: supplier?.id ?? null }),
    supplier: supplier
      ? Object.freeze({ id: supplier.id, name: supplier.name, currency: supplier.currency })
      : null,
    product_tier_id: tierId,
    currency,
    parameters: Object.freeze({ house, supplier: supplierDefaults }),
    inputs,
  })
}

// A what-if value stands in for the resolved input, remembering what it
// replaced. A freight override is dollars per unit (the ledger's default
// basis); a percentage rate can only come from the ledger itself.
const applyOverrides = (inputs, overrides = {}) => {
  const next = { ...inputs }
  for (const key of OVERRIDABLE_INPUTS) {
    const value = overrides[key]
    if (value === undefined || value === null || value === '') continue
    const number = Number(value)
    if (!Number.isFinite(number) || number < 0) continue
    const was = inputs[key]
    next[key] = input(number, 'manual', {
      ...(key === 'freight' ? { basis: 'dollar', unit: was?.detail?.unit ?? null } : {}),
      replaced: { value: was?.value ?? null, source: was?.source ?? 'missing' },
    })
  }
  return Object.freeze(next)
}

/**
 * The waterfall for one house at one wholesale rate, with every input's source.
 * `overrides` are what-if values for this preview only — the screen's Manual
 * mode — and never touch a row.
 *
 * @param {{ query: Function }} db
 * @param {{ brandId: number, wholesaleRate: number, supplierId?: number|null,
 *           productId?: number|null, category?: string|null,
 *           dutyClass?: string|null, freightClass?: string|null,
 *           on?: string|null, overrides?: object }} query
 */
export const previewWaterfall = async (
  db,
  {
    brandId,
    wholesaleRate,
    supplierId = null,
    productId = null,
    category = null,
    dutyClass = null,
    freightClass = null,
    on = null,
    overrides = {},
  }
) => {
  const resolved = await resolveWaterfallInputs(db, {
    brandId,
    supplierId,
    productId,
    category,
    dutyClass,
    freightClass,
    on,
  })
  const inputs = applyOverrides(resolved.inputs, overrides)
  const waterfall = computeWaterfall({
    wholesale_rate: wholesaleRate,
    currency: resolved.currency,
    discount_percent: inputs.discount_percent.value,
    fx_rate: inputs.fx_rate.value,
    fx_margin_percent: inputs.fx_margin_percent.value,
    duty_percent: inputs.duty_percent.value,
    freight: inputs.freight.value,
    freight_basis: inputs.freight.detail?.basis ?? 'dollar',
    freight_unit: inputs.freight.detail?.unit ?? null,
    clearance_percent: inputs.clearance_percent.value,
    handling: inputs.handling.value,
    trade_markup_percent: inputs.trade_markup_percent.value,
    retail_markup: inputs.retail_markup.value,
  })
  return Object.freeze({ ...resolved, inputs, wholesale_rate: wholesaleRate, waterfall })
}
