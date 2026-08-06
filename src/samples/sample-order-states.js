// The sample-order state machine: the vocabulary, the legal moves, the stamp
// each move writes, and which states may still be hard-deleted (W4-US-007).
//
// THIS MODULE IS PURE AND IMPORTS NOTHING, deliberately, and there are three
// reasons rather than one:
//   - The CRM mirrors it. `atelier-crm/src/screens/sampleFlow.js` (US-009) needs
//     the same map so the UI never offers a move the API would 409, and a module
//     that reached for pg could not be copied across a repo boundary.
//   - `src/lifecycle/registry.js` imports `DELETABLE_SAMPLE_ORDER_STATUSES` for
//     the sample-order delete guard. The registry is imported by
//     `src/lifecycle/archive.js`, which `sample-orders.js` imports in turn, so
//     the machine had to live in a LEAF module or the three would form a cycle
//     and the registry's import-time validation would run against a
//     half-initialised module.
//   - It unit-tests with no database at all.
//
// THE MACHINE IS NOT IN THE SCHEMA, and cannot be. A CHECK constraint sees one
// row at a time and cannot see which state a row is moving FROM, so
// `sample_orders_status_check` holds the vocabulary and this module holds the
// transitions. `test/samples-order-lifecycle.test.js` parses the live constraint
// and asserts the two agree on the vocabulary, so widening one without the other
// fails rather than drifting.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * The vocabulary `sample_orders_status_check` holds. Exported so a route spends
 * it as a schema enum instead of keeping its own copy.
 */
export const SAMPLE_ORDER_STATUSES = Object.freeze([
  'requested',
  'ordered',
  'in_transit',
  'received',
  'displayed',
  'cancelled',
])

/** Every order starts here; a create may not choose another state (see below). */
export const INITIAL_SAMPLE_ORDER_STATUS = 'requested'

/**
 * The legal moves, keyed by the state being moved FROM.
 *
 * The spine is linear — a house is asked, it accepts, it ships, it arrives, it
 * goes on the shelf — and `cancelled` is reachable from anywhere short of a
 * terminal state, because a showroom may give up on a request at any point
 * before the material is standing in it. `displayed` and `cancelled` are
 * terminal: an order that reached the shelf has nothing left to do, and one that
 * was abandoned is re-raised as a new request rather than resurrected (which
 * would leave `cancelled_at` stamped on a live order and make the six stamps
 * lie).
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  requested: Object.freeze(['ordered', 'cancelled']),
  ordered: Object.freeze(['in_transit', 'cancelled']),
  in_transit: Object.freeze(['received', 'cancelled']),
  received: Object.freeze(['displayed', 'cancelled']),
  displayed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/**
 * The column each state stamps when it is reached. One per transition is the
 * table's reason to exist: `status` answers "where is it now" and the stamps
 * answer "when did it move", which is what a showroom chasing a house asks.
 */
export const STATUS_STAMPS = Object.freeze({
  requested: 'requested_at',
  ordered: 'ordered_at',
  in_transit: 'in_transit_at',
  received: 'received_at',
  displayed: 'displayed_at',
  cancelled: 'cancelled_at',
})

/**
 * The states a hard delete is still allowed from — the delete policy's
 * "409 unless requested or cancelled".
 *
 * An order that was actually placed with a house is a commercial record: money
 * may have been spent and the house was asked for something. A request nobody
 * acted on, and one that was abandoned before anybody did, are the two states
 * where nothing happened, so removing the row destroys nothing. Everything else
 * archives instead — which is why `sample_orders.archived_at` exists.
 */
export const DELETABLE_SAMPLE_ORDER_STATUSES = Object.freeze(['requested', 'cancelled'])

/**
 * The inverse map: which states may move TO each target. DERIVED from
 * ALLOWED_TRANSITIONS rather than typed a second time, so the two can never
 * disagree about a move.
 */
export const SOURCE_STATUSES = Object.freeze(
  Object.fromEntries(
    SAMPLE_ORDER_STATUSES.map((target) => [
      target,
      Object.freeze(
        SAMPLE_ORDER_STATUSES.filter((from) => ALLOWED_TRANSITIONS[from].includes(target))
      ),
    ])
  )
)

// Validated at module load, the same posture as `assertEntity` in
// src/lifecycle/registry.js: a machine that named a state the CHECK does not
// hold would surface as a 23514 thousands of rows away from the typo.
const assertMachine = () => {
  const known = new Set(SAMPLE_ORDER_STATUSES)
  for (const status of SAMPLE_ORDER_STATUSES) {
    if (!Array.isArray(ALLOWED_TRANSITIONS[status])) {
      throw new Error(`Sample-order status "${status}" declares no transitions.`)
    }
    if (typeof STATUS_STAMPS[status] !== 'string') {
      throw new Error(`Sample-order status "${status}" declares no timestamp column.`)
    }
    for (const target of ALLOWED_TRANSITIONS[status]) {
      if (!known.has(target)) {
        throw new Error(`Sample-order status "${status}" may move to unknown state "${target}".`)
      }
      if (target === status) {
        throw new Error(`Sample-order status "${status}" may not move to itself.`)
      }
    }
  }
  for (const status of DELETABLE_SAMPLE_ORDER_STATUSES) {
    if (!known.has(status)) {
      throw new Error(`Deletable sample-order status "${status}" is not in the vocabulary.`)
    }
  }
}
assertMachine()

/**
 * Refuse an action the row's current state does not allow, with a 409.
 *
 * Mirrors the private `requireStatus` in src/orders/admin-orders.js — same
 * signature, same status, same message shape — because staff read both refusals
 * in the same CRM and a second dialect would be gratuitous. It is exported here
 * (and private there) because this module is the one the CRM mirrors.
 *
 * @param {{ status: string }} order
 * @param {string|string[]} allowed
 * @param {string} action  phrased to follow "Cannot …", e.g. 'move to "ordered"'
 */
export const requireStatus = (order, allowed, action) => {
  const set = Array.isArray(allowed) ? allowed : [allowed]
  if (!set.includes(order.status)) {
    throw httpError(
      409,
      `Cannot ${action} a sample order in status "${order.status}".`
    )
  }
}

/**
 * Refuse a move the machine does not allow. The allowed FROM states come from
 * `SOURCE_STATUSES`, so a target nothing may reach (a terminal state named as a
 * destination from the wrong place) refuses with the same 409 rather than a
 * silent success.
 *
 * @param {{ status: string }} order
 * @param {string} target
 */
export const requireTransition = (order, target) => {
  requireStatus(order, SOURCE_STATUSES[target] ?? [], `move to "${target}"`)
}

/**
 * Whether a hard delete is still allowed from this state. The registry's guard
 * is the enforcement; this is the predicate behind it, shared so the CRM can
 * grey the button out rather than discovering the 409.
 *
 * @param {string} status
 * @returns {boolean}
 */
export const isDeletableStatus = (status) =>
  DELETABLE_SAMPLE_ORDER_STATUSES.includes(status)
