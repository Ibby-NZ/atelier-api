import { getDummyHash, verifyPassword } from '../auth/passwords.js'

// Same staff semantics as guards.requireRole('backoffice'): director inherits.
const PANEL_ROLES = Object.freeze(new Set(['backoffice', 'director']))

// Same timing posture as /auth/login: verify against a dummy hash when the
// email is unknown so the panel login cannot enumerate accounts.
export const createAdminAuthenticate = (pool) => async (email, password) => {
  if (typeof email !== 'string' || typeof password !== 'string') {
    return null
  }

  const { rows } = await pool.query(
    'SELECT id, email, role, password_hash FROM users WHERE email = $1',
    [email.toLowerCase()]
  )
  const user = rows[0] ?? null

  const passwordHash = user ? user.password_hash : await getDummyHash()
  const passwordOk = await verifyPassword(passwordHash, password)
  if (!passwordOk || !user || !PANEL_ROLES.has(user.role)) {
    return null
  }

  return { id: user.id, email: user.email, role: user.role }
}
