// Bulk orders: ONE letter to a house covering several purchase orders (24 Sep
// 2026, the Bulk orders tab: "send a single purchase order to the supplier that
// can contain different purchase orders from different client sales orders").
//
// A bulk is a GROUPING and a SEND, not a second kind of purchase order. Each
// member keeps its own number, lines, allocations to sales orders, Xero bill and
// status; the bulk records which went to the house together, and when. So
// receiving stays line by line on the members — which is what lets the receive
// screen split a delivery back to the sales orders it was bought for.
//
// Only purchase orders marked READY TO SEND go into a bulk (25 Sep 2026 — a
// draft is still being written), all for ONE supplier, and sending the bulk is
// Send PO for every member at once (ready_to_send → pending_payment, in ONE
// transaction: either the whole bulk went or none of it did). The route raises
// each member's Xero bill and sends the one combined letter afterwards, exactly
// as a single Send PO does — neither can un-send the bulk.

import { BULKABLE_PURCHASE_ORDER_STATUS, STATUS_STAMPS } from './po-states.js'
import { listPurchaseOrders } from './admin-purchase-orders.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The bulk's own number, from its own sequence — never a PO number, which the
// house files each member under.
const BULK_NUMBER = `'BULK-' || lpad(nextval('purchase_order_bulks_number_seq')::text, 6, '0')`

// The most purchase orders one bulk may carry — the list's page ceiling, so the
// bulk page reads every member in one query.
export const MAX_BULK_SIZE = 100

/**
 * Send several ready-to-send purchase orders to their supplier as one bulk
 * order. Returns the new bulk's id.
 *
 * @param {import('pg').Pool} pool
 * @param {{ purchaseOrderIds: number[], user?: { id: number }|null }} input
 * @returns {Promise<number>}
 */
export const sendBulkOrder = async (pool, { purchaseOrderIds, user = null }) => {
  const ids = [...new Set(purchaseOrderIds)]
  if (ids.length === 0 || ids.length > MAX_BULK_SIZE) {
    throw httpError(422, `A bulk order carries between 1 and ${MAX_BULK_SIZE} purchase orders.`)
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT po.id, po.po_number, po.status, po.supplier_id, po.supplier_name
         FROM purchase_orders po
        WHERE po.id = ANY($1::int[])
        ORDER BY po.id
          FOR UPDATE`,
      [ids]
    )
    if (rows.length !== ids.length) {
      const found = new Set(rows.map((row) => row.id))
      throw httpError(404, `Purchase order ${ids.find((id) => !found.has(id))} not found.`)
    }
    const notReady = rows.find((row) => row.status !== BULKABLE_PURCHASE_ORDER_STATUS)
    if (notReady) {
      throw httpError(
        409,
        notReady.status === 'draft'
          ? `${notReady.po_number} is still a draft — mark it Ready to send before it goes in a bulk order.`
          : `${notReady.po_number} is "${notReady.status}" — a bulk order sends purchase orders that are ready to send and have not gone to the house yet.`
      )
    }
    const suppliers = [...new Set(rows.map((row) => row.supplier_id))]
    if (suppliers.length !== 1 || suppliers[0] == null) {
      throw httpError(
        422,
        'A bulk order goes to ONE supplier — ' +
          rows.map((row) => `${row.po_number} is ${row.supplier_name ?? 'unaddressed'}`).join(', ') +
          '.'
      )
    }
    const { rows: bulks } = await client.query(
      `INSERT INTO purchase_order_bulks (bulk_number, supplier_id, created_by)
       VALUES (${BULK_NUMBER}, $1, $2)
       RETURNING id`,
      [suppliers[0], user?.id ?? null]
    )
    const bulkId = bulks[0].id
    // Send PO for every member: the move and its stamp in one statement, the
    // rule moveStatus keeps for a single order.
    await client.query(
      `UPDATE purchase_orders
          SET bulk_order_id = $1,
              status = 'pending_payment',
              ${STATUS_STAMPS.pending_payment} = now(),
              updated_at = now()
        WHERE id = ANY($2::int[])`,
      [bulkId, ids]
    )
    await client.query('COMMIT')
    return bulkId
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * One bulk order with every member purchase order (lines, allocations to sales
 * orders, received quantities), or null.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ finance?: boolean }} [options]
 */
export const getBulkOrder = async (pool, id, { finance = false } = {}) => {
  const { rows } = await pool.query(
    `SELECT pb.id, pb.bulk_number, pb.supplier_id, s.name AS supplier_name,
            pb.created_at, u.name AS created_by_name
       FROM purchase_order_bulks pb
       JOIN suppliers s ON s.id = pb.supplier_id
       LEFT JOIN users u ON u.id = pb.created_by
      WHERE pb.id = $1`,
    [id]
  )
  if (!rows[0]) return null
  const { purchase_orders } = await listPurchaseOrders(pool, {
    bulkOrderId: id,
    limit: MAX_BULK_SIZE,
    finance,
  })
  // The list reads newest first; a bulk reads upward, in the order its members
  // were raised — the letter, the page and the history all agree.
  return Object.freeze({ ...rows[0], purchase_orders: [...purchase_orders].sort((a, b) => a.id - b.id) })
}

/**
 * Every bulk order sent, newest first, with its members' numbers and statuses —
 * the Bulk orders tab's history.
 *
 * @param {import('pg').Pool} pool
 */
export const listBulkOrders = async (pool) => {
  const { rows } = await pool.query(
    `SELECT pb.id, pb.bulk_number, pb.supplier_id, s.name AS supplier_name,
            pb.created_at, u.name AS created_by_name,
            array_agg(po.po_number ORDER BY po.id) AS po_numbers,
            array_agg(po.status ORDER BY po.id) AS statuses
       FROM purchase_order_bulks pb
       JOIN suppliers s ON s.id = pb.supplier_id
       LEFT JOIN users u ON u.id = pb.created_by
       JOIN purchase_orders po ON po.bulk_order_id = pb.id
      GROUP BY pb.id, s.name, u.name
      ORDER BY pb.created_at DESC, pb.id DESC`
  )
  return rows
}
