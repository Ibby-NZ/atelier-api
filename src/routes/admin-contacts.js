// /admin/contacts — the whole address book, across companies and none. The
// per-company book stays on /admin/trade-accounts/:id/contacts; this is the
// cross-company list and the writes that file a contact under a company (or
// take it out of one). Backoffice, like the book.

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  updateContact,
} from '../trade-accounts/contacts.js'

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    filed: { type: 'boolean' },
    trade_account_id: { type: 'integer', minimum: 1 },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const bodyProps = {
  name: { type: 'string', minLength: 1, maxLength: 200 },
  trade_account_id: { type: ['integer', 'null'], minimum: 1 },
  company_name: { type: ['string', 'null'], maxLength: 200 },
  role: { type: ['string', 'null'], maxLength: 200 },
  email: { type: ['string', 'null'], maxLength: 254 },
  phone: { type: ['string', 'null'], maxLength: 50 },
  note: { type: ['string', 'null'], maxLength: 2000 },
}

const createBody = { type: 'object', additionalProperties: false, required: ['name'], properties: bodyProps }
const patchBody = { type: 'object', additionalProperties: false, minProperties: 1, properties: bodyProps }

const notFound = (reply, id) => {
  reply.code(404)
  return { error: 'Not Found', message: `Contact ${id} not found.` }
}

export const adminContactRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get('/admin/contacts', { preHandler: backoffice, schema: { querystring: listQuery } }, async (request) =>
    listContacts(pool, {
      q: request.query.q ?? null,
      filed: request.query.filed ?? null,
      tradeAccountId: request.query.trade_account_id ?? null,
      page: request.query.page,
      limit: request.query.limit,
    })
  )

  app.get('/admin/contacts/:id', { preHandler: backoffice, schema: { params: idParams } }, async (request, reply) => {
    const contact = await getContact(pool, request.params.id)
    return contact ? { contact } : notFound(reply, request.params.id)
  })

  app.post('/admin/contacts', { preHandler: backoffice, schema: { body: createBody } }, async (request, reply) => {
    const contact = await createContact(pool, request.body)
    reply.code(201)
    return { contact }
  })

  app.patch('/admin/contacts/:id', { preHandler: backoffice, schema: { params: idParams, body: patchBody } }, async (request, reply) => {
    const contact = await updateContact(pool, request.params.id, request.body)
    return contact ? { contact } : notFound(reply, request.params.id)
  })

  app.delete('/admin/contacts/:id', { preHandler: backoffice, schema: { params: idParams } }, async (request, reply) => {
    const deleted = await deleteContact(pool, request.params.id)
    if (!deleted) return notFound(reply, request.params.id)
    reply.code(204)
    return null
  })
}
