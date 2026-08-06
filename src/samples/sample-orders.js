// Showroom stocking: the reads and the writes for `sample_orders` (W4-US-007).
//
// This is the samples domain's SECOND lifecycle and it is independent of the
// first. `sample_loans` records a sample Atelier already owns leaving the
// library; a sample order records material that is not here yet being requested
// from a house. Nothing joins them — an order that reaches `received` may or may
// not ever become a barcoded row in `samples`, and that is the office's call.
//
// THE STATE MACHINE LIVES NEXT DOOR, in the pure `sample-order-states.js`, which
// the CRM mirrors and the lifecycle registry imports. This module is the SQL: it
// spends `requireTransition` and `STATUS_STAMPS` and owns no vocabulary of its
// own.
//
// STATUS IS NOT PATCHABLE, and that is the same rule the register applies to
// `out`. A move writes two things that only mean anything together — the state
// AND the stamp that dates it — so it goes through `transitionSampleOrder`, and
// `status` is absent from `SAMPLE_ORDER_UPDATE_COLUMNS`. A PATCH that could set
// `displayed` would leave `displayed_at` NULL, and a NULL stamp is readable as
// "has not been there": the row would then contradict itself.
//
// A CREATE IS ALWAYS `requested`, for the same reason. An order allowed to start
// at `received` would carry no `ordered_at` and no `in_transit_at`, so the six
// stamps would stop being a history and become decoration. Recording an order
// raised weeks ago is a create with a back-dated `requested_at` followed by the
// moves, each carrying its own `at`.
//
// SAMPLES ARE NOT STOCK. A sample order is not a purchase order: nothing here
// reads or writes a quantity, and `test/samples-schema.test.js` scans this
// directory for those columns while `test/samples-order-lifecycle.test.js`
// asserts it again at runtime over every statement these functions issue.

import { buildUpdate } from '../catalogue/admin-brands.js'
import { setArchived } from '../lifecycle/archive.js'
import {
  SAMPLE_ORDER_STATUSES,
  STATUS_STAMPS,
  requireTransition,
} from './sample-order-states.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// A named parent that is not there. 422 rather than 404: the id arrived in a
// body as a business fact about the order, exactly like an unknown `brand_id` on
// a product create, so it is the body that is wrong and not the URL.
const MISSING_PARENT_MESSAGES = Object.freeze({
  sample_orders_showroom_id_fkey: 'That showroom does not exist.',
  sample_orders_colourway_id_fkey: 'That colourway does not exist.',
  sample_orders_supplier_id_fkey: 'That supplier does not exist.',
})

// No 23505 branch: nothing on this table is unique. Two showrooms may ask the
// same house for the same design on the same day, and both requests are real.
const rethrowWriteError = (error) => {
  if (error?.code === '23503') {
    throw httpError(
      422,
      MISSING_PARENT_MESSAGES[error.constraint] ?? 'A referenced record does not exist.'
    )
  }
  // The route requires showroom_id by schema; this is the direct caller's
  // answer, because an order with no destination is a request nobody can fulfil
  // and that is a rejected value rather than a server fault.
  if (error?.code === '23502') {
    throw httpError(422, `${error.column ?? 'A required field'} is required.`)
  }
  if (error?.code === '23514' && error.constraint === 'sample_orders_status_check') {
    throw httpError(422, `status must be one of: ${SAMPLE_ORDER_STATUSES.join(', ')}.`)
  }
  // A timestamp with the right SHAPE and no place in the calendar (2026-02-31).
  // The route's pattern cannot catch that — only Postgres knows the calendar —
  // and a rejected value must not surface as a 500.
  if (error?.code === '22007' || error?.code === '22008') {
    throw httpError(422, 'That timestamp is not a real date.')
  }
  throw error
}

