// One house's pricing, read and written as ONE set — the Pricing panel on the
// house's own page in the CRM (/admin/brands/:id).
//
// The office asked (September 2026) for every figure on the Dynamics parameter
// export — duty A/B/C, clearance, freight, discount, trade markup and the
// small-order surcharge — to live on its house and be editable there, then for
// freight CLASSES (a rate per freight letter) and discount CLASSES (a house's
// several discount tiers). Each figure ALREADY has exactly one home on the
// platform, and this module adds none; it is a view over the three and a writer
// that routes each field to its own:
//
//   duty bands, clearance, trade markup, FX margin, handling, surcharge
//       -> the house's override row in `supplier_pricing_parameters`
//          (PUT semantics: the whole set travels, an omitted field clears)
//   discount, discount classes
//       -> the house's supplier terms, through src/suppliers/supplier-terms.js
//          (the terms tables are named only under src/suppliers/ —
//          test/suppliers-terms.test.js scans for it): the flat rate, and the
//          tiers as the house's discount classes. A house on a compounded chain
//          is refused here with a 422 that sends the office to the supplier's
//          terms panel — the chain wins over everything and is a different
//          agreement, not an edit.
//   freight, freight classes
//       -> NEW dated rows on the append-only freight ledger, scoped to the
//          house's name (the client answered F1 in Sept 2026: freight is per
//          house): the every-class rate, and one rate per letter. Never an
//          overwrite (FR-192); the same figure again is a no-op rather than a
//          duplicate, and a rate cannot be removed.
//
// The write is one transaction (the route opens it), so a refused discount does
// not leave a half-saved house behind.
//
// Percentages are as the office writes them (5 is 5%) on every field, the
// discount and its classes included: the terms tables store a fraction, and
// the conversion happens here and nowhere in the CRM.

import {
  PARAMETER_COLUMNS,
  getBrandParameters,
  getSupplierParameters,
  upsertBrandParameters,
} from './pricing-parameters.js'
import {
  createFreightRate,
  currentClassRates,
  deleteHouseClassRates,
  freightClassOf,
  resolveFreightRate,
  today,
} from './freight-rates.js'
import { chainMultiplier, resolveTermsChain } from '../suppliers/discount-chain.js'
import {
  createSupplierBrandTerms,
  createSupplierDiscountTier,
  deleteSupplierDiscountTier,
  getBrandTerms,
  updateSupplierBrandTerms,
  updateSupplierDiscountTier,
} from '../suppliers/supplier-terms.js'
import { countProductsByTier } from '../suppliers/product-tiers.js'
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

const CHAIN_REFUSAL =
  "This house's discount is a compounded chain. Edit it on the supplier's terms — a flat rate or classes would replace the agreement."
const NO_SUPPLIER_REFUSAL =
  'Link this house to the supplier that invoices it before setting a discount — a discount is that supplier’s term.'

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

// Price lines name their house in `product_range` (19,447 of 19,514 rows —
// migration 1791724800000), matched as the freight ledger matches a range
// name: case-insensitively, trimmed. Archived and discontinued lines count for
// nothing here.
const HOUSE_LINES = `FROM price_list_items pli
  JOIN brands b ON lower(btrim(b.name)) = lower(btrim(pli.product_range))
 WHERE pli.archived_at IS NULL
   AND pli.discontinued_at IS NULL`

/**
 * The freight letters one house's price lines carry, with how many lines each —
 * the classes the house page offers a rate for, so the office sets the letters
 * that are actually priced (Fabricut: A on most lines, B on trimmings).
 *
 * @param {{ query: Function }} db
 * @param {number} brandId
 * @returns {Promise<{ freight_class: string, lines: number }[]>}
 */
export const houseFreightClassLines = async (db, brandId) => {
  const { rows } = await db.query(
    `SELECT pli.freight_class, count(*)::int AS lines
       ${HOUSE_LINES}
        AND pli.freight_class IS NOT NULL
        AND b.id = $1
      GROUP BY pli.freight_class
      ORDER BY pli.freight_class`,
    [brandId]
  )
  return rows.map((row) => Object.freeze({ freight_class: row.freight_class, lines: row.lines }))
}

const describeClasses = (terms, productCounts) =>
  Object.freeze(
    (terms?.tiers ?? []).map((tier) =>
      Object.freeze({
        id: tier.id,
        label: tier.label,
        percent: fractionToPercent(tier.pct),
        is_default: tier.is_fallback,
        // A class whose label is no category is chosen only by a product
        // picking it; the page says so.
        matches_category: tier.matches_category,
        // How many products chose this class — they fall back to category
        // matching if it is removed.
        products: productCounts.get(tier.id) ?? 0,
      })
    )
  )

