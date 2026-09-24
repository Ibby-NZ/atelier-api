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
  createTradeAccount,
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
import {
  linkCompanyToXero,
  setCompanyXeroArchived,
  setTradeAccountArchived,
} from '../trade-accounts/review.js'

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
    customer_type: { type: 'string', maxLength: 50 },
    include_archived: { type: 'boolean', default: false },
    // The review queue: only accounts with an unapproved trade login.
    pending: { type: 'boolean', default: false },
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

// A nullable text cell, capped at the column's width.
const text = (maxLength) => ({ type: ['string', 'null'], maxLength })

// One route, two creates, because they are the same sentence said about two
// kinds of client: with a `legacy_account_guid` this LINKS a Dynamics customer
// (`user_id` optional — without it the company row is created BARE, so its
// contact book can exist before any login does, and a later real link upserts
// onto the same row because the GUID is unique), and with a `company_name` it
// RAISES a client that is in no export at all.
//
// Which of the two is present is a business rule (422 from the handler), not
// something the schema can express — the same posture POST /admin/orders takes
// on account-or-contact attribution.
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    legacy_account_guid: { type: 'string', pattern: UUID_PATTERN },
    user_id: { type: 'integer', minimum: 1 },
    company_name: { type: 'string', minLength: 1, maxLength: 200 },
    account_number: text(50),
    customer_type: text(50),
    primary_contact_name: text(200),
    email: text(254),
    phone: text(50),
    address: text(1000),
    city: text(200),
    country: text(200),
    payment_terms: text(200),
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

// The account-manager block and the company details, both backoffice. The identity of the
// link (which D365 customer, the snapshotted name) is deliberately absent:
// re-pointing it is unlink-then-link, which leaves a trail.
const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    // Hand-raised rows only; a Dynamics-linked row 422s (updateTradeAccount).
    company_name: { type: 'string', minLength: 1, maxLength: 200 },
    account_manager_name: text(200),
    account_manager_email: text(254),
    account_manager_phone: text(50),
    account_number: text(50),
    customer_type: text(50),
    primary_contact_name: text(200),
    email: text(254),
    phone: text(50),
    address: text(1000),
    city: text(200),
    country: text(200),
    payment_terms: text(200),
    xero_contact_id: text(100),
    // The staff login who owns the client and is its account manager in the
    // portal (a current backoffice/director login, else 422); null clears it.
    account_owner_id: { type: ['integer', 'null'], minimum: 1 },
  },
}

const notFound = (reply, message) => {
  reply.code(404)
  return { error: 'Not Found', message }
}

export const adminTradeAccountRoutes = async (
  app,
  { pool, xero = null, tradeApproverEmail = null, tradeAccountsEmail = null }
) => {
  // Who takes each review step (config), for the CRM to offer the right
  // buttons to the right person — the order_copy_email precedent. The routes
  // in admin-users.js enforce it; this only tells. null = anyone back-office.
  const tradeReview = Object.freeze({
    approver_email: tradeApproverEmail || null,
    accounts_email: tradeAccountsEmail || null,
  })

  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/trade-accounts',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) =>
      listTradeAccounts(pool, {
        q: request.query.q ?? null,
        customerType: request.query.customer_type ?? null,
        includeArchived: request.query.include_archived,
        pending: request.query.pending,
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
      return { trade_account: tradeAccount, trade_review: tradeReview }
    }
  )

  // Backoffice for create AND edit (22 Sep 2026, client asked): taking down a
  // client's name, address and terms is the order desk's own work, and the
  // detail PATCH used to 403 anyone but a director, which meant a typo taken
  // over the phone waited until one was free.
  app.post(
    '/admin/trade-accounts',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      if (!request.body.legacy_account_guid && !request.body.company_name) {
        reply.code(422)
        return {
          error: 'Unprocessable Entity',
          message: 'A client needs either a Dynamics customer or a company name.',
        }
      }
      const tradeAccount = request.body.legacy_account_guid
        ? await linkTradeAccount(pool, {
            legacyAccountGuid: request.body.legacy_account_guid,
            userId: request.body.user_id,
            linkedByUserId: request.user.id,
          })
        : await createTradeAccount(pool, {
            ...request.body,
            created_by_user_id: request.user.id,
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

  // ---- cancelling a client ---------------------------------------------------
  // Archive is the client's cancellation: the company AND its logins are
  // archived (nobody there can sign in), and so is its Xero contact. Restore
  // brings the company and its Xero contact back; each login is restored on
  // its own. Xero's answer rides along as `xero_contact` (null when the
  // company has no contact) and never fails the move.
  for (const [verb, archived] of [['archive', true], ['restore', false]]) {
    app.post(
      `/admin/trade-accounts/:id/${verb}`,
      { preHandler: backoffice, schema: { params: idParamsSchema } },
      async (request, reply) => {
        const moved = await setTradeAccountArchived(pool, request.params.id, archived)
        if (!moved) {
          return notFound(reply, `Trade account ${request.params.id} not found.`)
        }
        const xeroContact = await setCompanyXeroArchived(xero, moved.xeroContactId, archived)
        return {
          trade_account: await getTradeAccount(pool, request.params.id),
          xero_contact: xeroContact,
        }
      }
    )
  }

  // "Add to Xero": match-or-create the company's contact and remember its id —
  // the retry for an approval whose Xero step did not land.
  app.post(
    '/admin/trade-accounts/:id/xero-contact',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!(await getTradeAccount(pool, request.params.id))) {
        return notFound(reply, `Trade account ${request.params.id} not found.`)
      }
      if (!xero) {
        reply.code(503)
        return { error: 'Service Unavailable', message: 'Xero is not set up on this server.' }
      }
      const result = await linkCompanyToXero(xero, request.params.id)
      if (!result.linked) {
        reply.code(502)
        return { error: 'Bad Gateway', message: result.reason }
      }
      return { trade_account: await getTradeAccount(pool, request.params.id) }
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
