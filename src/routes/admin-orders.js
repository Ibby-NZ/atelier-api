// Back-office order management endpoints (US-014). All routes are backoffice-only
// (director inherits backoffice via the role guard). Business rules and the state
// machine live in ../orders/admin-orders.js; these handlers stay thin.

import { withGst } from '../orders/gst.js'
import {
  ORDER_STATUSES,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  PRICE_TYPES,
  listAdminOrders,
  getAdminOrder,
  createManualOrder,
  editOrderLines,
  confirmOrder,
  markOrderPaid,
  shipOrder,
  declineOrder,
  setOrderArchived,
} from '../orders/admin-orders.js'
import { parseOrderFilters } from '../orders/order-filters.js'
// The delivery address's shape lives beside the trimmer that stores it, so this
// route and the storefront's request route cannot drift apart on it.
import { SHIPPING_ADDRESS_SCHEMA } from '../orders/order-request.js'
// The single source of truth for the kind vocabulary — retyping it here is how
// the CHECK and the filter drift apart on the next kind.
import { ORDER_KINDS } from '../reports/filters.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import { notifyOrderTransition, notifyOrderCreated } from '../email/notifications.js'

// A shape check, not the whitelist: src/orders/order-filters.js decides which
// filters exist and what a value may be (an unknown name is ignored, an unusable
// value is a 400 naming it), because Ajv's `removeAdditional` strips unknown
// keys rather than rejecting them. `maximum: MAX_LIMIT` is the one thing only
// the schema can do — it makes an over-large limit a 400 instead of a silent
// clamp reporting a page size nobody asked for.
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // A single status, or a SET of them (repeated params — the dashboard's
    // Open tile means requested+confirmed+paid at once). Same anyOf posture as
    // `brand` in admin-reports.js: declaring only `string` would 400 the array
    // form before the handler ever saw it.
    status: {
      anyOf: [
        { type: 'string', enum: ORDER_STATUSES },
        {
          type: 'array',
          minItems: 1,
          maxItems: ORDER_STATUSES.length,
          items: { type: 'string', enum: ORDER_STATUSES },
        },
      ],
    },
    kind: { type: 'string', enum: ORDER_KINDS },
    include_archived: { type: 'boolean', default: false },
    q: { type: 'string', maxLength: 200 },
    client: { type: 'string', maxLength: 200 },
    reference: { type: 'string', maxLength: 200 },
    po_number: { type: 'string', maxLength: 200 },
    from: { type: 'string', maxLength: 10 },
    to: { type: 'string', maxLength: 10 },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
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

const MAX_LINES = 100

// Money is integer cents everywhere on the wire; the CRM converts to and from
// dollars at its inputs.
const priceProp = { type: 'integer', minimum: 0 }
const qtyProp = { type: 'number', exclusiveMinimum: 0 }
const cutProp = { type: ['string', 'null'], maxLength: 2000 }

// The manual pricing override (Rebecca-R2). The schema pins only the shape a
// database CHECK also pins (0–100); the POLICY — 0/5/10 for any back-office
// user, anything else director-only and carrying a reason — lives in
// src/orders/discounts.js, because only the handler knows the caller's role.
// Both keys MUST be here as well as in the module: Ajv's `removeAdditional`
// would otherwise strip them silently and the discount would simply never
// arrive.
const discountPctProp = { type: 'number', minimum: 0, maximum: 100 }
const discountReasonProp = { type: ['string', 'null'], maxLength: 2000 }
// A reason may not travel alone — it is set (or cleared) WITH the percentage
// it justifies, so a body carrying only `discount_reason` is a 400 rather
// than a key `applyDiscount` would silently ignore.
const discountDependencies = { discount_reason: ['discount_pct'] }

// The vocabulary comes from the module, never retyped here: the CHECK, the enum
// and the CRM's dropdown are one list or they drift on the next value.
const priceTypeProp = { type: 'string', enum: [...PRICE_TYPES] }

