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
//
// The identity fields beyond sku/name (`slug`, `product_type`, `brand_name`,
// `colourway_name`) are what REORDER needs: the storefront rebuilds a request
// list — or a cart — from a past order, and both need to know which product page
// a line came from and whether it is cloth (a cut request) or a finished good (a
// card checkout). Without the slug the client would have to search for the SKU
// to find the product again.
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
            c.name AS colourway_name,
            p.name AS product_name,
            p.slug,
            p.product_type,
            p.lead_time,
            b.name AS brand_name
       FROM order_lines ol
       JOIN colourways c ON c.id = ol.colourway_id
       JOIN products p ON p.id = c.product_id
       JOIN brands b ON b.id = p.brand_id
      WHERE ol.order_id = ANY($1::int[])
      ORDER BY ol.id`,
    [orderIds]
  )
  const byOrder = new Map()
  for (const row of rows) {
    const line = {
      sku: row.sku,
      product_name: row.product_name,
      slug: row.slug,
      product_type: row.product_type,
      brand_name: row.brand_name,
      colourway_name: row.colourway_name,
      lead_time: row.lead_time,
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

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

/**
 * A page of the orders owned by a user, newest first, each with its lines.
 *
 * PAGED, not unbounded: this used to return every order a user had ever placed
 * plus every line of every one of them, which the account dashboard then sliced
 * to three. A long-standing trade client is exactly the account that breaks
 * that, and it is the one this page exists for.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ orders: object[], meta: { total, page, limit } }>}
 */
export const listUserOrders = async (
  pool,
  userId,
  { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = {}
) => {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const safePage = Math.max(page, 1)
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS},
            count(*) OVER () AS total_count
       FROM orders o
      WHERE o.user_id = $1
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $2 OFFSET $3`,
    [userId, safeLimit, (safePage - 1) * safeLimit]
  )
  const linesByOrderId = await loadLinesByOrderId(
    pool,
    rows.map((row) => row.id)
  )
  return {
    orders: rows.map((row) => toOrder(row, linesByOrderId)),
    meta: {
      total: rows.length > 0 ? Number(rows[0].total_count) : 0,
      page: safePage,
      limit: safeLimit,
    },
  }
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
