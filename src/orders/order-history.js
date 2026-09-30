// Order history (US-013, FR meeting 00:21:46).
//
// Two read paths, one shape: listUserOrders(pool, userId) — every order owned
// by a logged-in user, header + lines — and getCustomerOrder(pool, { id }), the
// single order a quote link names (src/routes/orders.js resolves the token to
// the id; nothing here takes one from a caller). The unauthenticated order_number + email
// lookup that used to sit beside it is gone: it let anyone who knew (or
// guessed) both halves read another client's order, and a logged-in client
// already sees their orders under /account.
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
        o.gst_cents,
        o.total_cents,
        o.shipping_zone,
        o.discount_pct,
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
            p.sell_retail,
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
      // Whether the cart sells it today (1 Oct 2026): the store's Reorder
      // refills the cart with it, else the quote request.
      sell_retail: row.sell_retail === true,
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

// A quote the office has not sent carries no price the client may read (24 Sep
// 2026: "customer cannot see price on quote made until quote status set sent").
// The indicative figures a request is stored with are the office's starting
// point, not an offer; the money appears once the quote goes out — and hides
// again if the office takes a sent quote back to re-price it.
const PRICE_HIDDEN_STATUSES = Object.freeze(['quote_requested'])

const toOrder = (row, linesByOrderId) => {
  const hidden = PRICE_HIDDEN_STATUSES.includes(row.status)
  const money = (value) => (hidden ? null : value)
  const lines = linesByOrderId.get(row.id) ?? []
  return {
    id: row.id,
    order_number: row.order_number,
    kind: row.kind,
    status: row.status,
    subtotal_cents: money(row.subtotal_cents),
    shipping_cents: money(row.shipping_cents),
    gst_cents: money(row.gst_cents),
    total_cents: money(row.total_cents),
    shipping_zone: row.shipping_zone,
    // The percentage only: the client sees why their total is under the
    // subtotal, the reason and who applied it stay in the back office.
    discount_pct: money(row.discount_pct),
    xero_invoice_ref: row.xero_invoice_ref,
    // Where a card checkout is being delivered. Null for request-kind orders and
    // for checkouts placed before delivery details were collected.
    shipping_address: row.shipping_address ?? null,
    created_at: row.created_at,
    lines: hidden ? lines.map((line) => ({ ...line, unit_price_cents: null })) : lines,
  }
}

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
 * One order in the customer shape, or null. For the quote page, which reaches
 * it through the signed link's token — the caller resolves the token; this
 * never takes an id from a request.
 *
 * @param {import('pg').Pool} pool
 * @param {{ id: number }} args
 */
export const getCustomerOrder = async (pool, { id }) => {
  const { rows } = await pool.query(`SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.id = $1`, [
    id,
  ])
  if (!rows[0]) return null
  return toOrder(rows[0], await loadLinesByOrderId(pool, [id]))
}
