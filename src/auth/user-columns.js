// The only columns ever selected into a response. Single source of truth so
// password_hash can never leak through a drifted copy of this list.
export const PUBLIC_USER_COLUMNS = 'id, email, name, role, trade_approved'

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
