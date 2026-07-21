// Back-office order management (US-014, FR-7).
//
// Staff review, edit, and drive website orders through their lifecycle. The
// interesting state lives in the reservation: an order-request reserves stock
// (qty_reserved) the moment it is placed (US-012). This module holds that
// reservation through review and payment, then either converts it to a real
// decrement (ship) or releases it (decline).
//
// Lifecycle (order-request / backorder kinds):
//   requested --confirm--> confirmed --mark-paid--> paid --ship--> shipped
//         \____________________ decline ____________________/  -> declined
//
// Any other transition is rejected with 409 (e.g. ship before paid). Checkout
// orders (kind='checkout') arrive already paid with inventory decremented and
// hold no reservation, so their inventory is never touched here.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Only these order kinds reserve stock; checkout orders decrement at payment.
const RESERVING_KINDS = new Set(['order_request', 'backorder_request'])
const reserves = (kind) => RESERVING_KINDS.has(kind)

export const ORDER_STATUSES = Object.freeze([
  'requested',
  'confirmed',
  'paid',
  'shipped',
  'declined',
])

// The reservation a reserving order currently holds against inventory:
//   held      -> qty_reserved still carries this order's demand
//   converted -> reservation turned into a real stock decrement (shipped)
//   released  -> reservation handed back (declined)
//   none      -> non-reserving kind (checkout)
const reservationState = (kind, status) => {
  if (!reserves(kind)) return 'none'
  if (status === 'shipped') return 'converted'
  if (status === 'declined') return 'released'
  return 'held'
}

const requireStatus = (order, allowed, action) => {
  const set = Array.isArray(allowed) ? allowed : [allowed]
  if (!set.includes(order.status)) {
    throw httpError(
      409,
      `Cannot ${action} an order in status "${order.status}".`
    )
  }
}

const ORDER_COLUMNS = `o.id,
        o.user_id,
        o.guest_email,
        o.order_number,
        o.kind,
        o.status,
        o.subtotal_cents,
        o.shipping_cents,
        o.total_cents,
        o.shipping_zone,
        o.xero_invoice_ref,
        o.notes,
        o.created_at`

// Load every line for a set of orders (one query, no N+1) with a snapshot of the
// colourway's inventory so staff see current stock alongside each line.
const loadLinesByOrderId = async (db, orderIds) => {
  if (orderIds.length === 0) {
    return new Map()
  }
  const { rows } = await db.query(
    `SELECT ol.order_id,
            ol.id,
            ol.qty,
            ol.unit_price_cents,
            ol.cut_requirements,
            ol.colourway_id,
            c.sku,
            p.name AS product_name,
            i.qty_available,
            i.qty_reserved
       FROM order_lines ol
       JOIN colourways c ON c.id = ol.colourway_id
       JOIN products p ON p.id = c.product_id
       LEFT JOIN inventory i ON i.colourway_id = ol.colourway_id
      WHERE ol.order_id = ANY($1::int[])
      ORDER BY ol.id`,
    [orderIds]
  )
  const byOrder = new Map()
  for (const row of rows) {
    const existing = byOrder.get(row.order_id)
    if (existing) {
      existing.push(row)
    } else {
      byOrder.set(row.order_id, [row])
    }
  }
  return byOrder
}

const toLine = (row, state) => ({
  id: row.id,
  sku: row.sku,
  product_name: row.product_name,
  qty: row.qty,
  unit_price_cents: row.unit_price_cents,
  cut_requirements: row.cut_requirements,
  colourway_id: row.colourway_id,
  inventory:
    row.qty_available === null
      ? null
      : { qty_available: row.qty_available, qty_reserved: row.qty_reserved },
  // How much of inventory.qty_reserved this line is responsible for right now.
  reserved_qty: state === 'held' && row.qty_available !== null ? row.qty : '0',
})

const toOrder = (row, lineRows) => {
  const state = reservationState(row.kind, row.status)
  return {
    id: row.id,
    user_id: row.user_id,
    guest_email: row.guest_email,
    order_number: row.order_number,
    kind: row.kind,
    status: row.status,
    subtotal_cents: row.subtotal_cents,
    shipping_cents: row.shipping_cents,
    total_cents: row.total_cents,
    shipping_zone: row.shipping_zone,
    xero_invoice_ref: row.xero_invoice_ref,
    notes: row.notes,
    created_at: row.created_at,
    reservation_state: state,
    lines: (lineRows ?? []).map((line) => toLine(line, state)),
  }
}

/**
 * List orders (optionally filtered by status), newest first, each with lines
 * and reservation state.
 *
 * @param {import('pg').Pool} pool
 * @param {{ status?: string }} [filter]
 * @returns {Promise<object[]>}
 */
