// Filling the platform's pricing parameters from the Dynamics export.
//
// The client's parameter export (`legacy_tracking_options`, Range rows — or
// the "Active Tracking Options" workbook uploaded from the CRM, which is the
// same export read by the same rule) states, per range, the duty bands, the
// clearance, the freight, the supplier discount, the trade markup and the
// small-order surcharge Atelier prices with today. A range is a house —
// `RUBELLI`, `LARSEN`, `JANE CHURCHILL` — so each row lands on that HOUSE, each
// figure in its one home (see src/pricing/house-pricing.js):
//
//   duty A/B/C, clearance, trade markup, surcharge -> the house's override set
//                                                     in supplier_pricing_parameters
//   discount -> a flat rate on the house's terms
//   freight  -> a dated row on the freight ledger, scoped to the house's name
//
// FILL ONLY WHAT IS BLANK, unless told to replace. By default a value the
// office already saved is not overwritten: a NULL column in a saved set is
// filled, a house with no discount of its own gets a flat one (no terms, or
// terms carrying only a markup), a house with no freight rate of its own gets
// one. Every saved value the export DISAGREES with is
// reported as `kept`, line by line, so the dry run says exactly what a replace
// would change. With `overwrite` those lines become `replace` and are written —
// a parameter column is set, a flat discount is re-rated, and freight is a NEW
// dated row (the ledger is append-only; the old rate stays as history).
//
// WHAT IS NEVER TOUCHED, EITHER WAY. A house on a compounded chain or discount
// tiers keeps them — writing a flat rate over either is a different agreement,
// not a replacement — and is reported. A BLANK in the export never clears a
// saved value: a blank duty band is "no defined duty", blank freight is
// UNKNOWN (never zero), and neither is an instruction to delete anything.
//
// A BLANK DISCOUNT IS 0%. Verified on all 4,638 rows belonging to a blank-
// discount range (export/wholesale ratio exactly 1.000). It is written as a
// stated 0% flat discount, with the note saying where it came from.
//
// FREIGHT NEEDS A UNIT. A dollar rate on the ledger must say what it is per
// (FR-187) and the export does not. A house's FIRST rate takes the unit its
// price lines are mostly quoted in (`houseUnits`) — the "range's own pack
// type" the Dynamics figure is per; a replacement keeps the unit the house's
// current rate states. A house with neither is reported, not guessed. FX and
// handling are not in the export at all and stay as finance sets them.
//
// FREIGHT PER LETTER COMES FROM DYNAMICS' OWN PRICES (30 Sep 2026). Dynamics
// charged freight per range AND letter (Fabricut A $30, B $3, C $5; Pierre
// Frey A $29.80, B $35, C $10) from a table no export carries; the range's one
// freight figure is not what its prices used (Fabricut's range says $23, and
// every lettered Fabricut price used $30, $3 or $5). The product-price archive
// keeps each price's steps, so the rate a letter paid solves back exactly:
// landed ÷ (1 + clearance) − price incl duty (`letterFreights`). Where
// FREIGHT_CLASS_SHARE of a letter's rows (at least MIN_FREIGHT_CLASS_ROWS)
// agree, it fills the house's freight CLASS for that letter — unless the
// house's every-class rate already says the same. A class the house already
// has is kept (reported) or, with `overwrite`, re-dated; a letter with no
// clear majority (typed prices) is reported and left.
//
// The same two exact routes the supplier roll-up uses match a range to a house
// — its name, then its slug — and nothing fuzzier. Reported, never guessed.

import { slugify } from '../seed/slugify.js'
import { nameKey } from '../suppliers/backfill-plan.js'
import {
  createSupplierBrandTerms,
  listBrandTermsShapes,
  updateSupplierBrandTerms,
} from '../suppliers/supplier-terms.js'
import { createFreightRate, currentRangeRates, today } from './freight-rates.js'
import { fractionToPercent, houseUnits, percentToFraction, sameRate } from './house-pricing.js'
import { listRangeParameters, MAX_LIMIT } from './tracking-parameters.js'

/** Parameter column <- the range row's field (src/pricing/tracking-parameters.js shape). */
const PARAMETER_FROM_RANGE = Object.freeze({
  duty_percent_a: 'duty_rate_a',
  duty_percent_b: 'duty_rate_b',
  duty_percent_c: 'duty_rate_c',
  clearance_percent: 'clearance_percent',
  trade_markup_percent: 'trade_markup_percent',
  surcharge_min_qty: 'min_qty_to_avoid_surcharge',
  surcharge_per_unit: 'surcharge_per_unit',
})

