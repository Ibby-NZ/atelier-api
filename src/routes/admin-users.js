// Back-office users / clients admin endpoints. All routes are backoffice-only
// (director inherits via the role guard). Business rules live in
// ../users/admin-users.js; these handlers stay thin.
//
// Two self-protection guards live in the handlers (not the module) because they
// need the caller's identity from `request.user`, which the module never sees:
//   - an admin can't change their OWN role (a mistyped role='customer' would
//     instantly revoke their back-office access);
//   - an admin can't archive their OWN account (self-lockout).
// The third — you can't hard-delete yourself — lives in the lifecycle registry's
// `user` guard instead, because `deleteOrExplain` owns that transaction and the
// refusal has to travel in the same envelope as a probe's. It arrives there as
// `ctx.user`, which is why the DELETE handler passes `{ user: request.user }`.

import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  setUserArchived,
  USER_SEGMENTS,
} from '../users/admin-users.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import { MIN_PASSWORD_LENGTH } from '../auth/passwords.js'

// The valid stored roles (matches the users_role_check constraint). Shared by the
// list filter and the patch/create body so an unknown role is a 400 by schema.
const USER_ROLES = ['customer', 'trade', 'backoffice', 'director']

// Fastify's bundled Ajv has no email format, so a pattern stands in (same as auth).
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

// When the office creates an account without setting a password, it lands on this
// temp password (the same one seed-staff uses); the person changes it on first login.
const DEFAULT_TEMP_PASSWORD = 'AtelierTemp2026!'

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'role'],
  properties: {
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    name: { type: ['string', 'null'], maxLength: 200 },
    role: { type: 'string', enum: USER_ROLES },
    password: { type: 'string', minLength: MIN_PASSWORD_LENGTH, maxLength: 200 },
  },
}

// `segment` is the coarse split the CRM navigates by — Clients (customer +
// trade) versus Users & permissions (backoffice + director). Enum-constrained so
// an unknown segment is a 400 rather than a silently unfiltered list.
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: USER_ROLES },
    segment: { type: 'string', enum: Object.keys(USER_SEGMENTS) },
    q: { type: 'string' },
    include_archived: { type: 'boolean', default: false },
  },
}

// :id is coerced to an integer by Fastify; a non-numeric id is a 400 by schema.
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

// minProperties: 1 rejects an empty patch with a 400. `name` is nullable so a
// PATCH can clear it; `email` is not — an account with no address could never
// sign in again. password/archived_at stay off this route (a password is an auth
// flow, archiving has its own endpoint).
const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    role: { type: 'string', enum: USER_ROLES },
    trade_approved: { type: 'boolean' },
    name: { type: ['string', 'null'], maxLength: 200 },
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
  },
}

const notFound = (reply, id) => {
  reply.code(404)
  return { error: 'Not Found', message: `User ${id} not found.` }
}

export const adminUsersRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/users',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => ({
      users: await listUsers(pool, {
        role: request.query.role,
        segment: request.query.segment,
        q: request.query.q,
        includeArchived: request.query.include_archived,
      }),
    })
  )

  app.post(
    '/admin/users',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      const user = await createUser(pool, {
        email: request.body.email,
        name: request.body.name ?? null,
        role: request.body.role,
        password: request.body.password ?? DEFAULT_TEMP_PASSWORD,
      })
      reply.code(201)
      return { user, temp_password: request.body.password ? undefined : DEFAULT_TEMP_PASSWORD }
    }
  )

  app.get(
    '/admin/users/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const user = await getUser(pool, request.params.id)
      if (!user) {
        return notFound(reply, request.params.id)
      }
      return { user }
    }
  )

  app.patch(
    '/admin/users/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchBodySchema } },
    async (request, reply) => {
      // Self role-change guard: only blocked when editing your own account AND
      // the body touches `role`. trade_approved/name/email self-edits are fine —
      // none of them can revoke your own back-office access.
      if (request.params.id === request.user.id && Object.hasOwn(request.body, 'role')) {
        reply.code(422)
        return {
          error: 'Unprocessable Entity',
          message: 'You cannot change your own role.',
        }
      }
      const user = await updateUser(pool, request.params.id, request.body)
      return { user }
    }
  )

  app.post(
    '/admin/users/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      // Self-lockout guard: archiving yourself would remove your own access.
      if (request.params.id === request.user.id) {
        reply.code(422)
        return {
          error: 'Unprocessable Entity',
          message: 'You cannot archive your own account.',
        }
      }
      const user = await setUserArchived(pool, request.params.id, true)
      if (!user) {
        return notFound(reply, request.params.id)
      }
      return { user }
    }
  )

  app.post(
    '/admin/users/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const user = await setUserArchived(pool, request.params.id, false)
      if (!user) {
        return notFound(reply, request.params.id)
      }
      return { user }
    }
  )

  // Hard delete, for a mistyped signup that never transacted. Every FK out of
  // `users` is SET NULL or CASCADE, so the database raises nothing: an unprobed
  // delete would silently turn an order history into anonymous guest orders with
  // no guest_email. The registry's probes turn each of those into a 409 carrying
  // the counts, and `deleteOrExplain` *returns* the refusal — Fastify's error
  // serializer drops `blockers` off a thrown error.
  //
  // 'user' is a code literal, never `:entity` from the URL: the registry knows
  // every entity name alike, so it is not an authorisation boundary.
  app.delete(
    '/admin/users/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'user', request.params.id, { user: request.user })
      )
  )
}