// Columns a create or a PATCH may ever write. Frozen and in-code, as buildUpdate
// requires — column names are never user input. `status` and the six stamps are
// deliberately absent (the machine owns them), and so is `archived_at`, which
// setArchived owns.
//
// `showroom_id` IS editable: a request can be redirected to another showroom
// before it arrives. It is NOT nullable, so the route types it as an integer
// rather than the usual nullable ref — an explicit null is a 400 there and a
// 23502 mapped to 422 here.
export const SAMPLE_ORDER_UPDATE_COLUMNS = Object.freeze([
  'showroom_id',
  'colourway_id',
  'supplier_id',
  'label',
  'notes',
])

const ORDER_COLUMNS = `so.id, so.showroom_id, so.colourway_id, so.supplier_id,
              so.label, so.status, so.requested_at, so.ordered_at,
              so.in_transit_at, so.received_at, so.displayed_at, so.cancelled_at,
              so.notes, so.created_at, so.updated_at, so.archived_at`

// The parents by NAME, not just their ids: nothing on an order row says which
// design was asked for or where it is going, and that is the whole content of
// the screen. Same reason `listSamples` carries them.
const ORDER_CONTEXT_COLUMNS = `sr.name AS showroom_name,
              c.name AS colourway_name,
              c.sku AS colourway_sku,
              p.id AS product_id,
              p.name AS product_name,
              p.slug AS product_slug,
              b.id AS brand_id,
              b.name AS brand_name,
              sup.name AS supplier_name`

// Every join is on a primary key, so none of them can multiply a row — which is
// what makes this FROM safe to share with the count query. The showroom join is
// INNER because `showroom_id` is NOT NULL: an order always has a destination.
const ORDER_FROM = `FROM sample_orders so
         JOIN showrooms sr ON sr.id = so.showroom_id
         LEFT JOIN colourways c ON c.id = so.colourway_id
         LEFT JOIN products p ON p.id = c.product_id
         LEFT JOIN brands b ON b.id = p.brand_id
         LEFT JOIN suppliers sup ON sup.id = so.supplier_id`

const toSampleOrder = (row, extra) =>
  Object.freeze({
    id: row.id,
    showroom_id: row.showroom_id,
    colourway_id: row.colourway_id,
    supplier_id: row.supplier_id,
    label: row.label,
    status: row.status,
    // One stamp per transition. A NULL reads as "has not been there" without
    // consulting `status`, so no screen needs a CASE to date a move.
    requested_at: row.requested_at,
    ordered_at: row.ordered_at,
    in_transit_at: row.in_transit_at,
    received_at: row.received_at,
    displayed_at: row.displayed_at,
    cancelled_at: row.cancelled_at,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    ...extra,
  })

const orderContext = (row) => ({
  showroom_name: row.showroom_name,
  colourway_name: row.colourway_name,
  colourway_sku: row.colourway_sku,
  product_id: row.product_id,
  product_name: row.product_name,
  product_slug: row.product_slug,
  brand_id: row.brand_id,
  brand_name: row.brand_name,
  supplier_name: row.supplier_name,
})

