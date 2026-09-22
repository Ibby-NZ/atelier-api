// Back-office purchase-order endpoints (W13-US-006/US-007/US-008). All routes
// are `requireRole('backoffice')` (director inherits). Handlers stay thin — the
// state machine, the derivation and every rule live in ../purchasing/.
//
// VERBS, NOT STATUS PATCHES, wherever a move writes two tables or writes a state
// and the stamp that dates it. `send`, `close` and `cancel` each write `status`
// AND its timestamp, and `cancel` additionally releases every live allocation
// back to the order desk — three tables' worth of meaning that a
// `PATCH { status }` would let a screen assert half of. `status` is therefore
// absent from the PATCH schema and from `PURCHASE_ORDER_UPDATE_COLUMNS`; Ajv's
// `removeAdditional` strips it rather than rejecting it, so the whitelist is the
// real gate. Same rule `POST /admin/sample-orders/:id/transition` follows.
//
// COST FIGURES ARE FINANCE-GATED, and the gate is `loadReportAccess(pool, user)`
// — never `reportAccess(request.user)`. `src/auth/guards.js` loads `request.user`
// through `PUBLIC_USER_COLUMNS`, which carries no `can_view_finance`, so reading
// it off the request yields `undefined` and answers false to everyone for ever.
// It is a primary-key lookup keyed on the id the SESSION resolved and it costs
// nothing worth optimising.
//
// `plan` and `generate` are separate paths on purpose: a dry run that writes
// nothing is what makes the derivation something the office will run at 5pm
// rather than something they are afraid of.

import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  listPurchaseOrders,
  getPurchaseOrder,
  planPurchaseOrdersFromOrders,
  generatePurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrder,
  sendPurchaseOrder,
  payPurchaseOrder,
  closePurchaseOrder,
  cancelPurchaseOrder,
  allocatePurchaseOrderLine,
} from '../purchasing/admin-purchase-orders.js'
import { createReceipt } from '../purchasing/receipts.js'
import { PURCHASE_ORDER_STATUSES } from '../purchasing/po-states.js'
import { loadReportAccess } from '../reports/access.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import {
  notifyPurchaseOrderSent,
  notifyPurchaseOrderEnded,
  notifyPurchaseOrderReceipt,
} from '../email/purchasing-notifications.js'

const MAX_LINES = 200

// :id is coerced to an integer by Fastify; a non-numeric id is a 400 by schema.
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

// Fastify's bundled Ajv carries no `format` keywords (the same reason the auth
// schemas use EMAIL_PATTERN), so a date is an explicit pattern. It can only
// police the SHAPE — `2026-02-31` passes and arrives as a pg 22007, which the
// modules map to a 422 rather than letting it surface as a 500.
const timestampProp = {
  type: ['string', 'null'],
  pattern: '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$',
}
const dateProp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const nullableText = { type: ['string', 'null'], maxLength: 2000 }
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
const qtyProp = { type: 'number', exclusiveMinimum: 0 }
// numeric(12,4), CHECK unit_price IS NULL OR unit_price >= 0. Nullable and
// `minimum: 0` rather than `exclusiveMinimum`: NULL is "nobody has priced this"
// and 0 is "free, and we know it", and they are different facts.
const unitPriceProp = { type: ['number', 'null'], minimum: 0 }

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier_id: { type: 'integer', minimum: 1 },
    brand_id: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: [...PURCHASE_ORDER_STATUSES] },
    from: dateProp,
    to: dateProp,
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// `supplier_id` is deliberately not a property here and must never become one.
// It is DERIVED from `brands.supplier_id`; a client-chosen value produces no
// constraint violation and no error of any kind, it silently addresses the
// purchase order to the wrong house.
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['brand_id', 'lines'],
  properties: {
    brand_id: { type: 'integer', minimum: 1 },
    expected_at: timestampProp,
    notes: nullableText,
    lines: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_LINES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['colourway_id', 'qty_ordered'],
        properties: {
          colourway_id: { type: 'integer', minimum: 1 },
          qty_ordered: qtyProp,
          unit_price: unitPriceProp,
          // C18: a hanger or cutting bought on the same paper as the cloth.
          // DECLARED here because Ajv's removeAdditional would otherwise strip
          // both keys silently and every sample line would land as goods. The
          // barcode is a reference by value into the samples register — the
          // migration header says why it is not an FK.
          is_sample: { type: 'boolean' },
          sample_barcode: nullableShort,
          supplier_code: nullableShort,
          notes: nullableText,
        },
      },
    },
  },
}

const brandIdsSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    brand_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'integer', minimum: 1 },
    },
  },
}

// `anyOf` demands at least one key: Ajv strips unknown ones rather than
// rejecting them, so a body of nothing but unknown keys must still be a 400.
const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  anyOf: [
    { required: ['expected_at'] },
    { required: ['notes'] },
    { required: ['po_email'] },
    { required: ['agent'] },
    { required: ['incoterm'] },
    { required: ['currency'] },
    { required: ['lines'] },
  ],
  properties: {
    expected_at: timestampProp,
    notes: nullableText,
    po_email: nullableShort,
    agent: nullableShort,
    incoterm: nullableShort,
    currency: nullableShort,
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
          qty_ordered: qtyProp,
          unit_price: unitPriceProp,
          // Correctable, like the rest of the paper: a goods line keyed without
          // its sample tick, or a mistyped tag. The module refuses turning a
          // line that covers sales demand into a sample.
          is_sample: { type: 'boolean' },
          sample_barcode: nullableShort,
          supplier_code: nullableShort,
          notes: nullableText,
        },
      },
    },
  },
}

const allocationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['order_line_id', 'qty'],
  properties: {
    order_line_id: { type: 'integer', minimum: 1 },
    qty: qtyProp,
  },
}

// `qty` is a plain number with NO minimum and NO maximum, and both absences are
// the story. A NEGATIVE receipt is how a mistake is reversed — the database's
// `CHECK (qty <> 0)` is the enforcement and the module answers 422 for zero —
// and there is no upper bound because OVER-RECEIPT IS LEGITIMATE: suppliers
// over-ship rolls, and a clamp destroys a fact about the warehouse.
const receiptBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['qty'],
  properties: {
    qty: { type: 'number' },
    received_at: timestampProp,
    consignment_ref: nullableShort,
    notes: nullableText,
  },
}