// Editing an order: quantities, prices, cut requirements, lines added or
// removed, and the contact header. Every key is optional and `anyOf` demands at
// least one — Ajv runs `removeAdditional`, so an unknown key is stripped rather
// than rejected and a body of nothing but unknown keys must still be a 400.
//
// The old qty-only body (`{ lines: [{ id, qty }] }`) still validates: `qty` is
// simply one of the properties a line edit may carry now.
const editBodySchema = {
  type: 'object',
  additionalProperties: false,
  anyOf: [
    { required: ['lines'] },
    { required: ['add_lines'] },
    { required: ['remove_line_ids'] },
    { required: ['notes'] },
    { required: ['guest_email'] },
    { required: ['contact_phone'] },
    { required: ['client_reference'] },
    { required: ['customer_po_number'] },
    { required: ['price_type'] },
    // Deliberately no `discount_reason` member: a reason alone changes nothing
    // (see discountDependencies), so it cannot be the key that makes a body
    // non-empty.
    { required: ['discount_pct'] },
    { required: ['sales_rep_user_id'] },
    { required: ['shipping_address'] },
  ],
  dependencies: discountDependencies,
  properties: {
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        // The id alone changes nothing, so a line edit must say what to change.
        minProperties: 2,
        properties: {
          id: { type: 'integer', minimum: 1 },
          qty: qtyProp,
          unit_price_cents: priceProp,
          cut_requirements: cutProp,
        },
      },
    },
    add_lines: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['colourway_id', 'qty', 'unit_price_cents'],
        properties: {
          colourway_id: { type: 'integer', minimum: 1 },
          qty: qtyProp,
          unit_price_cents: priceProp,
          cut_requirements: cutProp,
        },
      },
    },
    remove_line_ids: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_LINES,
      items: { type: 'integer', minimum: 1 },
    },
    notes: { type: ['string', 'null'], maxLength: 2000 },
    guest_email: { type: ['string', 'null'], maxLength: 254 },
    contact_phone: { type: ['string', 'null'], maxLength: 50 },
    // The client's own two numbers (US-006). Both nullable — an explicit null
    // (or an empty string, which the module folds to null) clears them.
    client_reference: { type: ['string', 'null'], maxLength: 200 },
    customer_po_number: { type: ['string', 'null'], maxLength: 200 },
    // Which price list the order was written off. NOT nullable, unlike the two
    // above: the column is NOT NULL, so a null here would reach Postgres as a
    // 23502 and surface as a 500 rather than the 400 an enum answers with.
    price_type: priceTypeProp,
    discount_pct: discountPctProp,
    discount_reason: discountReasonProp,
    // Staff-asserted attribution (A6 groundwork): null clears it. Must be
    // declared here as well as in the module — Ajv's removeAdditional would
    // otherwise strip it silently and the rep would simply never arrive.
    sales_rep_user_id: { type: ['integer', 'null'], minimum: 1 },
    // The delivery details, corrected on the order page (Edit delivery). Sent
    // alone it is accepted until the order ships; null clears it. The same
    // shape the create body and the storefront request take.
    shipping_address: SHIPPING_ADDRESS_SCHEMA,
  },
}

// Creating a sales order the office keyed itself. Attribution is either an
// account or a walk-in's contact details — which of the two is present is a
// business rule (422 from the module), not something the schema can express,
// since either may legitimately be absent on its own.
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  dependencies: discountDependencies,
  properties: {
    user_id: { type: 'integer', minimum: 1 },
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
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['colourway_id', 'qty', 'unit_price_cents'],
        properties: {
          colourway_id: { type: 'integer', minimum: 1 },
          qty: qtyProp,
          unit_price_cents: priceProp,
          cut_requirements: cutProp,
        },
      },
    },
    notes: { type: ['string', 'null'], maxLength: 2000 },
    // Absent means the column default (retail) — the office states the basis
    // when it knows it, and edits it on the order when it changes.
    price_type: priceTypeProp,
    // Where the cloth is going. The CRM fills it from the client's own record
    // when the client it picked has an address on file — the order desk should
    // not retype what the client roster already holds — and it lands in the
    // same column the webhook and the storefront request write.
    shipping_address: SHIPPING_ADDRESS_SCHEMA,
    discount_pct: discountPctProp,
    discount_reason: discountReasonProp,
    sales_rep_user_id: { type: 'integer', minimum: 1 },
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

// Shipping takes an OPTIONAL courier link — the office hand-delivers plenty of
// orders, and the ship transition must not start demanding one. The type is
// `['object','null']` rather than `'object'` because Fastify validates a
// body-less POST as null: declaring only `object` would 400 every ship the CRM
// sends today.
//
// `https?://` is the whole validation and it lives in the schema, so a bad
// value is Fastify's own 400 rather than a hand-rolled one. It has to be
// validated somewhere: the shipped letter puts this string in a client's inbox
// as a link, and `javascript:…` or a bare `nzpost.co.nz` is either dangerous or
// simply broken. The empty alternative is the header-field rule again (FR-127):
// a text input sends `''` when a person types nothing, and that means "hand
// delivered", not "bad URL" — the handler folds it to null.
const shipBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    tracking_url: { type: 'string', maxLength: 500, pattern: '^(https?://.*)?$' },
  },
}

