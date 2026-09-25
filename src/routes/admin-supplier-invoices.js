// Back-office supplier-invoice endpoints (W14-US-003/US-004/US-005). All routes
// are `requireRole('backoffice')` (director inherits), and every money figure on
// them is finance-gated on top of that guard.
//
// VERBS, NOT A STATUS PATCH, WHERE A MOVE WRITES TWO TABLES.
// `POST /:id/allocations` and `DELETE /:id/allocations/:poId` are routes of
// their own because attaching a purchase order to a bill is an act with its own
// refusals (the 409 for one already invoiced, the 422 for another house's) and
// its own attribution — not a field on a form somebody saves. `status` IS on the
// PATCH, and that is the same rule rather than an exception to it: it writes one
// column of one row, dates nothing and is a judgement a person makes.
//
// COST FIGURES ARE FINANCE-GATED, and the gate is `loadReportAccess(pool, user)`
// — never `reportAccess(request.user)`. `src/auth/guards.js` loads
// `request.user` through `PUBLIC_USER_COLUMNS`, which carries no
// `can_view_finance`, so reading it off the request yields `undefined` and
// answers false to everyone for ever. It is a primary-key lookup keyed on the id
// the SESSION resolved.
//
// `/unbilled` IS A STATIC SEGMENT BEFORE `/:id`, and Fastify's radix router
// prefers the static one — the same shape `/admin/purchase-orders/plan` already
// relies on.
//
// THE CRM NO LONGER DRAWS THESE (25 Sep 2026: "Supplier invoice page and
// sections should be removed, ask for invoice should be merged with bulk
// purchase orders"). The routes and the tables stay — the bills already keyed
// are records, and a purchase order on one still refuses a statement (409) —
// but the statement itself moved to `POST /admin/purchase-orders/statement`
// (src/routes/admin-purchase-orders.js), where it is sent as a PDF.

import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SUPPLIER_INVOICE_STATUSES,
  listSupplierInvoices,
  listUnbilledPurchaseOrders,
  getSupplierInvoice,
  createSupplierInvoice,
  updateSupplierInvoice,
  attachPurchaseOrder,
  detachPurchaseOrder,
} from '../purchasing/supplier-invoices.js'
import { PURCHASE_ORDER_STATUSES } from '../purchasing/po-states.js'
import { loadReportAccess } from '../reports/access.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

const allocationParamsSchema = {
  type: 'object',
  required: ['id', 'poId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    poId: { type: 'integer', minimum: 1 },
  },
}

// Fastify's bundled Ajv carries no `format` keywords (the same reason the auth
// schemas use EMAIL_PATTERN), so a date is an explicit pattern. It can only
// police the SHAPE — `2026-02-31` passes and arrives as a pg 22007, which the
// module maps to a 422 rather than letting it surface as a 500.
const dateProp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const nullableText = { type: ['string', 'null'], maxLength: 2000 }
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
// numeric(12,4), CHECK >= 0. `minimum: 0` rather than `exclusiveMinimum`: a
// zero-value replacement consignment is real, and NULL ("not stated") and 0
// ("stated as nil") are different facts.
const moneyProp = { type: 'number', minimum: 0 }
const nullableMoneyProp = { type: ['number', 'null'], minimum: 0 }
// Recorded raw and never interpreted — nothing in this API multiplies by it.
const fxProp = { type: ['number', 'null'], exclusiveMinimum: 0 }

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier_id: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: [...SUPPLIER_INVOICE_STATUSES] },
    from: dateProp,
    to: dateProp,
    q: { type: 'string', maxLength: 200 },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// The matching search (FR-158). Where a house does not quote Atelier's
// purchase-order numbers on its consolidated bill, the office matches by date
// and amount — so this is a SEARCH and not a join, and `q` is one filter among
// several rather than the model.
const unbilledQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    supplier_id: { type: 'integer', minimum: 1 },
    brand_id: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: [...PURCHASE_ORDER_STATUSES] },
    from: dateProp,
    to: dateProp,
    q: { type: 'string', maxLength: 200 },
    amount_min: moneyProp,
    amount_max: moneyProp,
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier_id', 'invoice_number', 'invoice_date', 'total_amount'],
  properties: {
    supplier_id: { type: 'integer', minimum: 1 },
    invoice_number: { type: 'string', minLength: 1, maxLength: 200 },
    invoice_date: dateProp,
    currency: nullableShort,
    total_amount: moneyProp,
    freight_amount: nullableMoneyProp,
    duty_amount: nullableMoneyProp,
    fx_rate: fxProp,
    status: { type: 'string', enum: [...SUPPLIER_INVOICE_STATUSES] },
    notes: nullableText,
  },
}

