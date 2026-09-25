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
  backOrderRaisedOrders,
  createPurchaseOrder,
  updatePurchaseOrder,
  setPurchaseOrderStatus,
  allocatePurchaseOrderLine,
} from '../purchasing/admin-purchase-orders.js'
import { createReceipt } from '../purchasing/receipts.js'
import {
  PURCHASE_ORDER_STATUSES,
  UNSENT_PURCHASE_ORDER_STATUSES,
  canTransition,
} from '../purchasing/po-states.js'
import {
  MAX_BULK_SIZE,
  sendBulkOrder,
  getBulkOrder,
  listBulkOrders,
} from '../purchasing/bulk-orders.js'
import { PDF_DOCUMENTS, documentFilename, renderPurchaseOrderPdf } from '../purchasing/po-pdf.js'
import {
  MAX_DOCUMENT_PURCHASE_ORDERS,
  buildPurchaseOrderDocument,
  documentRecipients,
  requestConsolidatedInvoice,
} from '../purchasing/invoice-statements.js'
import { NOTIFY_EMAILS_MAX, NOTIFY_EMAIL_PATTERN } from '../orders/notify-emails.js'
import { loadReportAccess } from '../reports/access.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import {
  notifyPurchaseOrderSent,
  notifyPurchaseOrderPaid,
  notifyPurchaseOrderEnded,
  notifyPurchaseOrderReceipt,
  notifyBulkOrderSent,
  pdfAttachments,
  purchaseOrderStatusTemplate,
  sendPurchaseOrderLetter,
} from '../email/purchasing-notifications.js'
import { notifyOrderTransition } from '../email/notifications.js'

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
    // One status, or a SET of them (repeated params — the dashboard's goods-
    // on-the-way tile means three at once). The orders list's anyOf posture:
    // declaring only `string` would 400 the array form.
    status: {
      anyOf: [
        { type: 'string', enum: [...PURCHASE_ORDER_STATUSES] },
        {
          type: 'array',
          minItems: 1,
          maxItems: PURCHASE_ORDER_STATUSES.length,
          items: { type: 'string', enum: [...PURCHASE_ORDER_STATUSES] },
        },
      ],
    },
    from: dateProp,
    to: dateProp,
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// `supplier_id` is optional and CHECKED, never trusted: it must be one of the
// house's suppliers (main or additional, migration 1791638400000) or the
// create is a 422. Absent means the house's main supplier. An unchecked value
// would produce no constraint violation of any kind — it would silently
// address the purchase order to the wrong house.
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['brand_id', 'lines'],
  properties: {
    brand_id: { type: 'integer', minimum: 1 },
    supplier_id: { type: ['integer', 'null'], minimum: 1 },
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
    // Named sales orders — the order page's "Create purchase order". Narrows
    // the run to their lines; on generate each is moved to back_order.
    order_ids: {
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
    { required: ['notify_emails'] },
  ],
  properties: {
    // The purchase order's Emails list (24 Sep 2026), the WHOLE list replacing
    // what was stored — the sales order's shape and limits, from the same leaf.
    notify_emails: {
      type: 'array',
      maxItems: NOTIFY_EMAILS_MAX,
      items: { type: 'string', maxLength: 254, pattern: NOTIFY_EMAIL_PATTERN },
    },
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

// The purchase orders a PDF or a statement is drawn from — one supplier's, the
// module refuses a mix (src/purchasing/invoice-statements.js).
const documentIdsProp = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_DOCUMENT_PURCHASE_ORDERS,
  items: { type: 'integer', minimum: 1 },
}

const pdfBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['purchase_order_ids'],
  properties: {
    purchase_order_ids: documentIdsProp,
    document: { type: 'string', enum: [...PDF_DOCUMENTS], default: 'order' },
  },
}