export const adminOrderRoutes = async (
  app,
  { pool, mailer = null, lineAmountTypes = 'Exclusive', xero = null }
) => {
  const backoffice = app.guards.requireRole('backoffice')

  // Every order this plugin answers with carries its GST figures. Added at
  // serialisation rather than in each of the dozen handlers because the figure
  // is a function of the total and the Xero basis, not of which route produced
  // the order — see src/orders/gst.js. Encapsulated: this hook sees only
  // responses from routes registered in this plugin.
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (!payload || typeof payload !== 'object') return payload
    if (Array.isArray(payload.orders)) {
      return { ...payload, orders: payload.orders.map((order) => withGst(order, lineAmountTypes)) }
    }
    if (payload.order) {
      return { ...payload, order: withGst(payload.order, lineAmountTypes) }
    }
    return payload
  })

  app.get(
    '/admin/orders',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { page, limit } = request.query
      const { orders, total } = await listAdminOrders(pool, {
        kind: request.query.kind,
        status: request.query.status,
        includeArchived: request.query.include_archived,
        // Throws a 400 naming the filter when a value is unusable; Fastify
        // serialises a { statusCode } error, so there is no try/catch here.
        filters: parseOrderFilters(request.query),
        page,
        limit,
      })
      return { orders, meta: { total, page, limit } }
    }
  )

  // A sales order the back office keys itself — a phone call, a walk-in, a
  // bespoke enquiry. It lands in the same queue as a storefront request, in
  // 'requested', holding a reservation, and drives the same lifecycle from there.
  app.post(
    '/admin/orders',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      // request.user rides along for the discount gate: the route guard admits
      // all of backoffice (director inherits), so only the handler's view of
      // the caller's role can hold the director-only line — the admin-users
      // self-protection posture. It also stamps `discount_applied_by`.
      const order = await createManualOrder(pool, request.body, request.user)
      // The client's confirmation goes out at CREATION (US-005) and the back
      // office is alerted at the same moment (US-004) — this path notified
      // nobody at all before. Never fails the order: the mailer swallows
      // delivery errors and is a no-op when null.
      await notifyOrderCreated(mailer, pool, order)
      reply.code(201)
      return { order }
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
      // The actor, for the same two reasons as the create route above.
      const order = await editOrderLines(
        pool,
        request.params.id,
        request.body,
        request.user
      )
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
      await notifyOrderTransition(mailer, pool, order)
      return { order }
    }
  )

  app.post(
    '/admin/orders/:id/mark-paid',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => {
      const order = await markOrderPaid(pool, request.params.id)
      await notifyOrderTransition(mailer, pool, order)
      // The invoice in Xero follows the order: marking it paid here records
      // the payment there (client feedback, 16 Sep 2026 — "xero invoice should
      // be marked as paid when the order is paid"). Never fails the
      // transition: the order IS paid, whatever Xero said, so a refusal comes
      // back as `xero_payment.reason` for the CRM to print beside the toast.
      // Absent when Xero is not configured, so an un-integrated deployment's
      // answer is unchanged.
      const xeroPayment = xero
        ? await xero.recordOrderPayment(order.id).catch((error) => ({
            recorded: false,
            reason: error?.message || 'Xero did not record the payment.',
          }))
        : null
      return { order, ...(xeroPayment ? { xero_payment: xeroPayment } : {}) }
    }
  )

  app.post(
    '/admin/orders/:id/ship',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: shipBodySchema },
    },
    async (request) => {
      const order = await shipOrder(pool, request.params.id, {
        // `|| null`, not `?? null`: '' is the CRM's "left blank", and a stored
        // '' is an absence every `IS NULL` read misses (FR-127).
        trackingUrl: request.body?.tracking_url || null,
      })
      // The shipped letter carries the link (src/email/templates.js) — which is
      // why the URL is written before this line, not alongside it.
      await notifyOrderTransition(mailer, pool, order)
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

  // Archive / restore. Archiving tidies a finished order out of the queue; it is
  // a soft delete (sets archived_at) and reversible. A reserving order must be
  // shipped or declined first (else 409) so no live reservation is stranded.
  app.post(
    '/admin/orders/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({ order: await setOrderArchived(pool, request.params.id, true) })
  )
  app.post(
    '/admin/orders/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({ order: await setOrderArchived(pool, request.params.id, false) })
  )

  // Hard delete, for an order that is not yet a financial record: a mis-keyed
  // sales order, a request nobody priced, a declined one. The registry entry
  // holds the rule (`orderGuard`) and the reservation release (`beforeDelete`),
  // so this handler is one line — and `'order'` is a single-quoted literal,
  // never a path parameter, because the registry is not an authorisation
  // boundary. Anything refused here archives instead.
  app.delete(
    '/admin/orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'order', request.params.id, { user: request.user })
      )
  )
}