export const adminPurchaseOrderRoutes = async (app, { pool, mailer = null, xero = null }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // Whether this login may see cost figures. Resolved per request from the row
  // the session id names, never from anything the caller sent.
  const financeFor = async (request) => (await loadReportAccess(pool, request.user)).finance

  app.get(
    '/admin/purchase-orders',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { supplier_id, brand_id, status, from, to, page, limit } = request.query
      const { purchase_orders, total } = await listPurchaseOrders(pool, {
        supplierId: supplier_id,
        brandId: brand_id,
        status,
        from,
        to,
        page,
        limit,
        finance: await financeFor(request),
      })
      return { purchase_orders, meta: { total, page, limit } }
    }
  )

  // THE DRY RUN. Writes nothing, and that is asserted rather than promised:
  // `planPurchaseOrdersFromOrders` issues one SELECT and hands it to a pure
  // planner. A house with no supplier comes back in `blocked` naming itself,
  // which on today's data is most of them — that is the backfill's state
  // surfacing where it can be scheduled, not a fault.
  app.post(
    '/admin/purchase-orders/plan',
    { preHandler: backoffice, schema: { body: brandIdsSchema } },
    async (request) => {
      const plan = await planPurchaseOrdersFromOrders(pool, {
        brandIds: request.body?.brand_ids ?? null,
      })
      return { plan }
    }
  )

  // The same grouping, written. 201 because it creates documents; `blocked`
  // travels beside them so the screen can say what it could not raise.
  app.post(
    '/admin/purchase-orders/generate',
    { preHandler: backoffice, schema: { body: brandIdsSchema } },
    async (request, reply) => {
      const result = await generatePurchaseOrders(pool, {
        brandIds: request.body?.brand_ids ?? null,
        user: request.user,
        finance: await financeFor(request),
      })
      reply.code(201)
      return result
    }
  )

  app.post(
    '/admin/purchase-orders',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      const purchase_order = await createPurchaseOrder(pool, request.body, {
        user: request.user,
        finance: await financeFor(request),
      })
      reply.code(201)
      return { purchase_order }
    }
  )

  app.get(
    '/admin/purchase-orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const purchase_order = await getPurchaseOrder(pool, request.params.id, {
        finance: await financeFor(request),
      })
      if (!purchase_order) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Purchase order ${request.params.id} not found.`,
        }
      }
      return { purchase_order }
    }
  )

  app.patch(
    '/admin/purchase-orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchBodySchema } },
    async (request) => ({
      purchase_order: await updatePurchaseOrder(pool, request.params.id, request.body, {
        finance: await financeFor(request),
      }),
    })
  )

  // The four moves, and the letters that hang off three of them. `send` writes
  // to the house and copies the office; `close`/`cancel` write to the house
  // alone (src/email/purchasing-notifications.js). `pay` mails nobody — it
  // records a fact about the bank, not a change the house needs telling. A
  // `draft` deliberately mails nobody — nothing has left the building until Send.
  //
  // **The notification re-reads the order with `finance: true`, whatever the
  // staffer may see.** A purchase order without prices is not a purchase order,
  // and the house quoted those prices in the first place; finance masking
  // exists so a staffer without cost access does not read costs ON SCREEN, and
  // this letter is composed server-side for the house and the one configured
  // back-office address. The masked view still goes back in the RESPONSE, so
  // nothing the caller receives changes.
  for (const [verb, move, notify] of [
    ['send', sendPurchaseOrder, notifyPurchaseOrderSent],
    ['pay', payPurchaseOrder, null],
    ['close', closePurchaseOrder, (m, po) => notifyPurchaseOrderEnded(m, po, 'closed')],
    ['cancel', cancelPurchaseOrder, (m, po) => notifyPurchaseOrderEnded(m, po, 'cancelled')],
  ]) {
    app.post(
      `/admin/purchase-orders/:id/${verb}`,
      { preHandler: backoffice, schema: { params: idParamsSchema } },
      async (request) => {
        const finance = await financeFor(request)
        let purchase_order = await move(pool, request.params.id, { finance })
        // Sending is the commitment, so the bill is raised in Xero here. The
        // transition NEVER fails because of Xero (the `mark-paid` posture):
        // a refusal — unpriced lines, Xero down, not connected — comes back as
        // `xero_bill.reason` for the CRM to print, and the Xero screen's push
        // button is the retry.
        let xero_bill = null
        if (verb === 'send' && xero) {
          xero_bill = await xero
            .pushPurchaseOrderBill(request.params.id, { finance })
            .then((result) => {
              purchase_order = result.purchase_order
              return { raised: true, ...result.bill }
            })
            .catch((error) => ({ raised: false, reason: error.message }))
        }
        // The letter goes after the Xero push so the re-read carries the bill
        // ref if one was raised; the letter itself is unchanged either way.
        if (mailer && notify) {
          await notify(mailer, await getPurchaseOrder(pool, request.params.id, { finance: true }))
        }
        return { purchase_order, ...(xero_bill ? { xero_bill } : {}) }
      }
    )
  }

  // Hard delete, refused once anything hangs off the order (FR-147). The
  // registry entry holds the probes, so this handler is one line — and
  // `'purchase_order'` is a single-quoted literal, never a path parameter,
  // because the registry is not an authorisation boundary.
  app.delete(
    '/admin/purchase-orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'purchase_order', request.params.id, {
          user: request.user,
        })
      )
  )

  // Cover a sales-order line off an existing purchase-order line — the case the
  // derivation cannot reach, where stock was bought first and a client asked for
  // it afterwards. The `SUM(qty) <= qty_ordered` rule and the one-purchase-order-
  // per-sales-line index are both enforced under the module's row lock.
  app.post(
    '/admin/purchase-order-lines/:id/allocations',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: allocationBodySchema } },
    async (request, reply) => {
      const purchase_order = await allocatePurchaseOrderLine(
        pool,
        request.params.id,
        request.body,
        { finance: await financeFor(request) }
      )
      reply.code(201)
      return { purchase_order }
    }
  )

  // Book goods in. APPEND-ONLY: there is no PATCH and no DELETE here, and there
  // must never be one — a mistake is reversed with a negative `qty`. The whole
  // purchase order comes back so the receipting screen re-renders off one shape.
  // `sample_register` travels beside it (C18): which register rows the receipt
  // valued by barcode, and — the actionable half — which barcodes matched no
  // register row, so the screen can say "register the tag, then key the value
  // on the sample" instead of the flow failing silently.
  app.post(
    '/admin/purchase-order-lines/:id/receipts',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: receiptBodySchema } },
    async (request, reply) => {
      const { receipt, purchase_order_id, sample_register } = await createReceipt(
        pool,
        request.params.id,
        request.body,
        { user: request.user }
      )
      const purchase_order = await getPurchaseOrder(pool, purchase_order_id, {
        finance: await financeFor(request),
      })
      // BACK OFFICE ONLY. The house knows what it shipped; what this alert
      // carries is the discrepancy — an over-receipt is never clamped, and a
      // mis-key is reversed with a negative qty. Both are conversations for
      // inside the building.
      await notifyPurchaseOrderReceipt(mailer, purchase_order, receipt)
      reply.code(201)
      return { receipt, sample_register, purchase_order }
    }
  )
}
