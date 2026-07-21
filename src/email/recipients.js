// Resolve the customer email for an order. A guest order carries the address
// directly (guest_email); a logged-in order carries only user_id, so the address
// is looked up from the users table. Returns null when neither is available.

/**
 * @param {{ query: Function }} db  pool or client
 * @param {{ guest_email?: string|null, user_id?: number|null }} order
 * @returns {Promise<string|null>}
 */
export const resolveOrderRecipient = async (db, { guest_email, user_id }) => {
  if (guest_email) {
    return guest_email
  }
  if (!user_id) {
    return null
  }
  const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [user_id])
  return rows[0]?.email ?? null
}
