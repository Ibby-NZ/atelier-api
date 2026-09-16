// The back office's view of storefront sample requests: the pending queue, the
// two moves (sent / declined), archive, and delete through the registry.
// Backoffice-only (director inherits), the posture of every /admin/* route.

import {
  listSampleRequests,
  getSampleRequest,
  transitionSampleRequest,
  setSampleRequestArchived,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../samples/sample-requests.js'
import { SAMPLE_REQUEST_STATUSES } from '../samples/sample-request-states.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

const listQuerySchema = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: SAMPLE_REQUEST_STATUSES },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const transitionBodySchema = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string', enum: SAMPLE_REQUEST_STATUSES } },
}

const notFound = (reply, id) => {
  reply.code(404)
  return { error: 'Not Found', message: `Sample request ${id} not found.` }
}

export const adminSampleRequestRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/sample-requests',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { page, limit } = request.query
      const { sample_requests, total } = await listSampleRequests(pool, {
        q: request.query.q,
        status: request.query.status,
        includeArchived: request.query.include_archived,
        page,
        limit,
      })
      return { sample_requests, meta: { total, page, limit } }
    }
  )

  app.get(
    '/admin/sample-requests/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const row = await getSampleRequest(pool, request.params.id)
      return row ? { sample_request: row } : notFound(reply, request.params.id)
    }
  )

  app.post(
    '/admin/sample-requests/:id/transition',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: transitionBodySchema } },
    async (request, reply) => {
      const row = await transitionSampleRequest(pool, request.params.id, request.body.status)
      return row ? { sample_request: row } : notFound(reply, request.params.id)
    }
  )

  for (const [verb, archived] of [['archive', true], ['restore', false]]) {
    app.post(
      `/admin/sample-requests/:id/${verb}`,
      { preHandler: backoffice, schema: { params: idParamsSchema } },
      async (request, reply) => {
        const row = await setSampleRequestArchived(pool, request.params.id, archived)
        return row ? { sample_request: row } : notFound(reply, request.params.id)
      }
    )
  }

  app.delete(
    '/admin/sample-requests/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'sample_request', request.params.id, { user: request.user })
      )
  )
}
