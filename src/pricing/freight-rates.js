// Freight rates: the resolver (W16 US-005) and the append-only writes (US-008).
//
// A MISSING RATE RETURNS NULL WITH A NAMED REASON, NEVER ZERO. `Number(null)` is
// 0 and a zero freight rate reads as free shipping from Italy — a landed cost
// that is quietly short by $50 a metre looks exactly as authoritative as one
// that is right. Every miss here therefore comes back as
// `{ rate: null, reason: '<why>' }` and the caller decides; nothing in this
// module COALESCEs a freight figure to anything. (Blank means zero for the
// discount and for the duty letter — both verified over the corpus — and
// UNKNOWN for freight. One COALESCE for all three is the trap.)
//
// APPEND-ONLY, AND THERE IS DELIBERATELY NO UPDATE AND NO DELETE (FR-192). A
// rate carries `effective_from` and a new rate never overwrites the old one:
// that is what makes the >=5% annual uplift auditable and what lets a 2024
// landed cost be reconciled at all. A correction is a later row, not an edit,
// so `supplier_freight_rates` has no `updateFreightRate` to find and no route
// to call one. The unique index is what stops two rates claiming one day, which
// would otherwise make this resolver pick at random.
//
// NOTHING DERIVES A RATE FROM THE PRICE CORPUS. The exported `Freight` column
// agrees with the rate the price rows imply in only 30 of 43 ranges, and
// `src/pricing/freight-recovery.js` reports that evidence rather than acting on
// it. F1 was answered in Sept 2026 — freight is per HOUSE — so the rows here
// are what a person types (the form, the yearly sheet, the house page) or the
// Dynamics export's own per-house figure, applied by the pricing import
// (src/pricing/parameters-backfill.js) as a dated range rate. A house nobody
// has set is still a miss, never a zero.

import { CATEGORIES, UNITS } from '../../scripts/lib/price-template.js'
import { categorySlugs } from '../catalogue/categories.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/** Boundary copies of the column CHECKs, so a typo is a 422 and not a 500. */
export const FREIGHT_BASES = Object.freeze(['dollar', 'percent'])
// The SEEDED nine. `supplier_freight_rates.category` references
// `product_categories` since migration 1791379200000, so the live vocabulary is
// that table and `createFreightRate` reads it; this is the fallback for a
// validation call made without one.
export const FREIGHT_CATEGORIES = Object.freeze([...CATEGORIES])
export const FREIGHT_UNITS = Object.freeze([...UNITS])

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 500

/** Why a resolve came back empty. Every one of these is a null rate, never a 0. */
export const NO_RATE_REASONS = Object.freeze({
  NO_SCOPE: 'no_scope',
  NO_RATE_FOR_SCOPE: 'no_rate_for_scope',
  NOT_YET_EFFECTIVE: 'not_yet_effective',
})

const RATE_COLUMNS = `id, supplier_id, range_name, category, freight_class, basis,
  rate, unit, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, note, created_at`

