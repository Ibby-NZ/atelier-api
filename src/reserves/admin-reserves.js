// Reserve dockets: the reads and writes for `reserve_requests` + `reserve_lines`.
//
// THE STATE MACHINE LIVES NEXT DOOR in the pure `reserve-line-states.js`, which
// the CRM mirrors and the lifecycle registry imports. This module is the SQL:
// it spends `requireTransition` and `STATUS_STAMPS` and owns no vocabulary of
// its own.
//
// STATUS IS NOT PATCHABLE. A move writes two things that only mean anything
// together — the state AND the stamp that dates it — so it goes through
// `transitionReserveLine`, and `status` is absent from
// `RESERVE_LINE_UPDATE_COLUMNS`. Everything else on a line IS patchable,
// because the everyday workflow is exactly that: the house replies, and staff
// type the reserve number and the hold date onto the line they already entered.
//
// THE LIST IS DOCKET-GRAIN, LINES EMBEDDED — the admin-orders shape, because
// the screen renders one account's visit to the form as one card. Line-level
// filters (kind, status, supplier) select DOCKETS by EXISTS; the docket then
// arrives whole, because half a docket is not a thing the office can act on.
//
// `expired` IS DERIVED HERE, AT READ TIME, against the server's CURRENT_DATE —
// never in the browser, whose clock and zone answer for the device rather than
// the business. Same rule the sample register's `overdue` follows.
//
// NOTHING HERE TOUCHES `inventory.qty_reserved`: a reserve is a request to the
// HOUSE to hold stock at their end. The order state machine stays that
// column's sole writer.

import { buildUpdate } from '../catalogue/admin-brands.js'
import {
  RESERVE_LINE_STATUSES,
  RESERVE_LINE_KINDS,
  CFA_STATES,
  STATUS_STAMPS,
  requireTransition,
} from './reserve-line-states.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 25
export const MAX_LIMIT = 100

// The report a shipment is closed against: what is still expected from the
// house. Arrived material is here already; dispatched and cancelled lines are
// history.
export const OPEN_LINE_STATUSES = Object.freeze(['requested', 'confirmed'])

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// A named parent that is not there. 422 rather than 404: the id arrived in a
// body as a business fact, so it is the body that is wrong and not the URL.
const MISSING_PARENT_MESSAGES = Object.freeze({
  reserve_requests_user_id_fkey: 'That client account does not exist.',
  reserve_lines_request_id_fkey: 'That reserve docket does not exist.',
  reserve_lines_price_list_item_id_fkey: 'That price-list item does not exist.',
  reserve_lines_source_line_id_fkey: 'The reserve line this cutting points back at does not exist.',
})

const CHECK_MESSAGES = Object.freeze({
  reserve_lines_kind_check: `kind must be one of: ${RESERVE_LINE_KINDS.join(', ')}.`,
  reserve_lines_status_check: `status must be one of: ${RESERVE_LINE_STATUSES.join(', ')}.`,
  reserve_lines_cfa_check: `cfa must be one of: ${CFA_STATES.join(', ')}.`,
  reserve_lines_qty_check: 'qty must be above zero — leave it out when it is not known yet.',
  reserve_lines_multiplier_check: 'multiplier must be a whole number, 1 or more.',
})

const rethrowWriteError = (error) => {
  if (error?.code === '23503') {
    throw httpError(
      422,
      MISSING_PARENT_MESSAGES[error.constraint] ?? 'A referenced record does not exist.'
    )
  }
  if (error?.code === '23502') {
    throw httpError(422, `${error.column ?? 'A required field'} is required.`)
  }
  if (error?.code === '23514' && CHECK_MESSAGES[error.constraint]) {
    throw httpError(422, CHECK_MESSAGES[error.constraint])
  }
  // A date with the right SHAPE and no place in the calendar (2026-02-31).
  if (error?.code === '22007' || error?.code === '22008') {
    throw httpError(422, 'That date is not a real calendar date.')
  }
  throw error
}

// Columns a PATCH may ever write, frozen and in-code as buildUpdate requires.
// `user_id` is absent from the docket list: relinking paperwork to a different
// platform account is a delete-and-re-enter, not an edit — the snapshot name
// would silently stop matching the link.
export const RESERVE_REQUEST_UPDATE_COLUMNS = Object.freeze([
  'account_name',
  'contact_name',
  'notes',
])

