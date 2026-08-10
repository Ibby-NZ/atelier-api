// Which order kinds reserve stock, and which states an order may still be
// deleted from.
//
// THIS MODULE IS PURE AND IMPORTS NOTHING, deliberately, for the same three
// reasons `src/samples/sample-order-states.js` does:
//   - `src/lifecycle/registry.js` imports it for the order delete guard and the
//     reservation release. The registry is imported by `src/lifecycle/archive.js`,
//     which `src/orders/admin-orders.js` imports in turn, so these rules had to
//     live in a LEAF module or the three would form a cycle and the registry's
//     import-time validation would run against a half-initialised module.
//   - The CRM mirrors it (`atelier-crm/src/admin/orderFlow.js`) so staff are
//     never shown a Delete button the API would 409.
//   - It unit-tests with no database at all.
//
// `RESERVING_KINDS` lived in admin-orders.js until the delete story needed it
// here; that module now imports it, so there is one source of truth rather than
// two copies that could disagree about whether a manual order holds stock.

/**
 * The kinds that hold a reservation against `inventory.qty_reserved`.
 *
 * A card checkout is absent because it arrives already paid with stock
 * decremented (the Stripe webhook does that), so it holds no reservation and
 * nothing here may touch its inventory. Everything else is unfulfilled demand:
 * a shopper's request, a backorder, and a sales order the office keyed itself.
 */
export const RESERVING_KINDS = Object.freeze([
  'order_request',
  'backorder_request',
  'manual',
])

/** @param {string} kind */
export const reserves = (kind) => RESERVING_KINDS.includes(kind)

/**
 * The states a hard delete is still allowed from.
 *
 * `paid` and `shipped` are excluded because money has moved: the row carries the
 * Xero reference the office invoiced against, and a shipped order is what the
 * stock decrement was justified by. Both archive instead. `declined` IS
 * deletable — it is a refusal, its reservation was already handed back, and
 * nothing downstream reads it.
 *
 * Kind matters as well as status and is checked separately in the guard: a
 * `checkout` order carries a Stripe session id and is a payment record whatever
 * its status.
 */
export const DELETABLE_ORDER_STATUSES = Object.freeze([
  'requested',
  'confirmed',
  'declined',
])

/**
 * The states in which a reserving order's demand is STILL SITTING in
 * `inventory.qty_reserved`.
 *
 * `shipped` converted the reservation into a real decrement and `declined`
 * released it, so both have already been settled — releasing again on delete
 * would hand back stock twice and inflate availability, silently. This is the
 * predicate that stops that.
 */
export const HELD_STATUSES = Object.freeze(['requested', 'confirmed', 'paid'])

/**
 * Whether a hard delete is allowed at all. The registry's guard is the
 * enforcement; this is the predicate behind it, shared so the CRM can hide the
 * button rather than discovering the 409.
 *
 * @param {{ kind: string, status: string }} order
 * @returns {boolean}
 */
export const isDeletableOrder = (order) =>
  order?.kind !== 'checkout' && DELETABLE_ORDER_STATUSES.includes(order?.status)

/**
 * Whether deleting this order must release its reservation first.
 *
 * @param {{ kind: string, status: string }} order
 * @returns {boolean}
 */
export const holdsReservation = (order) =>
  reserves(order?.kind) && HELD_STATUSES.includes(order?.status)
