// The purchase-order state machine, and the DERIVED receipt state beside it.
//
// THIS MODULE IS PURE AND IMPORTS NOTHING, deliberately, for the three reasons
// `src/samples/sample-order-states.js` and `src/orders/order-states.js` already
// state:
//   - the CRM mirrors it (W13-US-009/US-010), so staff are never offered a move
//     the API would 409, and a module that reached for pg could not be copied
//     across a repo boundary;
//   - anything `src/lifecycle/registry.js` might later need from here has to
//     come from a LEAF, or registry -> purchasing -> lifecycle/archive ->
//     registry is a cycle and the registry's import-time validation would run
//     against a half-initialised module;
//   - it unit-tests with no database at all.
//
// TWO VOCABULARIES LIVE HERE AND THEY MUST NEVER BE MERGED.
//
// `status` is WHAT A PERSON DID (24 Sep 2026: draft, pending_payment, paid,
// awaiting_delivery, received, completed, cancelled; ready_to_send joined on
// 25 Sep 2026) — with two moves the
// platform makes for them: the Xero bill paid moves an order to `paid`, and the
// last line booked in full moves it to `received`.
// The receipt state is WHAT ARRIVED: none, part, full, over — arithmetic over
// the append-only receipt ledger, computed at read time and stored nowhere.
//
// **`completed` is not `full`.** A purchase order completed short because the house
// discontinued the balance is a decision somebody made; a purchase order that is
// `full` is a fact about a warehouse. Storing the second as a status gives two
// answers to one question the first time they disagree, which is the ordinary
// case rather than the exotic one.
//
// THE MACHINE IS NOT IN THE SCHEMA and cannot be: a CHECK sees one row at a time
// and cannot see which state a row is moving FROM, so
// `purchase_orders_status_check` holds the vocabulary and this module holds the
// transitions. `test/purchasing.test.js` parses the live constraint and asserts
// the two agree on the vocabulary, so widening one without the other fails
// rather than drifting.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * The vocabulary `purchase_orders_status_check` holds. Exported so a route
 * spends it as a schema enum instead of keeping its own copy.
 */
export const PURCHASE_ORDER_STATUSES = Object.freeze([
  'draft',
  'ready_to_send',
  'pending_payment',
  'paid',
  'awaiting_delivery',
  'received',
  'completed',
  'cancelled',
])

/** Every purchase order starts here; a create may not choose another state. */
export const INITIAL_PURCHASE_ORDER_STATUS = 'draft'

/**
 * The states in which nothing has gone to the house yet. A letter about the
 * order (the Emails panel) is refused in either: Send PO is what first sends
 * it, and a letter that went early is not recallable.
 */
export const UNSENT_PURCHASE_ORDER_STATUSES = Object.freeze(['draft', 'ready_to_send'])

/**
 * The one state a Bulk purchase order takes its members from (25 Sep 2026). A
 * draft is still being written; marking it Ready to send is the office saying
 * "this can go to the house with the others".
 */
export const BULKABLE_PURCHASE_ORDER_STATUS = 'ready_to_send'

/**
 * The legal moves, keyed by the state being moved FROM (24 Sep 2026).
 *
 * `draft → ready_to_send` (25 Sep 2026) is the office saying the order is
 * finished and may go to the house — on its own, or in a Bulk purchase order
 * with others for the same supplier; `ready_to_send → draft` takes it back for
 * more work. Neither move sends anything.
 *
 * `draft | ready_to_send → pending_payment` is **Send PO**: the purchase order goes to the
 * house and its bill is raised in Xero, so from then on it is waiting to be
 * paid. Goods may arrive before the house is paid (a supplier on account), so
 * `received` is reachable before `paid` and `received → paid` closes that gap;
 * `awaiting_delivery` is the house confirmed and the goods are on their way.
 * `completed` is the office finishing with it — full, or SHORT by decision,
 * which is why it is not the receipt state `full`. `cancelled` is reachable
 * only before money has left (draft, ready_to_send, pending_payment): money that has left is
 * a credit note, and nobody has stated that document. Both terminal states are
 * dead ends — a cancelled order is re-raised, never resurrected.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['ready_to_send', 'pending_payment', 'cancelled']),
  ready_to_send: Object.freeze(['draft', 'pending_payment', 'cancelled']),
  pending_payment: Object.freeze(['paid', 'awaiting_delivery', 'received', 'cancelled']),
  paid: Object.freeze(['awaiting_delivery', 'received', 'completed']),
  awaiting_delivery: Object.freeze(['paid', 'received', 'completed']),
  received: Object.freeze(['paid', 'completed']),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
})

/** Whether the machine allows `from → to`. */
export const canTransition = (from, to) => (ALLOWED_TRANSITIONS[from] ?? []).includes(to)

