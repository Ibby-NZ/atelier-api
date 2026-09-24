// The CRM dashboard's numbers, in one round trip.
//
// It lives in reports/ because the month-to-date tile is a revenue figure and
// revenue has ONE definition here: `buildRevenueScope` (paid + shipped,
// archived orders out — src/reports/revenue-lines.js). A dashboard that
// re-derived "sales" with its own join tree would disagree with the report
// library the first time either changed.
//
// THE PAYLOAD STATES ITS POPULATIONS. `sales_mtd.statuses`, `sales_mtd.from`,
// `open_orders.statuses` and `inbound.status` say exactly what each figure is
// of, so the CRM builds its drill-down links FROM the payload and a tile can
// never disagree with the list it opens (the meta.coverage posture).
//
// MONEY RULES TRAVEL TOO:
//   - A figure that cannot honestly be added is withheld: two currencies in
//     the month's population make `value_cents` null with `mixed_currency`
//     set, never a summed lie.
//   - `unpriced_lines` is the honesty column — request-kind lines sit in the
//     population at zero value, and without the count a total that includes
//     them reads as a discount.
//   - Sell-side money (sales MTD) carries NO finance gate — a sell value is
//     money and is not a cost, and /admin/orders already serves every addend
//     ungated. PO money IS cost: `inbound` reuses listPurchaseOrders with the
//     caller's finance flag, so cost keys are DELETED for a login without
//     finance visibility exactly as the PO screen deletes them.

import { buildRevenueScope, REVENUE_STATUSES, SCOPE_NAME } from './revenue-lines.js'
import { HELD_STATUSES } from '../orders/order-states.js'
import { listAdminOrders } from '../orders/admin-orders.js'
import { listPurchaseOrders } from '../purchasing/admin-purchase-orders.js'

// How many rows each of the two lists carries. A dashboard glances; the full
// screens page.
const LIST_LIMIT = 5

// Goods on their way in: sent to the house and not yet received (24 Sep 2026,
// the purchase-order statuses). Was the single `sent`.
const INBOUND_STATUSES = Object.freeze(['pending_payment', 'paid', 'awaiting_delivery'])

// The first of the current month, in this process's local day — the same
// YYYY-MM-DD vocabulary the report filters speak, echoed back as
// `sales_mtd.from` so the CRM's drill link covers exactly the tile's window.
const monthStart = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * Everything the dashboard shows, as one object.
 *
 * @param {import('pg').Pool} pool
 * @param {{ finance?: boolean }} [options] from loadReportAccess — NEVER from
 *   `request.user.can_view_finance`, which the guard's projection does not carry
 * @returns {Promise<object>}
 */
export const buildDashboard = async (pool, { finance = false } = {}) => {
  const from = monthStart()
  // The scope's own `from` filter (>= the first, exclusive-next-day rules do
  // not apply to a lower bound) over the default revenue population.
  const { cte, params } = buildRevenueScope({ from })

  const [mtdResult, openResult, inbound, recent] = await Promise.all([
    pool.query(
      `WITH ${cte}
       SELECT COALESCE(ROUND(SUM(line_value_cents)), 0) AS value_cents,
              COUNT(DISTINCT order_id)::int AS orders,
              COUNT(*) FILTER (WHERE unpriced)::int AS unpriced_lines,
              COUNT(DISTINCT currency) FILTER (WHERE NOT unpriced)::int AS currencies,
              MAX(currency) FILTER (WHERE NOT unpriced) AS currency
         FROM ${SCOPE_NAME}`,
      params
    ),
    pool.query(
      `SELECT count(*)::int AS total FROM orders
        WHERE status = ANY($1::text[]) AND archived_at IS NULL`,
      // HELD_STATUSES spent as the "awaiting fulfilment" set — the same frozen
      // constant the reservation model keys on, never retyped.
      [[...HELD_STATUSES]]
    ),
    listPurchaseOrders(pool, { status: [...INBOUND_STATUSES], limit: LIST_LIMIT, finance }),
    listAdminOrders(pool, { limit: LIST_LIMIT }),
  ])

  const mtd = mtdResult.rows[0]
  const mixedCurrency = mtd.currencies > 1

  return Object.freeze({
    sales_mtd: Object.freeze({
      // Withheld under mixed currencies — absent-not-summed, as every report.
      value_cents: mixedCurrency ? null : Number(mtd.value_cents),
      currency: mixedCurrency ? null : mtd.currency,
      mixed_currency: mixedCurrency,
      orders: mtd.orders,
      unpriced_lines: mtd.unpriced_lines,
      from,
      statuses: REVENUE_STATUSES,
    }),
    open_orders: Object.freeze({
      count: openResult.rows[0].total,
      statuses: HELD_STATUSES,
    }),
    inbound: Object.freeze({
      count: inbound.total,
      statuses: INBOUND_STATUSES,
      purchase_orders: inbound.purchase_orders,
    }),
    recent_orders: recent.orders,
  })
}
