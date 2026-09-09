// Pre-filling the platform's pricing parameters from the Dynamics export.
//
// The client's parameter export (`legacy_tracking_options`, Range rows) states,
// per range, the duty bands, the clearance, the trade markup and the supplier
// discount Atelier prices with today. A range is a house — `RUBELLI`, `LARSEN`,
// `JANE CHURCHILL` — so each row becomes that HOUSE's override set in
// `supplier_pricing_parameters`, and its discount becomes the house's flat
// discount in the supplier terms. The office edits from real numbers
// instead of blanks; from then on Dynamics is a reference beside the field.
//
// FILL ONLY WHAT IS NULL. A parameter set the office already saved is not
// overwritten column by column; a NULL column in it is filled. A house that
// already has terms is left entirely alone — the terms row carries a shape
// (flat / chain / tiers) and merging a flat rate into it is not a fill.
//
// FREIGHT, FX AND HANDLING ARE NOT HERE. Freight belongs to the dated ledger
// and its rate grain is still out with the client (F1); the export has no
// exchange rate on a range and no handling anywhere. Both stay "missing" until
// finance sets them on the Pricing screen.
//
// A BLANK DISCOUNT IS 0%. Verified on all 4,638 rows belonging to a blank-
// discount range (export/wholesale ratio exactly 1.000). It is written as a
// stated 0% flat discount, with the note saying where it came from.
//
// The same two exact routes the supplier roll-up uses match a range to a house
// — its name, then its slug — and nothing fuzzier. Reported, never guessed.

import { slugify } from '../seed/slugify.js'
import { nameKey } from '../suppliers/backfill-plan.js'
import { createSupplierBrandTerms, listBrandIdsWithTerms } from '../suppliers/supplier-terms.js'
import { listRangeParameters, MAX_LIMIT } from './tracking-parameters.js'

/** D365 column -> parameter column. */
const PARAMETER_FROM_RANGE = Object.freeze({
  duty_percent_a: 'duty_rate_a',
  duty_percent_b: 'duty_rate_b',
  duty_percent_c: 'duty_rate_c',
  clearance_percent: 'clearance_percent',
  trade_markup_percent: 'trade_markup_percent',
})

const FILLABLE = Object.freeze(Object.keys(PARAMETER_FROM_RANGE))

export const BACKFILL_NOTE = 'From the Dynamics parameter export'

const sluggable = (value) => {
  try {
    const slug = slugify(value)
    return slug === '' ? null : slug
  } catch {
    return null
  }
}

/**
 * Plan the backfill. Pure.
 *
 * @param {object} input
 * @param {object[]} input.parameters   Range rows (src/pricing/tracking-parameters.js shape)
 * @param {{id:number, name:string, slug:string, supplier_id:number|null}[]} input.brands
 * @param {object[]} input.existing     current brand-scoped parameter rows
 * @param {{brand_id:number}[]} input.terms   brands that already have terms
 */
export const planParametersBackfill = ({ parameters = [], brands = [], existing = [], terms = [] }) => {
  const reports = {
    rangesWithoutBrand: [],
    brandsWithSeveralRanges: [],
    brandsWithoutSupplier: [],
    termsAlreadyOnFile: [],
  }
  const brandByName = new Map(brands.map((b) => [nameKey(b.name), b]))
  const brandBySlug = new Map(brands.map((b) => [b.slug, b]))
  const existingByBrand = new Map(existing.map((row) => [row.brand_id, row]))
  const termsByBrand = new Set(terms.map((row) => row.brand_id))

  const brandFor = (range) => {
    const key = nameKey(range)
    if (key === '') return null
    const named = brandByName.get(key)
    if (named) return named
    const slug = sluggable(range)
    return slug ? (brandBySlug.get(slug) ?? null) : null
  }

  const inserts = []
  const fills = []
  const termsInserts = []
  const claimed = new Map() // brand id -> range that claimed it

  for (const parameter of parameters) {
    const range = typeof parameter?.name === 'string' ? parameter.name.trim() : ''
    if (range === '') continue
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

    const values = Object.fromEntries(
      FILLABLE.map((column) => [column, parameter[PARAMETER_FROM_RANGE[column]] ?? null])
    )
    const current = existingByBrand.get(brand.id)
    if (!current) {
      inserts.push(Object.freeze({ brand_id: brand.id, brand: brand.name, range, ...values, note: `${BACKFILL_NOTE} (range ${range})` }))
    } else {
      const fill = Object.fromEntries(
        FILLABLE.filter((column) => current[column] == null && values[column] != null).map((column) => [
          column,
          values[column],
        ])
      )
      if (Object.keys(fill).length > 0) {
        fills.push(Object.freeze({ brand_id: brand.id, brand: brand.name, range, ...fill }))
      }
    }

    // The discount: a flat rate on the house's terms, only where the house has
    // a supplier to hang the terms on and no terms yet.
    if (termsByBrand.has(brand.id)) {
      reports.termsAlreadyOnFile.push(Object.freeze({ brand: brand.name, range }))
    } else if (brand.supplier_id == null) {
      reports.brandsWithoutSupplier.push(Object.freeze({ brand: brand.name, range }))
    } else {
      termsInserts.push(
        Object.freeze({
          supplier_id: brand.supplier_id,
          brand_id: brand.id,
          brand: brand.name,
          range,
          discount: Number(parameter.discount_percent ?? 0) / 100,
          discount_stated: parameter.discount_stated === true,
        })
      )
    }
  }

  return Object.freeze({
    inserts: Object.freeze(inserts),
    fills: Object.freeze(fills),
    termsInserts: Object.freeze(termsInserts),
    reports: Object.freeze(
      Object.fromEntries(Object.entries(reports).map(([name, rows]) => [name, Object.freeze(rows)]))
    ),
    summary: Object.freeze({
      ranges: parameters.length,
      parameter_inserts: inserts.length,
      parameter_fills: fills.length,
      terms_inserts: termsInserts.length,
      ranges_without_brand: reports.rangesWithoutBrand.length,
    }),
  })
}

const readSources = async (client, rangeParameters) => {
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
  const terms = (await listBrandIdsWithTerms(client)).map((brand_id) => ({ brand_id }))
  return { parameters, brands, existing, terms }
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

// Through the owner module (src/suppliers/supplier-terms.js), never a direct
// INSERT: the terms table has a shape rule and a chain check that live there.
// The planner already excluded every house with terms, so a create cannot
// collide within the transaction.
const applyTerms = async (client, termsInserts) => {
  for (const row of termsInserts) {
    await createSupplierBrandTerms(client, row.supplier_id, {
      brand_id: row.brand_id,
      discount: row.discount,
      note: `${BACKFILL_NOTE} (range ${row.range}${row.discount_stated ? '' : ', blank discount read as 0%'})`,
    })
  }
  return termsInserts.length
}

/**
 * Plan and apply in one transaction. `rangeParameters` is injectable so a test
 * never touches the real houses in the shared database.
 *
 * @param {import('pg').Pool} pool
 * @param {{ rangeParameters?: object[] }} [options]
 */
export const backfillPricingParameters = async (pool, { rangeParameters } = {}) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const plan = planParametersBackfill(await readSources(client, rangeParameters))
    const inserted = await applyInserts(client, plan.inserts)
    const filled = await applyFills(client, plan.fills)
    const terms = await applyTerms(client, plan.termsInserts)
    await client.query('COMMIT')
    return Object.freeze({
      ...plan.summary,
      parameters_inserted: inserted,
      parameters_filled: filled,
      terms_inserted: terms,
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