// The body is the tick list and nothing about the bill itself, which does not
// exist yet and whose number, date and total only the house can state.
const statementBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['purchase_order_ids'],
  properties: {
    purchase_order_ids: documentIdsProp,
    // Anything the office wants to say alongside — a cycle, a reference, a
    // reason. Optional, and it is the only free text that reaches the house.
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
        orderIds: request.body?.order_ids ?? null,
      })
      return { plan }
    }
  )

  // The same grouping, written. 201 because it creates documents; `blocked`
  // travels beside them so the screen can say what it could not raise.
  //
  // Raised FROM named sales orders (`order_ids`), each order that got a
  // purchase order moves to back_order, with its letter; one the machine will
  // not move (paid, say) keeps its status and is listed in `not_moved`.
  app.post(
    '/admin/purchase-orders/generate',
    { preHandler: backoffice, schema: { body: brandIdsSchema } },
    async (request, reply) => {
      const orderIds = request.body?.order_ids ?? null
      const result = await generatePurchaseOrders(pool, {
        brandIds: request.body?.brand_ids ?? null,
        orderIds,
        user: request.user,
        finance: await financeFor(request),
      })
      reply.code(201)
      if (!orderIds) return result
      const { moved, notMoved } = await backOrderRaisedOrders(pool, result.purchase_orders, {
        actor: { kind: 'staff', userId: request.user.id },
      })
      for (const order of moved) {
        await notifyOrderTransition(mailer, pool, order)
      }
      return { ...result, not_moved: notMoved }
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

  // Raise the purchase order's bill in Xero — Send PO's second half. NEVER
  // fails the move (the paid posture): a refusal — unpriced lines, Xero down,
  // not connected — comes back as `reason` for the CRM to print, and the Xero
  // screen's push button is the retry.
  const raiseBill = (id, finance) =>
    xero
      .pushPurchaseOrderBill(id, { finance })
      .then((result) => ({ bill: { raised: true, ...result.bill }, purchase_order: result.purchase_order }))
      .catch((error) => ({ bill: { raised: false, reason: error.message }, purchase_order: null }))

  // The purchase order as a PDF for a letter to the house — the same document
  // the CRM previews before Send (src/purchasing/po-pdf.js), drawn from the
  // finance view the letter itself is composed from. NEVER fails the send: a
  // render failure is logged and the letter goes without its attachment, the
  // posture every purchasing letter takes towards its move.
  const letterPdf = async (purchaseOrders, reference = null) => {
    try {
      const supplierName = purchaseOrders[0]?.supplier_name ?? null
      const issuedAt = new Date()
      const content = await renderPurchaseOrderPdf({
        document: 'order',
        purchaseOrders,
        supplierName,
        recipients: documentRecipients(null, purchaseOrders),
        reference,
        issuedAt,
      })
      return pdfAttachments({
        filename: documentFilename({ document: 'order', purchaseOrders, reference, supplierName, issuedAt }),
        content,
      })
    } catch (error) {
      app.log.error({ err: error }, 'the purchase-order PDF could not be drawn; the letter goes without it')
      return []
    }
  }

  // The letter each move sends the house (and the purchase order's Emails
  // list): Send PO the purchase order itself (its PDF attached), paid a release
  // note, completed only when SHORT, cancelled always. The others — ready to
  // send, awaiting delivery, received — are the office's own bookkeeping.
  const LETTERS = Object.freeze({
    pending_payment: async (m, po) => notifyPurchaseOrderSent(m, po, { attachments: await letterPdf([po]) }),
    paid: notifyPurchaseOrderPaid,
    completed: (m, po) => notifyPurchaseOrderEnded(m, po, 'completed'),
    cancelled: (m, po) => notifyPurchaseOrderEnded(m, po, 'cancelled'),
  })

  // Every move a purchase order makes (24 Sep 2026): Draft → Ready to send
  // (25 Sep 2026) → Pending payment (Send PO) → Paid / Awaiting delivery →
  // Received → Completed, or Cancelled. Send PO may also go straight from a
  // draft. The machine in src/purchasing/po-states.js answers 409.
  //
  // **The letter re-reads the order with `finance: true`, whatever the staffer
  // may see.** A purchase order without prices is not a purchase order, and the
  // house quoted those prices in the first place; finance masking exists so a
  // staffer without cost access does not read costs ON SCREEN, and this letter
  // is composed server-side for the house. The masked view still goes back in
  // the RESPONSE, so nothing the caller receives changes.
  app.post(
    '/admin/purchase-orders/:id/status',
    {
      preHandler: backoffice,
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['status'],
          properties: { status: { type: 'string', enum: [...PURCHASE_ORDER_STATUSES] } },
        },
      },
    },
    async (request) => {
      const finance = await financeFor(request)
      const target = request.body.status
      let purchase_order = await setPurchaseOrderStatus(pool, request.params.id, target, { finance })
      let xero_bill = null
      if (target === 'pending_payment' && xero) {
        const raised = await raiseBill(request.params.id, finance)
        if (raised.purchase_order) purchase_order = raised.purchase_order
        xero_bill = raised.bill
      }
      // After the Xero push, so the re-read carries the bill ref if one was
      // raised; the letter itself is unchanged either way.
      const letter = LETTERS[target]
      if (mailer && letter) {
        await letter(mailer, await getPurchaseOrder(pool, request.params.id, { finance: true }))
      }
      return { purchase_order, ...(xero_bill ? { xero_bill } : {}) }
    }
  )

  // The Emails panel's letters, sent NOW (24 Sep 2026: "purchase orders should
  // also have email function like sales order"): `details` is the purchase
  // order itself, `status` re-sends the letter for where it stands — to the
  // house and the Emails list. The letter IS the act, so it refuses rather than
  // no-ops (the sales order's rule): 503 with no delivering mailer, 409 on a
  // draft or a ready-to-send order (Send PO is what first sends it), 422 at a
  // status with no letter, 502 when every address failed. `details` carries
  // the purchase order's PDF, as Send PO's letter does.
  app.post(
    '/admin/purchase-orders/:id/email',
    {
      preHandler: backoffice,
      schema: {
        params: idParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['letter'],
          properties: { letter: { type: 'string', enum: ['details', 'status'] } },
        },
      },
    },
    async (request, reply) => {
      if (!mailer?.delivers) {
        reply.code(503)
        return {
          error: 'Service Unavailable',
          message: 'Email is not configured on this server (SMTP_HOST is unset), so nothing was sent.',
        }
      }
      const purchaseOrder = await getPurchaseOrder(pool, request.params.id, { finance: true })
      if (!purchaseOrder) {
        reply.code(404)
        return { error: 'Not Found', message: `Purchase order ${request.params.id} not found.` }
      }
      if (UNSENT_PURCHASE_ORDER_STATUSES.includes(purchaseOrder.status)) {
        reply.code(409)
        return {
          error: 'Conflict',
          message: `${purchaseOrder.po_number} has not been sent yet — Send PO is what emails it to the house.`,
        }
      }
      const { letter } = request.body
      if (letter === 'status' && !purchaseOrderStatusTemplate(purchaseOrder)) {
        reply.code(422)
        return {
          error: 'Unprocessable Entity',
          message: `${purchaseOrder.po_number} is ${purchaseOrder.status.replaceAll('_', ' ')} — the house is sent no letter for that status.`,
        }
      }
      const { template, sent, failed } = await sendPurchaseOrderLetter(mailer, purchaseOrder, letter, {
        attachments: letter === 'details' ? await letterPdf([purchaseOrder]) : [],
      })
      if (sent.length === 0) {
        reply.code(failed.length ? 502 : 422)
        return {
          error: failed.length ? 'Bad Gateway' : 'Unprocessable Entity',
          message: failed.length
            ? `The letter could not be sent to ${failed.join(', ')}.`
            : `${purchaseOrder.po_number} has nobody to email — add the house's PO email, or an address under Emails.`,
          template,
          sent,
          failed,
        }
      }
      return { template, sent, failed }
    }
  )

  // ---- The PDF, and the statement that asks for one invoice ---------------
  // (25 Sep 2026: "a preview ability for purchase orders before sending it —
  // generate statement creates a PDF, attaches that PDF and sends it as an
  // email"; src/purchasing/invoice-statements.js). Static paths.

  // THE PREVIEW. The PDF the office reads before pressing Send: `order` is the
  // purchase order itself (one, or a bulk order's members — what Send PO and
  // the bulk letter attach), `statement` the request for one invoice (what the
  // statement attaches). It writes nothing, and a statement preview runs every
  // refusal the send runs, so a preview that draws is a statement that will
  // go. Drawn with the CALLER's finance grant: a login that may not see costs
  // gets the quantities and a line saying the prices are withheld.
  app.post(
    '/admin/purchase-orders/pdf',
    { preHandler: backoffice, schema: { body: pdfBodySchema } },
    async (request, reply) => {
      const { pdf, filename } = await buildPurchaseOrderDocument(pool, {
        purchaseOrderIds: request.body.purchase_order_ids,
        document: request.body.document ?? 'order',
        finance: await financeFor(request),
        replyTo: mailer?.backofficeEmail ?? null,
      })
      reply
        .type('application/pdf')
        .header('Content-Disposition', `inline; filename="${filename}"`)
        .header('Cache-Control', 'no-store')
      return pdf
    }
  )

  // Ask one house for ONE invoice covering the purchase orders named, with the
  // statement attached as a PDF — what the supplier-invoice screens' "Ask for
  // one invoice" did, moved beside the bulk order (25 Sep 2026). A VERB AND
  // NOT A CREATE: it writes no invoice, only the contact-log entry that records
  // the office asked. Refused whole, never narrowed; 503 with no delivering
  // mailer, 502 when every address failed.
  app.post(
    '/admin/purchase-orders/statement',
    { preHandler: backoffice, schema: { body: statementBodySchema } },
    async (request) =>
      requestConsolidatedInvoice(pool, mailer, {
        purchaseOrderIds: request.body.purchase_order_ids,
        notes: request.body.notes ?? null,
        // The session, never the body — who chased a house is not the caller's
        // to state.
        user: request.user,
      })
  )

  // ---- Bulk orders: one letter to a house for several purchase orders ------
  // (24 Sep 2026; src/purchasing/bulk-orders.js). Static paths, so they win
  // over `/admin/purchase-orders/:id`.
  app.get('/admin/purchase-orders/bulk', { preHandler: backoffice }, async () => ({
    bulk_orders: await listBulkOrders(pool),
  }))

  app.get(
    '/admin/purchase-orders/bulk/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const bulk_order = await getBulkOrder(pool, request.params.id, {
        finance: await financeFor(request),
      })
      if (!bulk_order) {
        reply.code(404)
        return { error: 'Not Found', message: `Bulk order ${request.params.id} not found.` }
      }
      return { bulk_order }
    }
  )

  // Send the chosen ready-to-send purchase orders of ONE supplier as a bulk
  // order: every member moves to Pending payment in one transaction, then each
  // member's Xero bill is raised and ONE combined letter goes to the house
  // (+ every member's Emails list, + the office's copy), the bulk order's PDF
  // attached. 201.
  app.post(
    '/admin/purchase-orders/bulk',
    {
      preHandler: backoffice,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['purchase_order_ids'],
          properties: {
            purchase_order_ids: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BULK_SIZE,
              items: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const finance = await financeFor(request)
      const bulkId = await sendBulkOrder(pool, {
        purchaseOrderIds: request.body.purchase_order_ids,
        user: request.user,
      })
      const xero_bills = []
      if (xero) {
        const { purchase_orders: members } = await getBulkOrder(pool, bulkId, { finance: true })
        for (const member of members) {
          xero_bills.push({ po_number: member.po_number, ...(await raiseBill(member.id, finance)).bill })
        }
      }
      // Read after the bills, so the letter and the answer carry each bill ref.
      const bulk = await getBulkOrder(pool, bulkId, { finance: true })
      if (mailer) {
        await notifyBulkOrderSent(mailer, bulk, bulk.purchase_orders, {
          attachments: await letterPdf(bulk.purchase_orders, bulk.bulk_number),
        })
      }
      reply.code(201)
      return {
        bulk_order: finance ? bulk : await getBulkOrder(pool, bulkId, { finance }),
        ...(xero ? { xero_bills } : {}),
      }
    }
  )

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
  // on the sample" instead of the flow failing silently. `stock` is the
  // colourway's shelf after the receipt moved it (null for a sample line).
  app.post(
    '/admin/purchase-order-lines/:id/receipts',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: receiptBodySchema } },
    async (request, reply) => {
      const { receipt, purchase_order_id, sample_register, stock } = await createReceipt(
        pool,
        request.params.id,
        request.body,
        { user: request.user }
      )
      const finance = await financeFor(request)
      let purchase_order = await getPurchaseOrder(pool, purchase_order_id, { finance })
      // The last line booked in full moves the order to Received (24 Sep 2026),
      // where the machine allows it; a reversal moves nothing back — the
      // receipt state beside the status still says what is on the shelf.
      if (
        ['full', 'over'].includes(purchase_order.receipt_state) &&
        canTransition(purchase_order.status, 'received')
      ) {
        purchase_order = await setPurchaseOrderStatus(pool, purchase_order_id, 'received', {
          finance,
        })
      }
      // BACK OFFICE ONLY. The house knows what it shipped; what this alert
      // carries is the discrepancy — an over-receipt is never clamped, and a
      // mis-key is reversed with a negative qty. Both are conversations for
      // inside the building.
      await notifyPurchaseOrderReceipt(mailer, purchase_order, receipt)
      reply.code(201)
      return { receipt, sample_register, stock, purchase_order }
    }
  )
}