// What the panel says about the discount, and whether it may write one.
const describeDiscount = (house, terms, supplierDefault, productCounts) => {
  const classes = describeClasses(terms, productCounts)
  if (terms && terms.discount_chain.length > 0) {
    const resolved = resolveTermsChain(terms, terms.tiers)
    return Object.freeze({
      percent: round3((1 - chainMultiplier(resolved.chain)) * 100),
      source: 'house',
      shape: 'chain',
      editable: false,
      reason: "This house is on a compounded discount chain. Edit it on the supplier's terms.",
      classes,
    })
  }
  // The house's own flat rate, else the supplier's averaged one, else nothing.
  // Classes sit beside it: a product's class (chosen, or matched by category,
  // or the default class) wins, and the flat rate covers everything else.
  const base =
    terms?.discount != null
      ? { percent: fractionToPercent(terms.discount), source: 'house' }
      : supplierDefault != null
        ? { percent: fractionToPercent(supplierDefault), source: 'supplier' }
        : { percent: null, source: 'missing' }
  // Writing needs a supplier to hang terms on — the terms' own, or the house's.
  const editable = terms != null || house.supplier_id != null
  return Object.freeze({
    ...base,
    shape: classes.length > 0 ? 'tiers' : terms ? 'flat' : 'none',
    editable,
    reason: editable ? null : NO_SUPPLIER_REFUSAL,
    classes,
  })
}

const freightView = (rate) =>
  rate
    ? Object.freeze({
        rate: rate.rate,
        basis: rate.basis,
        effective_from: rate.effective_from,
        note: rate.note,
        freight_class: rate.freight_class ?? null,
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
  const [parameters, supplierParameters, terms, houseFreight, supplierFreight] = [
    await getBrandParameters(db, house.id),
    supplier ? await getSupplierParameters(db, supplier.id) : null,
    await getBrandTerms(db, house.id),
    await resolveFreightRate(db, { range_name: house.name }),
    supplier ? await resolveFreightRate(db, { supplier_id: supplier.id }) : null,
  ]
  const [classRates, classLines, productCounts] = [
    await currentClassRates(db, { range_name: house.name }),
    await houseFreightClassLines(db, house.id),
    await countProductsByTier(db, (terms?.tiers ?? []).map((tier) => tier.id)),
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
    discount: describeDiscount(house, terms, supplier?.default_discount ?? null, productCounts),
    // The house's own every-class rate; the supplier-wide one covers a house
    // with none.
    freight: freightView(houseFreight.rate),
    supplier_freight: freightView(supplierFreight?.rate ?? null),
    // The house's rate per freight letter, and the letters its price lines
    // carry (with how many lines) — the classes worth setting.
    freight_classes: Object.freeze(classRates.map(freightView)),
    freight_class_lines: Object.freeze(classLines),
  })
}

const writeDiscount = async (db, house, percent) => {
  const terms = await getBrandTerms(db, house.id)
  const fraction = percentToFraction(percent)
  if (terms) {
    if (terms.discount_chain.length > 0) throw httpError(422, CHAIN_REFUSAL)
    if (terms.discount == null ? fraction == null : sameRate(terms.discount, fraction)) return
    await updateSupplierBrandTerms(db, terms.supplier_id ?? house.supplier_id, terms.id, { discount: fraction })
    return
  }
  // Nothing to clear on a house with no terms.
  if (fraction == null) return
  if (house.supplier_id == null) throw httpError(422, NO_SUPPLIER_REFUSAL)
  await createSupplierBrandTerms(db, house.supplier_id, {
    brand_id: house.id,
    discount: fraction,
    note: 'Set on the house page',
  })
}

/**
 * Replace the house's discount classes with the given set: an entry with an
 * `id` keeps (and may edit) that class, one without is new, and a class left
 * out is removed. Order matters for the two unique indexes the tiers carry
 * (one label per terms row, one default): removals first, then the default
 * cleared where it moves, then edits, then new classes.
 */
