// The sales-order state machine: the status vocabulary, the legal moves, which
// kinds reserve stock, and the status sets every other rule is phrased in.
//
// THIS MODULE IS PURE AND IMPORTS NOTHING, deliberately, for the same three
// reasons `src/samples/sample-order-states.js` does:
//   - `src/lifecycle/registry.js` imports it for the order delete guard and the
//     reservation release. The registry is imported by `src/lifecycle/archive.js`,
//     which `src/orders/admin-orders.js` imports in turn, so these rules had to
//     live in a LEAF module or the three would form a cycle and the registry's
//     import-time validation would run against a half-initialised module.
//   - The CRM mirrors it (`atelier-crm/src/admin/orderFlow.js`) so staff are
//     only ever offered the moves the API will take.
//   - It unit-tests with no database at all.
//
// `RESERVING_KINDS` lived in admin-orders.js until the delete story needed it
// here; that module now imports it, so there is one source of truth rather than
// two copies that could disagree about whether a manual order holds stock.
// `ORDER_STATUSES` moved here with the 24 Sep 2026 overhaul for the same reason;
// admin-orders.js re-exports it for its existing importers.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * The vocabulary `orders_status_check` holds, in lifecycle order (the CRM's
 * dropdown and filters list them in this order). `test/order-states.test.js`
 * parses the live constraint and asserts the two agree.
 */
export const ORDER_STATUSES = Object.freeze([
  'quote_requested',
  'quote_sent',
  'quote_accepted',
  'quote_rejected',
  'back_order',
  'processing',
  'pending_payment',
  'paid',
  'shipped',
  'completed',
  'cancelled',
  'refunded',
])

/**
 * The legal moves, keyed by the state being moved FROM. The CRM offers every
 * target in a dropdown; the API refuses anything not listed here (409).
 *
 * The quote half is optional on purpose: an order taken over the phone skips
 * straight to `processing` or `pending_payment`, and `back_order` is reachable
 * before quoting because a purchase order may be raised the moment the office
 * sees the stock is short. `quote_sent → quote_requested` is a re-price; a
 * rejected quote is re-quoted or given up on. `back_order`, `processing` and
 * `pending_payment` move freely among themselves — the office juggles stock and
 * invoicing in whichever order the job demands. Once paid, the order only moves
 * forward (ship, complete) or is refunded; `cancelled` and `refunded` are dead
 * ends — a cancelled order is re-raised as a new one, never resurrected.
 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  quote_requested: Object.freeze([
    'quote_sent',
    'back_order',
    'processing',
    'pending_payment',
    'cancelled',
  ]),
  quote_sent: Object.freeze([
    'quote_accepted',
    'quote_rejected',
    'quote_requested',
    'back_order',
    'cancelled',
  ]),
  quote_accepted: Object.freeze(['back_order', 'processing', 'pending_payment', 'cancelled']),
  quote_rejected: Object.freeze(['quote_sent', 'cancelled']),
  back_order: Object.freeze(['processing', 'pending_payment', 'paid', 'cancelled']),
  processing: Object.freeze(['back_order', 'pending_payment', 'paid', 'cancelled']),
  pending_payment: Object.freeze(['paid', 'back_order', 'processing', 'cancelled']),
  paid: Object.freeze(['shipped', 'refunded']),
  shipped: Object.freeze(['completed', 'refunded']),
  completed: Object.freeze(['refunded']),
  cancelled: Object.freeze([]),
  refunded: Object.freeze([]),
})

/** @param {string} from @param {string} to */
export const canTransition = (from, to) =>
  (ALLOWED_TRANSITIONS[from] ?? []).includes(to)

/**
 * Throw the 409 for a move the machine does not allow. The CRM prints API
 * messages verbatim, so the sentence names both ends.
 *
 * @param {{ status: string }} order
 * @param {string} to
 */
export const requireTransition = (order, to) => {
  if (!canTransition(order.status, to)) {
    throw httpError(409, `Cannot move an order from "${order.status}" to "${to}".`)
  }
}

/**
 * The statuses an order may not ENTER while any line is still at $0.00 (422 —
 * see `unpricedLineCount`): a quote that goes out, an invoice the client is
 * asked to pay, and money received all state a price.
 */
