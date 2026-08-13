// Back-office read models for the physical sample register.
//
// The register answers three questions and this module is where all three are
// asked: what is on the shelf, what is out, and what is late back. Handlers stay
// thin — the SQL and the derivations live here, mirroring
// src/suppliers/admin-suppliers.js and src/catalogue/admin-products.js.
//
// OVERDUE IS DERIVED AT READ TIME, NEVER STORED. It is
// `returned_at IS NULL AND due_back_at < now()`, evaluated in the query: there is
// no column to store it in and there must not be one, because a stored boolean is
// wrong from the first minute nobody runs the job that would maintain it. The
// open-loan join carries the `returned_at IS NULL` half, so the expression here is
// only about the date. `sample_loans_overdue_idx` is what makes it cheap.
//
// SAMPLES ARE NOT STOCK. Nothing here reads or writes a stock quantity: a sample
// leaving the library is not a sale, and the order state machine is the only owner
// of the reservation arithmetic. `test/samples-schema.test.js` scans this
// directory for those columns, and `test/samples-read-models.test.js` asserts it
// again at runtime over every statement these functions issue.
//
// Two shaping details:
//   - Every row carries its parents' names, not just their ids. Nothing on a
//     sample row says which design or showroom it belongs to, and the whole point
//     of the register is not knowing that when you pick the object up. Same
//     reason `listAdminColourways` carries the design and the house.
//   - The open loan is a plain LEFT JOIN rather than a lateral, because
//     `sample_loans_open_unique` guarantees at most one open loan per sample. That
//     is what lets the count query share the FROM clause without inflating
//     `meta.total`.
//
// The writes live here too (W4-US-005). Two rules shape them:
//   - A duplicate barcode is the database's 23505 on `samples_barcode_key`,
//     mapped to a 409. Never pre-checked: a pre-check races the scanner, which is
//     a concurrent device, and would still need the handler. That rule survives
//     W20-US-002 unchanged and covers GENERATED barcodes too — see
//     GENERATED_BARCODE below.
//   - `out` is never accepted on a create or a PATCH. It is the one status that
//     ASSERTS an open loan exists, and only check-out (US-006) writes both tables
//     in the one transaction that can make that true. A status PATCH that could
//     say `out` would let a screen mark a sample out with no loan behind it,
//     which is exactly what architecture.md means by "check-out and check-in are
//     verb routes, not a status PATCH".

import { buildUpdate } from '../catalogue/admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

// The vocabulary `samples_status_check` holds, exported so a route can spend it
// as a schema enum instead of keeping its own copy. `test/samples-read-models.test.js`
// parses the live constraint and asserts the two are the same set — the posture
// `DISCOUNT_METHOD_ENUM` takes in src/routes/admin-suppliers.js, with the drift
// test that one had to add afterwards.
export const SAMPLE_STATUSES = Object.freeze([
  'in_library',
  'out',
  'missing',
  'retired',
])

// The statuses a create or a PATCH may write — everything the CHECK accepts
// except `out`, which only check-out may set (see the module header). Derived
// from SAMPLE_STATUSES rather than re-typed, so widening the CHECK widens this
// too and the two can never drift into disagreeing about a value.
export const WRITABLE_SAMPLE_STATUSES = Object.freeze(
  SAMPLE_STATUSES.filter((status) => status !== 'out')
)

// The derivation, in ONE place, spelled once per alias — two spellings of it is
// how a list and its badge start disagreeing. NULL-safe: a loan with no agreed
// date is not overdue, and neither is a sample with no open loan (the join
// yields NULL). The `returned_at IS NULL` half is carried by the caller's own
// predicate: the open-loan join here, and the outstanding queue's WHERE in
// ./sample-loan-queue.js, which IMPORTS this rather than re-spelling it.
export const overdueExpression = (alias) => `COALESCE(${alias}.due_back_at < now(), false)`

const OVERDUE_EXPRESSION = overdueExpression('ol')

