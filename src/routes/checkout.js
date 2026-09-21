import {
  createCheckoutSession,
  retrieveCheckoutSession,
  getCheckoutPrefill,
} from '../checkout/checkout.js'

const TEXT = (max) => ({ type: 'string', minLength: 1, maxLength: max })
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

// The delivery details the store collects (Sept 2026). Lengths are bounded so
// each fits a Stripe metadata value (500 chars); country is not accepted —
// the zone tiers only price New Zealand.
const customerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'email', 'phone', 'address'],
  properties: {
    name: TEXT(200),
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    phone: TEXT(50),
    address: {
      type: 'object',
      additionalProperties: false,
      required: ['line1', 'city', 'postal_code'],
      properties: {
        line1: TEXT(200),
        line2: { type: 'string', maxLength: 200 },
        city: TEXT(100),
        postal_code: TEXT(20),
      },
    },
  },
}

// Body: a non-empty cart of { sku, qty } plus the shipping zone and the
// customer's delivery details. Prices are never accepted from the client — the
// server resolves them from the DB.
const checkoutBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'zone', 'customer'],
  properties: {
    zone: { type: 'string', minLength: 1, maxLength: 200 },
    // Optional, and free text: what the shopper wants the office to know, plus
    // the two numbers a client files the job under (`client_reference` is the
    // name they call it; `customer_po_number` is their own purchase order).
    // They ride to the webhook as Stripe metadata, whose values cap at 500
    // characters — these caps stay under it.
    notes: { type: 'string', maxLength: 500 },
    client_reference: { type: 'string', maxLength: 200 },
    customer_po_number: { type: 'string', maxLength: 200 },
    customer: customerSchema,
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

// The success page SPENDS too: every call retrieves the session from Stripe,
// the 404 path included. That page polls this route every 2s for up to 30s
// while it waits for the webhook, so one completed order costs ~15 calls. 120
// is eight of those — a buyer who reloads the page and buys twice over is
// nowhere near it — while a scripted loop is capped at eight Stripe retrieves
// a minute from one IP.
const CHECKOUT_LOOKUP_RATE_LIMIT = Object.freeze({ max: 120, timeWindow: 15 * 60 * 1000 })

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
        {
          lines: request.body.lines,
          zone: request.body.zone,
          customer: request.body.customer,
          user,
          notes: request.body.notes ?? null,
          clientReference: request.body.client_reference ?? null,
          customerPoNumber: request.body.customer_po_number ?? null,
        }
      )
      return { url, session_id }
    }
  )

  // Signed in only: the form's starting values. Guests get 401 and start blank.
  app.get(
    '/checkout/prefill',
    { preHandler: app.guards.requireAuth },
    async (request) => getCheckoutPrefill(pool, request.user)
  )

  // Public: the success page verifies the completed session and shows the order
  // it became — its human order number, what was bought and where it is going.
  // Keyed on the Stripe session id the redirect carries, so the order comes
  // back only to whoever completed that checkout.
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
      config: { rateLimit: CHECKOUT_LOOKUP_RATE_LIMIT },
    },
    async (request) => retrieveCheckoutSession({ pool, stripe }, request.params.id)
  )
}
