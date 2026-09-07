// Password reset by emailed link. Two halves: issue a token for an account
// (forgot-password, or the back office on someone's behalf) and consume it with
// a new password. The raw token lives only in the email; the table holds its
// SHA-256, so a database read is not a sign-in. See the migration's header for
// the one-row-per-account and single-use decisions.
import { createHash, randomBytes } from 'node:crypto'
import { hashPassword } from './passwords.js'
import { ACTIVE_USER_CONDITION, PUBLIC_USER_COLUMNS } from './user-columns.js'

// Long enough to find the email, short enough that a forgotten inbox is not a
// standing door. Surfaced in the letter so the reader knows to act.
export const RESET_TOKEN_TTL_MINUTES = 60

// Where the link lands. Staff reset in the CRM (HashRouter, hence the `#/`);
// everyone else in the storefront. Decided by role rather than by which app
// asked, because the office requests resets for clients from the CRM and the
// client must still land in the store.
const STAFF_ROLES = Object.freeze(['backoffice', 'director'])

export const resetUrlFor = ({ role, token, storeBaseUrl, crmBaseUrl }) =>
  STAFF_ROLES.includes(role)
    ? `${crmBaseUrl}/#/reset-password?token=${token}`
    : `${storeBaseUrl}/reset-password?token=${token}`

const hashToken = (token) => createHash('sha256').update(token).digest('hex')

/**
 * Issue (or replace) the reset token for an account. Returns the RAW token —
 * the only time it exists outside the email.
 */
export const issueResetTokenFor = async (pool, userId) => {
  const token = randomBytes(32).toString('base64url')
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (user_id) DO UPDATE
       SET token_hash = EXCLUDED.token_hash,
           expires_at = EXCLUDED.expires_at,
           created_at = now()`,
    [userId, hashToken(token), RESET_TOKEN_TTL_MINUTES]
  )
  return token
}

/**
 * The forgot-password half: look the address up and issue a token for it.
 * Returns `{ user, token }`, or null when no ACTIVE account carries the
 * address — an unknown or archived email gets no token and no mail, and the
 * route answers identically either way.
 */
export const issueResetToken = async (pool, email) => {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users
      WHERE email = $1 AND ${ACTIVE_USER_CONDITION}`,
    [email.toLowerCase()]
  )
  const user = rows[0]
  if (!user) return null
  return { user, token: await issueResetTokenFor(pool, user.id) }
}

/**
 * Spend a token: set the new password and delete the row in one statement.
 * Returns the public user, or null when the token is unknown, expired, or
 * belongs to an archived account. The unqualified columns in
 * ACTIVE_USER_CONDITION resolve to `users` — the token table has none of them.
 */
export const consumeResetToken = async (pool, token, password) => {
  const passwordHash = await hashPassword(password)
  const { rows } = await pool.query(
    `WITH spent AS (
       DELETE FROM password_reset_tokens t
        USING users u
        WHERE t.token_hash = $1
          AND t.expires_at > now()
          AND u.id = t.user_id
          AND u.${ACTIVE_USER_CONDITION}
        RETURNING t.user_id
     )
     UPDATE users SET password_hash = $2
      WHERE id = (SELECT user_id FROM spent)
      RETURNING ${PUBLIC_USER_COLUMNS}`,
    [hashToken(token), passwordHash]
  )
  return rows[0] ?? null
}
