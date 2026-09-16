// The storefront's sample enquiry cart, submitted (16 Sep 2026): a guest or a
// signed-in shopper sends the colourways they collected as ONE request. Public,
// honeypotted and rate-limited exactly like POST /orders/request — it writes a
// row and sends two emails per call, which is mail amplification with an
// attacker-chosen recipient.

import { honeypotProperty, honeypotTripped } from '../lib/honeypot.js'
import { createSampleRequest, validateSampleRequestInput, MAX_LINES } from '../samples/sample-requests.js'
import { notifySampleRequestReceived } from '../email/notifications.js'

const SAMPLE_REQUEST_RATE_LIMIT = Object.freeze({ max: 10, timeWindow: 15 * 60 * 1000 })

const bodySchema = {
  type: 'object',
  required: ['lines'],
  additionalProperties: false,
  properties: {
    ...honeypotProperty,
    lines: {
      type: 'array',
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        required: ['sku'],
        additionalProperties: false,
        properties: {
          sku: { type: 'string', maxLength: 100 },
          note: { type: ['string', 'null'], maxLength: 500 },
        },
      },
    },
    contact: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: ['string', 'null'], maxLength: 200 },
        email: { type: ['string', 'null'], maxLength: 254 },
        phone: { type: ['string', 'null'], maxLength: 40 },
      },
    },
    notes: { type: ['string', 'null'], maxLength: 2000 },
  },
}

export const sampleRequestRoutes = async (app, { pool, mailer = null }) => {
  app.post(
    '/samples/request',
    { schema: { body: bodySchema }, config: { rateLimit: SAMPLE_REQUEST_RATE_LIMIT } },
    async (request, reply) => {
      // A bot filled the hidden field: answer as if it worked, store and send
      // nothing.
      if (honeypotTripped(request)) {
        reply.code(201)
        return { sample_request: null }
      }
      const user = await app.guards.loadOptionalUser(request)
      const errors = validateSampleRequestInput(request.body, { hasUser: Boolean(user) })
      if (errors.length > 0) {
        reply.code(422)
        return { error: 'Unprocessable Entity', message: 'Validation failed.', errors }
      }
      let sampleRequest
      try {
        sampleRequest = await createSampleRequest(pool, {
          lines: request.body.lines,
          contact: request.body.contact ?? {},
          notes: request.body.notes ?? null,
          user,
        })
      } catch (error) {
        if (error.statusCode === 422) {
          reply.code(422)
          return { error: 'Unprocessable Entity', message: error.message, errors: error.errors ?? [] }
        }
        throw error
      }
      // Acknowledge to the shopper and alert the back office. Never fails the
      // request — the mailer swallows delivery errors.
      await notifySampleRequestReceived(mailer, sampleRequest)
      reply.code(201)
      return { sample_request: sampleRequest }
    }
  )
}