// The retail markup is not in the ranges export — Dynamics' tracking option
// has no such field — so it comes from Dynamics' own prices instead: each
// house's majority retail ÷ trade over its product-price rows (`retailRatios`).
export const RETAIL_MARKUP = 'retail_markup_percent'
export const MIN_RETAIL_ROWS = 5

/** A letter's rate needs this many archive rows, this share of them agreeing. */
export const MIN_FREIGHT_CLASS_ROWS = 5
export const FREIGHT_CLASS_SHARE = 0.9
export const FREIGHT_CLASS_NOTE = "From Dynamics' own product prices"
const FILLABLE = Object.freeze([...Object.keys(PARAMETER_FROM_RANGE), RETAIL_MARKUP])

export const BACKFILL_NOTE = 'From the Dynamics parameter export'

/** The two change-line fields that are not parameter columns. */
export const DISCOUNT_FIELD = 'discount_percent'
export const FREIGHT_FIELD = 'freight'
/** A freight class's change line: `freight_class_B`. */
export const freightClassField = (letter) => `freight_class_${letter}`

/** What happens to one value on one house. */
export const CHANGE_KINDS = Object.freeze({
  FILL: 'fill', // blank on the house, stated in the export — written
  REPLACE: 'replace', // saved on the house, different in the export — written (overwrite)
  KEPT: 'kept', // saved on the house, different in the export — left (no overwrite)
})

const ACTIVE_STATUS = 'Active'

const sluggable = (value) => {
  try {
    const slug = slugify(value)
    return slug === '' ? null : slug
  } catch {
    return null
  }
}

// pg hands numeric back as a string; a planner compares numbers.
const numeric = (value) => (value == null ? null : Number(value))

/**
 * Plan the fill. Pure.
 *
 * @param {object} input
 * @param {object[]} input.parameters  Range rows (src/pricing/tracking-parameters.js shape)
 * @param {{id:number, name:string, slug:string, supplier_id:number|null}[]} input.brands
 * @param {object[]} input.existing    current brand-scoped parameter rows
 * @param {object[]} input.terms       every house's terms shape (listBrandTermsShapes);
 *                                     a row without shape fields is treated as not flat
 * @param {object[]} [input.freight]   each house's current catch-all rate (currentRangeRates)
 * @param {Map<number,string|null>|[number,string|null][]} [input.units]
 *                                     the unit each house's price lines are quoted in
 * @param {{range_name:string, ratio:number, rows:number}[]} [input.retailRatios]
 *                                     Dynamics' retail ÷ trade, counted per range
 * @param {{range_name:string, letter:string, rate:number, rows:number}[]} [input.letterFreights]
 *                                     the freight each letter's Dynamics prices paid, counted
 * @param {object[]} [input.classRates] every house's current freight-class rates (ledger shape)
 * @param {{ overwrite?: boolean, on?: string }} [options]
 */