// The minted tag, when a create supplies no barcode (W20-US-002). Six
// zero-padded digits behind `ATL-S-`, off `samples_barcode_seq` — the format,
// the start value and the evidence for both live in
// migrations/1787371200000_sample-barcode-sequence.js. It is spelled here and
// NOT as a column DEFAULT so there is exactly one copy of it.
//
// It is a COALESCE arm rather than a preceding SELECT, and both halves of that
// are load-bearing:
//   - Postgres does not evaluate a COALESCE argument it does not need, so a
//     SUPPLIED barcode never calls nextval and never burns a number. A supplied
//     barcode wins outright — the generator fills a gap, it never overrides, and
//     the tag printed on the object is the one the office typed.
//   - The mint and the INSERT are one statement, so no number can be handed out
//     for a row that then fails to land, and no second round trip opens a window
//     for another writer.
// A minted value can still hit `samples_barcode_key` if the sequence is ever
// behind the corpus. That is the same 23505 → 409 a typed duplicate gets, and
// deliberately NOT a retry loop: retrying hides the real fault and spins.
const GENERATED_BARCODE = `'ATL-S-' || lpad(nextval('samples_barcode_seq')::text, 6, '0')`

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Message per unique constraint. Only one can fire today, but the shape is the
// house one (src/suppliers/admin-suppliers.js): keyed on the constraint name, an
// unknown key degrades the MESSAGE and never the status.
const CONFLICT_MESSAGES = Object.freeze({
  samples_barcode_key: 'A sample with that barcode already exists.',
})

// A named parent that is not there. All three are 422 rather than 404: the id
// arrived in a body as a business fact about the sample, exactly like an unknown
// `brand_id` on a product create, so it is the body that is wrong and not the URL.
const MISSING_PARENT_MESSAGES = Object.freeze({
  samples_colourway_id_fkey: 'That colourway does not exist.',
  samples_supplier_id_fkey: 'That supplier does not exist.',
  samples_showroom_id_fkey: 'That showroom does not exist.',
})

const rethrowWriteError = (error) => {
  if (error?.code === '23505') {
    throw httpError(
      409,
      CONFLICT_MESSAGES[error.constraint] ?? 'That sample detail is already in use.'
    )
  }
  if (error?.code === '23503') {
    throw httpError(
      422,
      MISSING_PARENT_MESSAGES[error.constraint] ?? 'A referenced record does not exist.'
    )
  }
  // The route spends WRITABLE_SAMPLE_STATUSES as a schema enum, so a bad status
  // is a 400 there. This is the direct caller's answer: a 23514 is a rejected
  // value, not a server fault, so it must not surface as a 500.
  if (error?.code === '23514' && error.constraint === 'samples_status_check') {
    throw httpError(422, `status must be one of: ${SAMPLE_STATUSES.join(', ')}.`)
  }
  if (error?.code === '23514' && error.constraint === 'samples_unit_cost_check') {
    // `>= 0`, not `> 0`: zero is legal and means "free of charge, and we know
    // it". Only a negative reaches here.
    throw httpError(422, 'unit_cost cannot be negative. Leave it empty if nobody recorded a cost.')
  }
  throw error
}

// --- What a sample cost (W20-US-001/US-008) ---------------------------------
//
// NULL AND 0 ARE DIFFERENT FACTS end to end, and `Number(null)` is 0, so a bare
// `Number()` on this column turns every hanger nobody has costed into a gift.
// One coercion, used everywhere the column is read.
const numericOrNull = (value) => (value == null ? null : Number(value))

// The finance columns, selected ONLY for a caller with finance visibility (see
// `readOne`/`listSamples`). Fail-closed at the SQL rather than deleted from the
// payload afterwards: a column that was never selected cannot be leaked by a
// projection somebody forgot to apply, and every statement a non-finance read
// issues can be asserted not to name it.
const SAMPLE_COST_COLUMNS = `s.unit_cost, s.cost_currency`