// `anyOf` demands at least one key: Ajv strips unknown ones rather than
// rejecting them, so a body of nothing but unknown keys must still be a 400.
//
// `supplier_id` is absent and must stay absent — moving an invoice to another
// house would leave every already-attached purchase order belonging to the old
// one, which is the supplier agreement broken retroactively by a field that
// looks like a typo fix.
const patchBodySchema = {
  type: 'object',
  additionalProperties: false,
  anyOf: [
    { required: ['invoice_number'] },
    { required: ['invoice_date'] },
    { required: ['currency'] },
    { required: ['total_amount'] },
    { required: ['freight_amount'] },
    { required: ['duty_amount'] },
    { required: ['fx_rate'] },
    { required: ['status'] },
    { required: ['notes'] },
  ],
  properties: {
    invoice_number: { type: 'string', minLength: 1, maxLength: 200 },
    invoice_date: dateProp,
    currency: nullableShort,
    total_amount: moneyProp,
    freight_amount: nullableMoneyProp,
    duty_amount: nullableMoneyProp,
    fx_rate: fxProp,
    status: { type: 'string', enum: [...SUPPLIER_INVOICE_STATUSES] },
    notes: nullableText,
  },
}

const attachBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['purchase_order_id'],
  properties: {
    purchase_order_id: { type: 'integer', minimum: 1 },
    // Optional on purpose: a consolidated invoice often does not break its
    // total down per purchase order, and "attached, amount not stated" is the
    // ordinary half-done state this feature exists to hold.
    amount: nullableMoneyProp,
    notes: nullableText,
  },
}

export const adminSupplierInvoiceRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // Whether this login may see money figures. Resolved per request from the row
  // the session id names, never from anything the caller sent.
  const financeFor = async (request) => (await loadReportAccess(pool, request.user)).finance

  app.get(
    '/admin/supplier-invoices',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { supplier_id, status, from, to, q, page, limit } = request.query
      const { supplier_invoices, total } = await listSupplierInvoices(pool, {
        supplierId: supplier_id,
        status,
        from,
        to,
        q,
        page,
        limit,
        finance: await financeFor(request),
      })
      return { supplier_invoices, meta: { total, page, limit } }
    }
  )

  // The matching search: purchase orders no invoice covers yet. Registered
  // BEFORE `/:id` for readability only — Fastify prefers the static segment
  // whatever the order.
  app.get(
    '/admin/supplier-invoices/unbilled',
    { preHandler: backoffice, schema: { querystring: unbilledQuerySchema } },
    async (request) => {
      const { supplier_id, brand_id, status, from, to, q, amount_min, amount_max, page, limit } =
        request.query
      const { purchase_orders, total } = await listUnbilledPurchaseOrders(pool, {
        supplierId: supplier_id,
        brandId: brand_id,
        status,
        from,
        to,
        q,
        amountMin: amount_min,
        amountMax: amount_max,
        page,
        limit,
        finance: await financeFor(request),
      })
      return { purchase_orders, meta: { total, page, limit } }
    }
  )

  app.post(
    '/admin/supplier-invoices',
    { preHandler: backoffice, schema: { body: createBodySchema } },
    async (request, reply) => {
      const supplier_invoice = await createSupplierInvoice(pool, request.body, {
        user: request.user,
        finance: await financeFor(request),
      })
      reply.code(201)
      return { supplier_invoice }
    }
  )

  app.get(
    '/admin/supplier-invoices/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier_invoice = await getSupplierInvoice(pool, request.params.id, {
        finance: await financeFor(request),
      })
      if (!supplier_invoice) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Supplier invoice ${request.params.id} not found.`,
        }
      }
      return { supplier_invoice }
    }
  )

  app.patch(
    '/admin/supplier-invoices/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchBodySchema } },
    async (request) => ({
      supplier_invoice: await updateSupplierInvoice(pool, request.params.id, request.body, {
        finance: await financeFor(request),
      }),
    })
  )

  // Hard delete, refused while purchase orders are attached (FR-159). The
  // registry entry holds the probe, so this handler is one line — and
  // `'supplier_invoice'` is a single-quoted literal, never a path parameter,
  // because the registry is not an authorisation boundary.
  app.delete(
    '/admin/supplier-invoices/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'supplier_invoice', request.params.id, {
          user: request.user,
        })
      )
  )

  app.post(
    '/admin/supplier-invoices/:id/allocations',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: attachBodySchema } },
    async (request, reply) => {
      const supplier_invoice = await attachPurchaseOrder(pool, request.params.id, request.body, {
        user: request.user,
        finance: await financeFor(request),
      })
      reply.code(201)
      return { supplier_invoice }
    }
  )

  // Addressed by PURCHASE-ORDER id rather than by the allocation row's own id:
  // a purchase order is on exactly one invoice, so the pair is the identity the
  // screen already holds, and nothing has to look a join-row id up to undo a
  // mistake.
  app.delete(
    '/admin/supplier-invoices/:id/allocations/:poId',
    { preHandler: backoffice, schema: { params: allocationParamsSchema } },
    async (request) => ({
      supplier_invoice: await detachPurchaseOrder(
        pool,
        request.params.id,
        request.params.poId,
        { finance: await financeFor(request) }
      ),
    })
  )
}