export const planParametersBackfill = (
  {
    parameters = [], brands = [], existing = [], terms = [], freight = [], units = [], retailRatios = [],
    letterFreights = [], classRates = [],
  },
  { overwrite = false, on = today() } = {}
) => {
  const reports = {
    rangesWithoutBrand: [],
    brandsWithSeveralRanges: [],
    brandsWithoutSupplier: [],
    termsAlreadyOnFile: [],
    inactiveRanges: [],
    freightWithoutUnit: [],
    freightDatedToday: [],
    retailMarkupUnclear: [],
    freightClassUnclear: [],
  }
  const brandByName = new Map(brands.map((b) => [nameKey(b.name), b]))
  const brandBySlug = new Map(brands.map((b) => [b.slug, b]))
  const existingByBrand = new Map(existing.map((row) => [row.brand_id, row]))
  const termsByBrand = new Map(terms.map((row) => [row.brand_id, row]))
  const freightByHouse = new Map(freight.map((rate) => [nameKey(rate.range_name), rate]))
  const unitByBrand = new Map(units)
  const classRatesByHouse = new Map()
  for (const rate of classRates) {
    const key = nameKey(rate.range_name)
    classRatesByHouse.set(key, new Map([...(classRatesByHouse.get(key) ?? []), [rate.freight_class, rate]]))
  }

  const brandFor = (range) => {
    const key = nameKey(range)
    if (key === '') return null
    const named = brandByName.get(key)
    if (named) return named
    const slug = sluggable(range)
    return slug ? (brandBySlug.get(slug) ?? null) : null
  }

  // A house's retail markup: the ratio most of its rows share, as a percentage
  // on trade (1.30 → 30). A house whose rows are split with no majority, or
  // that has fewer than MIN_RETAIL_ROWS, is left for a person, and reported.
  const ratiosByBrand = new Map()
  for (const { range_name: rangeName, ratio, rows } of retailRatios) {
    const brand = brandFor(rangeName)
    if (!brand) continue
    const counts = ratiosByBrand.get(brand.id) ?? new Map()
    counts.set(Number(ratio), (counts.get(Number(ratio)) ?? 0) + Number(rows))
    ratiosByBrand.set(brand.id, counts)
  }
  const retailMarkupFor = (brand) => {
    const counts = ratiosByBrand.get(brand.id)
    if (!counts) return null
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
    const [ratio, rows] = [...counts].sort((a, b) => b[1] - a[1])[0]
    // A handful of rows is an anecdote, not a house's rule (Jean Monro's archive
    // prices one product, 28 Sep 2026).
    if (rows * 2 <= total || total < MIN_RETAIL_ROWS) {
      reports.retailMarkupUnclear.push(Object.freeze({ brand: brand.name, rows: total, largest_share: Math.round((rows / total) * 100) / 100 }))
      return null
    }
    return Math.round((ratio - 1) * 10000) / 100
  }

  // A house's rate per freight letter, as Dynamics' prices paid it: the rate
  // most of the letter's rows share, where that is FREIGHT_CLASS_SHARE of them.
  const letterCountsByBrand = new Map()
  for (const { range_name: rangeName, letter, rate, rows } of letterFreights) {
    const brand = brandFor(rangeName)
    if (!brand) continue
    const letters = letterCountsByBrand.get(brand.id) ?? new Map()
    const counts = letters.get(letter) ?? new Map()
    counts.set(Number(rate), (counts.get(Number(rate)) ?? 0) + Number(rows))
    letters.set(letter, counts)
    letterCountsByBrand.set(brand.id, letters)
  }
  const letterRatesFor = (brand) => {
    const rates = []
    for (const [letter, counts] of [...(letterCountsByBrand.get(brand.id) ?? [])].sort()) {
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
      const [rate, rows] = [...counts].sort((a, b) => b[1] - a[1])[0]
      if (total < MIN_FREIGHT_CLASS_ROWS || rows < total * FREIGHT_CLASS_SHARE) {
        reports.freightClassUnclear.push(
          Object.freeze({ brand: brand.name, letter, rows: total, largest_share: Math.round((rows / total) * 100) / 100 })
        )
      } else {
        rates.push({ letter, rate, rows })
      }
    }
    return rates
  }

  const inserts = []
  const fills = []
  const overwrites = []
  const termsInserts = []
  const termsUpdates = []
  const freightInserts = []
  const changes = []
  const claimed = new Map() // brand id -> range that claimed it

  for (const parameter of parameters) {
    const range = typeof parameter?.name === 'string' ? parameter.name.trim() : ''
    if (range === '') continue
    // An inactive range is one the office retired in Dynamics; its figures
    // are not today's. (Staged rows without a status are read as active.)
    if (parameter.status != null && parameter.status !== ACTIVE_STATUS) {
      reports.inactiveRanges.push(Object.freeze({ range, status: parameter.status }))
      continue
    }
    const brand = brandFor(range)
    if (!brand) {
      reports.rangesWithoutBrand.push(Object.freeze({ range, supplier: parameter.supplier ?? null }))
      continue
    }
    if (claimed.has(brand.id)) {
      reports.brandsWithSeveralRanges.push(
        Object.freeze({ brand: brand.name, kept: claimed.get(brand.id), skipped: range })
      )
      continue
    }
    claimed.set(brand.id, range)

    const where = { brand_id: brand.id, brand: brand.name, range }
    const change = (field, from, to, kind, extra = {}) =>
      changes.push(Object.freeze({ ...where, field, from, to, kind, ...extra }))

    // --- the parameter set ---------------------------------------------------
    const values = Object.fromEntries(
      FILLABLE.map((column) => [
        column,
        column === RETAIL_MARKUP ? retailMarkupFor(brand) : numeric(parameter[PARAMETER_FROM_RANGE[column]]),
      ])
    )
    const current = existingByBrand.get(brand.id)
    if (!current) {
      inserts.push(Object.freeze({ ...where, ...values, note: `${BACKFILL_NOTE} (range ${range})` }))
      for (const column of FILLABLE) {
        if (values[column] != null) change(column, null, values[column], CHANGE_KINDS.FILL)
      }
    } else {
      const fill = {}
      const replace = {}
      for (const column of FILLABLE) {
        const stated = values[column]
        if (stated == null) continue // a blank never clears a saved value
        const saved = numeric(current[column])
        if (saved == null) {
          fill[column] = stated
          change(column, null, stated, CHANGE_KINDS.FILL)
        } else if (!sameRate(saved, stated)) {
          if (overwrite) replace[column] = stated
          change(column, saved, stated, overwrite ? CHANGE_KINDS.REPLACE : CHANGE_KINDS.KEPT)
        }
      }
      if (Object.keys(fill).length > 0) fills.push(Object.freeze({ ...where, ...fill }))
      if (Object.keys(replace).length > 0) overwrites.push(Object.freeze({ ...where, ...replace }))
    }

    // --- the discount: a flat rate on the house's terms ------------------------
    const percent = Number(parameter.discount_percent ?? 0)
    const discount = percentToFraction(percent)
    const blankNote = parameter.discount_stated === true ? '' : ', blank discount read as 0%'
    const terms = termsByBrand.get(brand.id)
    if (!terms) {
      if (brand.supplier_id == null) {
        reports.brandsWithoutSupplier.push(Object.freeze({ brand: brand.name, range }))
      } else {
        termsInserts.push(
          Object.freeze({
            ...where,
            supplier_id: brand.supplier_id,
            discount,
            discount_stated: parameter.discount_stated === true,
            note: `${BACKFILL_NOTE} (range ${range}${blankNote})`,
          })
        )
        change(DISCOUNT_FIELD, null, percent, CHANGE_KINDS.FILL)
      }
    } else if (!(terms.chain_length === 0 && terms.tier_count === 0)) {
      // A chain or tiers — never merged into (see the header).
      reports.termsAlreadyOnFile.push(Object.freeze({ brand: brand.name, range }))
    } else if (terms.discount == null) {
      // Terms with no discount at all — a row kept for its retail markup, say
      // (the snapshot's Fabricut rows). The house has no discount of its own,
      // exactly as if it had no terms: a blank, so it fills.
      termsUpdates.push(
        Object.freeze({ ...where, terms_id: terms.id, supplier_id: terms.supplier_id, discount, was: null })
      )
      change(DISCOUNT_FIELD, null, percent, CHANGE_KINDS.FILL)
    } else if (!sameRate(terms.discount, discount)) {
      const saved = fractionToPercent(terms.discount)
      if (overwrite) {
        termsUpdates.push(
          Object.freeze({ ...where, terms_id: terms.id, supplier_id: terms.supplier_id, discount, was: terms.discount })
        )
      }
      change(DISCOUNT_FIELD, saved, percent, overwrite ? CHANGE_KINDS.REPLACE : CHANGE_KINDS.KEPT)
    }

    // --- freight: a dated row on the ledger, under the house's name ------------
    const stated = numeric(parameter.freight_per_unit)
    if (stated != null) {
      const rate = freightByHouse.get(nameKey(brand.name)) ?? null
      const append = (unit, kind, from) => {
        freightInserts.push(
          Object.freeze({
            ...where,
            range_name: brand.name,
            rate: stated,
            unit,
            effective_from: on,
            note: `${BACKFILL_NOTE} (range ${range})`,
          })
        )
        change(FREIGHT_FIELD, from, stated, kind, { unit, from_unit: rate?.unit ?? null })
      }
      if (!rate) {
        const unit = unitByBrand.get(brand.id) ?? null
        if (unit) append(unit, CHANGE_KINDS.FILL, null)
        else reports.freightWithoutUnit.push(Object.freeze({ brand: brand.name, range, rate: stated }))
      } else if (!(rate.basis === 'dollar' && sameRate(rate.rate, stated))) {
        const unit = rate.unit ?? unitByBrand.get(brand.id) ?? null
        if (!overwrite) {
          change(FREIGHT_FIELD, rate.rate, stated, CHANGE_KINDS.KEPT, { unit: rate.unit, from_unit: rate.unit })
        } else if (rate.effective_from === on) {
          // The ledger holds one rate per house per day; today's is already set.
          reports.freightDatedToday.push(Object.freeze({ brand: brand.name, range, rate: stated, current: rate.rate }))
        } else if (!unit) {
          reports.freightWithoutUnit.push(Object.freeze({ brand: brand.name, range, rate: stated }))
        } else {
          append(unit, CHANGE_KINDS.REPLACE, rate.rate)
        }
      }
    }

    // --- freight classes: the rate each letter's Dynamics prices paid ----------
    const houseRate = freightByHouse.get(nameKey(brand.name)) ?? null
    const writtenRate = freightInserts.find((row) => row.brand_id === brand.id && row.freight_class == null)
    // The every-class rate once this import lands: what it writes, else what the
    // house has, else what the export states (a house with no unit to write it).
    const everyClass = writtenRate ? writtenRate.rate : houseRate ? (houseRate.basis === 'dollar' ? numeric(houseRate.rate) : null) : stated
    const unit = houseRate?.unit ?? writtenRate?.unit ?? unitByBrand.get(brand.id) ?? null
    const houseClasses = classRatesByHouse.get(nameKey(brand.name)) ?? new Map()
    for (const { letter, rate, rows } of letterRatesFor(brand)) {
      const field = freightClassField(letter)
      const current = houseClasses.get(letter) ?? null
      const append = (kind, from, classUnit) => {
        freightInserts.push(
          Object.freeze({
            ...where,
            range_name: brand.name,
            freight_class: letter,
            rate,
            unit: classUnit,
            effective_from: on,
            note: `${FREIGHT_CLASS_NOTE} (letter ${letter}, ${rows} prices)`,
          })
        )
        change(field, from, rate, kind, { unit: classUnit, from_unit: current?.unit ?? null })
      }
      if (!current) {
        if (sameRate(everyClass, rate)) continue // the every-class rate already charges it
        if (unit) append(CHANGE_KINDS.FILL, null, unit)
        else reports.freightWithoutUnit.push(Object.freeze({ brand: brand.name, range, rate, letter }))
      } else if (!(current.basis === 'dollar' && sameRate(current.rate, rate))) {
        if (!overwrite) {
          change(field, current.rate, rate, CHANGE_KINDS.KEPT, { unit: current.unit, from_unit: current.unit })
        } else if (current.effective_from === on) {
          reports.freightDatedToday.push(Object.freeze({ brand: brand.name, range, rate, current: current.rate, letter }))
        } else {
          append(CHANGE_KINDS.REPLACE, current.rate, current.unit ?? unit)
        }
      }
    }
  }

  const count = (kind) => changes.filter((line) => line.kind === kind).length

  return Object.freeze({
    inserts: Object.freeze(inserts),
    fills: Object.freeze(fills),
    overwrites: Object.freeze(overwrites),
    termsInserts: Object.freeze(termsInserts),
    termsUpdates: Object.freeze(termsUpdates),
    freightInserts: Object.freeze(freightInserts),
    changes: Object.freeze(changes),
    reports: Object.freeze(
      Object.fromEntries(Object.entries(reports).map(([name, rows]) => [name, Object.freeze(rows)]))
    ),
    summary: Object.freeze({
      ranges: parameters.length,
      overwrite,
      houses_matched: claimed.size,
      parameter_inserts: inserts.length,
      parameter_fills: fills.length,
      parameter_overwrites: overwrites.length,
      terms_inserts: termsInserts.length,
      terms_updates: termsUpdates.length,
      freight_inserts: freightInserts.length,
      ranges_without_brand: reports.rangesWithoutBrand.length,
      values_filled: count(CHANGE_KINDS.FILL),
      values_replaced: count(CHANGE_KINDS.REPLACE),
      values_kept: count(CHANGE_KINDS.KEPT),
    }),
  })
}