export const PRICED_ENTRY_STATUSES = Object.freeze(['quote_sent', 'pending_payment', 'paid'])

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
 * The states in which a reserving order's demand is STILL SITTING in
 * `inventory.qty_reserved` — every status but the four that settled it.
 *
 * `shipped` converted the reservation into a real decrement (and `completed`
 * and a post-ship `refunded` follow it); `cancelled` and a pre-ship `refunded`
 * released it. Releasing again would hand back stock twice and inflate
 * availability, silently — this is the predicate that stops that.
 *
 * A rejected quote still HOLDS, deliberately: the office either re-quotes it or
 * cancels it, and cancelling is the one place its stock is handed back.
 */
export const HELD_STATUSES = Object.freeze(
  ORDER_STATUSES.filter(
    (status) => !['shipped', 'completed', 'cancelled', 'refunded'].includes(status)
  )
)

/**
 * The states a hard delete is still allowed from: every held state but `paid`
 * (money has moved), plus `cancelled` — a refusal whose reservation was already
 * handed back and that nothing downstream reads. Shipped, completed and
 * refunded orders archive instead.
 *
 * Kind and the Xero invoice matter as well as status and are checked in
 * `isDeletableOrder`: a `checkout` order carries a Stripe session id and is a
 * payment record whatever its status.
 */
export const DELETABLE_ORDER_STATUSES = Object.freeze([
  ...HELD_STATUSES.filter((status) => status !== 'paid'),
  'cancelled',
])

/**
 * The states whose order the office may push to Xero as an invoice (and the
 * not-invoiced report's population). A quote the client has not accepted is not
 * awaiting an invoice; a cancelled or refunded order never will be.
 */
export const INVOICEABLE_STATUSES = Object.freeze([
  'quote_accepted',
  'back_order',
  'processing',
  'pending_payment',
  'paid',
  'shipped',
  'completed',
])

/**
 * Lines and money are editable while the order still holds its reservation and
 * nobody has paid it — the posture `confirmed` had before the overhaul.
 */
export const LINE_EDIT_STATUSES = Object.freeze(
  HELD_STATUSES.filter((status) => status !== 'paid')
)

/**
 * Where the cloth goes can change until it has gone: a client paying up front
 * and then asking for delivery to the upholsterer is ordinary, and the packing
 * slip prints from this address.
 */
export const DELIVERY_EDIT_STATUSES = HELD_STATUSES

/**
 * Whether a hard delete is allowed at all. The registry's guard is the
 * enforcement; this is the predicate behind it, shared so the CRM can hide the
 * button rather than discovering the 409.
 *
 * An order with an invoice in Xero is refused whatever its status: `cancelled`
 * is reachable after the invoice went out (from `pending_payment`), and an
 * invoiced order is a financial record.
 *
 * @param {{ kind: string, status: string, xero_invoice_id?: string|null }} order
 * @returns {boolean}
 */
export const isDeletableOrder = (order) =>
  order?.kind !== 'checkout' &&
  DELETABLE_ORDER_STATUSES.includes(order?.status) &&
  order?.xero_invoice_id == null

/**
 * Whether deleting, cancelling or refunding this order must release its
 * reservation first.
 *
 * @param {{ kind: string, status: string }} order
 * @returns {boolean}
 */
export const holdsReservation = (order) =>
  reserves(order?.kind) && HELD_STATUSES.includes(order?.status)

/**
 * The reservation a reserving order currently holds against inventory:
 *   held      -> qty_reserved still carries this order's demand
 *   converted -> reservation turned into a real stock decrement (shipped)
 *   released  -> reservation handed back (cancelled, refunded)
 *   none      -> non-reserving kind (checkout)
 *
 * @param {string} kind
 * @param {string} status
 */
export const reservationState = (kind, status) => {
  if (!reserves(kind)) return 'none'
  if (status === 'shipped' || status === 'completed') return 'converted'
  // ponytail: refunded-after-ship reads "released"; add a stock_settled column if the label ever matters
  if (status === 'cancelled' || status === 'refunded') return 'released'
  return 'held'
}

/**
 * How many of an order's lines are still at $0.00.
 *
 * A storefront request arrives with every line at 0 — "not priced yet", not
 * "free" — and the office prices it on the order desk. Entering any of
 * `PRICED_ENTRY_STATUSES` and the Xero push all refuse while this is non-zero,
 * from this ONE predicate, so they cannot disagree; the CRM mirrors it to warn
 * before the 422. pg hands `unit_price_cents` back as a number, but `Number()`
 * keeps the string form honest too.
 *
 * @param {Array<{ unit_price_cents: number|string }>|null|undefined} lines
 * @returns {number}
 */
export const unpricedLineCount = (lines) =>
  (lines ?? []).filter((line) => Number(line.unit_price_cents) === 0).length
