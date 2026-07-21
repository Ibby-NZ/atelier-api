// The only columns ever selected into a response. Single source of truth so
// password_hash can never leak through a drifted copy of this list.
export const PUBLIC_USER_COLUMNS = 'id, email, name, role, trade_approved'