const readSources = async (client, rangeParameters, on) => {
  const parameters =
    rangeParameters !== undefined
      ? rangeParameters
      : (await listRangeParameters(client, { limit: MAX_LIMIT })).parameters
  const { rows: brands } = await client.query(
    `SELECT id, name, slug, supplier_id FROM brands WHERE archived_at IS NULL ORDER BY id`
  )
  const { rows: existing } = await client.query(
    `SELECT brand_id, ${FILLABLE.join(', ')} FROM supplier_pricing_parameters WHERE brand_id IS NOT NULL`
  )
  const terms = await listBrandTermsShapes(client)
  const freight = await currentRangeRates(client, on)
  const { rows: classRates } = await client.query(
    `SELECT DISTINCT ON (lower(range_name), freight_class) range_name, freight_class, basis, rate::float8 AS rate, unit,
            to_char(effective_from, 'YYYY-MM-DD') AS effective_from
       FROM supplier_freight_rates
      WHERE range_name IS NOT NULL AND category IS NULL AND freight_class IS NOT NULL AND effective_from <= $1::date
      ORDER BY lower(range_name), freight_class, effective_from DESC, id DESC`,
    [on]
  )
  const units = await houseUnits(client)
  // Dynamics' retail ÷ trade, read off its product-price archive: for each row of
  // the latest product-prices import by its guid (so a range the office renamed
  // on the way in counts under its new name), and — for a range none of whose
  // rows match, because Dynamics re-created them since the archive (Stroheim,
  // S. Harris, Clarence House, Vervain on 28 Sep 2026) — the archive's own rows
  // under that range's name. Empty until both are imported.
  const { rows: retailRatios } = await client.query(
    `WITH joined AS (
       SELECT pp.range_name, round(lp.retail_sell_price_nz / lp.trade_sell_price_nz, 2) AS ratio
         FROM product_prices pp
         JOIN legacy_product_prices lp ON lp.guid = pp.guid
        WHERE pp.last_import_id = (SELECT max(id) FROM product_price_imports)
          AND lp.retail_sell_price_nz > 0 AND lp.trade_sell_price_nz > 0
     ), archive AS (
       SELECT lp.range_name, round(lp.retail_sell_price_nz / lp.trade_sell_price_nz, 2) AS ratio
         FROM legacy_product_prices lp
        WHERE lp.retail_sell_price_nz > 0 AND lp.trade_sell_price_nz > 0
          AND NOT EXISTS (SELECT 1 FROM joined j WHERE j.range_name = lp.range_name)
     )
     SELECT range_name, ratio, count(*)::int AS rows
       FROM (SELECT * FROM joined UNION ALL SELECT * FROM archive) r
      GROUP BY 1, 2`
  )
  // The freight each price paid, solved back from its archived steps with its
  // range's Dynamics clearance: landed ÷ (1 + clearance) − price incl duty. A
  // row of the latest import counts under its range name there (renamed on the
  // way in), any other under the archive's own. Prices set by hand follow
  // another formula and are left out. Empty until both are imported.
  const { rows: letterFreights } = await client.query(
    `SELECT COALESCE(pp.range_name, lp.range_name) AS range_name, upper(btrim(lp.freight_rate)) AS letter,
            round(lp.landed_cost_nz / (1 + t.clearance / 100) - lp.price_incl_duty_nz, 1)::float8 AS rate,
            count(*)::int AS rows
       FROM legacy_product_prices lp
       JOIN legacy_tracking_options t ON lower(btrim(t.name)) = lower(btrim(lp.range_name))
       LEFT JOIN product_prices pp
              ON pp.guid = lp.guid AND pp.last_import_id = (SELECT max(id) FROM product_price_imports)
      WHERE NOT COALESCE(lp.set_prices_manually, false)
        AND lp.landed_cost_nz > 0 AND lp.price_incl_duty_nz > 0 AND t.clearance IS NOT NULL
        AND upper(btrim(lp.freight_rate)) ~ '^[A-E]$'
      GROUP BY 1, 2, 3`
  )
  return { parameters, brands, existing, terms, freight, units, retailRatios, letterFreights, classRates }
}