// Escape the LIKE wildcards so a label containing an underscore matches that
// literal character rather than any single one. Pairs with ESCAPE '\' in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// WHERE fragments + bound params. Column names are in-code literals; every value
// flows through a $n placeholder.
const buildWhere = ({ q, status, showroomId, supplierId, includeArchived }) => {
  const clauses = []
  const params = []

  // Archived orders are hidden from the working list; the caller opts back in.
  // `cancelled` is a different question — that is a statement about the ORDER,
  // this is the reversible removal of the row.
  if (!includeArchived) {
    clauses.push('so.archived_at IS NULL')
  }

  if (typeof status === 'string' && status) {
    params.push(status)
    clauses.push(`so.status = $${params.length}`)
  }

  if (Number.isInteger(showroomId)) {
    params.push(showroomId)
    clauses.push(`so.showroom_id = $${params.length}`)
  }

  if (Number.isInteger(supplierId)) {
    params.push(supplierId)
    clauses.push(`so.supplier_id = $${params.length}`)
  }

  // A blank/whitespace term is ignored, not treated as "match nothing".
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // What was asked for (the label, or the design when the catalogue holds it)
    // and where it is going. `notes` is deliberately not searched: it is the
    // office's running commentary, and matching it makes a list of requests
    // answer with orders whose request matched nothing the user typed.
    clauses.push(`(
      so.label ILIKE $${i} ESCAPE '\\'
      OR sr.name ILIKE $${i} ESCAPE '\\'
      OR c.name ILIKE $${i} ESCAPE '\\'
      OR c.sku ILIKE $${i} ESCAPE '\\'
      OR p.name ILIKE $${i} ESCAPE '\\'
    )`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return { where, params }
}

/**
 * Filtered, paginated sample orders, newest request first, each carrying its
 * showroom, its design and its supplier by name. Returns
 * { sample_orders, total } — the route builds the meta envelope, as every other
 * admin list here does.
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, status?: string, showroomId?: number, supplierId?: number,
 *           includeArchived?: boolean, page?: number, limit?: number }} [options]
 * @returns {Promise<{ sample_orders: object[], total: number }>}
 */
export const listSampleOrders = async (
  pool,
  { q, status, showroomId, supplierId, includeArchived = false, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere({ q, status, showroomId, supplierId, includeArchived })

  const countResult = await pool.query(
    `SELECT count(*)::int AS total ${ORDER_FROM} ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS},
            ${ORDER_CONTEXT_COLUMNS}
       ${ORDER_FROM}
       ${where}
      ORDER BY so.requested_at DESC, so.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    sample_orders: rows.map((row) => toSampleOrder(row, orderContext(row))),
    total: countResult.rows[0].total,
  }
}

/**
 * One sample order by id, or null when the id is unknown.
 *
 * No archived filter, like every other by-id admin read: the caller already
 * knows the row exists, and the restore screen has to be able to read back the
 * archive it just made.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getSampleOrder = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS},
            ${ORDER_CONTEXT_COLUMNS}
       ${ORDER_FROM}
      WHERE so.id = $1`,
    [id]
  )
  return rows[0] ? toSampleOrder(rows[0], orderContext(rows[0])) : null
}

/**
 * Raise a request. Always lands in `requested` (see the module header); the
 * showroom is required because an order with no destination is unroutable.
 *
 * `requested_at` is optional and defaults to now(), so an order raised weeks ago
 * carries the day it was actually raised — the same posture as
 * `sample_loans.out_at`.
 *
 * Every write returns through `getSampleOrder`, so a create, a patch, a move, an
 * archive and a plain read all hand the CRM the SAME shape. One renderer, one
 * extra round trip, and the screens re-read after every write anyway.
 *
 * @param {import('pg').Pool} pool
 * @param {{ showroom_id: number, colourway_id?: number, supplier_id?: number,
 *           label?: string, notes?: string, requested_at?: string }} input
 * @returns {Promise<object>}
 */
export const createSampleOrder = async (pool, input) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO sample_orders
         (showroom_id, colourway_id, supplier_id, label, notes, requested_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()))
       RETURNING id`,
      [
        input.showroom_id ?? null,
        input.colourway_id ?? null,
        input.supplier_id ?? null,
        input.label ?? null,
        input.notes ?? null,
        input.requested_at ?? null,
      ]
    )
    return getSampleOrder(pool, rows[0].id)
  } catch (error) {
    return rethrowWriteError(error)
  }
}

/**
 * Patch a sample order from the frozen whitelist. `Object.hasOwn` (inside
 * buildUpdate) keeps an explicit null — which clears a nullable column, e.g.
 * detaching a request from a catalogue design — distinct from an absent key.
 *
 * `status` is not on the whitelist: a move is `transitionSampleOrder`, because
 * the state and the stamp that dates it must be written together.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateSampleOrder = async (pool, id, input) => {
  const { sets, params } = buildUpdate(input, SAMPLE_ORDER_UPDATE_COLUMNS)
  try {
    const { rows } = await pool.query(
      `UPDATE sample_orders SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}
        RETURNING id`,
      [...params, id]
    )
    if (rows.length === 0) {
      throw httpError(404, `Sample order ${id} not found.`)
    }
    return getSampleOrder(pool, id)
  } catch (error) {
    return rethrowWriteError(error)
  }
}

/**
 * Lock the order row, run a move inside ONE transaction, and return the fresh
 * order. 404 when the id is unknown. Mirrors `withSampleTxn`
 * (./sample-loans.js) and `withOrderTxn` (../orders/admin-orders.js): BEGIN,
 * SELECT … FOR UPDATE, run, COMMIT, re-read.
 *
 * The lock is what makes `requireTransition` mean anything: it reads the state
 * this transaction is about to overwrite, so two staff advancing one order at
 * once are serialised and the loser is refused rather than silently overwriting
 * the winner's stamp. `FOR UPDATE` rather than `FOR NO KEY UPDATE`, as
 * everywhere else here — nothing weaker conflicts with the `FOR KEY SHARE` a
 * referencing insert takes, and the register has already been bitten by that
 * distinction.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {(client: import('pg').PoolClient, order: { id: number, status: string }) => Promise<void>} fn
 * @returns {Promise<object|null>}
 */
export const withSampleOrderTxn = async (pool, id, fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, status FROM sample_orders WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const order = rows[0]
    if (!order) {
      throw httpError(404, `Sample order ${id} not found.`)
    }
    await fn(client, order)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getSampleOrder(pool, id)
}

/**
 * Advance an order to `status`, stamping the column that dates the move. An
 * illegal move — including a move to the state the order is already in, and any
 * move out of a terminal state — is a 409 from `requireTransition`.
 *
 * `at` is optional and defaults to now(), so a move recorded after the fact
 * carries the day it happened. Nothing refuses a stamp earlier than the previous
 * one: a back-dated correction has to stay possible, which is the same reason
 * the schema carries no CHECK tying `cancelled` to `cancelled_at`.
 *
 * The stamp column is looked up in the frozen `STATUS_STAMPS` map, keyed by a
 * value the machine has already accepted, so the interpolated identifier is a
 * code literal — never anything a caller supplied.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ status: string, at?: string }} input
 * @returns {Promise<object|null>}
 */
export const transitionSampleOrder = (pool, id, input) =>
  withSampleOrderTxn(pool, id, async (client, order) => {
    const target = input.status
    const stamp = STATUS_STAMPS[target]
    if (!stamp) {
      // The route spends the vocabulary as a schema enum, so this is the direct
      // caller's answer rather than a 500 on an interpolated undefined.
      throw httpError(422, `status must be one of: ${SAMPLE_ORDER_STATUSES.join(', ')}.`)
    }
    requireTransition(order, target)

    try {
      await client.query(
        `UPDATE sample_orders
            SET status = $2,
                ${stamp} = COALESCE($3::timestamptz, now()),
                updated_at = now()
          WHERE id = $1`,
        [id, target, input.at ?? null]
      )
    } catch (error) {
      rethrowWriteError(error)
    }
  })

/**
 * Soft-archive (archived=true) or restore (archived=false) a sample order,
 * stamping `updated_at`. Returns the fresh row, or null when the id is unknown.
 *
 * This is the alternative a blocked DELETE offers. An order past
 * `requested`/`cancelled` is refused a hard delete for good — it is the record
 * that a house was asked for something — so archiving is the only way a finished
 * order leaves the working list.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object|null>}
 */
export const setSampleOrderArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'sample_order', id, archived, {
    extraSets: ['updated_at = now()'],
    returning: 'id',
  })
  return row ? getSampleOrder(pool, row.id) : null
}
