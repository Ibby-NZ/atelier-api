// Back-office stock (inventory) management.
//
// Inventory quantities normally move only through the order state machine
// (src/orders/admin-orders.js): a request reserves stock, shipping converts the
// reservation to a decrement, declining releases it. This module is the manual
// correction path staff reach for when reality and the ledger disagree —
// receiving a delivery, writing off shrinkage, or fixing a mis-typed count.
//
// Two rules shape it:
//   - qty_available and qty_reserved are both editable (receiving, shrinkage, a
//     manual reservation override), but neither may go below zero.
//   - reserved <= available is deliberately NOT enforced: a short backorder
//     legitimately reserves more than is on hand, so clamping the two together
//     would corrupt that committed demand.
//
// pg returns numeric columns as strings ('60.00'); every quantity is coerced
// with Number() before it leaves this module so callers never do string maths.

import { buildUpdate } from '../catalogue/admin-brands.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The only columns a PATCH may write. Names are never user input; values always
// flow through placeholders built by buildUpdate.
const INVENTORY_UPDATE_COLUMNS = Object.freeze(['qty_available', 'qty_reserved'])

// Escape the LIKE wildcards so a search for "100%" matches a literal percent
// rather than everything. Pairs with the ESCAPE '\' clause in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

// Joined stock view: the inventory row plus the human-readable identifiers staff
// need to recognise what they are editing (SKU, colourway, product, house).
const INVENTORY_SELECT = `SELECT i.colourway_id,
              i.qty_available,
              i.qty_reserved,
              i.unit,
              c.sku,
              c.name AS colourway_name,
              p.name AS product_name,
              b.name AS brand_name
         FROM inventory i
         JOIN colourways c ON c.id = i.colourway_id
         JOIN products p ON p.id = c.product_id
         JOIN brands b ON b.id = p.brand_id`

// Immutable public shape. Quantities are coerced out of pg's numeric strings so
// the caller can do arithmetic and equality checks without surprises.
const toInventory = (row) =>
  Object.freeze({
    colourway_id: row.colourway_id,
    sku: row.sku,
    colourway_name: row.colourway_name,
    product_name: row.product_name,
    brand_name: row.brand_name,
    unit: row.unit,
    qty_available: Number(row.qty_available),
    qty_reserved: Number(row.qty_reserved),
  })

// Guard the quantities a PATCH supplies. The route schema also caps them at >= 0,
// so this is belt-and-suspenders for any direct caller: it keeps the module the
// single gate that never lets a negative quantity reach the UPDATE.
const assertQuantities = (input) => {
  for (const column of INVENTORY_UPDATE_COLUMNS) {
    if (Object.hasOwn(input, column)) {
      const value = input[column]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw httpError(422, `${column} must be a number of 0 or more.`)
      }
    }
  }
}

/**
 * Every inventory row, joined to its colourway/product/brand for display and
 * ordered house -> product -> colourway. An optional free-text `q` narrows the
 * list by SKU, product name or colourway name (ILIKE, wildcards escaped).
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string }} [filter]
 * @returns {Promise<object[]>}
 */
export const listInventory = async (pool, { q } = {}) => {
  const params = []
  let where = ''
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    where = `WHERE (
        c.sku ILIKE $${i} ESCAPE '\\'
        OR p.name ILIKE $${i} ESCAPE '\\'
        OR c.name ILIKE $${i} ESCAPE '\\'
      )`
  }
  const { rows } = await pool.query(
    `${INVENTORY_SELECT} ${where}
      ORDER BY b.name ASC, p.name ASC, c.name ASC, i.colourway_id ASC`,
    params
  )
  return rows.map(toInventory)
}

/**
 * A single joined inventory row, or null when the colourway has no inventory row
 * (the caller turns that into a 404). Reads through `pool` — or any client — so
 * it can reflect a re-fetch after a write.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} pool
 * @param {number} colourwayId
 * @returns {Promise<object|null>}
 */
export const getInventory = async (pool, colourwayId) => {
  const { rows } = await pool.query(
    `${INVENTORY_SELECT} WHERE i.colourway_id = $1`,
    [colourwayId]
  )
  return rows[0] ? toInventory(rows[0]) : null
}

/**
 * Set qty_available and/or qty_reserved to absolute values (staff correction).
 * Only the whitelisted columns are written; each supplied value must be a finite
 * number >= 0 (else 422). An unknown colourway (no inventory row) is a 404.
 *
 * @param {import('pg').Pool} pool
 * @param {number} colourwayId
 * @param {{ qty_available?: number, qty_reserved?: number }} input
 * @returns {Promise<object>}
 */
export const updateInventory = async (pool, colourwayId, input) => {
  assertQuantities(input)
  const { sets, params } = buildUpdate(input, INVENTORY_UPDATE_COLUMNS)
  const { rowCount } = await pool.query(
    `UPDATE inventory SET ${sets.join(', ')}
      WHERE colourway_id = $${params.length + 1}`,
    [...params, colourwayId]
  )
  if (rowCount === 0) {
    throw httpError(404, `No inventory row for colourway ${colourwayId}.`)
  }
  return getInventory(pool, colourwayId)
}

/**
 * Move qty_available by a signed delta (e.g. +50 receiving a delivery, -3
 * writing off damage). The guard lives in the WHERE clause so the whole
 * read-modify-write is one atomic statement — concurrent adjustments can never
 * race a stale value below zero. When the guard blocks the update we distinguish
 * a missing row (404) from an over-decrement (422) with a follow-up existence
 * check.
 *
 * @param {import('pg').Pool} pool
 * @param {number} colourwayId
 * @param {number} delta
 * @returns {Promise<object>}
 */
export const adjustInventory = async (pool, colourwayId, delta) => {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    throw httpError(422, 'Adjustment delta must be a finite number.')
  }
  const { rowCount } = await pool.query(
    `UPDATE inventory
        SET qty_available = qty_available + $1
      WHERE colourway_id = $2
        AND qty_available + $1 >= 0`,
    [delta, colourwayId]
  )
  if (rowCount === 0) {
    const { rowCount: exists } = await pool.query(
      `SELECT 1 FROM inventory WHERE colourway_id = $1`,
      [colourwayId]
    )
    if (exists === 0) {
      throw httpError(404, `No inventory row for colourway ${colourwayId}.`)
    }
    throw httpError(422, 'Adjustment would make stock negative.')
  }
  return getInventory(pool, colourwayId)
}
