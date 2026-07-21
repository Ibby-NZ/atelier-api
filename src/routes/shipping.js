import {
  getShippingQuote,
  upsertShippingRates,
} from '../shipping/rates.js'

// Public quote query: zone + qty are both required. Fastify coerces the
// querystring qty to a number; a missing/invalid value is a 400 by schema.
const quoteQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['zone', 'qty'],
  properties: {
    zone: { type: 'string', minLength: 1, maxLength: 200 },
    qty: { type: 'number', minimum: 0 },
  },
}

// Admin rate update: a non-empty array of tiers. rate_cents is whole cents.
const updateRatesBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rates'],
  properties: {
    rates: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['zone', 'threshold_qty', 'rate_cents'],
        properties: {
          zone: { type: 'string', minLength: 1, maxLength: 200 },
          threshold_qty: { type: 'number', minimum: 0 },
          rate_cents: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
}

export const shippingRoutes = async (app, { pool }) => {
  app.get(
    '/shipping/quote',
    { schema: { querystring: quoteQuerySchema } },
    async (request, reply) => {
      const quote = await getShippingQuote(pool, request.query)
      if (!quote) {
        return reply
          .code(400)
          .send({ error: `Unknown shipping zone "${request.query.zone}".` })
      }
      return quote
    }
  )

  // Back-office only: edit rates without a redeploy.
  app.put(
    '/admin/shipping-rates',
    {
      preHandler: app.guards.requireRole('backoffice'),
      schema: { body: updateRatesBodySchema },
    },
    async (request) => {
      const rates = await upsertShippingRates(pool, request.body.rates)
      return { rates }
    }
  )
}
