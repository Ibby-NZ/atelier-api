// The trade client dashboard, in one round trip.
//
// The dashboard is not a data source of its own — it is a digest of the panels
// beside it, and every figure on it is produced by the same scoped read model
// the full panel uses. That is deliberate: a bespoke aggregate query would be a
// second place the client's identity has to be applied correctly, and the first
// time the two disagreed the dashboard would be the one that was wrong.
//
// It always answers 200, including for a client whose login has not been linked
// to a D365 customer yet. `trade_account.linked` is the flag the storefront
// branches on: false means "your account is still being set up" rather than a
// row of confident zeroes, which is the difference between an honest empty state
// and one that reads as data loss.

import { loadViewerTradeAccount, toClientTradeAccount } from '../trade-accounts/viewer.js'
import { getClientLegacyCounts } from '../trade-accounts/client-legacy.js'
import { listUserOrders } from '../orders/order-history.js'

/** How many recent orders the dashboard carries inline. */
export const RECENT_ORDER_LIMIT = 3

/**
 * @param {import('pg').Pool} pool
 * @param {{ id: number, name?: string|null, email: string }} user  the authenticated user
 * @param {{ priceListsEnabled?: boolean }} [options]
 */
export const getAccountSummary = async (pool, user, { priceListsEnabled = false } = {}) => {
  // The legacy counts and the order page are independent — the first is scoped
  // by the D365 link, the second by user_id — so they run together.
  const [account, counts, orderPage] = await Promise.all([
    loadViewerTradeAccount(pool, user.id),
    getClientLegacyCounts(pool, user.id),
    listUserOrders(pool, user.id, { page: 1, limit: RECENT_ORDER_LIMIT }),
  ])

  return {
    account: {
      name: user.name ?? null,
      email: user.email,
    },
    trade_account: toClientTradeAccount(account),
    orders: {
      total: orderPage.meta.total,
      recent: orderPage.orders,
    },
    // Counts, not rows: the dashboard says "18 cuttings on record" and links to
    // the panel. `getClientLegacyCounts` fails closed for an unlinked viewer, so
    // these are 0 rather than an error.
    samples: { total: counts.samples },
    invoices: {
      total: counts.invoices,
      latest_invoice_date: counts.latest_invoice_date,
    },
    // Whether the price-list panel exists at all. Config, not entitlement — see
    // src/pricing/trade-price-lists.js for why it ships off.
    price_lists: { available: priceListsEnabled },
  }
}
