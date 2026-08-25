// A supplier's per-brand commercial terms: the read model AND the back-office
// write path (the CRM's Terms tab, which was read-only until this module grew
// writes because `npm run backfill:suppliers` was the only writer).
//
// THIS IS BACK-OFFICE ONLY. `supplier_brand_terms` and `supplier_discount_tiers`
// hold what Atelier pays a maison, which is that maison's confidential term —
// `test/suppliers-terms.test.js` scans src/ and fails if either table is named
// outside src/suppliers/, src/routes/admin-suppliers.js or the lifecycle
// registry. Nothing here may be joined into a client-facing read model, and the
// write routes additionally need `can_view_finance` (see the route file).
//
// Five details shape the module:
//   - Tiers are batch-loaded for every terms row in one query and grouped in
//     JS, the same posture as order lines in src/orders/order-history.js. A
//     per-row query would be an N+1 over the supplier's whole house list.
//   - pg parses `numeric[]` into JS numbers but a scalar `numeric` into a
//     STRING, so the two shapes of the same column family arrive differently
//     typed. Every rate is coerced defensively rather than trusting either.
//   - `discount_chain` is a Postgres `numeric(6,4)[]`, NOT jsonb, so a plain JS
//     array binds straight through. The house "JSON.stringify a jsonb param"
//     rule is about jsonb and does NOT apply here — stringifying would store
//     the literal text `[0.4,0.4]` as a one-element array, or fail outright.
//   - NOTHING HERE PRE-CHECKS A CONSTRAINT. The one-terms-row-per-brand UNIQUE,
//     the shape CHECK (`discount` xor `discount_chain`), the two rate ranges,
//     the case-insensitive tier label index and the single-fallback index are
//     all the database's to enforce; a pre-check races and would still need the
//     handler. They come back as 409/422 through `rethrowWrite`.
//   - The ONE rule SQL cannot enforce is the inside of the chain array — a
//     CHECK cannot contain a subquery — so `chainMultiplier` is spent as the
//     validator on the way IN. It is the same evaluator the read model resolves
//     with: the x0.36 rule is never re-derived, here or anywhere else.

import { buildUpdate } from '../catalogue/admin-brands.js'
import { CATEGORIES } from '../../scripts/lib/price-template.js'
import { chainMultiplier, resolveTermsChain } from './discount-chain.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

// Qualified, because every statement below joins `brands` for the house name a
// terms list is unreadable without.
const TERMS_COLUMNS = `supplier_brand_terms.id, supplier_brand_terms.brand_id,
  supplier_brand_terms.discount, supplier_brand_terms.discount_chain,
  supplier_brand_terms.markup, supplier_brand_terms.indicative,
  supplier_brand_terms.note, supplier_brand_terms.created_at,
  supplier_brand_terms.updated_at,
  brands.name AS brand_name, brands.slug AS brand_slug`

const TIER_COLUMNS = `id, supplier_brand_term_id, label, pct, is_fallback`

// Columns a PATCH may ever write, frozen and in-code as buildUpdate requires.
// `brand_id` is absent: it is the row's identity (UNIQUE, one set of terms per
// house), and moving terms to another maison is a delete and a re-create, not
// an edit — same posture as `supplier` on a price-list item and `slug` on a
// supplier.
export const TERMS_UPDATE_COLUMNS = Object.freeze([
  'discount',
  'discount_chain',
  'markup',
  'indicative',
  'note',
])

export const TIER_UPDATE_COLUMNS = Object.freeze(['label', 'pct', 'is_fallback'])

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// One message per unique constraint. Keyed on the constraint name because four
// of them can fire and "already exists" alone leaves staff hunting which field.
// The two tier entries are unique INDEXES; pg reports the index name here.
const CONFLICT_MESSAGES = Object.freeze({
  supplier_brand_terms_brand_id_key:
    'That house already has terms on file. Edit them rather than adding a second set.',
  supplier_discount_tiers_label_unique:
    'These terms already have a tier with that label. Labels are matched ' +
    'ignoring case and padding, so two that differ only there would resolve at random.',
  supplier_discount_tiers_fallback_unique:
    'These terms already have a fallback tier. Clear that one first — two ' +
    'fallbacks make the unmatched case, which is the common case, non-deterministic.',
})

