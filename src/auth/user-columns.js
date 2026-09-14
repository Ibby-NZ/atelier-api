// The only columns ever selected into a response. Single source of truth so
// password_hash can never leak through a drifted copy of this list.
//
// `phone` is public because it is the account holder's OWN number, and the one
// place it is used is their own form: the storefront's order-request form asked
// for it on every request and forgot it every time, so /auth/me hands it back to
// prefill and `PATCH /auth/me` edits it. Nullable — nothing requires a number.
export const PUBLIC_USER_COLUMNS = 'id, email, name, role, trade_approved, phone'

// Every authentication path must exclude archived accounts. Archiving is a soft
// delete (`users.archived_at`) because orders reference the row, so the account
// is still there to be logged into unless this clause is applied — a "removed"
// client would keep an unexpired session cookie and could log back in with the
// old password. Exported as a constant so the three auth queries (login,
// /auth/me, the session guard) cannot drift apart.
//
// The back-office admin queries deliberately do NOT use this: staff need to
// list, restore and inspect archived accounts.
export const ACTIVE_USER_CONDITION = 'archived_at IS NULL'

// What a session cookie may resolve to: an active account that is NOT a
// pending trade application. A trade account cannot authenticate at all until
// the back office approves it (it used to browse as a customer meanwhile —
// changed so an applicant cannot sign in before review). Login enforces the
// same rule with an explicit check AFTER the argon2 verify so it can answer
// 403 "pending" instead of silently failing; this clause covers the session
// paths (/auth/me and the guards), killing any cookie the moment approval is
// revoked, exactly like archiving.
export const SESSION_USER_CONDITION = `${ACTIVE_USER_CONDITION} AND NOT (role = 'trade' AND trade_approved = false)`

// /auth/me selects ONE column beyond the public projection — `can_view_finance`,
// the fact behind the report access it derives (src/reports/access.js) — and must
// not return it. The payload states what the login may SEE, never the flag behind
// it: two statements of one rule in one body invite a client to read the flag and
// re-derive the rule itself, which is the arrangement `report_access` exists to
// end. Login and register keep PUBLIC_USER_COLUMNS untouched; nothing outside the
// session read has any use for the flag.
export const SESSION_USER_COLUMNS = `${PUBLIC_USER_COLUMNS}, can_view_finance`

// The keys PUBLIC_USER_COLUMNS selects, derived from that list rather than
// retyped, so a column added there becomes a key here with no second edit — the
// same reason the list is a single source of truth in the first place.
const PUBLIC_USER_KEYS = Object.freeze(
  PUBLIC_USER_COLUMNS.split(',').map((column) => column.trim())
)

/**
 * The public shape of a user row, whatever else the query selected beside it.
 * Projection rather than deletion, the posture maskReport takes: a key that was
 * never declared public cannot survive a projection, where a `delete` can only
 * remove what somebody remembered to name.
 *
 * @param {object} row
 * @returns {object}
 */
export const publicUser = (row) =>
  Object.fromEntries(PUBLIC_USER_KEYS.map((key) => [key, row?.[key]]))
