// The client's answer to a quote (24 Sep 2026): accept it, or reject it with a
// reason the office re-quotes from. Two ways in, one move: a guest follows the
// signed link in the `quote_sent` letter (src/orders/quote-links.js); a
// signed-in client answers from My Account. Both end in `setOrderStatus`, so
// the machine decides whether the quote can still be answered (409 unless it is
// `quote_sent`) and the answer lands on the audit trail as the client's.

import { setOrderStatus } from './admin-orders.js'
import { hashQuoteToken } from './quote-links.js'

export const REJECTION_REASON_MAX = 2000

/**
 * Field-level 422s for an answer, in the `validateOrderRequestInput` shape
 * (`[{ field, message }]`, empty when fine). A rejection must say why — the
 * reason is what the office re-quotes from; an acceptance needs nothing.
 *
 * @param {{ accept: boolean, reason?: string|null }} answer
 * @returns {Array<{ field: string, message: string }>}
 */
export const validateQuoteAnswer = ({ accept, reason }) => {
  if (accept) return []
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (text === '') {
    return [{ field: 'reason', message: 'Tell us why so we can re-quote.' }]
  }
  if (text.length > REJECTION_REASON_MAX) {
    return [
      { field: 'reason', message: `Keep the reason under ${REJECTION_REASON_MAX} characters.` },
    ]
  }
  return []
}

/**
 * Record the client's answer. Validate first (`validateQuoteAnswer`); this only
 * moves the order. An acceptance ignores any reason sent with it.
 *
 * @param {import('pg').Pool} pool
 * @param {{ orderId: number, accept: boolean, reason?: string|null, userId?: number|null }} answer
 * @returns {Promise<object>} the fresh ADMIN order (for the office's letter)
 */
export const respondToQuote = (pool, { orderId, accept, reason = null, userId = null }) =>
  setOrderStatus(pool, orderId, accept ? 'quote_accepted' : 'quote_rejected', {
    actor: { kind: 'customer', userId },
    note: accept ? null : reason,
  })

/**
 * The order a quote link names, or null for a token that matches nothing (an
 * old link a re-quote rotated away, or a made-up one).
 *
 * @param {import('pg').Pool} pool
 * @param {string} token
 * @returns {Promise<{ id: number, status: string, user_id: number|null }|null>}
 */
export const findOrderByQuoteToken = async (pool, token) => {
  const { rows } = await pool.query(
    `SELECT id, status, user_id FROM orders WHERE quote_token_hash = $1`,
    [hashQuoteToken(token)]
  )
  return rows[0] ?? null
}

/**
 * A signed-in client's own order by its number — ownership in SQL, the
 * `/orders/mine` posture — or null.
 *
 * @param {import('pg').Pool} pool
 * @param {{ userId: number, orderNumber: string }} args
 */
export const findUserOrderByNumber = async (pool, { userId, orderNumber }) => {
  const { rows } = await pool.query(
    `SELECT id, status, user_id FROM orders WHERE user_id = $1 AND order_number = $2`,
    [userId, orderNumber]
  )
  return rows[0] ?? null
}