// The CHECKs, in the words the office needs rather than the constraint's.
const CHECK_MESSAGES = Object.freeze({
  supplier_brand_terms_discount_shape_check:
    'A house is on a flat discount OR on a compounded chain, never both — with ' +
    'both, the net rate depends on which reader ran. Clear one of them.',
  supplier_brand_terms_discount_range_check:
    'A discount is a fraction off list: 0 or more and below 1. 1 would be a free metre.',
  supplier_brand_terms_markup_check:
    'A markup multiplies the landed cost, so it must be above 0.',
  supplier_brand_terms_chain_not_null_check:
    'A chain cannot contain a blank rate — one null nulls the whole net rate.',
  supplier_discount_tiers_pct_check:
    'A tier rate is a fraction off list: 0 or more and below 1.',
})

// Both foreign keys are NOT NULL, so a bad id is the caller's mistake either
// way; only the noun differs.
const FK_MESSAGES = Object.freeze({
  supplier_brand_terms_supplier_id_fkey: 'No supplier with that id.',
  supplier_brand_terms_brand_id_fkey: 'No house with that id.',
})

const rethrowWrite = (error) => {
  if (error?.code === '23505') {
    throw httpError(
      409,
      CONFLICT_MESSAGES[error.constraint] ?? 'Those terms are already on file.'
    )
  }
  if (error?.code === '23514') {
    throw httpError(
      422,
      CHECK_MESSAGES[error.constraint] ?? 'Those terms are not a shape this schema accepts.'
    )
  }
  if (error?.code === '23503') {
    throw httpError(422, FK_MESSAGES[error.constraint] ?? 'That record does not exist.')
  }
  throw error
}

/**
 * The chain, validated by the one evaluator. `chainMultiplier` throws on any
 * element that is not a fraction below 1 — the same throw the read model reports
 * as `invalid_reason` rather than failing a whole supplier's page. On the way IN
 * it is a 422 instead: a bad rate that reaches the column moves every price
 * under that house, and this is the only gate there is (a CHECK cannot reach
 * inside an array). A NULL element survives this — `Number(null)` is 0 — and is
 * caught by `supplier_brand_terms_chain_not_null_check` a statement later.
 */
const assertChain = (chain) => {
  try {
    chainMultiplier(chain)
  } catch (error) {
    throw httpError(422, error.message)
  }
}

/**
 * A tier label is free text matched case-insensitively against the LINE's
 * category — deliberately not the `products.category` enum, because the houses
 * quote things the enum has no word for ("new collections", "wallpapers by the
 * metre"). So there is nothing to validate it against beyond "is it a label at
 * all": a blank one matches nothing and still takes the unique index's slot.
 * Whether it will ever match is REPORTED on the row (`matches_category`), never
 * enforced — the fallback tier is what makes the unmatched case survivable.
 */
const assertLabel = (label) => {
  const trimmed = String(label ?? '').trim()
  if (trimmed === '') {
    throw httpError(422, 'A tier needs a label: it is matched against the line’s category.')
  }
  return trimmed
}

// null must survive as null: Number(null) is 0, which would read as "free".
const rateOrNull = (value) => (value == null ? null : Number(value))

