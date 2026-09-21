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

/**
 * Resolve a house's PO address from the free-text supplier name a reserve line
 * carries.
 *
 * **A reserve line's `supplier` is typed on the docket, not picked from a
 * list** (`reserve_lines.supplier` is plain text, no foreign key) — it is a
 * D365 carry-over and the office types what the client said. So the only way
 * to reach that house by email is to match the text against `suppliers.name`,
 * and the match is deliberately CONSERVATIVE: case-insensitive and
 * whitespace-trimmed, nothing fuzzier. A near-match resolved by guesswork
 * addresses a purchase conversation to the wrong house, which is worse in
 * every case than sending nothing and telling the office so — which is what
 * the null return is for.
 *
 * Archived suppliers are excluded: an archived house is one the office has
 * stopped buying from.
 *
 * @param {{ query: Function }} db  pool or client
 * @param {string|null|undefined} supplierName
 * @returns {Promise<string|null>}
 */
export const resolveSupplierEmail = async (db, supplierName) => {
  const name = typeof supplierName === 'string' ? supplierName.trim() : ''
  if (!name) {
    return null
  }
  const { rows } = await db.query(
    `SELECT po_email FROM suppliers
      WHERE lower(name) = lower($1) AND archived_at IS NULL
      ORDER BY id
      LIMIT 1`,
    [name]
  )
  return rows[0]?.po_email ?? null
}
