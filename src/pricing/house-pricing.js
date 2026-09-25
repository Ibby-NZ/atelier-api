// One house's pricing, read and written as ONE set — the Pricing panel on the
// house's own page in the CRM (/admin/brands/:id).
//
// The office asked (September 2026) for every figure on the Dynamics parameter
// export — duty A/B/C, clearance, freight, discount, trade markup and the
// small-order surcharge — to live on its house and be editable there. Each of
// those figures ALREADY has exactly one home on the platform, and this module
// adds none; it is a view over the three and a writer that routes each field to
// its own:
//
//   duty bands, clearance, trade markup, FX margin, handling, surcharge
//       -> the house's override row in `supplier_pricing_parameters`
//          (PUT semantics: the whole set travels, an omitted field clears)
//   discount
//       -> a FLAT rate on the house's supplier terms, through
//          src/suppliers/supplier-terms.js (the terms tables are named only
//          under src/suppliers/ — test/suppliers-terms.test.js scans for it).
//          A house on a compounded chain or discount tiers is refused
//          here with a 422 that sends the office to the supplier's terms panel:
//          writing a flat rate over either is a different agreement, not an edit.
//   freight
//       -> a NEW dated row on the append-only freight ledger, scoped to the
//          house's name (the client answered F1 in Sept 2026: freight is per
//          house). Never an overwrite (FR-192); the same figure again is a
//          no-op rather than a duplicate.
//
// The write is one transaction (the route opens it), so a refused discount does
// not leave a half-saved house behind.
//
// Percentages are as the office writes them (5 is 5%) on every field, the
// discount included: the terms table stores a fraction, and the conversion
// happens here and nowhere in the CRM.

import {
  PARAMETER_COLUMNS,
  getBrandParameters,
  getSupplierParameters,
  upsertBrandParameters,
} from './pricing-parameters.js'
import { createFreightRate, resolveFreightRate, today } from './freight-rates.js'
import { chainMultiplier, resolveTermsChain } from '../suppliers/discount-chain.js'
import {
  createSupplierBrandTerms,
  getBrandTerms,
  updateSupplierBrandTerms,
} from '../suppliers/supplier-terms.js'
import { supplierForBrand } from '../suppliers/brand-suppliers.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Rates are compared at the precision the columns store (numeric(6,4) for a
// terms fraction, numeric(12,4) for a freight rate); floating point would call
// 0.1 + 0.2 a change.
const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000
const round3 = (value) => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000

/** Two rates are the same figure at the ledger's and the terms' own precision. */
export const sameRate = (left, right) =>
  left != null && right != null && round4(left) === round4(right)

/** A terms fraction as the percentage the office reads and types. */
export const fractionToPercent = (fraction) => (fraction == null ? null : round3(Number(fraction) * 100))

/** The percentage the office typed, as the fraction the terms table stores. */
export const percentToFraction = (percent) => (percent == null ? null : round4(Number(percent) / 100))

// A house page shows an ARCHIVED house too, so its pricing reads for one as
// well — unlike the waterfall's loader, which prices live houses only.
const loadHouse = async (db, brandId) => {
  const { rows } = await db.query(
    `SELECT b.id, b.name, b.slug, b.supplier_id, s.name AS supplier_name, b.archived_at
       FROM brands b LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.id = $1`,
    [brandId]
  )
  if (rows.length === 0) throw httpError(404, 'That house does not exist.')
  return rows[0]
}

/**
 * The unit each house's price lines are mostly quoted in — the "range's own
 * pack type" that a Dynamics freight figure is per. A dollar rate on the ledger
 * must state its unit, and the export does not, so this is where the import
 * takes it from. A tie is no answer (null), and so is a house with no price
 * lines; both are reported by the caller rather than guessed.
 *
 * Price lines name their house in `product_range` (19,447 of 19,514 rows —
 * migration 1791724800000), matched as the freight ledger matches a range
 * name: case-insensitively, trimmed. Archived and discontinued lines do not
 * vote.
 *
 * @param {{ query: Function }} db
 * @param {number|null} [brandId] one house, or every house when absent
 * @returns {Promise<Map<number, string|null>>} brand id -> unit
 */
export const houseUnits = async (db, brandId = null) => {
  const { rows } = await db.query(
    `SELECT b.id AS brand_id, pli.unit, count(*)::int AS lines
       FROM price_list_items pli
       JOIN brands b ON lower(btrim(b.name)) = lower(btrim(pli.product_range))
      WHERE pli.unit IS NOT NULL
        AND pli.archived_at IS NULL
        AND pli.discontinued_at IS NULL
        AND ($1::int IS NULL OR b.id = $1::int)
      GROUP BY b.id, pli.unit`,
    [brandId]
  )
  const byHouse = new Map()
  for (const row of rows) {
    const list = byHouse.get(row.brand_id) ?? []
    byHouse.set(row.brand_id, [...list, row])
  }
  const units = new Map()
  for (const [id, list] of byHouse) {
    const top = Math.max(...list.map((row) => row.lines))
    const leaders = list.filter((row) => row.lines === top)
    units.set(id, leaders.length === 1 ? leaders[0].unit : null)
  }
  return units
}