const applyInserts = async (client, inserts) => {
  let count = 0
  for (const row of inserts) {
    const { rowCount } = await client.query(
      `INSERT INTO supplier_pricing_parameters
         (brand_id, ${FILLABLE.join(', ')}, note)
       VALUES ($1, ${FILLABLE.map((_, i) => `$${i + 2}`).join(', ')}, $${FILLABLE.length + 2})
       ON CONFLICT (brand_id) WHERE brand_id IS NOT NULL DO NOTHING`,
      [row.brand_id, ...FILLABLE.map((column) => row[column]), row.note]
    )
    count += rowCount
  }
  return count
}

const applyFills = async (client, fills) => {
  let count = 0
  for (const row of fills) {
    const columns = FILLABLE.filter((column) => Object.hasOwn(row, column))
    const { rowCount } = await client.query(
      `UPDATE supplier_pricing_parameters
          SET ${columns.map((column, i) => `${column} = COALESCE(${column}, $${i + 2})`).join(', ')},
              updated_at = now()
        WHERE brand_id = $1
          AND (${columns.map((column) => `${column} IS NULL`).join(' OR ')})`,
      [row.brand_id, ...columns.map((column) => row[column])]
    )
    count += rowCount
  }
  return count
}

// Column names come from FILLABLE, never from the row: the planner put only
// those keys on it, and this filter is what keeps it that way.
const applyOverwrites = async (client, overwrites) => {
  let count = 0
  for (const row of overwrites) {
    const columns = FILLABLE.filter((column) => Object.hasOwn(row, column))
    const { rowCount } = await client.query(
      `UPDATE supplier_pricing_parameters
          SET ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')},
              updated_at = now()
        WHERE brand_id = $1`,
      [row.brand_id, ...columns.map((column) => row[column])]
    )
    count += rowCount
  }
  return count
}

