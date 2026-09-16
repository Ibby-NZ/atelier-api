// The sample-request lifecycle — a pure, zero-import leaf, the
// `sample-order-states.js` posture: `src/lifecycle/registry.js` imports it for
// the delete guard, the CRM mirrors it so a move is never offered where the API
// would 409, and it unit-tests with no database.
//
// Three states and two moves. `pending` is the storefront's landing state and
// the office's queue; `sent` means the cuttings went out; `declined` is the
// office answering no. Both are terminal.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

export const SAMPLE_REQUEST_STATUSES = Object.freeze(['pending', 'sent', 'declined'])
export const INITIAL_SAMPLE_REQUEST_STATUS = 'pending'

export const ALLOWED_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['sent', 'declined']),
  sent: Object.freeze([]),
  declined: Object.freeze([]),
})

export const STATUS_STAMPS = Object.freeze({
  sent: 'sent_at',
  declined: 'declined_at',
})

// A request the office has acted on is a record of what went out; only one
// nobody has touched, or one already refused, may be deleted outright.
export const DELETABLE_SAMPLE_REQUEST_STATUSES = Object.freeze(['pending', 'declined'])

/**
 * Refuse a move the machine does not allow, with the 409 the CRM renders.
 *
 * @param {string} from
 * @param {string} to
 */
export const assertTransition = (from, to) => {
  if (!SAMPLE_REQUEST_STATUSES.includes(to)) {
    throw httpError(400, `"${to}" is not a sample request status.`)
  }
  if (!(ALLOWED_TRANSITIONS[from] ?? []).includes(to)) {
    throw httpError(409, `A "${from}" sample request cannot move to "${to}".`)
  }
}
