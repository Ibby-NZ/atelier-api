import { createCheckoutSession } from '../checkout/checkout.js'

// Body: a non-empty cart of { sku, qty } plus the shipping zone. Prices are
// never accepted from the client — the server resolves them from the DB.
const checkoutBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'zone'],
  properties: {
    zone: { type: 'string', minLength: 1, maxLength: 200 },
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sku', 'qty'],
        properties: {
          sku: { type: 'string', minLength: 1, maxLength: 100 },
          qty: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
    },
  },
}

export const checkoutRoutes = async (app, { pool, stripe, storeBaseUrl }) => {
  // Public: guests may check out. When logged in, the session is tagged with the
  // user for reconciliation and their email is pre-filled.
  app.post(
    '/checkout/session',
    { schema: { body: checkoutBodySchema } },
    async (request) => {
      const user = await app.guards.loadOptionalUser(request)
      const { url, session_id } = await createCheckoutSession(
        { pool, stripe, storeBaseUrl },
        { lines: request.body.lines, zone: request.body.zone, user }
      )
      return { url, session_id }
    }
  )
}