// Through the owner module (src/suppliers/supplier-terms.js), never a direct
// INSERT: the terms table has a shape rule and a chain check that live there.
// The planner already excluded every house with terms, so a create cannot
// collide within the transaction.
const applyTerms = async (client, termsInserts) => {
  for (const row of termsInserts) {
    await createSupplierBrandTerms(client, row.supplier_id, {
      brand_id: row.brand_id,
      discount: row.discount,
      note: row.note,
    })
  }
  return termsInserts.length
}

// The flat rate only; the office's note on the row is theirs and stays.
const applyTermsUpdates = async (client, termsUpdates) => {
  for (const row of termsUpdates) {
    await updateSupplierBrandTerms(client, row.supplier_id, row.terms_id, { discount: row.discount })
  }
  return termsUpdates.length
}

// Through createFreightRate, so the ledger's own rules (unit per basis, the
// house must exist, one rate per scope per day) hold for an import as they do
// for the form and the yearly sheet.
const applyFreight = async (client, freightInserts) => {
  for (const row of freightInserts) {
    await createFreightRate(client, {
      range_name: row.range_name,
      freight_class: row.freight_class ?? null,
      basis: 'dollar',
      rate: row.rate,
      unit: row.unit,
      effective_from: row.effective_from,
      note: row.note,
    })
  }
  return freightInserts.length
}

