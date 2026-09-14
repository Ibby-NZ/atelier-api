// The human order number, one shape for every channel that opens an order.
//
// `<PREFIX>-<8 upper-cased hex from a UUID>`: short enough to read down a phone
// line, unique enough that nothing has to check. Prefixes in use: `REQ` (order
// request), `BO` (backorder request), `SO` (back-office manual order) and `WEB`
// (card checkout).
//
// Card checkout used to be `WEB-${stripe_session_id}` — seventy characters of
// Stripe internals on the client's success page, in their receipt and in the
// back-office alert. That was never what made the webhook idempotent: the
// `webhook_events` ledger keys on the Stripe EVENT id and its claim commits in
// the same transaction as the order (`src/webhooks/CLAUDE.md`), so a replay
// creates nothing whatever the order number says. The number is free to be
// readable, and a retry that rolls back never reaches the INSERT.

import { randomUUID } from 'node:crypto'

/**
 * @param {string} prefix channel prefix, e.g. 'WEB'
 * @returns {string} e.g. 'WEB-9F3A21BC'
 */
export const orderNumber = (prefix) =>
  `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`