const toTier = (row) =>
  Object.freeze({
    id: row.id,
    label: row.label,
    pct: Number(row.pct),
    is_fallback: row.is_fallback,
    // Advisory, not a rule: a label that is neither a category nor the fallback
    // can never be selected by resolveTermsChain, and the office has no other
    // way to see that. Compared the way the resolver compares.
    matches_category: CATEGORIES.has(String(row.label).trim().toLowerCase()),
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
 * CRM can badge it rather than the screen 500ing. (The write path refuses such a
 * chain outright — see assertChain — so this now only fires for rows that
 * predate it or came in through the backfill.)
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
    brand_name: row.brand_name,
    brand_slug: row.brand_slug,
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

// Every terms row matching `where`, each with its tiers and its net multiplier.
// `brand_id` is NOT NULL and foreign-keyed, so the join can be inner.
const loadTerms = async (db, { where, params, limit = null, offset = 0 }) => {
  const paged = limit == null ? '' : ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
  const { rows } = await db.query(
    `SELECT ${TERMS_COLUMNS} FROM supplier_brand_terms
       JOIN brands ON brands.id = supplier_brand_terms.brand_id
      WHERE ${where}
      ORDER BY brands.name ASC, supplier_brand_terms.id ASC${paged}`,
    limit == null ? params : [...params, limit, offset]
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

/**
 * Every terms row belonging to one supplier, each with its tiers and the net
 * multiplier it resolves to. Empty array when the supplier has no terms on file
 * — which is the normal state for an `averaged` supplier, whose one net rate is
 * recorded on the supplier itself.
 *
 * Unpaginated on purpose: `getSupplier` embeds the result per house, and a
 * silent LIMIT there would drop cost data off the detail screen with nothing to
 * show it had happened. The paginated variant below is the standalone list.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db pool or an open client
 * @param {number} supplierId
 * @returns {Promise<object[]>}
 */
export const listSupplierBrandTerms = (db, supplierId) =>
  loadTerms(db, { where: 'supplier_brand_terms.supplier_id = $1', params: [supplierId] })

/**
 * The same rows, paginated, for the standalone terms list. Returns
 * { terms, total } — the route builds the meta envelope, as the other admin
 * lists do.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ terms: object[], total: number }>}
 */
export const pageSupplierBrandTerms = async (pool, supplierId, { page, limit } = {}) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT

  const { rows } = await pool.query(
    `SELECT count(*)::int AS total FROM supplier_brand_terms WHERE supplier_id = $1`,
    [supplierId]
  )
  const terms = await loadTerms(pool, {
    where: 'supplier_brand_terms.supplier_id = $1',
    params: [supplierId],
    limit: safeLimit,
    offset: (safePage - 1) * safeLimit,
  })
  return { terms, total: rows[0].total }
}

/**
 * One terms row, scoped to its supplier, or null. The scope is not decoration:
 * `brand_id` is unique across the whole table, so a terms id is meaningful
 * without a supplier, and without this clause /admin/suppliers/7/... would reach
 * supplier 8's terms.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} supplierId
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getSupplierBrandTerms = async (db, supplierId, id) => {
  const [terms] = await loadTerms(db, {
    where: 'supplier_brand_terms.id = $1 AND supplier_brand_terms.supplier_id = $2',
    params: [id, supplierId],
  })
  return terms ?? null
}

const termsNotFound = (supplierId, id) =>
  httpError(404, `Supplier ${supplierId} has no terms ${id}.`)

/**
 * Create one house's terms under a supplier. The shape rules are the database's
 * — a flat discount and a chain together is a 422 from the shape CHECK, a second
 * set for the same house a 409 from the UNIQUE — and the chain's contents are
 * this module's, because SQL cannot see inside an array.
 *
 * Returns the same shape the read model serves, so the response carries the
 * evaluated `net_multiplier`: an office typing {0.4, 0.4} has no other way to
 * see that it means x0.36 rather than x0.2.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createSupplierBrandTerms = async (pool, supplierId, input) => {
  const chain = input.discount_chain ?? []
  assertChain(chain)
  try {
    const { rows } = await pool.query(
      `INSERT INTO supplier_brand_terms
         (supplier_id, brand_id, discount, discount_chain, markup, indicative, note)
       VALUES ($1, $2, $3, $4::numeric(6,4)[], $5, $6, $7)
       RETURNING id`,
      [
        supplierId,
        input.brand_id,
        input.discount ?? null,
        chain,
        input.markup ?? null,
        input.indicative ?? false,
        input.note ?? null,
      ]
    )
    return await getSupplierBrandTerms(pool, supplierId, rows[0].id)
  } catch (error) {
    return rethrowWrite(error)
  }
}

/**
 * Patch a terms row from the frozen whitelist. `Object.hasOwn` keeps an explicit
 * null (which clears an optional column) distinct from an absent key; the chain
 * is normalised to `[]` rather than null, because the column is NOT NULL and
 * "no chain" is an empty array, not an absent one.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateSupplierBrandTerms = async (pool, supplierId, id, input) => {
  const patch = Object.hasOwn(input, 'discount_chain')
    ? { ...input, discount_chain: input.discount_chain ?? [] }
    : input
  if (Object.hasOwn(patch, 'discount_chain')) assertChain(patch.discount_chain)

  const { sets, params } = buildUpdate(patch, TERMS_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE supplier_brand_terms SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1} AND supplier_id = $${params.length + 2}
        RETURNING id`,
      [...params, id, supplierId]
    )
    if (rows.length === 0) throw termsNotFound(supplierId, id)
    return await getSupplierBrandTerms(pool, supplierId, id)
  } catch (error) {
    return rethrowWrite(error)
  }
}

/**
 * Add a tier to a terms row. The INSERT ... SELECT is what scopes it: the parent
 * must both exist and belong to this supplier, in the one statement that writes,
 * so there is no pre-check to race with.
 *
 * Returns the PARENT terms row, because a tier changes what the whole row
 * resolves to and a bare tier tells the office nothing.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {number} termsId
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createSupplierDiscountTier = async (pool, supplierId, termsId, input) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO supplier_discount_tiers
         (supplier_brand_term_id, label, pct, is_fallback)
       SELECT id, $2, $3, $4 FROM supplier_brand_terms
        WHERE id = $1 AND supplier_id = $5
       RETURNING id`,
      [termsId, assertLabel(input.label), input.pct, input.is_fallback ?? false, supplierId]
    )
    if (rows.length === 0) throw termsNotFound(supplierId, termsId)
    return await getSupplierBrandTerms(pool, supplierId, termsId)
  } catch (error) {
    return rethrowWrite(error)
  }
}

/**
 * Patch a tier, scoped to its terms row and that row's supplier. Returns the
 * parent terms row, for the same reason create does.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {number} termsId
 * @param {number} tierId
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateSupplierDiscountTier = async (
  pool,
  supplierId,
  termsId,
  tierId,
  input
) => {
  const patch = Object.hasOwn(input, 'label')
    ? { ...input, label: assertLabel(input.label) }
    : input
  const { sets, params } = buildUpdate(patch, TIER_UPDATE_COLUMNS)
  const [tier, terms, supplier] = [params.length + 1, params.length + 2, params.length + 3]
  try {
    const { rows } = await pool.query(
      `UPDATE supplier_discount_tiers SET ${sets.join(', ')}
         FROM supplier_brand_terms
        WHERE supplier_discount_tiers.supplier_brand_term_id = supplier_brand_terms.id
          AND supplier_discount_tiers.id = $${tier}
          AND supplier_brand_terms.id = $${terms}
          AND supplier_brand_terms.supplier_id = $${supplier}
        RETURNING supplier_discount_tiers.id`,
      [...params, tierId, termsId, supplierId]
    )
    if (rows.length === 0) {
      throw httpError(404, `Terms ${termsId} have no tier ${tierId}.`)
    }
    return await getSupplierBrandTerms(pool, supplierId, termsId)
  } catch (error) {
    return rethrowWrite(error)
  }
}

/**
 * The tier's id, but only when it belongs to these terms and this supplier.
 * `deleteOrExplain` addresses a row by id alone, so this is what keeps a DELETE
 * under /admin/suppliers/7/... from reaching another supplier's tier. Null when
 * any link in the chain does not hold — the route answers 404.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {number} termsId
 * @param {number} tierId
 * @returns {Promise<number|null>}
 */
export const findScopedTierId = async (pool, supplierId, termsId, tierId) => {
  const { rows } = await pool.query(
    `SELECT supplier_discount_tiers.id FROM supplier_discount_tiers
       JOIN supplier_brand_terms
         ON supplier_brand_terms.id = supplier_discount_tiers.supplier_brand_term_id
      WHERE supplier_discount_tiers.id = $1
        AND supplier_brand_terms.id = $2
        AND supplier_brand_terms.supplier_id = $3`,
    [tierId, termsId, supplierId]
  )
  return rows[0]?.id ?? null
}