/**
 * Plan and apply in one transaction. `rangeParameters` is injectable so a test
 * never touches the real houses in the shared database, and so the CRM's
 * upload can hand in the rows it read out of the workbook.
 *
 * `dryRun` plans against the live state and writes nothing — the upload's
 * validate step. `overwrite` replaces saved values the export disagrees with
 * (see the header). `on` dates any freight row written (today by default).
 *
 * @param {import('pg').Pool} pool
 * @param {{ rangeParameters?: object[], overwrite?: boolean, dryRun?: boolean, on?: string }} [options]
 */
export const backfillPricingParameters = async (
  pool,
  { rangeParameters, overwrite = false, dryRun = false, on = today() } = {}
) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const plan = planParametersBackfill(await readSources(client, rangeParameters, on), { overwrite, on })
    if (dryRun) {
      await client.query('ROLLBACK')
      return Object.freeze({ ...plan.summary, dry_run: true, changes: plan.changes, reports: plan.reports })
    }
    const inserted = await applyInserts(client, plan.inserts)
    const filled = await applyFills(client, plan.fills)
    const replaced = await applyOverwrites(client, plan.overwrites)
    const terms = await applyTerms(client, plan.termsInserts)
    const termsUpdated = await applyTermsUpdates(client, plan.termsUpdates)
    const freight = await applyFreight(client, plan.freightInserts)
    await client.query('COMMIT')
    return Object.freeze({
      ...plan.summary,
      dry_run: false,
      parameters_inserted: inserted,
      parameters_filled: filled,
      parameters_replaced: replaced,
      terms_inserted: terms,
      terms_updated: termsUpdated,
      freight_inserted: freight,
      changes: plan.changes,
      reports: plan.reports,
    })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // surface the original failure
    }
    throw error
  } finally {
    client.release()
  }
}
