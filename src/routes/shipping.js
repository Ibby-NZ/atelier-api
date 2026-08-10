// Public shipping quote + the back-office rate admin. Handlers stay thin — the
// SQL and the rules live in ../shipping/rates.js.
//
// Two write shapes coexist on /admin/shipping-rates by design: the bulk PUT
// edits the whole tier table in one transaction (the original no-redeploy
// escape hatch, unchanged), while POST/PATCH/DELETE are the single-row surface
// the CRM screen drives. Hard DELETE goes through the lifecycle registry, whose
// `shipping_rate` guard refuses the last tier for a zone.

import {
  getShippingQuote,
  listShippingRates,
  createShippingRate,
  updateShippingRate,
  upsertShippingRates,
} from '../shipping/rates.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

// One vocabulary for a tier, shared by the bulk and single-row schemas so the
// two can never drift apart on what a zone or a rate is allowed to be.
const zoneProp = { type: 'string', minLength: 1, maxLength: 200 }
const thresholdQtyProp = { type: 'number', minimum: 0 }
const rateCentsProp = { type: 'integer', minimum: 0 }

// Public quote query: zone + qty are both required. Fastify coerces the
// querystring qty to a number; a missing/invalid value is a 400 by schema.
const quoteQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['zone', 'qty'],
  properties: {
    zone: zoneProp,
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
          zone: zoneProp,
          threshold_qty: thresholdQtyProp,
          rate_cents: rateCentsProp,
        },
      },
    },
  },
}

const createRateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['zone', 'threshold_qty', 'rate_cents'],
  properties: {
    zone: zoneProp,
    threshold_qty: thresholdQtyProp,
    rate_cents: rateCentsProp,
  },
}

// `rate_cents` only, and required rather than optional: (zone, threshold_qty)
// is the identity key, so there is no second editable field for a
// minProperties:1 rule to choose between. Ajv strips a stray `zone` (it does not
// reject it), which leaves the body empty — hence `required`, which turns that
// into a 400 instead of an UPDATE with nothing to set.
const patchRateBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rate_cents'],
  properties: {
    rate_cents: rateCentsProp,
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

export const shippingRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

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

  // Every tier, zone then threshold ascending. Unpaginated on purpose: the
  // table is one row per (zone, tier) — three zones and two tiers each today —
  // so a pager would be chrome over a list that never needs one.
  app.get(
    '/admin/shipping-rates',
    { preHandler: backoffice },
    async () => ({ rates: await listShippingRates(pool) })
  )

  // Back-office only: edit rates without a redeploy.
  app.put(
    '/admin/shipping-rates',
    {
      preHandler: backoffice,
      schema: { body: updateRatesBodySchema },
    },
    async (request) => {
      const rates = await upsertShippingRates(pool, request.body.rates)
      return { rates }
    }
  )

  app.post(
    '/admin/shipping-rates',
    { preHandler: backoffice, schema: { body: createRateBodySchema } },
    async (request, reply) => {
      const rate = await createShippingRate(pool, request.body)
      reply.code(201)
      return { rate }
    }
  )

  app.patch(
    '/admin/shipping-rates/:id',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: patchRateBodySchema },
    },
    async (request) => ({
      rate: await updateShippingRate(pool, request.params.id, request.body),
    })
  )

  // The registry's `shipping_rate` guard refuses the last tier for a zone with a
  // 409: a zone with no tiers makes getShippingQuote answer 400 "unknown zone",
  // which stops checkout for every shopper in it. The entity is not archivable
  // (no archived_at column), so the refusal offers no "archive instead".
  app.delete(
    '/admin/shipping-rates/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'shipping_rate', request.params.id, {
          user: request.user,
        })
      )
  )
}
