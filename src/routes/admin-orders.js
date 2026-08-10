// Back-office order management endpoints (US-014). All routes are backoffice-only
// (director inherits backoffice via the role guard). Business rules and the state
// machine live in ../orders/admin-orders.js; these handlers stay thin.

import {
  ORDER_STATUSES,
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
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import { notifyOrderTransition } from '../email/notifications.js'

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ORDER_STATUSES },
    include_archived: { type: 'boolean', default: false },
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
  ],
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

export const adminOrderRoutes = async (app, { pool, mailer = null }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/orders',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const orders = await listAdminOrders(pool, {
        status: request.query.status,
        includeArchived: request.query.include_archived,
      })
      return { orders }
    }
  )

  // A sales order the back office keys itself — a phone call, a walk-in, a
  // bespoke enquiry. It lands in the same queue as a storefront request, in
  // 'requested', holding a reservation, and drives the same lifecycle from there.
  app.post(
    '/admin/orders',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      const order = await createManualOrder(pool, request.body)
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
      const order = await editOrderLines(pool, request.params.id, request.body)
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
      return { order }
    }
  )

  app.post(
    '/admin/orders/:id/ship',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => {
      const order = await shipOrder(pool, request.params.id)
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
