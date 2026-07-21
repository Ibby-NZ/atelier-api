import { readSessionUserId } from './session.js'
import { PUBLIC_USER_COLUMNS } from './user-columns.js'

// Which stored roles satisfy a given requireRole() check. Director is the
// superset of backoffice; trade is only trade (approval handled separately).
const GRANTING_ROLES = Object.freeze({
  customer: Object.freeze(['customer', 'trade', 'backoffice', 'director']),
  trade: Object.freeze(['trade']),
  backoffice: Object.freeze(['backoffice', 'director']),
  director: Object.freeze(['director']),
})

// An unapproved trade account has no trade capability: it acts as a customer
// until the back office flips trade_approved.
export const effectiveRole = (user) =>
  user.role === 'trade' && !user.trade_approved ? 'customer' : user.role

export const createGuards = (pool) => {
  const loadSessionUser = async (request) => {
    const userId = readSessionUserId(request)
    if (!userId) {
      return null
    }
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`,
      [userId]
    )
    return rows[0] ?? null
  }

  const requireAuth = async (request, reply) => {
    const user = await loadSessionUser(request)
    if (!user) {
      return reply.code(401).send({ error: 'Authentication required.' })
    }
    request.user = user
  }

  const requireRole = (role) => {
    // Object.hasOwn: a plain [role] lookup would accept prototype keys like
    // 'constructor' and skip this registration-time guard.
    if (!Object.hasOwn(GRANTING_ROLES, role)) {
      throw new Error(`requireRole: unknown role "${role}"`)
    }
    const grantingRoles = GRANTING_ROLES[role]
    return async (request, reply) => {
      await requireAuth(request, reply)
      if (reply.sent) {
        return
      }
      if (!grantingRoles.includes(effectiveRole(request.user))) {
        return reply.code(403).send({ error: 'Insufficient permissions.' })
      }
    }
  }

  return Object.freeze({ requireAuth, requireRole })
}