const writeDiscountClasses = async (db, house, classes) => {
  const labels = new Set()
  for (const entry of classes) {
    const key = entry.label.trim().toLowerCase()
    if (key === '') throw httpError(422, 'A discount class needs a name.')
    if (labels.has(key)) throw httpError(422, `Two discount classes are called "${entry.label.trim()}".`)
    labels.add(key)
  }
  if (classes.filter((entry) => entry.is_default).length > 1) {
    throw httpError(422, 'Only one discount class can be the default.')
  }

  let terms = await getBrandTerms(db, house.id)
  if (terms?.discount_chain.length > 0) throw httpError(422, CHAIN_REFUSAL)
  if (!terms) {
    if (classes.length === 0) return
    if (house.supplier_id == null) throw httpError(422, NO_SUPPLIER_REFUSAL)
    terms = await createSupplierBrandTerms(db, house.supplier_id, {
      brand_id: house.id,
      note: 'Set on the house page',
    })
  }
  const supplierId = terms.supplier_id ?? house.supplier_id
  const current = new Map(terms.tiers.map((tier) => [tier.id, tier]))
  for (const entry of classes) {
    if (entry.id != null && !current.has(entry.id)) {
      throw httpError(422, `Discount class ${entry.id} is not one of this house's classes.`)
    }
  }
  const kept = new Set(classes.filter((entry) => entry.id != null).map((entry) => entry.id))

  for (const tier of terms.tiers) {
    if (!kept.has(tier.id)) await deleteSupplierDiscountTier(db, supplierId, terms.id, tier.id)
  }
  for (const entry of classes) {
    const tier = entry.id == null ? null : current.get(entry.id)
    if (tier?.is_fallback && !entry.is_default) {
      await updateSupplierDiscountTier(db, supplierId, terms.id, tier.id, { is_fallback: false })
    }
  }
  for (const entry of classes) {
    const tier = entry.id == null ? null : current.get(entry.id)
    if (!tier) continue
    const label = entry.label.trim()
    const pct = percentToFraction(entry.percent)
    const patch = {
      ...(tier.label !== label ? { label } : {}),
      ...(sameRate(tier.pct, pct) ? {} : { pct }),
      ...(entry.is_default && !tier.is_fallback ? { is_fallback: true } : {}),
    }
    if (Object.keys(patch).length > 0) {
      await updateSupplierDiscountTier(db, supplierId, terms.id, tier.id, patch)
    }
  }
  for (const entry of classes) {
    if (entry.id != null) continue
    await createSupplierDiscountTier(db, supplierId, terms.id, {
      label: entry.label.trim(),
      pct: percentToFraction(entry.percent),
      is_fallback: entry.is_default === true,
    })
  }
}

const sameFreight = (current, freight) =>
  current != null &&
  current.basis === 'dollar' &&
  sameRate(current.rate, freight.rate)

const appendFreight = (db, house, freight, freightClass = null) =>
  createFreightRate(db, {
    range_name: house.name,
    freight_class: freightClass,
    basis: 'dollar',
    rate: freight.rate,
    effective_from: freight.effective_from ?? today(),
    note: freight.note ?? 'Set on the house page',
  })

const writeFreight = async (db, house, freight) => {
  const current = (await resolveFreightRate(db, { range_name: house.name })).rate
  if (sameFreight(current, freight)) return
  await appendFreight(db, house, freight)
}

// Each letter's rate appended where it differs from the letter's current one.
const writeFreightClasses = async (db, house, rates) => {
  const letters = new Set()
  for (const rate of rates) {
    const letter = freightClassOf(rate.freight_class)
    if (letters.has(letter)) throw httpError(422, `Freight class ${letter} is listed twice.`)
    letters.add(letter)
  }
  const current = new Map(
    (await currentClassRates(db, { range_name: house.name })).map((rate) => [rate.freight_class, rate])
  )
  for (const rate of rates) {
    const letter = freightClassOf(rate.freight_class)
    if (sameFreight(current.get(letter), rate)) continue
    await appendFreight(db, house, rate, letter)
  }
}

/**
 * Save the house's pricing. Call inside a transaction.
 *
 *   parameters        the whole override set (PUT — an omitted column clears)
 *   discount_percent  optional; absent leaves the terms alone, null clears a
 *                     flat rate, a number sets one
 *   discount_classes  optional; the whole set of the house's classes
 *                     ([{ id?, label, percent, is_default? }]) — absent leaves
 *                     them alone
 *   freight           optional { rate, effective_from?, note? }; absent
 *                     or null leaves the ledger alone (it cannot be cleared)
 *   freight_classes   optional [{ freight_class, rate, effective_from? }];
 *                     a letter left out keeps its rate
 *   remove_freight_classes optional ['B', …]; each letter's own rate is
 *                     removed, so its lines pay the house's rate
 *
 * @param {{ query: Function }} db an open client inside BEGIN
 * @param {number} brandId
 * @param {object} input
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
  if (Array.isArray(input.discount_classes)) {
    await writeDiscountClasses(db, house, input.discount_classes)
  }
  if (input.freight != null) {
    await writeFreight(db, house, input.freight)
  }
  if (Array.isArray(input.remove_freight_classes)) {
    const removing = new Set(input.remove_freight_classes.map(freightClassOf))
    const both = (input.freight_classes ?? []).map((rate) => freightClassOf(rate.freight_class)).filter((l) => removing.has(l))
    if (both.length > 0) throw httpError(422, `Freight class ${both[0]} cannot be both set and removed in one save.`)
    for (const letter of removing) await deleteHouseClassRates(db, { range_name: house.name, freight_class: letter })
  }
  if (Array.isArray(input.freight_classes)) {
    await writeFreightClasses(db, house, input.freight_classes)
  }
  return getHousePricing(db, house.id)
}
