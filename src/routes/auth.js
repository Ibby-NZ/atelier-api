import { hashPassword, verifyPassword, getDummyHash } from '../auth/passwords.js'
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionUserId,
} from '../auth/session.js'
import { PUBLIC_USER_COLUMNS, ACTIVE_USER_CONDITION } from '../auth/user-columns.js'

const LOGIN_RATE_LIMIT_MAX = 10
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const PG_UNIQUE_VIOLATION = '23505'

// Register is limited too: each attempt runs an argon2 hash (memory-hard, so an
// unthrottled loop is a cheap DoS) and 409s would otherwise enumerate emails.
const AUTH_RATE_LIMIT = Object.freeze({
  max: LOGIN_RATE_LIMIT_MAX,
  timeWindow: LOGIN_RATE_LIMIT_WINDOW_MS,
})

// Fastify's bundled Ajv has no email format, so a pattern stands in.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
const MIN_PASSWORD_LENGTH = 8

const registerBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    password: { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 200 },
    name: { type: 'string', maxLength: 200 },
  },
}

const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', maxLength: 254 },
    password: { type: 'string', maxLength: 200 },
  },
}

const INVALID_CREDENTIALS = 'Invalid email or password.'

// Shared by register (role=customer) and trade-application (role=trade,
// trade_approved defaults false in the schema). Sets the session cookie so
// the new account is immediately logged in.
const createAccount = async ({ pool, reply, body, role }) => {
  const { email, password, name } = body
  const passwordHash = await hashPassword(password)

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${PUBLIC_USER_COLUMNS}`,
      [email.toLowerCase(), passwordHash, name ?? null, role]
    )
    const user = rows[0]
    setSessionCookie(reply, user.id)
    reply.code(201)
    return { user }
  } catch (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      reply.code(409)
      return { error: 'An account with that email already exists.' }
    }
    throw error
  }
}

export const authRoutes = async (app, { pool }) => {
  app.post(
    '/auth/register',
    {
      schema: { body: registerBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) =>
      createAccount({ pool, reply, body: request.body, role: 'customer' })
  )

  // Trade accounts start unapproved: guards treat them as customers until the
  // back office flips trade_approved (US-006 gate).
  app.post(
    '/auth/trade-application',
    {
      schema: { body: registerBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) =>
      createAccount({ pool, reply, body: request.body, role: 'trade' })
  )

  app.post(
    '/auth/login',
    {
      schema: { body: loginBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) => {
      const { email, password } = request.body
      // archived_at is selected rather than filtered in SQL so an archived
      // account still costs a full argon2 verify — filtering it out here would
      // make "archived" measurably faster than "wrong password" and expose the
      // account state, the same reason getDummyHash() exists for unknown emails.
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}, password_hash, archived_at
           FROM users WHERE email = $1`,
        [email.toLowerCase()]
      )
      const row = rows[0]

      const passwordHash = row ? row.password_hash : await getDummyHash()
      const passwordOk = await verifyPassword(passwordHash, password)
      // Archived accounts get the same generic 401: the back office removed
      // them, and saying so would confirm the address is registered.
      if (!row || !passwordOk || row.archived_at) {
        reply.code(401)
        return { error: INVALID_CREDENTIALS }
      }

      const user = {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        trade_approved: row.trade_approved,
      }
      setSessionCookie(reply, user.id)
      return { user }
    }
  )

  app.post('/auth/logout', async (request, reply) => {
    clearSessionCookie(reply)
    reply.code(204)
    return null
  })

  app.get('/auth/me', async (request, reply) => {
    const userId = readSessionUserId(request)
    if (!userId) {
      reply.code(401)
      return { error: 'Not logged in.' }
    }

    const { rows } = await pool.query(
      `SELECT ${PUBLIC_USER_COLUMNS} FROM users
        WHERE id = $1 AND ${ACTIVE_USER_CONDITION}`,
      [userId]
    )
    // Deleted OR archived: either way the session is dead, so drop the cookie.
    if (!rows[0]) {
      clearSessionCookie(reply)
      reply.code(401)
      return { error: 'Not logged in.' }
    }
    return { user: rows[0] }
  })
}
