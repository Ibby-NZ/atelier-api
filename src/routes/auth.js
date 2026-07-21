import { hashPassword, verifyPassword, getDummyHash } from '../auth/passwords.js'
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionUserId,
} from '../auth/session.js'

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

const PUBLIC_USER_COLUMNS = 'id, email, name, role, trade_approved'

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

export const authRoutes = async (app, { pool }) => {
  app.post(
    '/auth/register',
    {
      schema: { body: registerBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) => {
      const { email, password, name } = request.body
      const passwordHash = await hashPassword(password)

      try {
        const { rows } = await pool.query(
          `INSERT INTO users (email, password_hash, name, role)
           VALUES ($1, $2, $3, 'customer')
           RETURNING ${PUBLIC_USER_COLUMNS}`,
          [email.toLowerCase(), passwordHash, name ?? null]
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
  )

  app.post(
    '/auth/login',
    {
      schema: { body: loginBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) => {
      const { email, password } = request.body
      const { rows } = await pool.query(
        `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users WHERE email = $1`,
        [email.toLowerCase()]
      )
      const row = rows[0]

      const passwordHash = row ? row.password_hash : await getDummyHash()
      const passwordOk = await verifyPassword(passwordHash, password)
      if (!row || !passwordOk) {
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
      `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`,
      [userId]
    )
    if (!rows[0]) {
      clearSessionCookie(reply)
      reply.code(401)
      return { error: 'Not logged in.' }
    }
    return { user: rows[0] }
  })
}