// `status` and the stamps are deliberately absent (the machine owns them);
// `request_id` and `source_line_id` are absent because a line's parentage is
// set at birth. Everything the office types on the old form IS here — the
// house's reply (reserve_number, reserved_until, cfa) most of all.
export const RESERVE_LINE_UPDATE_COLUMNS = Object.freeze([
  'kind',
  'product_name',
  'range_name',
  'supplier',
  'product_code',
  'price_list_item_id',
  'colour',
  'qty',
  'multiplier',
  'customer_reference',
  'reserve_number',
  'reserved_until',
  'cfa',
  'comment',
])

const REQUEST_COLUMNS = `r.id, r.user_id, r.account_name, r.contact_name,
              r.owner_name, r.created_by, r.notes, r.created_at, r.updated_at`

// `reserved_until` travels as text ('YYYY-MM-DD'): the pg driver would hand a
// DATE column back as a JS Date pinned to the server's zone, and a calendar
// date that grew a time is exactly how off-by-one-day bugs are made.
const LINE_COLUMNS = `l.id, l.request_id, l.kind, l.status, l.product_name,
              l.range_name, l.supplier, l.product_code, l.price_list_item_id,
              l.colour, l.qty, l.multiplier, l.customer_reference,
              l.reserve_number, to_char(l.reserved_until, 'YYYY-MM-DD') AS reserved_until,
              l.cfa, l.comment, l.source_line_id,
              l.requested_at, l.confirmed_at, l.arrived_at, l.dispatched_at,
              l.cancelled_at, l.created_at, l.updated_at,
              (l.reserved_until IS NOT NULL
                AND l.reserved_until < CURRENT_DATE
                AND l.status IN ('requested', 'confirmed')) AS expired`

const toLine = (row) =>
  Object.freeze({
    id: row.id,
    request_id: row.request_id,
    kind: row.kind,
    status: row.status,
    product_name: row.product_name,
    range_name: row.range_name,
    supplier: row.supplier,
    product_code: row.product_code,
    price_list_item_id: row.price_list_item_id,
    colour: row.colour,
    qty: row.qty,
    multiplier: row.multiplier,
    customer_reference: row.customer_reference,
    reserve_number: row.reserve_number,
    reserved_until: row.reserved_until,
    cfa: row.cfa,
    comment: row.comment,
    source_line_id: row.source_line_id,
    requested_at: row.requested_at,
    confirmed_at: row.confirmed_at,
    arrived_at: row.arrived_at,
    dispatched_at: row.dispatched_at,
    cancelled_at: row.cancelled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expired: row.expired,
  })

const toReserve = (row, lines) =>
  Object.freeze({
    id: row.id,
    user_id: row.user_id,
    account_name: row.account_name,
    contact_name: row.contact_name,
    owner_name: row.owner_name,
    created_by: row.created_by,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lines,
  })

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// WHERE fragments + bound params for the docket list. Line-grain filters
// select dockets via EXISTS; column names are in-code literals and every
// value flows through a $n placeholder.
const buildWhere = ({ q, kind, status, supplier, includeDone }) => {
  const clauses = []
  const params = []

  // The working list is what is still moving. A docket whose every line is
  // dispatched or cancelled drops out unless asked for — but one with NO lines
  // stays visible, or deleting its last line would leave a ghost nothing lists.
  if (!includeDone) {
    clauses.push(`(EXISTS (SELECT 1 FROM reserve_lines l
                     WHERE l.request_id = r.id
                       AND l.status IN ('requested', 'confirmed', 'arrived'))
                   OR NOT EXISTS (SELECT 1 FROM reserve_lines l WHERE l.request_id = r.id))`)
  }

  if (typeof kind === 'string' && kind) {
    params.push(kind)
    clauses.push(
      `EXISTS (SELECT 1 FROM reserve_lines l WHERE l.request_id = r.id AND l.kind = $${params.length})`
    )
  }

  if (typeof status === 'string' && status) {
    params.push(status)
    clauses.push(
      `EXISTS (SELECT 1 FROM reserve_lines l WHERE l.request_id = r.id AND l.status = $${params.length})`
    )
  }

  if (typeof supplier === 'string' && supplier.trim()) {
    params.push(`%${escapeLike(supplier.trim())}%`)
    clauses.push(
      `EXISTS (SELECT 1 FROM reserve_lines l
          WHERE l.request_id = r.id AND l.supplier ILIKE $${params.length} ESCAPE '\\')`
    )
  }

  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // Who it is for, and what is on it. The line side covers every column the
    // office quotes down the phone: design, range, code, colour, both
    // references. `notes`/`comment` are deliberately not searched.
    clauses.push(`(
      r.account_name ILIKE $${i} ESCAPE '\\'
      OR r.contact_name ILIKE $${i} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM reserve_lines l
            WHERE l.request_id = r.id
              AND (l.product_name ILIKE $${i} ESCAPE '\\'
                OR l.range_name ILIKE $${i} ESCAPE '\\'
                OR l.product_code ILIKE $${i} ESCAPE '\\'
                OR l.colour ILIKE $${i} ESCAPE '\\'
                OR l.reserve_number ILIKE $${i} ESCAPE '\\'
                OR l.customer_reference ILIKE $${i} ESCAPE '\\'))
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

// Batch-load every docket's lines in one query — no N+1. Order by id: entry
// order is the order the office typed them in, which is the order they read
// the docket back in.
const loadLines = async (db, requestIds) => {
  if (requestIds.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT ${LINE_COLUMNS}
       FROM reserve_lines l
      WHERE l.request_id = ANY($1::int[])
      ORDER BY l.id`,
    [requestIds]
  )
  const byRequest = new Map()
  for (const row of rows) {
    const list = byRequest.get(row.request_id) ?? []
    list.push(toLine(row))
    byRequest.set(row.request_id, list)
  }
  return byRequest
}