export const listAdminOrders = async (pool, { status } = {}) => {
  const params = []
  let where = ''
  if (status) {
    params.push(status)
    where = `WHERE o.status = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS}
       FROM orders o
       ${where}
      ORDER BY o.created_at DESC, o.id DESC`,
    params
  )
  const linesByOrderId = await loadLinesByOrderId(
    pool,
    rows.map((row) => row.id)
  )
  return rows.map((row) => toOrder(row, linesByOrderId.get(row.id)))
}

/**
 * A single order with lines and reservation state, or null when it doesn't
 * exist. Reads through `db` (pool or client) so it can reflect an open txn.
 */
export const getAdminOrder = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  const linesByOrderId = await loadLinesByOrderId(db, [id])
  return toOrder(row, linesByOrderId.get(id))
}

// Lock the order row, run a mutation inside one transaction, and return the
// fresh order. 404 when the order id is unknown.
const withOrderTxn = async (pool, id, fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, kind, status FROM orders WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const order = rows[0]
    if (!order) {
      throw httpError(404, `Order ${id} not found.`)
    }
    await fn(client, order)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getAdminOrder(pool, id)
}

/**
 * Edit line quantities and adjust the held reservation to match. Only allowed
 * while the order is still in the reservation phase (requested/confirmed);
 * later states have already converted or released the reservation.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {Array<{ id: number, qty: number }>} edits
 */
export const editOrderLines = (pool, id, edits) =>
  withOrderTxn(pool, id, async (client, order) => {
    requireStatus(order, ['requested', 'confirmed'], 'edit lines on')

    const { rows: lines } = await client.query(
      `SELECT id, colourway_id, qty FROM order_lines WHERE order_id = $1`,
      [id]
    )
    const byId = new Map(lines.map((line) => [line.id, line]))

    for (const edit of edits) {
      const line = byId.get(edit.id)
      if (!line) {
        throw httpError(422, `Order line ${edit.id} is not on order ${id}.`)
      }
      const delta = edit.qty - Number(line.qty)
      await client.query(`UPDATE order_lines SET qty = $1 WHERE id = $2`, [
        edit.qty,
        edit.id,
      ])
      // Keep the reservation in step with the new quantity. Reserving kinds only;
      // a colourway with no inventory row (short backorder) reserved nothing, so
      // the UPDATE simply matches no rows.
      if (reserves(order.kind) && delta !== 0) {
        await client.query(
          `UPDATE inventory
              SET qty_reserved = qty_reserved + $1
            WHERE colourway_id = $2`,
          [delta, line.colourway_id]
        )
      }
    }
  })

/**
 * Confirm a requested order and store the manually-created Xero invoice ref.
 * No Xero API call — the ref is typed in by staff after invoicing in Xero.
 */
export const confirmOrder = (pool, id, xeroInvoiceRef) =>
  withOrderTxn(pool, id, async (client, order) => {
    requireStatus(order, 'requested', 'confirm')
    await client.query(
      `UPDATE orders SET status = 'confirmed', xero_invoice_ref = $2 WHERE id = $1`,
      [id, xeroInvoiceRef]
    )
  })

/** Mark a confirmed order paid (payment reconciled manually / off-platform). */
export const markOrderPaid = (pool, id) =>
  withOrderTxn(pool, id, async (client, order) => {
    requireStatus(order, 'confirmed', 'mark paid')
    await client.query(`UPDATE orders SET status = 'paid' WHERE id = $1`, [id])
  })

/**
 * Ship a paid order: set status=shipped and convert the held reservation into a
 * real stock decrement (qty_reserved down, qty_available down by the same amount).
 */
export const shipOrder = (pool, id) =>
  withOrderTxn(pool, id, async (client, order) => {
    requireStatus(order, 'paid', 'ship')
    if (reserves(order.kind)) {
      await client.query(
        `UPDATE inventory i
            SET qty_reserved = i.qty_reserved - ol.qty,
                qty_available = i.qty_available - ol.qty
           FROM order_lines ol
          WHERE ol.order_id = $1
            AND i.colourway_id = ol.colourway_id`,
        [id]
      )
    }
    await client.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [id])
  })

/**
 * Decline an order still in the reservation phase (requested/confirmed) and
 * release its held reservation back to available stock.
 */
export const declineOrder = (pool, id) =>
  withOrderTxn(pool, id, async (client, order) => {
    requireStatus(order, ['requested', 'confirmed'], 'decline')
    if (reserves(order.kind)) {
      await client.query(
        `UPDATE inventory i
            SET qty_reserved = i.qty_reserved - ol.qty
           FROM order_lines ol
          WHERE ol.order_id = $1
            AND i.colourway_id = ol.colourway_id`,
        [id]
      )
    }
    await client.query(`UPDATE orders SET status = 'declined' WHERE id = $1`, [id])
  })
