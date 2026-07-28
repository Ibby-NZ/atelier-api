// Order history + guest lookup (US-013, FR meeting 00:21:46).
//
// Two read paths, both returning the same order shape (header + lines):
//   - listUserOrders(pool, userId): every order owned by a logged-in user.
//   - lookupOrder(pool, { orderNumber, email }): a single order matched by BOTH
//     its order number and an email — either the guest_email it was placed with
//     or the email of the user who placed it. Returns null when nothing matches
//     (the route turns that into a 404), so an order is never leaked to someone
//     who can't name both halves of the key.
//
// Ownership is enforced in SQL, never in the handler: /orders/mine filters on
// user_id, so one user can never read another user's orders.

// Header columns returned for every order (no internal ids like stripe_session_id).
const ORDER_COLUMNS = `o.id,
        o.order_number,
        o.kind,
        o.status,
        o.subtotal_cents,
        o.shipping_cents,
        o.total_cents,
        o.shipping_zone,
        o.xero_invoice_ref,
        o.shipping_address,
        o.guest_email,
        o.created_at`

// Fetch the lines for a set of order ids in one query, then group by order id.
// pg returns numeric `qty` as a string — expose it as-is (callers coerce).
const loadLinesByOrderId = async (pool, orderIds) => {
  if (orderIds.length === 0) {
    return new Map()
  }
  const { rows } = await pool.query(
    `SELECT ol.order_id,
            ol.qty,
            ol.unit_price_cents,
            ol.cut_requirements,
            c.sku,
            p.name AS product_name
       FROM order_lines ol
       JOIN colourways c ON c.id = ol.colourway_id
       JOIN products p ON p.id = c.product_id
      WHERE ol.order_id = ANY($1::int[])
      ORDER BY ol.id`,
    [orderIds]
  )
  const byOrder = new Map()
  for (const row of rows) {
    const line = {
      sku: row.sku,
      product_name: row.product_name,
      qty: row.qty,
      unit_price_cents: row.unit_price_cents,
      cut_requirements: row.cut_requirements,
    }
    const existing = byOrder.get(row.order_id)
    if (existing) {
      existing.push(line)
    } else {
      byOrder.set(row.order_id, [line])
    }
  }
  return byOrder
}

const toOrder = (row, linesByOrderId) => ({
  id: row.id,
  order_number: row.order_number,
  kind: row.kind,
  status: row.status,
  subtotal_cents: row.subtotal_cents,
  shipping_cents: row.shipping_cents,
  total_cents: row.total_cents,
  shipping_zone: row.shipping_zone,
  xero_invoice_ref: row.xero_invoice_ref,
  // Where a card checkout is being delivered. Null for request-kind orders and
  // for checkouts placed before delivery details were collected.
  shipping_address: row.shipping_address ?? null,
  created_at: row.created_at,
  lines: linesByOrderId.get(row.id) ?? [],
})

/**
 * Every order owned by a user, newest first, each with its lines.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<object[]>}
 */
export const listUserOrders = async (pool, userId) => {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS}
       FROM orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC, o.id DESC`,
    [userId]
  )
  const linesByOrderId = await loadLinesByOrderId(
    pool,
    rows.map((row) => row.id)
  )
  return rows.map((row) => toOrder(row, linesByOrderId))
}

/**
 * A single order matched by order number AND email (guest email or the placing
 * user's email). Returns null when there is no exact match.
 *
 * @param {import('pg').Pool} pool
 * @param {{ orderNumber: string, email: string }} key
 * @returns {Promise<object|null>}
 */
export const lookupOrder = async (pool, { orderNumber, email }) => {
  const normalizedEmail = email.trim().toLowerCase()
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS}
       FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
      WHERE o.order_number = $1
        AND (lower(o.guest_email) = $2 OR lower(u.email) = $2)
      LIMIT 1`,
    [orderNumber, normalizedEmail]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  const linesByOrderId = await loadLinesByOrderId(pool, [row.id])
  return toOrder(row, linesByOrderId)
}