/**
 * Filtered, paginated dockets, newest first, each carrying all of its lines.
 * Returns { reserves, total } — the route builds the meta envelope.
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, kind?: string, status?: string, supplier?: string,
 *           includeDone?: boolean, page?: number, limit?: number }} [options]
 * @returns {Promise<{ reserves: object[], total: number }>}
 */
export const listReserves = async (
  pool,
  { q, kind, status, supplier, includeDone = false, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere({ q, kind, status, supplier, includeDone })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM reserve_requests r ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLUMNS}
       FROM reserve_requests r
       ${where}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  const lines = await loadLines(pool, rows.map((row) => row.id))
  return {
    reserves: rows.map((row) => toReserve(row, lines.get(row.id) ?? [])),
    total: countResult.rows[0].total,
  }
}

/**
 * One docket by id with all its lines, or null when the id is unknown.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getReserve = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${REQUEST_COLUMNS} FROM reserve_requests r WHERE r.id = $1`,
    [id]
  )
  if (!rows[0]) return null
  const lines = await loadLines(db, [rows[0].id])
  return toReserve(rows[0], lines.get(rows[0].id) ?? [])
}

// One line's INSERT. `requested_at` takes the column default; `status` takes
// the schema default — a create is always `requested`, because a line born
// `arrived` would carry no history in its stamps.
const insertLine = async (client, requestId, line) => {
  try {
    await client.query(
      `INSERT INTO reserve_lines
         (request_id, kind, product_name, range_name, supplier, product_code,
          price_list_item_id, colour, qty, multiplier, customer_reference,
          reserve_number, reserved_until, cfa, comment, source_line_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        requestId,
        line.kind,
        line.product_name,
        line.range_name ?? null,
        line.supplier ?? null,
        line.product_code ?? null,
        line.price_list_item_id ?? null,
        line.colour ?? null,
        line.qty ?? null,
        line.multiplier ?? 1,
        line.customer_reference ?? null,
        line.reserve_number ?? null,
        line.reserved_until ?? null,
        line.cfa ?? null,
        line.comment ?? null,
        line.source_line_id ?? null,
      ]
    )
  } catch (error) {
    rethrowWriteError(error)
  }
}

/**
 * Create a docket with its lines in one transaction — account first, exactly
 * the entry shape the office asked for.
 *
 * Attribution: `user_id` (a platform account — the name is snapshotted off the
 * users row so the docket outlives the account) or `account_name` (most of the
 * client base is Dynamics-side until cutover, so a typed/copied name is the
 * common case). Neither is a 422.
 *
 * @param {import('pg').Pool} pool
 * @param {{ user_id?: number, account_name?: string, contact_name?: string,
 *           notes?: string, lines: object[] }} input
 * @param {{ user?: { id?: number, name?: string, email?: string } }} [context]
 * @returns {Promise<object>}
 */
