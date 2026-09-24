import {
  validateOrderRequestInput,
  createOrderRequest,
  SHIPPING_ADDRESS_SCHEMA,
} from '../orders/order-request.js'
import {
  listUserOrders,
  getCustomerOrder,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../orders/order-history.js'
import {
  REJECTION_REASON_MAX,
  validateQuoteAnswer,
  respondToQuote,
  findOrderByQuoteToken,
  findUserOrderByNumber,
} from '../orders/quote-response.js'
import { notifyRequestReceived, notifyQuoteAnswered } from '../email/notifications.js'
import { honeypotProperty, honeypotTripped } from '../lib/honeypot.js'

// Paging for /orders/mine. Fastify coerces both from the querystring; an
// out-of-range value is a 400 by schema rather than a silently clamped read.
const ordersMineQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// Structural schema only (400 on gross violations). qty > 0 and email validity
// are checked in the handler so they can return 422 with field-level messages.
const orderRequestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    ...honeypotProperty,
    accepted_lead_time: { type: 'boolean' },
    // The client's own two numbers — what they call this job, and the PO their
    // accounts payable issued to us (`orders.client_reference` /
    // `orders.customer_po_number`, the same columns and the same 200-char
    // limits the back-office PATCH writes). Both optional — most requests carry
    // neither — but a trade client's accounts payable will not pay an invoice
    // that does not quote the PO they issued.
    client_reference: { type: 'string', maxLength: 200 },
    customer_po_number: { type: 'string', maxLength: 200 },
    // The client's own note for the quote — goes into `orders.notes`, which
    // used to hold only a packed "Name | Email" line (Userback 8373461).
    notes: { type: 'string', maxLength: 2000 },
    // Where the cloth is going, in the shape the Stripe webhook already writes
    // to `orders.shipping_address`, so the CRM's Delivery block and the packing
    // slip read both without knowing which path wrote it. Optional: a request
    // is priced before it ships, and many are collected.
    shipping_address: SHIPPING_ADDRESS_SCHEMA,
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

// Unauthenticated, writes an order row AND sends two emails per call
// (notifyRequestReceived: acknowledgement to the customer, alert to the back
// office). That is mail amplification with an attacker-chosen recipient, the
// same shape of abuse POST /contact is limited for — so it carries the same
// number.
const ORDER_REQUEST_RATE_LIMIT = Object.freeze({ max: 10, timeWindow: 15 * 60 * 1000 })

// The quote link's token: 256 bits of base64url (src/orders/quote-links.js).
// The bound only keeps a junk path from reaching the hash.
const quoteTokenParamsSchema = {
  type: 'object',
  required: ['token'],
  properties: { token: { type: 'string', minLength: 1, maxLength: 200 } },
}

const orderNumberParamsSchema = {
  type: 'object',
  required: ['order_number'],
  properties: { order_number: { type: 'string', minLength: 1, maxLength: 100 } },
}

// Accept needs no body; reject carries the reason. `['object','null']` because
// Fastify validates a body-less POST as null (the admin ship posture). Whether
// the reason is present is a 422 from validateQuoteAnswer, not a 400 here.
const quoteAnswerBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    reason: { type: ['string', 'null'], maxLength: REJECTION_REASON_MAX },
  },
}