// `effective_from` is selected as text on purpose: pg turns a `date` into a JS
// Date at LOCAL midnight, so a naive comparison against an ISO day string is
// off by the session's offset for half the world. An ISO day compares
// correctly as a string and is what the CSV round trip reads and writes.
const toRate = (row) =>
  Object.freeze({
    id: row.id,
    supplier_id: row.supplier_id,
    range_name: row.range_name,
    category: row.category,
    // The freight LETTER the rate is for (migration 1792012800000); null is
    // every class.
    freight_class: row.freight_class ?? null,
    basis: row.basis,
    rate: Number(row.rate),
    unit: row.unit,
    effective_from: row.effective_from,
    note: row.note,
    created_at: row.created_at,
  })

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A house carries at most five freight classes, A to E — the letters the price
 * lines carry in the corpus (the office's cap, Sept 2026). Price lines still
 * store any letter; one past E simply prices on the every-class rate.
 */
export const FREIGHT_CLASS_PATTERN = /^[A-E]$/

/**
 * A caller's freight class as the letter the ledger stores, or null for "no
 * class" (blank, absent). Lower case is raised; anything else is returned as-is
 * for the validator to refuse in words.
 */
export const freightClassOf = (value) => {
  if (value == null) return null
  const text = String(value).trim()
  return text === '' ? null : text.toUpperCase()
}

/** Today as an ISO day, in the server's own timezone — the resolver's default. */
export const today = () => new Date().toISOString().slice(0, 10)

// Exactly one scope. A caller states WHICH grain it is asking at; nothing here
// picks between a supplier rate and a range rate. The client answered F1 in
// Sept 2026 — freight is per HOUSE — so the waterfall asks the house's range
// scope first and the supplier second (src/pricing/pricing-parameters.js).
const scopeOf = ({ supplier_id: supplierId = null, range_name: rangeName = null }) => {
  const range = typeof rangeName === 'string' && rangeName.trim() !== '' ? rangeName.trim() : null
  const supplier = Number.isInteger(supplierId) ? supplierId : null
  if ((supplier === null) === (range === null)) return null
  return { supplierId: supplier, rangeName: range }
}

/**
 * The rate in force for a scope on a day, or null with a reason.
 *
 * Precedence: a rate stated for the LINE'S OWN FREIGHT CLASS beats the rate for
 * every class (`freight_class IS NULL`); then a rate for the line's own
 * CATEGORY beats one for every category; among equals the latest
 * `effective_from` wins — which is what makes appending a new row a change of
 * rate rather than a second answer. The class outranks the category because the
 * letter is the line's own statement of how it ships (a full roll by air
 * against a trimming), where a category is a merchandising axis. A caller that
 * names no class, or no category, is asking for the catch-all on that axis and
 * gets only the catch-all: answering it with some letter's rate would be
 * picking one of five.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {{ supplier_id?: number|null, range_name?: string|null,
 *           category?: string|null, freight_class?: string|null, on?: string }} query
 * @returns {Promise<{ rate: object|null, reason: string|null }>}
 */
export const resolveFreightRate = async (db, query = {}) => {
  const scope = scopeOf(query)
  if (!scope) {
    return { rate: null, reason: NO_RATE_REASONS.NO_SCOPE }
  }
  const category = typeof query.category === 'string' && query.category !== '' ? query.category : null
  const freightClass = freightClassOf(query.freight_class)
  const on = ISO_DAY.test(query.on ?? '') ? query.on : today()

  const params = [scope.supplierId ?? scope.rangeName]
  const clauses = [scope.supplierId === null ? 'lower(range_name) = lower($1)' : 'supplier_id = $1']
  if (category === null) {
    clauses.push('category IS NULL')
  } else {
    params.push(category)
    clauses.push(`(category = $${params.length} OR category IS NULL)`)
  }
  if (freightClass === null) {
    clauses.push('freight_class IS NULL')
  } else {
    params.push(freightClass)
    clauses.push(`(freight_class = $${params.length} OR freight_class IS NULL)`)
  }
  const { rows } = await db.query(
    `SELECT ${RATE_COLUMNS} FROM supplier_freight_rates WHERE ${clauses.join(' AND ')}`,
    params
  )

  if (rows.length === 0) {
    return { rate: null, reason: NO_RATE_REASONS.NO_RATE_FOR_SCOPE }
  }

  const effective = rows
    .filter((row) => row.effective_from <= on)
    // Specific class first, then specific category, then newest; `id` breaks a
    // tie the unique index makes unreachable, so one corpus always resolves to
    // one rate.
    .sort(
      (left, right) =>
        Number(left.freight_class === null) - Number(right.freight_class === null) ||
        Number(left.category === null) - Number(right.category === null) ||
        right.effective_from.localeCompare(left.effective_from) ||
        right.id - left.id
    )

  if (effective.length === 0) {
    // Rates exist but every one of them starts later. That is a different fact
    // from "nobody has ever set one", and only one of the two is somebody
    // forgetting to enter a rate.
    return { rate: null, reason: NO_RATE_REASONS.NOT_YET_EFFECTIVE }
  }
  return { rate: toRate(effective[0]), reason: null }
}

/**
 * The catch-all rate in force for every HOUSE on a day, in one read — what
 * `resolveFreightRate({ range_name, on })` with no category answers, for all of
 * them at once. The pricing import compares a whole export against it, and 60
 * resolves in a loop would be 60 round trips inside one transaction.
 *
 * Same precedence as the resolver for that case: rows for every category and
 * every freight class only (a category's or a letter's rate is not the house's
 * default), effective on or before
 * `on`, newest `effective_from` first, `id` breaking the tie the unique index
 * makes unreachable. A house with no such row is simply absent — never a zero.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {string} [on] ISO day; today when absent or malformed
 * @returns {Promise<object[]>} one rate per range name, in the ledger's shape
 */
export const currentRangeRates = async (db, on) => {
  const day = ISO_DAY.test(on ?? '') ? on : today()
  const { rows } = await db.query(
    `SELECT DISTINCT ON (lower(range_name)) ${RATE_COLUMNS}
       FROM supplier_freight_rates
      WHERE range_name IS NOT NULL
        AND category IS NULL
        AND freight_class IS NULL
        AND effective_from <= $1::date
      ORDER BY lower(range_name), effective_from DESC, id DESC`,
    [day]
  )
  return rows.map(toRate)
}

/**
 * The rate in force for each FREIGHT CLASS of one scope, on a day — the house
 * page's class rows. Every-category rows only, the letter's newest dated rate
 * each, ordered by letter. The every-class default is not here; that is
 * `resolveFreightRate` with no class.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {{ supplier_id?: number|null, range_name?: string|null, on?: string }} query
 * @returns {Promise<object[]>} one rate per letter, in the ledger's shape
 */
export const currentClassRates = async (db, query = {}) => {
  const scope = scopeOf(query)
  if (!scope) return []
  const day = ISO_DAY.test(query.on ?? '') ? query.on : today()
  const { rows } = await db.query(
    `SELECT DISTINCT ON (freight_class) ${RATE_COLUMNS}
       FROM supplier_freight_rates
      WHERE ${scope.supplierId === null ? 'lower(range_name) = lower($1)' : 'supplier_id = $1'}
        AND category IS NULL
        AND freight_class IS NOT NULL
        AND effective_from <= $2::date
      ORDER BY freight_class, effective_from DESC, id DESC`,
    [scope.supplierId ?? scope.rangeName, day]
  )
  return rows.map(toRate)
}

/**
 * Remove a house's rate for one freight class — every dated row of it, dated
 * ahead included — so the letter pays the house's every-class rate again
 * (28 Sep 2026, the office: a class must be removable, not only added).
 * The one exception to "append-only": a class is an override the office
 * decided should not exist, and an end-dated row would be a rate of nothing.
 * The house's every-class rates and every other letter are untouched.
 *
 * @returns {Promise<number>} rows removed
 */
export const deleteHouseClassRates = async (db, { range_name: rangeName, freight_class: freightClass }) => {
  const { rowCount } = await db.query(
    `DELETE FROM supplier_freight_rates
      WHERE supplier_id IS NULL AND lower(range_name) = lower($1)
        AND category IS NULL AND freight_class = $2`,
    [rangeName, freightClassOf(freightClass)]
  )
  return rowCount
}

/**
 * Every rate on the ledger, newest first — the history, not a current view,
 * because the history is the point of an append-only table.
 *
 * @param {import('pg').Pool} pool
 * @param {{ supplier_id?: number, range_name?: string, category?: string,
 *           page?: number, limit?: number }} [options]
 * @returns {Promise<{ rates: object[], total: number }>}
 */
export const listFreightRates = async (
  pool,
  { supplier_id: supplierId, range_name: rangeName, category, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT

  const clauses = []
  const params = []
  if (Number.isInteger(supplierId)) {
    params.push(supplierId)
    clauses.push(`supplier_id = $${params.length}`)
  }
  if (typeof rangeName === 'string' && rangeName.trim() !== '') {
    params.push(rangeName.trim())
    clauses.push(`lower(range_name) = lower($${params.length})`)
  }
  if (typeof category === 'string' && category !== '') {
    params.push(category)
    clauses.push(`category = $${params.length}`)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  const { rows: counted } = await pool.query(
    `SELECT count(*)::int AS total FROM supplier_freight_rates ${where}`,
    params
  )
  const { rows } = await pool.query(
    `SELECT ${RATE_COLUMNS} FROM supplier_freight_rates
     ${where}
     ORDER BY effective_from DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, (safePage - 1) * safeLimit]
  )
  return { rates: rows.map(toRate), total: counted[0].total }
}

/**
 * Validate one rate. Pure, and shared by the write and by the CSV round trip's
 * dry run — a sheet has to be able to say what is wrong with a row before
 * anything is written, and a second copy of these rules is how the file and the
 * form start disagreeing.
 *
 * @param {object} input
 * @param {Set<string>|readonly string[]} [vocabulary] the categories a rate may
 *   be filed under; defaults to the seeded nine for a call with no database.
 * @returns {string|null} the first problem, or null
 */
export const validateFreightRate = (input = {}, vocabulary = FREIGHT_CATEGORIES) => {
  const categories = [...vocabulary]
  const scope = scopeOf(input)
  if (!scope) return 'State either a supplier or a range, and not both.'

  const basis = input.basis ?? 'dollar'
  if (!FREIGHT_BASES.includes(basis)) {
    return `"${basis}" is not a basis. Use one of: ${FREIGHT_BASES.join(', ')}.`
  }

  const rate = Number(input.rate)
  if (input.rate == null || input.rate === '' || !Number.isFinite(rate) || rate < 0) {
    return 'Rate must be a number of zero or more.'
  }

  const unit = input.unit ?? null
  if (basis === 'dollar' && !FREIGHT_UNITS.includes(unit)) {
    // FR-187: the unit is the range's own pack type, and a rate that does not
    // state it is unusable — the priced corpus is P/M 8,574, P/Y 5,753,
    // P/Roll 2,816, P/P 2,011, so a per-roll figure applied to a metre
    // overcharges by roughly the roll length.
    return `A dollar rate must state its unit. Use one of: ${FREIGHT_UNITS.join(', ')}.`
  }
  if (basis === 'percent' && unit != null) {
    return 'A percent rate is per nothing — leave the unit blank.'
  }

  if (input.category != null && !categories.includes(input.category)) {
    return `"${input.category}" is not a category. Use one of: ${categories.join(', ')}, or leave it blank for every category.`
  }

  if (input.freight_class != null && !FREIGHT_CLASS_PATTERN.test(input.freight_class)) {
    return `"${input.freight_class}" is not a freight class. Use one letter, A to E, or leave it blank for every class.`
  }

  if (!ISO_DAY.test(input.effective_from ?? '')) {
    return 'Effective from must be a date as YYYY-MM-DD.'
  }
  return null
}

/**
 * The range names, of those given, that name no catalogued house. A range rate
 * is keyed on the HOUSE's name (the waterfall looks it up by `brands.name`), so
 * a misspelt one would be accepted and then never match anything — refused
 * here instead, case-insensitively as the resolver matches. Archived houses
 * count: a rate for a house being wound down is still a rate.
 *
 * @param {{ query: Function }} db
 * @param {string[]} names
 * @returns {Promise<string[]>}
 */
export const unknownHouses = async (db, names) => {
  const wanted = [...new Set(names.filter(Boolean).map((name) => name.trim()))]
  if (wanted.length === 0) return []
  const { rows } = await db.query(
    `SELECT lower(name) AS key FROM brands WHERE lower(name) = ANY($1::text[])`,
    [wanted.map((name) => name.toLowerCase())]
  )
  const known = new Set(rows.map((row) => row.key))
  return wanted.filter((name) => !known.has(name.toLowerCase()))
}

/** The one sentence both the form and the sheet refuse an unknown house with. */
export const unknownHouseMessage = (name) =>
  `"${name}" is not a house. A range rate is keyed on the house's name exactly as the Houses screen spells it.`

/**
 * Append a rate. Never an overwrite: a duplicate scope + category + freight
 * class + date is a 409 telling the caller to date the correction, not a
 * silent replacement of the figure last year's landed costs were built on.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {object} input
 * @returns {Promise<object>}
 */
export const createFreightRate = async (db, rawInput) => {
  const input = { ...rawInput, freight_class: freightClassOf(rawInput?.freight_class) }
  // The vocabulary is read per write rather than cached: the office adds a
  // category on one screen and files a rate under it on the next.
  const problem = validateFreightRate(input, await categorySlugs(db))
  if (problem) throw httpError(422, problem)
  const scope = scopeOf(input)
  if (scope.rangeName && (await unknownHouses(db, [scope.rangeName])).length > 0) {
    throw httpError(422, unknownHouseMessage(scope.rangeName))
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO supplier_freight_rates
         (supplier_id, range_name, category, freight_class, basis, rate, unit, effective_from, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${RATE_COLUMNS}`,
      [
        scope.supplierId,
        scope.rangeName,
        input.category ?? null,
        input.freight_class,
        input.basis ?? 'dollar',
        Number(input.rate),
        input.unit ?? null,
        input.effective_from,
        input.note ?? null,
      ]
    )
    return toRate(rows[0])
  } catch (error) {
    if (error?.code === '23505') {
      throw httpError(
        409,
        `A rate already applies to that scope, category${input.freight_class ? ` and freight class ${input.freight_class}` : ''} ` +
          'from that date. Rates are append-only — date the correction from the day it takes effect.'
      )
    }
    // Two foreign keys can raise this now, so the message is chosen by which
    // one did: before migration 1791379200000 `supplier_id` was the only one and
    // an unknown category was a CHECK violation instead.
    if (error?.code === '23503') {
      if (error.constraint === 'supplier_freight_rates_category_fkey') {
        throw httpError(
          422,
          `"${input.category}" is not a category. Add it on Categories first.`
        )
      }
      throw httpError(422, `No supplier with id ${scope.supplierId}.`)
    }
    throw error
  }
}
