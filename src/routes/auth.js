import {
  hashPassword,
  verifyPassword,
  getDummyHash,
  MIN_PASSWORD_LENGTH,
} from '../auth/passwords.js'
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionUserId,
} from '../auth/session.js'
import {
  PUBLIC_USER_COLUMNS,
  SESSION_USER_COLUMNS,
  SESSION_USER_CONDITION,
  publicUser,
} from '../auth/user-columns.js'
import { reportAccess } from '../reports/access.js'
import {
  issueResetToken,
  consumeResetToken,
  resetUrlFor,
  RESET_TOKEN_TTL_MINUTES,
} from '../auth/password-reset.js'
import { notifyPasswordReset, notifyTradeApplicationReceived } from '../email/notifications.js'
import { honeypotProperty, honeypotTripped } from '../lib/honeypot.js'
import {
  validateTradeApplication,
  submitTradeApplication,
} from '../users/trade-applications.js'

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

// Trade application = register + the atelier.co.nz trade-account form. The
// schema is structural only (types + max lengths -> 400); required fields and
// formats are checked in the handler so the storefront gets field-level 422s
// (order-request posture). business_type is a plain string here for the same
// reason — the validator names the field instead of a bare enum 400.
const APPLICATION_TEXT = { type: 'string', maxLength: 2000 }
const tradeApplicationBodySchema = {
  type: 'object',
  required: ['email', 'password', 'application'],
  additionalProperties: false,
  properties: {
    ...honeypotProperty,
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    password: { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 200 },
    name: { type: 'string', maxLength: 200 },
    application: {
      type: 'object',
      additionalProperties: false,
      properties: {
        business_name: APPLICATION_TEXT,
        registered_name: APPLICATION_TEXT,
        postal_address: APPLICATION_TEXT,
        delivery_address: APPLICATION_TEXT,
        landline_phone: APPLICATION_TEXT,
        mobile_phone: APPLICATION_TEXT,
        accounts_contact_name: APPLICATION_TEXT,
        accounts_contact_person: APPLICATION_TEXT,
        accounts_email: APPLICATION_TEXT,
        design_contact_name: APPLICATION_TEXT,
        design_contact_email: APPLICATION_TEXT,
        design_contact_phone: APPLICATION_TEXT,
        design_qualifications: APPLICATION_TEXT,
        mailchimp_opt_in: { type: 'boolean' },
        primary_contact_email: APPLICATION_TEXT,
        wants_showroom_visit: { type: 'boolean' },
        wants_account_manager: { type: 'boolean' },
        nzbn: APPLICATION_TEXT,
        business_type: APPLICATION_TEXT,
        registered_office_address: APPLICATION_TEXT,
        directors_names_addresses: APPLICATION_TEXT,
        directors_dates_of_birth: APPLICATION_TEXT,
        cash_account_acceptable: { type: 'boolean' },
        trade_reference: APPLICATION_TEXT,
        terms_accepted: { type: 'boolean' },
        customer_full_name: APPLICATION_TEXT,
        signatory_name: APPLICATION_TEXT,
        signatory_position: APPLICATION_TEXT,
        signature: APPLICATION_TEXT,
      },
    },
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

const forgotPasswordBodySchema = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: {
    ...honeypotProperty,
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
  },
}

const resetPasswordBodySchema = {
  type: 'object',
  required: ['token', 'password'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 200 },
    password: { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 200 },
  },
}

// One sentence for every forgot-password call, known address or not: the reply
// must not say whether an account exists, the same rule INVALID_CREDENTIALS
// keeps at login.
const RESET_REQUESTED =
  'If an account exists for that address, a password reset link has been emailed to it.'
const RESET_LINK_INVALID = 'This reset link is invalid or has expired. Please request a new one.'
const MAIL_NOT_CONFIGURED =
  'This server cannot send email yet, so a reset link cannot be sent. Please contact the office.'

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