// Named once so a cost column added later has one place to be declared, and so
// a test can assert a non-finance response carries none of them.
export const SAMPLE_FINANCE_KEYS = Object.freeze(['unit_cost', 'cost_currency'])

// Presence follows the SELECT: the keys exist on the payload exactly when the
// query asked for them, so there is one decision and not two to drift apart.
const costOf = (row) =>
  Object.hasOwn(row, 'unit_cost')
    ? { unit_cost: numericOrNull(row.unit_cost), cost_currency: row.cost_currency }
    : {}

// Reading a cost and writing one are the same permission. A staffer who may not
// see what the library cost may not quietly restate it either, and a 403 here
// beats a silent no-op — Ajv's `removeAdditional` does not strip a DECLARED
// key, so without this the value would land. Enforced in the module because it
// is also called directly.
const assertCostWritable = (input, finance) => {
  if (finance) return
  const attempted = SAMPLE_FINANCE_KEYS.filter((key) => Object.hasOwn(input, key))
  if (attempted.length > 0) {
    throw httpError(
      403,
      `Your account does not have finance visibility, so it cannot set ${attempted.join(' or ')}.`
    )
  }
}

// Columns a create or a PATCH may ever write. Frozen and in-code, as buildUpdate
// requires — column names are never user input. The timestamps are absent (the
// UPDATE stamps `updated_at` itself) and so is `archived_at`, which setArchived
// owns. `barcode` IS editable: it is a printed tag that can be mistyped, and
// nothing references it — `sample_loans.sample_id` points at the row's id — so a
// correction is safe, and a collision is the same 409 a create answers with.
export const SAMPLE_UPDATE_COLUMNS = Object.freeze([
  'barcode',
  'label',
  'colourway_id',
  'supplier_id',
  'showroom_id',
  'sample_type',
  'location',
  'status',
  'notes',
  // W20-US-008. Writable only with finance visibility (assertCostWritable), and
  // an explicit null clears the figure back to "nobody recorded a cost" — which
  // is a different statement from 0, and both have to stay reachable.
  'unit_cost',
  'cost_currency',
])

// `out` is refused in the module as well as at the route schema, because the
// module is also called directly. 422 rather than 400: the value is a legal
// status, it is just not one a caller may assert without the loan write that
// makes it true.
const assertWritableStatus = (status) => {
  if (status !== undefined && status !== null && !WRITABLE_SAMPLE_STATUSES.includes(status)) {
    throw httpError(
      422,
      `status "${status}" is set by checking the sample out, not by writing it. ` +
        `Writable here: ${WRITABLE_SAMPLE_STATUSES.join(', ')}.`
    )
  }
}

const SAMPLE_COLUMNS = `s.id, s.barcode, s.label, s.colourway_id, s.supplier_id,
              s.showroom_id, s.sample_type, s.location, s.status, s.notes,
              s.created_at, s.updated_at, s.archived_at`

// The parents, the open loan and the loan count. The count is a correlated
// scalar subquery rather than an aggregate join, so it cannot multiply rows and
// the count query can leave it out entirely.
const SAMPLE_CONTEXT_COLUMNS = `c.name AS colourway_name,
              c.sku AS colourway_sku,
              p.id AS product_id,
              p.name AS product_name,
              p.slug AS product_slug,
              b.id AS brand_id,
              b.name AS brand_name,
              sup.name AS supplier_name,
              sr.name AS showroom_name,
              ol.id AS open_loan_id,
              ol.holder_name AS open_loan_holder_name,
              ol.trade_account_id AS open_loan_trade_account_id,
              ol.out_at AS open_loan_out_at,
              ol.due_back_at AS open_loan_due_back_at,
              ${OVERDUE_EXPRESSION} AS overdue,
              (SELECT count(*)::int FROM sample_loans lc WHERE lc.sample_id = s.id)
                AS loan_count`