/**
 * The column each state stamps when it is reached. `draft` has none — it is the
 * state a row is created in, and `created_at` already dates that; inventing a
 * `drafted_at` beside it would be two columns holding one fact. A ready order
 * taken back to draft therefore writes no stamp, and keeps the `ready_at` of
 * the last time it was marked ready.
 *
 * One stamp per move is the reason these columns exist at all: `status` answers
 * "where is it now" and the stamps answer "when did it move", which is what an
 * office chasing a house actually asks. A single `status_changed_at` is
 * overwritten by the next move and loses every earlier one.
 */
export const STATUS_STAMPS = Object.freeze({
  draft: null,
  ready_to_send: 'ready_at',
  // The send moment keeps its column; `completed` keeps `closed_at` for the
  // same reason — renaming them would be a migration for a word.
  pending_payment: 'sent_at',
  paid: 'paid_at',
  awaiting_delivery: 'awaiting_delivery_at',
  received: 'received_at',
  completed: 'closed_at',
  cancelled: 'cancelled_at',
})

/**
 * The states from which cancelling still releases allocations, i.e. the states
 * in which this purchase order is still holding a claim on sales-order lines.
 * Derived from the machine rather than re-typed.
 */
export const LIVE_PURCHASE_ORDER_STATUSES = Object.freeze(
  PURCHASE_ORDER_STATUSES.filter((status) => ALLOWED_TRANSITIONS[status].length > 0)
)

/**
 * The inverse map: which states may move TO each target. DERIVED from
 * ALLOWED_TRANSITIONS rather than typed a second time, so the two can never
 * disagree about a move.
 */
export const SOURCE_STATUSES = Object.freeze(
  Object.fromEntries(
    PURCHASE_ORDER_STATUSES.map((target) => [
      target,
      Object.freeze(
        PURCHASE_ORDER_STATUSES.filter((from) => ALLOWED_TRANSITIONS[from].includes(target))
      ),
    ])
  )
)

/**
 * The receipt vocabulary. DERIVED at read time from the receipt ledger and
 * stored nowhere — there is no `qty_received` column on `purchase_order_lines`
 * and there must never be one.
 *
 * `over` is a first-class member rather than an error: suppliers over-ship
 * rolls, a receipt of 42 against an order of 40 is a fact about the warehouse,
 * and clamping it destroys exactly the discrepancy the office needs to see.
 */
export const RECEIPT_STATES = Object.freeze(['none', 'part', 'full', 'over'])

/**
 * One line's receipt state.
 *
 * `received` is the SIGNED sum of the ledger, so a fully reversed line nets back
 * to zero and reads `none` again — which is the point of correcting by a
 * negative row rather than by an edit. A net-negative sum (more reversed than
 * ever arrived) is also `none`: it is a data problem the ledger displays row by
 * row, and inventing a fifth state for it would put arithmetic nobody asked for
 * in front of every reader.
 *
 * @param {number} ordered
 * @param {number} received
 * @returns {'none'|'part'|'full'|'over'}
 */
export const receiptState = (ordered, received) => {
  if (!(received > 0)) return 'none'
  if (received > ordered) return 'over'
  if (received >= ordered) return 'full'
  return 'part'
}