export const createReserve = async (pool, input, { user } = {}) => {
  const client = await pool.connect()
  let requestId
  try {
    await client.query('BEGIN')

    let accountName = typeof input.account_name === 'string' ? input.account_name.trim() : ''
    if (input.user_id != null) {
      const { rows } = await client.query(`SELECT name, email FROM users WHERE id = $1`, [
        input.user_id,
      ])
      if (!rows[0]) throw httpError(422, 'That client account does not exist.')
      if (!accountName) accountName = rows[0].name?.trim() || rows[0].email
    }
    if (!accountName) {
      throw httpError(422, 'A docket needs an account — pick a client or type the account name.')
    }

    const { rows } = await client.query(
      `INSERT INTO reserve_requests
         (user_id, account_name, contact_name, owner_name, created_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.user_id ?? null,
        accountName,
        input.contact_name ?? null,
        // The report's Owner column — whoever raised it, as they are named now.
        user?.name?.trim() || user?.email || null,
        user?.id ?? null,
        input.notes ?? null,
      ]
    )
    requestId = rows[0].id

    for (const line of input.lines) {
      await insertLine(client, requestId, line)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    rethrowWriteError(error)
  } finally {
    client.release()
  }
  return getReserve(pool, requestId)
}

/**
 * PATCH a docket's header. 404 when the id is unknown.
 */
export const updateReserve = async (pool, id, input) => {
  const { sets, params } = buildUpdate(input, RESERVE_REQUEST_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE reserve_requests
          SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING id`,
      [...params, id]
    )
    if (!rows[0]) throw httpError(404, `Reserve docket ${id} not found.`)
  } catch (error) {
    rethrowWriteError(error)
  }
  return getReserve(pool, id)
}

/**
 * Add lines to an existing docket — how a cutting is generated from a reserve
 * (the CRM posts a prefilled line carrying `source_line_id`), and how a docket
 * grows when the client rings back.
 */
export const addReserveLines = async (pool, id, lines) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id FROM reserve_requests WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (!rows[0]) throw httpError(404, `Reserve docket ${id} not found.`)
    for (const line of lines) {
      await insertLine(client, id, line)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getReserve(pool, id)
}

/**
 * PATCH one line's fields (never its status). Answers with the whole parent
 * docket — the screen renders dockets, so that is the reload it needs.
 */
export const updateReserveLine = async (pool, lineId, input) => {
  const { sets, params } = buildUpdate(input, RESERVE_LINE_UPDATE_COLUMNS)
  let requestId
  try {
    const { rows } = await pool.query(
      `UPDATE reserve_lines
          SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING request_id`,
      [...params, lineId]
    )
    if (!rows[0]) throw httpError(404, `Reserve line ${lineId} not found.`)
    requestId = rows[0].request_id
  } catch (error) {
    rethrowWriteError(error)
  }
  return getReserve(pool, requestId)
}

/**
 * The move. An illegal one — including a move to the state the line is already
 * in — is a 409 from `requireTransition`, decided against the row this
 * transaction holds locked. `at` back-dates the stamp; it defaults to now().
 */
export const transitionReserveLine = async (pool, lineId, { status, at } = {}) => {
  const client = await pool.connect()
  let requestId
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, status, request_id FROM reserve_lines WHERE id = $1 FOR UPDATE`,
      [lineId]
    )
    const line = rows[0]
    if (!line) throw httpError(404, `Reserve line ${lineId} not found.`)
    requestId = line.request_id

    const stamp = STATUS_STAMPS[status]
    if (!stamp) {
      throw httpError(422, `status must be one of: ${RESERVE_LINE_STATUSES.join(', ')}.`)
    }
    requireTransition(line, status)

    try {
      // `stamp` interpolates safely: it comes out of the frozen STATUS_STAMPS
      // map keyed by an already-validated enum value.
      await client.query(
        `UPDATE reserve_lines
            SET status = $2,
                ${stamp} = COALESCE($3::timestamptz, now()),
                updated_at = now()
          WHERE id = $1`,
        [lineId, status, at ?? null]
      )
    } catch (error) {
      rethrowWriteError(error)
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getReserve(pool, requestId)
}

/**
 * The suppliers with open lines, for the report picker: who is owed a chase.
 * Grouped on the snapshot column, because that is what the report prints.
 *
 * @returns {Promise<{ suppliers: { supplier: string, open_lines: number }[] }>}
 */
export const listReserveSuppliers = async (pool) => {
  const { rows } = await pool.query(
    `SELECT l.supplier, count(*)::int AS open_lines
       FROM reserve_lines l
      WHERE l.supplier IS NOT NULL
        AND l.status = ANY($1::text[])
      GROUP BY l.supplier
      ORDER BY lower(l.supplier)`,
    [[...OPEN_LINE_STATUSES]]
  )
  return { suppliers: rows }
}