// What the panel says about the discount, and whether it may write one.
const describeDiscount = (house, terms, supplierDefault) => {
  if (terms) {
    const shape = terms.discount_chain.length > 0 ? 'chain' : terms.tiers.length > 0 ? 'tiers' : 'flat'
    if (shape !== 'flat') {
      const resolved = resolveTermsChain(terms, terms.tiers)
      return Object.freeze({
        percent: resolved.source === 'none' ? null : round3((1 - chainMultiplier(resolved.chain)) * 100),
        source: 'house',
        shape,
        editable: false,
        reason:
          shape === 'chain'
            ? "This house is on a compounded discount chain. Edit it on the supplier's terms."
            : "This house is on discount tiers. Edit them on the supplier's terms.",
      })
    }
    if (terms.discount != null) {
      return Object.freeze({
        percent: fractionToPercent(terms.discount),
        source: 'house',
        shape,
        editable: true,
        reason: null,
      })
    }
  }
  // No flat rate of the house's own: the supplier's averaged rate applies, if
  // there is one. Writing needs a supplier to hang the terms on.
  const fallback =
    supplierDefault != null
      ? { percent: fractionToPercent(supplierDefault), source: 'supplier' }
      : { percent: null, source: 'missing' }
  return Object.freeze({
    ...fallback,
    shape: terms ? 'flat' : 'none',
    editable: house.supplier_id != null,
    reason:
      house.supplier_id == null
        ? 'Link this house to the supplier that invoices it first — a discount is that supplier’s term.'
        : null,
  })
}

const freightView = (rate) =>
  rate
    ? Object.freeze({
        rate: rate.rate,
        basis: rate.basis,
        unit: rate.unit,
        effective_from: rate.effective_from,
        note: rate.note,
      })
    : null

/**
 * Everything the house's Pricing panel shows.
 *
 * @param {{ query: Function }} db
 * @param {number} brandId
 */
export const getHousePricing = async (db, brandId) => {
  const house = await loadHouse(db, brandId)
  const supplier = await supplierForBrand(db, house.id)
  const [parameters, supplierParameters, terms, houseFreight, supplierFreight, units] = [
    await getBrandParameters(db, house.id),
    supplier ? await getSupplierParameters(db, supplier.id) : null,
    await getBrandTerms(db, house.id),
    await resolveFreightRate(db, { range_name: house.name }),
    supplier ? await resolveFreightRate(db, { supplier_id: supplier.id }) : null,
    await houseUnits(db, house.id),
  ]

  return Object.freeze({
    house: Object.freeze({
      id: house.id,
      name: house.name,
      slug: house.slug,
      supplier_id: house.supplier_id,
      supplier_name: house.supplier_name,
      archived_at: house.archived_at,
    }),
    // The house's own override row (null = none saved) and the supplier's
    // default row it falls back to, column for column.
    parameters,
    supplier_parameters: supplierParameters,
    discount: describeDiscount(house, terms, supplier?.default_discount ?? null),
    // The house's own rate; the supplier-wide one covers a house with none.
    freight: freightView(houseFreight.rate),
    supplier_freight: freightView(supplierFreight?.rate ?? null),
    // What a new freight rate's unit defaults to on the form.
    freight_unit_hint: houseFreight.rate?.unit ?? units.get(house.id) ?? null,
  })
}

const writeDiscount = async (db, house, percent) => {
  const terms = await getBrandTerms(db, house.id)
  const fraction = percentToFraction(percent)
  if (terms) {
    if (terms.discount_chain.length > 0 || terms.tiers.length > 0) {
      throw httpError(
        422,
        "This house's discount is a chain or a set of tiers. Edit it on the supplier's terms — a flat rate would replace the agreement."
      )
    }
    if (terms.discount == null ? fraction == null : sameRate(terms.discount, fraction)) return
    await updateSupplierBrandTerms(db, terms.supplier_id ?? house.supplier_id, terms.id, { discount: fraction })
    return
  }
  // Nothing to clear on a house with no terms.
  if (fraction == null) return
  if (house.supplier_id == null) {
    throw httpError(
      422,
      'Link this house to the supplier that invoices it before setting a discount — a discount is that supplier’s term.'
    )
  }
  await createSupplierBrandTerms(db, house.supplier_id, {
    brand_id: house.id,
    discount: fraction,
    note: 'Set on the house page',
  })
}

const writeFreight = async (db, house, freight) => {
  const current = (await resolveFreightRate(db, { range_name: house.name })).rate
  const unit = freight.unit ?? null
  if (
    current &&
    current.basis === 'dollar' &&
    sameRate(current.rate, freight.rate) &&
    current.unit === unit
  ) {
    return
  }
  await createFreightRate(db, {
    range_name: house.name,
    basis: 'dollar',
    rate: freight.rate,
    unit,
    effective_from: freight.effective_from ?? today(),
    note: freight.note ?? 'Set on the house page',
  })
}

/**
 * Save the house's pricing. Call inside a transaction.
 *
 *   parameters        the whole override set (PUT — an omitted column clears)
 *   discount_percent  optional; absent leaves the terms alone, null clears a
 *                     flat rate, a number sets one
 *   freight           optional { rate, unit, effective_from?, note? }; absent
 *                     or null leaves the ledger alone (it cannot be cleared)
 *
 * @param {{ query: Function }} db an open client inside BEGIN
 * @param {number} brandId
 * @param {{ parameters?: object, discount_percent?: number|null, freight?: object|null }} input
 */
export const saveHousePricing = async (db, brandId, input = {}) => {
  const house = await loadHouse(db, brandId)
  const parameters = Object.fromEntries(
    PARAMETER_COLUMNS.map((column) => [column, input.parameters?.[column] ?? null])
  )
  await upsertBrandParameters(db, house.id, parameters)
  if (Object.hasOwn(input, 'discount_percent')) {
    await writeDiscount(db, house, input.discount_percent)
  }
  if (input.freight != null) {
    await writeFreight(db, house, input.freight)
  }
  return getHousePricing(db, house.id)
}