export const orderRoutes = async (app, { pool, mailer = null }) => {
  // The client's answer to a quote, however they reached it: validate (422
  // field errors), move the order (409 unless it is still `quote_sent` — the
  // machine answers that), tell the office, and hand back the CUSTOMER shape.
  // Never the admin shape: these routes are the client's, and it carries the
  // office's notes and discount reasons.
  const answerQuote = async (request, reply, { orderId, accept, userId }) => {
    const reason = request.body?.reason ?? null
    const errors = validateQuoteAnswer({ accept, reason })
    if (errors.length > 0) {
      reply.code(422)
      return { error: 'Unprocessable Entity', message: 'Validation failed.', errors }
    }
    const answered = await respondToQuote(pool, {
      orderId,
      accept,
      reason: typeof reason === 'string' ? reason.trim() : null,
      userId,
    })
    await notifyQuoteAnswered(mailer, pool, answered, {
      accepted: accept,
      reason: answered.quote_rejection_reason,
    })
    return { order: await getCustomerOrder(pool, { id: orderId }) }
  }

  const quoteNotFound = (reply) => {
    reply.code(404)
    return { error: 'Not Found', message: 'This quote link is not valid.' }
  }

  // Public: guests may request an order. When logged in, the request is tied to
  // the user and their email is used when no contact email is supplied.
  app.post(
    '/orders/request',
    {
      schema: { body: orderRequestBodySchema },
      config: { rateLimit: ORDER_REQUEST_RATE_LIMIT },
    },
    async (request, reply) => {
      // A bot filled the hidden field: answer as if it worked, store and send
      // nothing.
      if (honeypotTripped(request)) {
        reply.code(201)
        return { order: null }
      }
      const user = await app.guards.loadOptionalUser(request)

      const errors = validateOrderRequestInput(request.body, {
        hasUser: Boolean(user),
      })
      if (errors.length > 0) {
        reply.code(422)
        return { error: 'Unprocessable Entity', message: 'Validation failed.', errors }
      }

      // Named one by one rather than spread: Ajv's `removeAdditional` strips
      // unknown keys silently, so this list — not the schema — is what decides
      // which of the body's fields ever reach a column.
      const { order } = await createOrderRequest(pool, {
        lines: request.body.lines,
        contact: request.body.contact ?? {},
        acceptedLeadTime: request.body.accepted_lead_time ?? false,
        clientReference: request.body.client_reference ?? null,
        customerPoNumber: request.body.customer_po_number ?? null,
        notes: request.body.notes ?? null,
        shippingAddress: request.body.shipping_address ?? null,
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

  // The quote page behind the `quote_sent` letter's link. Public — a guest has
  // no account — and the token IS the authorisation: 256 bits, stored hashed,
  // rotated on every send. Never an order_number + email lookup (the removed
  // /orders/lookup was exactly that). Viewable at any status once a quote has
  // gone out, so the client can see the outcome; answering is `quote_sent`
  // only. Rate-limited like /orders/request: every call is a query, and the
  // answers send mail.
  app.get(
    '/orders/quote/:token',
    {
      schema: { params: quoteTokenParamsSchema },
      config: { rateLimit: ORDER_REQUEST_RATE_LIMIT },
    },
    async (request, reply) => {
      const found = await findOrderByQuoteToken(pool, request.params.token)
      if (!found) return quoteNotFound(reply)
      return { order: await getCustomerOrder(pool, { id: found.id }) }
    }
  )

  for (const [action, accept] of [
    ['accept', true],
    ['reject', false],
  ]) {
    app.post(
      `/orders/quote/:token/${action}`,
      {
        schema: { params: quoteTokenParamsSchema, body: quoteAnswerBodySchema },
        config: { rateLimit: ORDER_REQUEST_RATE_LIMIT },
      },
      async (request, reply) => {
        const found = await findOrderByQuoteToken(pool, request.params.token)
        if (!found) return quoteNotFound(reply)
        // The link holder is the client, but not necessarily a signed-in one;
        // the trail says "Client" without naming an account.
        return answerQuote(request, reply, { orderId: found.id, accept, userId: null })
      }
    )

    // The same answer from My Account. Ownership in SQL: another client's
    // order number is a 404, exactly like one that does not exist.
    app.post(
      `/orders/mine/:order_number/${action}`,
      {
        preHandler: app.guards.requireAuth,
        schema: { params: orderNumberParamsSchema, body: quoteAnswerBodySchema },
      },
      async (request, reply) => {
        const found = await findUserOrderByNumber(pool, {
          userId: request.user.id,
          orderNumber: request.params.order_number,
        })
        if (!found) {
          reply.code(404)
          return { error: 'Not Found', message: `No order ${request.params.order_number}.` }
        }
        return answerQuote(request, reply, {
          orderId: found.id,
          accept,
          userId: request.user.id,
        })
      }
    )
  }

}