/**
 * A whole purchase order's receipt state, rolled up from its lines.
 *
 * It is NOT `receiptState(sum(ordered), sum(received))`: 10 received against a
 * 5+5 order sums to "full" while one line is over and the other is empty, which
 * is the one thing the office needs to see. So the roll-up is over the line
 * states — any line over makes the order over, every line full makes it full,
 * anything else in between is part, and an order with no lines has received
 * nothing.
 *
 * @param {ReadonlyArray<string>} states
 * @returns {'none'|'part'|'full'|'over'}
 */
export const rollUpReceiptState = (states) => {
  if (!Array.isArray(states) || states.length === 0) return 'none'
  if (states.includes('over')) return 'over'
  if (states.every((state) => state === 'full')) return 'full'
  if (states.every((state) => state === 'none')) return 'none'
  return 'part'
}

// Validated at module load, the same posture as `assertEntity` in
// src/lifecycle/registry.js and `assertMachine` in sample-order-states.js: a
// machine naming a state the CHECK does not hold would surface as a 23514
// thousands of rows away from the typo.
const assertMachine = () => {
  const known = new Set(PURCHASE_ORDER_STATUSES)
  for (const status of PURCHASE_ORDER_STATUSES) {
    if (!Array.isArray(ALLOWED_TRANSITIONS[status])) {
      throw new Error(`Purchase-order status "${status}" declares no transitions.`)
    }
    if (!Object.hasOwn(STATUS_STAMPS, status)) {
      throw new Error(`Purchase-order status "${status}" declares no timestamp column.`)
    }
    const stamp = STATUS_STAMPS[status]
    if (stamp !== null && typeof stamp !== 'string') {
      throw new Error(`Purchase-order status "${status}" has a malformed timestamp column.`)
    }
    for (const target of ALLOWED_TRANSITIONS[status]) {
      if (!known.has(target)) {
        throw new Error(
          `Purchase-order status "${status}" may move to unknown state "${target}".`
        )
      }
      if (target === status) {
        throw new Error(`Purchase-order status "${status}" may not move to itself.`)
      }
    }
  }
  if (!known.has(INITIAL_PURCHASE_ORDER_STATUS)) {
    throw new Error('The initial purchase-order status is not in the vocabulary.')
  }
  // The initial state is the only one allowed to have no stamp: every other
  // state is REACHED, and a move that writes no date is a move nobody can find.
  for (const status of PURCHASE_ORDER_STATUSES) {
    if (STATUS_STAMPS[status] === null && status !== INITIAL_PURCHASE_ORDER_STATUS) {
      throw new Error(`Purchase-order status "${status}" is reachable but dates nothing.`)
    }
  }
}
assertMachine()

/**
 * Refuse an action the row's current state does not allow, with a 409. Same
 * signature, status and message shape as the private `requireStatus` in
 * src/orders/admin-orders.js and the exported one in sample-order-states.js —
 * staff read all three refusals in the same CRM.
 *
 * @param {{ status: string }} purchaseOrder
 * @param {string|string[]} allowed
 * @param {string} action  phrased to follow "Cannot …", e.g. 'send'
 */
export const requireStatus = (purchaseOrder, allowed, action) => {
  const set = Array.isArray(allowed) ? allowed : [allowed]
  if (!set.includes(purchaseOrder.status)) {
    throw httpError(
      409,
      `Cannot ${action} a purchase order in status "${purchaseOrder.status}".`
    )
  }
}

/**
 * Refuse a move the machine does not allow. The allowed FROM states come from
 * `SOURCE_STATUSES`, so a target nothing may reach refuses with the same 409
 * rather than succeeding silently.
 *
 * @param {{ status: string }} purchaseOrder
 * @param {string} target
 */
export const requireTransition = (purchaseOrder, target) => {
  requireStatus(purchaseOrder, SOURCE_STATUSES[target] ?? [], `move to "${target}"`)
}
