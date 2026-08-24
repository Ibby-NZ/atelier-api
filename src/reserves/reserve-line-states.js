// The reserve-line state machine — vocabulary, transitions, stamps.
//
// PURE AND IMPORTS NOTHING, for the same three reasons sample-order-states.js
// states: the CRM mirrors it verbatim (atelier-crm/src/screens/reserveFlow.js),
// the lifecycle registry imports DELETABLE_RESERVE_LINE_STATUSES for its
// guards, and a leaf module cannot join an import cycle.
//
// The machine is not in the schema and cannot be: `reserve_lines_status_check`
// holds the vocabulary; the transitions live here. test/admin-reserves.test.js
// parses the live CHECK constraint and asserts the two agree.
//
// The states are the office's wish list, not the D365 ones. D365 had In
// Progress / Complete / Inactive, and "you only know whether it arrived by
// reading the notes" was the stated complaint — so In Progress splits into
// requested (entered; the reserve number is still "TBA") and confirmed (the
// house replied with a reference and a hold date), Complete splits into
// arrived (in the warehouse) and dispatched (out to the client), and Inactive
// is cancelled.

export const RESERVE_LINE_STATUSES = Object.freeze([
  'requested',
  'confirmed',
  'arrived',
  'dispatched',
  'cancelled',
])

export const INITIAL_RESERVE_LINE_STATUS = 'requested'

// requested → arrived is deliberate: goods turn up that nobody marked
// confirmed, and refusing the truth teaches staff to falsify the middle step.
// Nothing moves out of `arrived` except dispatch — material in the warehouse
// is past cancelling; a client who no longer wants it is a stock decision, not
// a lifecycle one.
export const ALLOWED_TRANSITIONS = Object.freeze({
  requested: Object.freeze(['confirmed', 'arrived', 'cancelled']),
  confirmed: Object.freeze(['arrived', 'cancelled']),
  arrived: Object.freeze(['dispatched']),
  dispatched: Object.freeze([]),
  cancelled: Object.freeze([]),
})

// One timestamp column per state, so a NULL reads as "has never been there"
// without consulting `status`. `requested_at` is written by the create.
export const STATUS_STAMPS = Object.freeze({
  requested: 'requested_at',
  confirmed: 'confirmed_at',
  arrived: 'arrived_at',
  dispatched: 'dispatched_at',
  cancelled: 'cancelled_at',
})

// The registry's guard: a line that reached the house is a record of material
// Atelier asked for, and loses its meaning if it can vanish. Cancel first is
// the honest path; delete exists for keying mistakes.
export const DELETABLE_RESERVE_LINE_STATUSES = Object.freeze(['requested', 'cancelled'])

// The CFA vocabulary ("cutting for approval") the houses reply to — carried
// over from D365 unchanged, because the suppliers' side of the conversation
// still speaks it. Lifecycle-independent: a confirmed reserve can have its CFA
// still in the post.
export const CFA_STATES = Object.freeze([
  'not_required',
  'required',
  'ordered',
  'received',
  'approved',
])

export const RESERVE_LINE_KINDS = Object.freeze(['reserve', 'cutting'])

// Derived, never re-typed: the sources for each target. requireTransition
// reads this so its 409 names the states a move IS legal from.
export const SOURCE_STATUSES = Object.freeze(
  Object.fromEntries(
    RESERVE_LINE_STATUSES.map((target) => [
      target,
      Object.freeze(
        RESERVE_LINE_STATUSES.filter((from) => ALLOWED_TRANSITIONS[from].includes(target))
      ),
    ])
  )
)

// Fail at import time, not at the first request: every target known, no
// self-move, terminals empty, deletables inside the vocabulary, one stamp per
// state. Same posture as sample-order-states.js.
const assertMachine = () => {
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    if (!RESERVE_LINE_STATUSES.includes(from)) {
      throw new Error(`reserve-line-states: unknown source status "${from}"`)
    }
    for (const target of targets) {
      if (!RESERVE_LINE_STATUSES.includes(target)) {
        throw new Error(`reserve-line-states: unknown target status "${target}"`)
      }
      if (target === from) {
        throw new Error(`reserve-line-states: self-move declared for "${from}"`)
      }
    }
  }
  for (const status of RESERVE_LINE_STATUSES) {
    if (!Object.hasOwn(ALLOWED_TRANSITIONS, status)) {
      throw new Error(`reserve-line-states: no transition row for "${status}"`)
    }
    if (!Object.hasOwn(STATUS_STAMPS, status)) {
      throw new Error(`reserve-line-states: no stamp column for "${status}"`)
    }
  }
  for (const status of DELETABLE_RESERVE_LINE_STATUSES) {
    if (!RESERVE_LINE_STATUSES.includes(status)) {
      throw new Error(`reserve-line-states: deletable status "${status}" is not in the vocabulary`)
    }
  }
}

assertMachine()

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * 409 unless the line is in one of the allowed states. `action` finishes the
 * sentence: "Cannot <action> a reserve line in status …".
 */
export const requireStatus = (line, allowed, action) => {
  const set = Array.isArray(allowed) ? allowed : [allowed]
  if (!set.includes(line.status)) {
    throw httpError(409, `Cannot ${action} a reserve line in status "${line.status}".`)
  }
}

/**
 * 409 unless the machine allows moving this line to `target` — including a
 * move to the state it is already in.
 */
export const requireTransition = (line, target) => {
  requireStatus(line, SOURCE_STATUSES[target] ?? [], `move to "${target}"`)
}
