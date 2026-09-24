// The link a `quote_sent` letter carries, so a client — guest or not — can
// accept or reject the quote from the storefront without signing in. The raw
// token lives only in the email; `orders.quote_token_hash` holds its SHA-256,
// so a database read is not a way to answer somebody's quote (the
// password-reset posture, src/auth/password-reset.js).
//
// Rotated on every send: the office re-quoting a rejected order mails a new
// link and the old one stops matching. There is no expiry — the status gate is
// what closes the link (accept/reject only answer at `quote_sent`), and the
// token is 256 bits.
// ponytail: no TTL; add quote_token_expires_at if the office asks for quotes to lapse.
import { createHash, randomBytes } from 'node:crypto'

export const hashQuoteToken = (token) => createHash('sha256').update(token).digest('hex')

/**
 * Issue (or replace) the quote token for an order. Returns the RAW token — the
 * only time it exists outside the email.
 *
 * @param {import('pg').Pool} pool
 * @param {number} orderId
 * @returns {Promise<string>}
 */
export const issueQuoteToken = async (pool, orderId) => {
  const token = randomBytes(32).toString('base64url')
  await pool.query(`UPDATE orders SET quote_token_hash = $2 WHERE id = $1`, [
    orderId,
    hashQuoteToken(token),
  ])
  return token
}

/** Where the letter's link lands: the storefront's quote page. */
export const quoteUrlFor = ({ token, storeBaseUrl }) =>
  `${storeBaseUrl}/quote?token=${token}`
