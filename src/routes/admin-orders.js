// Back-office order management endpoints (US-014). All routes are backoffice-only
// (director inherits backoffice via the role guard). Business rules and the state
// machine live in ../orders/admin-orders.js; these handlers stay thin.

import {
  ORDER_STATUSES,
  listAdminOrders,
  getAdminOrder,
  editOrderLines,
  confirmOrder,
  markOrderPaid,
  shipOrder,
  declineOrder,
} from '../orders/admin-orders.js'

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ORDER_STATUSES },
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

const editBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'qty'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          qty: { type: 'number', exclusiveMinimum: 0 },
        },
      },
    },
  },
}

const confirmBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['xero_invoice_ref'],
  properties: {
    xero_invoice_ref: { type: 'string', minLength: 1, maxLength: 200 },
  },
}

export const adminOrderRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/orders',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const orders = await listAdminOrders(pool, { status: request.query.status })
      return { orders }
    }
  )

  // Fetch a single order (handy for the back-office detail screen, US-023).
  app.get(
    '/admin/orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const order = await getAdminOrder(pool, request.params.id)
      if (!order) {
        reply.code(404)
        return { error: 'Not Found', message: `Order ${request.params.id} not found.` }
      }
      return { order }
    }
  )

  app.patch(
    '/admin/orders/:id',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: editBodySchema },
    },
    async (request) => {
      const order = await editOrderLines(pool, request.params.id, request.body.lines)
      return { order }
    }
  )

  app.post(
    '/admin/orders/:id/confirm',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: confirmBodySchema },
    },
    async (request) => {
      const order = await confirmOrder(
        pool,
        request.params.id,
        request.body.xero_invoice_ref
      )
      return { order }
    }
  )

  app.post(
    '/admin/orders/:id/mark-paid',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => {
      const order = await markOrderPaid(pool, request.params.id)
      return { order }
    }
  )

  app.post(
    '/admin/orders/:id/ship',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => {
      const order = await shipOrder(pool, request.params.id)
      return { order }
    }
  )

  app.post(
    '/admin/orders/:id/decline',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => {
      const order = await declineOrder(pool, request.params.id)
      return { order }
    }
  )
}
