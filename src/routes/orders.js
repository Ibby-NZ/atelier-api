import {
  validateOrderRequestInput,
  createOrderRequest,
} from '../orders/order-request.js'
import {
  listUserOrders,
  lookupOrder,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../orders/order-history.js'
import { notifyRequestReceived } from '../email/notifications.js'

// Paging for /orders/mine. Fastify coerces both from the querystring; an
// out-of-range value is a 400 by schema rather than a silently clamped read.
const ordersMineQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// Guest lookup requires both the order number and the matching email. Schema is
// structural only (both required, non-empty); a mismatch is a 404, not a 400.
const orderLookupQuerySchema = {
  type: 'object',
  required: ['order_number', 'email'],
  properties: {
    order_number: { type: 'string', minLength: 1, maxLength: 100 },
    email: { type: 'string', minLength: 1, maxLength: 254 },
  },
}

// Structural schema only (400 on gross violations). qty > 0 and email validity
// are checked in the handler so they can return 422 with field-level messages.
const orderRequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    accepted_lead_time: { type: 'boolean' },
    contact: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 200 },
        email: { type: 'string', maxLength: 254 },
        phone: { type: 'string', maxLength: 50 },
      },
    },
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'qty_metres'],
        properties: {
          sku: { type: 'string', minLength: 1, maxLength: 100 },
          qty_metres: { type: 'number' },
          cut_requirements: { type: 'string', maxLength: 2000 },
        },
      },
    },
  },
}

export const orderRoutes = async (app, { pool, mailer = null }) => {
  // Public: guests may request an order. When logged in, the request is tied to
  // the user and their email is used when no contact email is supplied.
  app.post(
    '/orders/request',
    { schema: { body: orderRequestBodySchema } },
    async (request, reply) => {
      const user = await app.guards.loadOptionalUser(request)

      const errors = validateOrderRequestInput(request.body, {
        hasUser: Boolean(user),
      })
      if (errors.length > 0) {
        reply.code(422)
        return { error: 'Unprocessable Entity', message: 'Validation failed.', errors }
      }

      const { order } = await createOrderRequest(pool, {
        lines: request.body.lines,
        contact: request.body.contact ?? {},
        acceptedLeadTime: request.body.accepted_lead_time ?? false,
        user,
      })

      // Acknowledge to the customer and alert the back office. Never fails the
      // request — the mailer swallows delivery errors.
      const customerEmail = user?.email ?? request.body.contact?.email ?? null
      await notifyRequestReceived(mailer, { order, customerEmail })

      reply.code(201)
      return { order }
    }
  )

  // Auth: the logged-in user's own orders, newest first. Ownership is enforced
  // in SQL (WHERE user_id = ...), so no order of another user can be returned.
  // Paged — `meta.total` is the whole history, `orders` is one page of it.
  app.get(
    '/orders/mine',
    {
      preHandler: app.guards.requireAuth,
      schema: { querystring: ordersMineQuerySchema },
    },
    async (request) => {
      return listUserOrders(pool, request.user.id, {
        page: request.query.page,
        limit: request.query.limit,
      })
    }
  )

  // Public guest lookup: a single order matched by order number AND email.
  // 404 when either half is wrong — never reveal an order without both keys.
  app.get(
    '/orders/lookup',
    { schema: { querystring: orderLookupQuerySchema } },
    async (request, reply) => {
      const order = await lookupOrder(pool, {
        orderNumber: request.query.order_number,
        email: request.query.email,
      })
      if (!order) {
        reply.code(404)
        return { error: 'Not Found', message: 'No matching order found.' }
      }
      return { order }
    }
  )
}