// Every join is on a unique or primary key, so none of them can multiply a row —
// including `ol`, which `sample_loans_open_unique` holds to at most one open loan
// per sample. That is what makes this FROM safe to share with the count query,
// which it must be, because the overdue filter refers to `ol`.
const SAMPLE_FROM = `FROM samples s
         LEFT JOIN colourways c ON c.id = s.colourway_id
         LEFT JOIN products p ON p.id = c.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN suppliers sup ON sup.id = s.supplier_id
         LEFT JOIN showrooms sr ON sr.id = s.showroom_id
         LEFT JOIN sample_loans ol
                ON ol.sample_id = s.id AND ol.returned_at IS NULL`

const openLoanOf = (row) =>
  row.open_loan_id === null || row.open_loan_id === undefined
    ? null
    : Object.freeze({
        id: row.open_loan_id,
        holder_name: row.open_loan_holder_name,
        trade_account_id: row.open_loan_trade_account_id,
        out_at: row.open_loan_out_at,
        due_back_at: row.open_loan_due_back_at,
      })

const toSample = (row, extra) =>
  Object.freeze({
    id: row.id,
    barcode: row.barcode,
    label: row.label,
    colourway_id: row.colourway_id,
    supplier_id: row.supplier_id,
    showroom_id: row.showroom_id,
    sample_type: row.sample_type,
    location: row.location,
    status: row.status,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    // Derived, every read, from the open loan's due date. False when nothing is
    // out — a sample on the shelf is not late back.
    overdue: row.overdue,
    loan_count: row.loan_count,
    open_loan: openLoanOf(row),
    // Present only when the query selected them, i.e. only for a caller with
    // finance visibility.
    ...costOf(row),
    ...extra,
  })

const sampleContext = (row) => ({
  colourway_name: row.colourway_name,
  colourway_sku: row.colourway_sku,
  product_id: row.product_id,
  product_name: row.product_name,
  product_slug: row.product_slug,
  brand_id: row.brand_id,
  brand_name: row.brand_name,
  supplier_name: row.supplier_name,
  showroom_name: row.showroom_name,
})

const toLoan = (row) =>
  Object.freeze({
    id: row.id,
    holder_name: row.holder_name,
    trade_account_id: row.trade_account_id,
    out_at: row.out_at,
    due_back_at: row.due_back_at,
    returned_at: row.returned_at,
    notes: row.notes,
    overdue: row.overdue,
  })

