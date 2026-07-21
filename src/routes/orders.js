import {
  validateOrderRequestInput,
  createOrderRequest,
} from '../orders/order-request.js'

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

export const orderRoutes = async (app, { pool }) => {
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

      reply.code(201)
      return { order }
    }
  )
}
