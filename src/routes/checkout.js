import {
  createCheckoutSession,
  retrieveCheckoutSession,
} from '../checkout/checkout.js'

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

// Unauthenticated and it SPENDS: every call creates a Checkout Session at
// Stripe, so an unmetered loop is third-party cost plus an unbounded pile of
// abandoned sessions in the dashboard. Looser than /contact's 10 because a
// shopper legitimately retries a card and a shared office IP may hold several
// buyers, but bounded, which it was not.
const CHECKOUT_RATE_LIMIT = Object.freeze({ max: 20, timeWindow: 15 * 60 * 1000 })

export const checkoutRoutes = async (app, { pool, stripe, storeBaseUrl }) => {
  // Public: guests may check out. When logged in, the session is tagged with the
  // user for reconciliation and their email is pre-filled.
  app.post(
    '/checkout/session',
    { schema: { body: checkoutBodySchema }, config: { rateLimit: CHECKOUT_RATE_LIMIT } },
    async (request) => {
      const user = await app.guards.loadOptionalUser(request)
      const { url, session_id } = await createCheckoutSession(
        { pool, stripe, storeBaseUrl },
        { lines: request.body.lines, zone: request.body.zone, user }
      )
      return { url, session_id }
    }
  )

  // Public: the success page verifies the completed session and shows the order
  // number. Only non-sensitive fields are returned (no line items / prices).
  app.get(
    '/checkout/session/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request) => retrieveCheckoutSession({ stripe }, request.params.id)
  )
}