// Escape the LIKE wildcards so a barcode containing an underscore matches that
// literal character rather than any single one. Pairs with ESCAPE '\' in the
// SQL. Exported for ./sample-loan-queue.js, which searches the same corpus.
export const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// WHERE fragments + bound params. Column names are in-code literals; every value
// flows through a $n placeholder.
const buildWhere = ({ q, status, showroomId, supplierId, overdue, includeArchived }) => {
  const clauses = []
  const params = []

  // Archived samples are hidden from the working list; the caller opts back in.
  // `status = 'retired'` is a different question — that is a statement about the
  // physical object, this is the reversible removal of the row.
  if (!includeArchived) {
    clauses.push('s.archived_at IS NULL')
  }

  if (typeof status === 'string' && status) {
    params.push(status)
    clauses.push(`s.status = $${params.length}`)
  }

  if (Number.isInteger(showroomId)) {
    params.push(showroomId)
    clauses.push(`s.showroom_id = $${params.length}`)
  }

  if (Number.isInteger(supplierId)) {
    params.push(supplierId)
    clauses.push(`s.supplier_id = $${params.length}`)
  }

  // Tri-state: absent leaves the list alone, true is the chase list, false is
  // everything that is not late back (out on time, or on the shelf).
  if (overdue === true) {
    clauses.push(`${OVERDUE_EXPRESSION}`)
  } else if (overdue === false) {
    clauses.push(`NOT ${OVERDUE_EXPRESSION}`)
  }

  // A blank/whitespace term is ignored, not treated as "match nothing".
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // The three ways staff arrive at a sample: the tag (barcode, label), where it
    // sits, and the design it is a piece of. The holder is deliberately NOT
    // searched here — "what has Kedgley got out" is a question about loans, and a
    // loan list is its own read model.
    clauses.push(`(
      s.barcode ILIKE $${i} ESCAPE '\\'
      OR s.label ILIKE $${i} ESCAPE '\\'
      OR s.sample_type ILIKE $${i} ESCAPE '\\'
      OR s.location ILIKE $${i} ESCAPE '\\'
      OR c.name ILIKE $${i} ESCAPE '\\'
      OR c.sku ILIKE $${i} ESCAPE '\\'
      OR p.name ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/**
 * Filtered, paginated register rows, each carrying its parents, its open loan,
 * its lifetime loan count and a freshly derived `overdue`. Returns
 * { samples, total } — the route builds the meta envelope, as every other admin
 * list here does.
 *
 * `finance` decides whether the cost columns are SELECTED at all, and it
 * defaults to false — a caller that says nothing gets no costs. The route
 * derives it from `loadReportAccess`, never from anything the caller sent.
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, status?: string, showroomId?: number, supplierId?: number,
 *           overdue?: boolean, includeArchived?: boolean, page?: number,
 *           limit?: number, finance?: boolean }} [options]
 * @returns {Promise<{ samples: object[], total: number }>}
 */
export const listSamples = async (
  pool,
  {
    q,
    status,
    showroomId,
    supplierId,
    overdue,
    includeArchived = false,
    page,
    limit,
    finance = false,
  } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere({
    q,
    status,
    showroomId,
    supplierId,
    overdue,
    includeArchived,
  })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total ${SAMPLE_FROM} ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${SAMPLE_COLUMNS},
            ${finance ? `${SAMPLE_COST_COLUMNS},` : ''}
            ${SAMPLE_CONTEXT_COLUMNS}
       ${SAMPLE_FROM}
       ${where}
      ORDER BY s.barcode ASC, s.id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    samples: rows.map((row) => toSample(row, sampleContext(row))),
    total: countResult.rows[0].total,
  }
}

/**
 * The full loan history of one sample, newest movement first, each row carrying
 * its own derived `overdue`. Append-only history: nothing here is archivable and
 * a closed loan stays exactly as it read on the day.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} sampleId
 * @returns {Promise<object[]>}
 */
export const listSampleLoans = async (db, sampleId) => {
  const { rows } = await db.query(
    `SELECT l.id, l.holder_name, l.trade_account_id, l.out_at, l.due_back_at,
            l.returned_at, l.notes,
            l.returned_at IS NULL AND ${overdueExpression('l')} AS overdue
       FROM sample_loans l
      WHERE l.sample_id = $1
      ORDER BY l.out_at DESC, l.id DESC`,
    [sampleId]
  )
  return rows.map(toLoan)
}

const readOne = async (db, predicate, value, { finance = false } = {}) => {
  const { rows } = await db.query(
    `SELECT ${SAMPLE_COLUMNS},
            ${finance ? `${SAMPLE_COST_COLUMNS},` : ''}
            ${SAMPLE_CONTEXT_COLUMNS}
       ${SAMPLE_FROM}
      WHERE ${predicate}`,
    [value]
  )
  if (!rows[0]) return null

  const loans = await listSampleLoans(db, rows[0].id)
  return Object.freeze({
    ...toSample(rows[0], sampleContext(rows[0])),
    loans: Object.freeze(loans),
  })
}

/**
 * One sample by id with its loan history, or null when the id is unknown.
 *
 * No archived filter, like every other by-id admin read: the caller already knows
 * the row exists, and the restore screen has to be able to read back the archive
 * it just made.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} id
 * @param {{ finance?: boolean }} [options] cost columns are selected only when true
 * @returns {Promise<object|null>}
 */
export const getSample = (db, id, options) => readOne(db, 's.id = $1', id, options)

/**
 * One sample by barcode, or null. The scanner's read: an EXACT match on the
 * unique column, so the answer is one row or none — never a filtered list, and
 * never a prefix that happens to match two tags. Archived rows are returned for
 * the same reason `getSample` returns them: a scanned object exists whatever the
 * CRM list is currently showing.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {string} barcode
 * @param {{ finance?: boolean }} [options] cost columns are selected only when true
 * @returns {Promise<object|null>}
 */
export const getSampleByBarcode = (db, barcode, options) =>
  readOne(db, 's.barcode = $1', barcode, options)

/**
 * Register a new sample. The barcode is the tag on the object: supply it and it
 * is used verbatim, OMIT it and the server mints the next one from
 * `samples_barcode_seq` (W20-US-002 — "remember the next number"). An empty
 * string is not an omission; the route's `minLength: 1` refuses one, so only an
 * absent key generates. Either way a duplicate is the database's 23505, mapped
 * to a 409 here.
 *
 * Every write returns through `getSample`, so a create, a patch, an archive and
 * a plain read all hand the CRM the SAME shape — parents by name, the open loan,
 * the loan count and the derived `overdue`. That costs one extra round trip and
 * buys one renderer instead of two, which is what the screens actually need
 * (they re-read a row after every write anyway).
 *
 * A cost may be recorded on the way in, but only with finance visibility — and
 * `unit_cost: 0` is a real value meaning "free of charge", never an omission,
 * so it is bound as given and never coalesced away.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object>}
 */
export const createSample = async (pool, input, { finance = false } = {}) => {
  assertWritableStatus(input.status)
  assertCostWritable(input, finance)
  try {
    const { rows } = await pool.query(
      `INSERT INTO samples
         (barcode, label, colourway_id, supplier_id, showroom_id, sample_type,
          location, status, notes, unit_cost, cost_currency)
       VALUES (COALESCE($1, ${GENERATED_BARCODE}), $2, $3, $4, $5, $6, $7,
               COALESCE($8, 'in_library'), $9, $10, $11)
       RETURNING id`,
      [
        input.barcode ?? null,
        input.label ?? null,
        input.colourway_id ?? null,
        input.supplier_id ?? null,
        input.showroom_id ?? null,
        input.sample_type ?? null,
        input.location ?? null,
        input.status ?? null,
        input.notes ?? null,
        input.unit_cost ?? null,
        input.cost_currency ?? null,
      ]
    )
    return getSample(pool, rows[0].id, { finance })
  } catch (error) {
    return rethrowWriteError(error)
  }
}

/**
 * Patch a sample from the frozen whitelist. `Object.hasOwn` (inside buildUpdate)
 * keeps an explicit null — which clears a nullable column, e.g. un-homing a
 * sample from a showroom — distinct from an absent key.
 *
 * `unit_cost: null` clears the figure back to "nobody recorded a cost";
 * `unit_cost: 0` records "free of charge". `Object.hasOwn` is what keeps the
 * two distinguishable from an absent key, and neither is ever coalesced.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object>}
 */
export const updateSample = async (pool, id, input, { finance = false } = {}) => {
  assertWritableStatus(input.status)
  assertCostWritable(input, finance)
  const { sets, params } = buildUpdate(input, SAMPLE_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE samples SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING id`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Sample ${id} not found.`)
    }
    return getSample(pool, id, { finance })
  } catch (error) {
    return rethrowWriteError(error)
  }
}

/**
 * Soft-archive (archived=true) or restore (archived=false) a sample, stamping
 * `updated_at`. Returns the fresh row, or null when the id is unknown.
 *
 * This is the alternative a blocked DELETE offers. A sample that has ever been
 * lent is refused a hard delete for good — its loans are the register's whole
 * point — so archiving is the only way one leaves the working list.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export const setSampleArchived = async (pool, id, archived, { finance = false } = {}) => {
  const row = await setArchived(pool, 'sample', id, archived, {
    extraSets: ['updated_at = now()'],
    returning: 'id',
  })
  return row ? getSample(pool, row.id, { finance }) : null
}
