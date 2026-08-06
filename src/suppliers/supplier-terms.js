// Read model for a supplier's per-brand commercial terms.
//
// THIS IS BACK-OFFICE ONLY. `supplier_brand_terms` and `supplier_discount_tiers`
// hold what Atelier pays a maison, which is that maison's confidential term —
// `test/suppliers-terms.test.js` scans src/ and fails if either table is named
// outside src/suppliers/ or src/routes/admin-suppliers.js. Nothing here may be
// joined into a client-facing read model.
//
// Two details shape the module:
//   - Tiers are batch-loaded for every terms row in one query and grouped in
//     JS, the same posture as order lines in src/orders/order-history.js. A
//     per-row query would be an N+1 over the supplier's whole house list.
//   - pg parses `numeric[]` into JS numbers but a scalar `numeric` into a
//     STRING, so the two shapes of the same column family arrive differently
//     typed. Every rate is coerced defensively rather than trusting either.

import { chainMultiplier, resolveTermsChain } from './discount-chain.js'

const TERMS_COLUMNS = `id, brand_id, discount, discount_chain, markup, indicative,
  note, created_at, updated_at`

const TIER_COLUMNS = `id, supplier_brand_term_id, label, pct, is_fallback`

// null must survive as null: Number(null) is 0, which would read as "free".
const rateOrNull = (value) => (value == null ? null : Number(value))

const toTier = (row) =>
  Object.freeze({
    id: row.id,
    label: row.label,
    pct: Number(row.pct),
    is_fallback: row.is_fallback,
  })

/**
 * The net multiplier the row resolves to, via the one evaluator
 * (discount-chain.js). A chain is MULTIPLICATIVE — {0.4, 0.4} is x0.36 — so
 * this is the only number a caller may treat as "the discount".
 *
 * `rateFrom` throws on an element outside [0, 1). A CHECK cannot validate array
 * elements (no subqueries), so `discount_chain` is the one place a bad rate can
 * reach the database, and failing the whole supplier read for one bad row would
 * hide the other thirty-nine. The reason is reported on the row instead, so the
 * CRM can badge it rather than the screen 500ing.
 */
const netOf = (terms, tiers) => {
  try {
    const resolved = resolveTermsChain(terms, tiers)
    return {
      net_multiplier: chainMultiplier(resolved.chain),
      net_source: resolved.source,
      net_label: resolved.label,
      invalid_reason: null,
    }
  } catch (error) {
    return {
      net_multiplier: null,
      net_source: null,
      net_label: null,
      invalid_reason: error.message,
    }
  }
}

const toTerms = (row, tiers) => {
  const base = {
    id: row.id,
    brand_id: row.brand_id,
    discount: rateOrNull(row.discount),
    discount_chain: (row.discount_chain ?? []).map(Number),
    markup: rateOrNull(row.markup),
    indicative: row.indicative,
    note: row.note,
    tiers,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
  return Object.freeze({ ...base, ...netOf(base, tiers) })
}

/**
 * Every terms row belonging to one supplier, each with its tiers and the net
 * multiplier it resolves to. Empty array when the supplier has no terms on file
 * — which is the normal state for an `averaged` supplier, whose one net rate is
 * recorded on the supplier itself.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db pool or an open client
 * @param {number} supplierId
 * @returns {Promise<object[]>}
 */
export const listSupplierBrandTerms = async (db, supplierId) => {
  const { rows } = await db.query(
    `SELECT ${TERMS_COLUMNS} FROM supplier_brand_terms
      WHERE supplier_id = $1
      ORDER BY brand_id ASC`,
    [supplierId]
  )
  if (rows.length === 0) return []

  // One round trip for every row's tiers, grouped below — never a query per row.
  const { rows: tierRows } = await db.query(
    `SELECT ${TIER_COLUMNS} FROM supplier_discount_tiers
      WHERE supplier_brand_term_id = ANY($1::int[])
      ORDER BY is_fallback ASC, label ASC`,
    [rows.map((row) => row.id)]
  )

  const byTerms = new Map()
  for (const tier of tierRows) {
    const list = byTerms.get(tier.supplier_brand_term_id) ?? []
    byTerms.set(tier.supplier_brand_term_id, [...list, toTier(tier)])
  }

  return rows.map((row) => toTerms(row, Object.freeze(byTerms.get(row.id) ?? [])))
}