export const authRoutes = async (
  app,
  { pool, mailer = null, storeBaseUrl = 'http://localhost:4321', crmBaseUrl = 'http://localhost:5273' }
) => {
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
  // back office flips trade_approved (US-006 gate). The submitted form is
  // stored alongside the account so the CRM's Applicants tab can review it.
  app.post(
    '/auth/trade-application',
    {
      schema: { body: tradeApplicationBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) => {
      // A bot filled the hidden field: answer as if it worked, create nothing.
      if (honeypotTripped(request)) {
        reply.code(201)
        return { user: null }
      }
      const { email, password, name, application } = request.body
      const errors = validateTradeApplication(application)
      if (errors.length > 0) {
        reply.code(422)
        return { error: 'Unprocessable Entity', message: 'Validation failed.', errors }
      }

      const passwordHash = await hashPassword(password)
      try {
        const user = await submitTradeApplication(pool, {
          email,
          passwordHash,
          name,
          application,
        })
        // The office learns of the application by mail; the applicant does
        // not — their one letter is the acceptance on approval.
        await notifyTradeApplicationReceived(mailer, { user, application, crmBaseUrl })
        // Deliberately NO session cookie: the account cannot sign in until the
        // back office approves the application (login answers 403 "pending").
        reply.code(201)
        return { user }
      } catch (error) {
        // Same shape as register's duplicate-email answer.
        if (error.statusCode === 409) {
          reply.code(409)
          return { error: error.message }
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

      // A pending trade application cannot sign in at all. Checked only AFTER
      // the argon2 verify succeeded, so the "pending" answer is never an
      // enumeration signal — without the right password it's the generic 401.
      if (row.role === 'trade' && !row.trade_approved) {
        reply.code(403)
        return {
          error:
            'Your trade application is awaiting review. You will be able to sign in once it has been approved.',
        }
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

  // Forgot password. Always 202 with the same sentence: an unknown or archived
  // address gets no token and no mail, and nothing in the reply says which.
  // Rate limited like login — it sends mail to a caller-supplied address, and
  // each call replaces the account's live link, so an open loop could keep a
  // real user's link perpetually stale.
  app.post(
    '/auth/forgot-password',
    {
      schema: { body: forgotPasswordBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) => {
      // A bot filled the hidden field: the usual sentence, no token, no mail.
      if (honeypotTripped(request)) {
        reply.code(202)
        return { message: RESET_REQUESTED }
      }
      // A server that cannot send mail cannot do this at all. Said plainly —
      // it reveals nothing about any account — rather than answering the
      // sentence below with no letter behind it.
      if (!mailer?.delivers) {
        request.log.warn('password reset requested but SMTP is not configured')
        reply.code(503)
        return { error: MAIL_NOT_CONFIGURED }
      }
      const issued = await issueResetToken(pool, request.body.email)
      if (issued) {
        await notifyPasswordReset(mailer, {
          user: issued.user,
          resetUrl: resetUrlFor({ role: issued.user.role, token: issued.token, storeBaseUrl, crmBaseUrl }),
          expiresMinutes: RESET_TOKEN_TTL_MINUTES,
        })
      }
      reply.code(202)
      return { message: RESET_REQUESTED }
    }
  )

  // Spend the link. No session cookie is set: the person signs in with the
  // password they just chose, which also proves the reset took. Rate limited
  // because each attempt costs an argon2 hash, exactly like register.
  app.post(
    '/auth/reset-password',
    {
      schema: { body: resetPasswordBodySchema },
      config: { rateLimit: AUTH_RATE_LIMIT },
    },
    async (request, reply) => {
      const user = await consumeResetToken(pool, request.body.token, request.body.password)
      if (!user) {
        reply.code(400)
        return { error: RESET_LINK_INVALID }
      }
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
      `SELECT ${SESSION_USER_COLUMNS} FROM users
        WHERE id = $1 AND ${SESSION_USER_CONDITION}`,
      [userId]
    )
    // Deleted, archived or a pending trade application: either way the session
    // is dead, so drop the cookie.
    if (!rows[0]) {
      clearSessionCookie(reply)
      reply.code(401)
      return { error: 'Not logged in.' }
    }
    // report_access is DERIVED on every read and is never stored on the session.
    // The cookie holds a user id and nothing else, so a finance grant revoked in
    // the back office takes effect on the CRM's very next /auth/me rather than at
    // the account's next sign-in — which is what makes it a revocation rather
    // than a note for later. It is also why nothing here trusts the client: the
    // statement is computed from the row, and the row is fetched by id.
    return { user: { ...publicUser(rows[0]), report_access: reportAccess(rows[0]) } }
  })
}
