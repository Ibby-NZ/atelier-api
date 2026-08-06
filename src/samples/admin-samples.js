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

// The derivation, in one place. NULL-safe: a loan with no agreed date is not
// overdue, and neither is a sample with no open loan (the join yields NULL).
const OVERDUE_EXPRESSION = `COALESCE(ol.due_back_at < now(), false)`

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
// literal character rather than any single one. Pairs with ESCAPE '\' in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

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
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, status?: string, showroomId?: number, supplierId?: number,
 *           overdue?: boolean, includeArchived?: boolean, page?: number,
 *           limit?: number }} [options]
 * @returns {Promise<{ samples: object[], total: number }>}
 */
export const listSamples = async (
  pool,
  { q, status, showroomId, supplierId, overdue, includeArchived = false, page, limit } = {}
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
    `SELECT id, holder_name, trade_account_id, out_at, due_back_at, returned_at, notes,
            COALESCE(returned_at IS NULL AND due_back_at < now(), false) AS overdue
       FROM sample_loans
      WHERE sample_id = $1
      ORDER BY out_at DESC, id DESC`,
    [sampleId]
  )
  return rows.map(toLoan)
}

const readOne = async (db, predicate, value) => {
  const { rows } = await db.query(
    `SELECT ${SAMPLE_COLUMNS},
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
 * @returns {Promise<object|null>}
 */
export const getSample = (db, id) => readOne(db, 's.id = $1', id)

/**
 * One sample by barcode, or null. The scanner's read: an EXACT match on the
 * unique column, so the answer is one row or none — never a filtered list, and
 * never a prefix that happens to match two tags. Archived rows are returned for
 * the same reason `getSample` returns them: a scanned object exists whatever the
 * CRM list is currently showing.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {string} barcode
 * @returns {Promise<object|null>}
 */
export const getSampleByBarcode = (db, barcode) => readOne(db, 's.barcode = $1', barcode)
