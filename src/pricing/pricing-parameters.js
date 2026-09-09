// The platform's own pricing parameters, and the resolver that turns a house
// into a full set of waterfall inputs.
//
// WHERE EACH INPUT COMES FROM, IN ORDER. A house's override row, then its
// supplier's default row, then "missing" — never zero. Discount and retail
// markup are read from the supplier terms (the one place a discount may
// live: flat, multiplicative chain or tiers, resolved by discount-chain.js),
// freight from the dated `supplier_freight_rates` ledger, and the exchange rate
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
    `SELECT b.id, b.name, b.slug, b.currency AS brand_currency, b.supplier_id,
            s.name AS supplier_name, s.currency AS supplier_currency
       FROM brands b
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.id = $1 AND b.archived_at IS NULL`,
    [brandId]
  )
  if (rows.length === 0) throw httpError(404, 'That house does not exist.')
  return rows[0]
}

const discountInput = (terms, category) => {
  if (!terms) return input(null, 'missing')
  const resolved = resolveTermsChain(terms, terms.tiers, category)
  if (resolved.source === 'none') return input(null, 'missing')
  // A chain is multiplicative; the waterfall takes the one net percentage.
  const percent = round3((1 - chainMultiplier(resolved.chain)) * 100)
  return input(percent, 'terms', {
    shape: resolved.source, // 'chain' | 'tier' | 'flat'
    label: resolved.label,
    chain: resolved.chain,
  })
}

const dutyInput = (dutyClass, house, supplierDefaults) => {
  const letter = typeof dutyClass === 'string' ? dutyClass.trim().toUpperCase() : ''
  if (letter === '') return input(0, 'none', { reason: 'no duty class on the line' })
  const column = DUTY_COLUMN_BY_CLASS[letter]
  if (!column) return input(null, 'missing', { reason: `unknown duty class ${letter}` })
  const picked = pickParameter(column, house, supplierDefaults)
  return input(picked.value, picked.source, { duty_class: letter })
}

const freightInput = async (db, { supplierId, brandName, category, on }) => {
  // Supplier scope first; the ledger can also carry a rate under a range name,
  // and a house's name is the range name Dynamics used for it.
  const scopes = [
    ...(supplierId ? [{ supplier_id: supplierId }] : []),
    { range_name: brandName },
  ]
  for (const scope of scopes) {
    const found = await resolveFreightRate(db, { ...scope, category, on })
    if (found.rate) {
      return input(found.rate.rate, 'freight-ledger', {
        basis: found.rate.basis,
        unit: found.rate.unit,
        effective_from: found.rate.effective_from,
        scope: scope.supplier_id ? 'supplier' : 'range',
      })
    }
  }
  return input(null, 'missing', { reason: 'no rate in the freight ledger for this scope' })
}

/**
 * Every waterfall input for one house, each with its source.
 *
 * @param {{ query: Function }} db
 * @param {{ brandId: number, category?: string|null, dutyClass?: string|null, on?: string|null }} query
 */
export const resolveWaterfallInputs = async (db, { brandId, category = null, dutyClass = null, on = null }) => {
  const brand = await loadBrand(db, brandId)
  const [house, supplierDefaults, terms] = [
    await getBrandParameters(db, brand.id),
    brand.supplier_id ? await getSupplierParameters(db, brand.supplier_id) : null,
    await getBrandTerms(db, brand.id),
  ]
  // The supplier's INVOICING currency is what the price list is quoted in; the
  // house's own currency is the seed's stand-in where no supplier is linked.
  const currency = brand.supplier_currency ?? brand.brand_currency ?? null
  const fx = currency ? await getFxRate(db, currency) : null
  const freight = await freightInput(db, {
    supplierId: brand.supplier_id,
    brandName: brand.name,
    category,
    on,
  })

  const inputs = Object.freeze({
    discount_percent: discountInput(terms, category),
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
    brand: Object.freeze({ id: brand.id, name: brand.name, slug: brand.slug, supplier_id: brand.supplier_id }),
    supplier: brand.supplier_id
      ? Object.freeze({ id: brand.supplier_id, name: brand.supplier_name, currency: brand.supplier_currency })
      : null,
    currency,
    parameters: Object.freeze({ house, supplier: supplierDefaults }),
    inputs,
  })
}

/**
 * The waterfall for one house at one wholesale rate, with every input's source.
 *
 * @param {{ query: Function }} db
 * @param {{ brandId: number, wholesaleRate: number, category?: string|null,
 *           dutyClass?: string|null, on?: string|null }} query
 */
export const previewWaterfall = async (db, { brandId, wholesaleRate, category = null, dutyClass = null, on = null }) => {
  const resolved = await resolveWaterfallInputs(db, { brandId, category, dutyClass, on })
  const { inputs } = resolved
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
  return Object.freeze({ ...resolved, wholesale_rate: wholesaleRate, waterfall })
}
