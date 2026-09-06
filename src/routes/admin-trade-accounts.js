// Back-office trade-account linking.
//
// No screen calls these yet — see the note in
// ../trade-accounts/admin-trade-accounts.js. The CRM's Users → Applicants tab is
// where they belong; the AdminJS panel is today's stopgap.
//
// Backoffice, not director: linking is part of approving a trade application,
// which backoffice already does via PATCH /admin/users/:id. Handlers stay thin —
// the resolution, the ambiguity check and the transaction live in
// ../trade-accounts/admin-trade-accounts.js.

import {
  listTradeAccounts,
  getTradeAccount,
  getTradeAccountByGuid,
  linkTradeAccount,
  unlinkTradeAccountUser,
  updateTradeAccount,
  suggestTradeAccounts,
  createTradeAccountContact,
  updateTradeAccountContact,
  deleteTradeAccountContact,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../trade-accounts/admin-trade-accounts.js'

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

const linkParamsSchema = {
  type: 'object',
  required: ['id', 'userId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    userId: { type: 'integer', minimum: 1 },
  },
}

const listQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const suggestQuerySchema = {
  type: 'object',
  properties: {
    email: { type: 'string', maxLength: 254 },
    q: { type: 'string', maxLength: 200 },
  },
}

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

// `user_id` is OPTIONAL: without it the company row is created BARE, so its
// contact book can exist before any login does. A later real link upserts onto
// the same row (the GUID is unique) and the contacts survive it.
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['legacy_account_guid'],
  properties: {
    legacy_account_guid: { type: 'string', pattern: UUID_PATTERN },
    user_id: { type: 'integer', minimum: 1 },
  },
}

const guidParamsSchema = {
  type: 'object',
  required: ['guid'],
  properties: {
    guid: { type: 'string', pattern: UUID_PATTERN },
  },
}

const contactParamsSchema = {
  type: 'object',
  required: ['id', 'contactId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    contactId: { type: 'integer', minimum: 1 },
  },
}

const contactBodyProps = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  role: { type: ['string', 'null'], maxLength: 200 },
  email: { type: ['string', 'null'], maxLength: 254 },
  phone: { type: ['string', 'null'], maxLength: 50 },
  note: { type: ['string', 'null'], maxLength: 2000 },
}

const createContactSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: contactBodyProps,
}

const patchContactSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: contactBodyProps,
}

// Only the account-manager block is patchable. The identity of the link
// (which D365 customer) is deliberately absent: re-pointing it is
// unlink-then-link, which leaves a trail.
const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    account_manager_name: { type: ['string', 'null'], maxLength: 200 },
    account_manager_email: { type: ['string', 'null'], maxLength: 254 },
    account_manager_phone: { type: ['string', 'null'], maxLength: 50 },
  },
}

const notFound = (reply, message) => {
  reply.code(404)
  return { error: 'Not Found', message }
}

export const adminTradeAccountRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/trade-accounts',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) =>
      listTradeAccounts(pool, {
        q: request.query.q ?? null,
        page: request.query.page,
        limit: request.query.limit,
      })
  )

  // Ranked D365 accounts a login might be. Suggestions only — nothing here
  // creates a link, because an email match is not reliable enough to trust
  // unattended (shared and free-mail addresses are common in this corpus).
  app.get(
    '/admin/trade-accounts/suggestions',
    { preHandler: backoffice, schema: { querystring: suggestQuerySchema } },
    async (request) =>
      suggestTradeAccounts(pool, {
        email: request.query.email ?? null,
        q: request.query.q ?? null,
      })
  )

  // The bridge from the CRM's mirror screens: /clients/:id is keyed by the D365
  // GUID, and this resolves it to the company row (static segment, so Fastify
  // prefers it over :id — the `suggestions` precedent).
  app.get(
    '/admin/trade-accounts/by-guid/:guid',
    { preHandler: backoffice, schema: { params: guidParamsSchema } },
    async (request, reply) => {
      const tradeAccount = await getTradeAccountByGuid(pool, request.params.guid)
      if (!tradeAccount) {
        return notFound(reply, `No trade account exists for that Dynamics customer yet.`)
      }
      return { trade_account: tradeAccount }
    }
  )

  app.get(
    '/admin/trade-accounts/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const tradeAccount = await getTradeAccount(pool, request.params.id)
      if (!tradeAccount) {
        return notFound(reply, `Trade account ${request.params.id} not found.`)
      }
      return { trade_account: tradeAccount }
    }
  )

  app.post(
    '/admin/trade-accounts',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      const tradeAccount = await linkTradeAccount(pool, {
        legacyAccountGuid: request.body.legacy_account_guid,
        userId: request.body.user_id,
        linkedByUserId: request.user.id,
      })
      reply.code(201)
      return { trade_account: tradeAccount }
    }
  )

  app.patch(
    '/admin/trade-accounts/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchBodySchema } },
    async (request, reply) => {
      const tradeAccount = await updateTradeAccount(pool, request.params.id, request.body)
      if (!tradeAccount) {
        return notFound(reply, `Trade account ${request.params.id} not found.`)
      }
      return { trade_account: tradeAccount }
    }
  )

  // ---- the contact book -----------------------------------------------------
  // Staff-kept people at the client company — NOT logins. Every write answers
  // with the fresh account, so the CRM redraws off one shape.

  app.post(
    '/admin/trade-accounts/:id/contacts',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: createContactSchema } },
    async (request, reply) => {
      const tradeAccount = await createTradeAccountContact(
        pool,
        request.params.id,
        request.body
      )
      if (!tradeAccount) {
        return notFound(reply, `Trade account ${request.params.id} not found.`)
      }
      reply.code(201)
      return { trade_account: tradeAccount }
    }
  )

  app.patch(
    '/admin/trade-accounts/:id/contacts/:contactId',
    { preHandler: backoffice, schema: { params: contactParamsSchema, body: patchContactSchema } },
    async (request, reply) => {
      const tradeAccount = await updateTradeAccountContact(
        pool,
        request.params.id,
        request.params.contactId,
        request.body
      )
      if (!tradeAccount) {
        return notFound(
          reply,
          `Trade account ${request.params.id} has no contact ${request.params.contactId}.`
        )
      }
      return { trade_account: tradeAccount }
    }
  )

  app.delete(
    '/admin/trade-accounts/:id/contacts/:contactId',
    { preHandler: backoffice, schema: { params: contactParamsSchema } },
    async (request, reply) => {
      const tradeAccount = await deleteTradeAccountContact(
        pool,
        request.params.id,
        request.params.contactId
      )
      if (!tradeAccount) {
        return notFound(
          reply,
          `Trade account ${request.params.id} has no contact ${request.params.contactId}.`
        )
      }
      return { trade_account: tradeAccount }
    }
  )

  // Revoke one login's access. The company row survives — it holds the
  // account-manager details and the audit trail.
  app.delete(
    '/admin/trade-accounts/:id/users/:userId',
    { preHandler: backoffice, schema: { params: linkParamsSchema } },
    async (request, reply) => {
      const tradeAccount = await unlinkTradeAccountUser(pool, {
        id: request.params.id,
        userId: request.params.userId,
      })
      if (!tradeAccount) {
        return notFound(reply, `Trade account ${request.params.id} not found.`)
      }
      return { trade_account: tradeAccount }
    }
  )
}
