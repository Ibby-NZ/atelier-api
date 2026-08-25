// Back-office reserves & cuttings JSON API — the live replacement for the D365
// fulmar_reserve / cutting entities.
//
// Every route is backoffice-only (director inherits): a reserve names a client
// and what they asked a house to hold, which is staff information. Handlers
// stay thin — the SQL, the docket read model and the write rules live in
// ../reserves/admin-reserves.js, the state machine in
// ../reserves/reserve-line-states.js, the supplier report in
// ../reserves/reserve-report.js.
//
// Shape notes worth reading before editing:
//   - The list is DOCKET-grain (account-first, lines embedded) — the entry
//     shape the office asked for. Line-level filters select dockets by EXISTS.
//   - Line routes live under the static segment `/admin/reserves/lines/:id`.
//     Fastify prefers a static segment over the parametric `:id`, so `lines`,
//     `suppliers` and `report` can never be swallowed by the docket read —
//     but every new sibling must stay OUT of the single-integer namespace.
//   - Every line write answers with the whole PARENT DOCKET, because the
//     screen renders dockets and that is the reload it needs.
//   - A move is a VERB (`POST .../transition`), never a status PATCH: it
//     writes the state and the stamp that dates it in one statement, and
//     `status` is absent from the PATCH whitelist.
//   - `.csv` is its own path segment (`/report/export.csv`), never a suffix on
//     a param, and the export re-runs the same builder the JSON report uses so
//     the two cannot disagree.
//   - DELETE goes through the shared lifecycle module and answers a refusal as
//     a VALUE (the envelope carries `blockers`, which Fastify's error
//     serializer would drop). Neither table has `archived_at`: `cancelled` is
//     the removal that keeps the record, so the registry says
//     `archivable: false` and the CRM's dialog offers Cancel alone.

import {
  listReserves,
  getReserve,
  createReserve,
  updateReserve,
  addReserveLines,
  updateReserveLine,
  transitionReserveLine,
  listReserveSuppliers,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../reserves/admin-reserves.js'
import {
  RESERVE_LINE_STATUSES,
  RESERVE_LINE_KINDS,
  CFA_STATES,
} from '../reserves/reserve-line-states.js'
import {
  reserveReport,
  toReserveReportCsv,
  reserveReportFilename,
  RESERVE_REPORT_CSV_CONTENT_TYPE,
} from '../reserves/reserve-report.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

const nullableText = { type: ['string', 'null'], maxLength: 500 }
const nullableRef = { type: ['integer', 'null'], minimum: 1 }
const nullableNote = { type: ['string', 'null'], maxLength: 5000 }

// A calendar date, not a timestamp: the house says "held until the 27th". The
// pattern polices the shape; 2026-02-31 comes back as a 422 from the module's
// 22007/22008 mapping, because only Postgres knows the calendar.
const nullableDate = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

// Back-dating a move, so a line advanced in the system days after the house
// actually shipped still reads truthfully.
const timestampProp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$',
}

// One line as entered. `qty` is metres and OPTIONAL — the office's current
// book has real reserves with no figure yet — but never zero-or-below.
// `multiplier` is the "×10 / ×20" copies count for identical cuttings.
const lineProps = {
  kind: { type: 'string', enum: [...RESERVE_LINE_KINDS] },
  product_name: { type: 'string', minLength: 1, maxLength: 500 },
  range_name: nullableText,
  supplier: nullableText,
  product_code: nullableText,
  price_list_item_id: nullableRef,
  colour: nullableText,
  qty: { type: ['number', 'null'], exclusiveMinimum: 0 },
  multiplier: { type: 'integer', minimum: 1, default: 1 },
  customer_reference: nullableText,
  reserve_number: nullableText,
  reserved_until: nullableDate,
  cfa: { type: ['string', 'null'], enum: [...CFA_STATES, null] },
  comment: nullableNote,
}

const lineCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'product_name'],
  properties: {
    ...lineProps,
    // Only on create: a cutting generated from a reserve line points back at
    // it. Parentage is set at birth, so the PATCH schema omits it.
    source_line_id: nullableRef,
  },
}

// The docket ceiling matches the office's worst day — "one person would
// reserve like a 100 cuttings" — with room, while keeping a runaway client
// from posting an unbounded body.
const linesProp = {
  type: 'array',
  minItems: 1,
  maxItems: 200,
  items: lineCreateSchema,
}

// Attribution is either/or and a schema cannot say so: `user_id` links a
// platform account (its name is snapshotted), `account_name` covers the
// Dynamics-side majority. The module 422s when neither yields a name.
const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    user_id: nullableRef,
    account_name: nullableText,
    contact_name: nullableText,
    notes: nullableNote,
    lines: linesProp,
  },
}

// `account_name` is typed `string`, not nullable: a docket that cannot say who
// it is for is paperwork nobody can act on, so clearing it is a 400 here
// rather than a 23502 the module has to map.
const requestPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    account_name: { type: 'string', minLength: 1, maxLength: 500 },
    contact_name: nullableText,
    notes: nullableNote,
  },
}

// Everything the office types on the old form is editable — the house's reply
// (reserve_number, reserved_until, cfa) most of all. `status` is deliberately
// absent: a move is a verb. `product_name` is typed `string` for the same
// reason `account_name` is above.
const linePatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    kind: lineProps.kind,
    product_name: lineProps.product_name,
    range_name: nullableText,
    supplier: nullableText,
    product_code: nullableText,
    price_list_item_id: nullableRef,
    colour: nullableText,
    qty: lineProps.qty,
    multiplier: { type: 'integer', minimum: 1 },
    customer_reference: nullableText,
    reserve_number: nullableText,
    reserved_until: nullableDate,
    cfa: lineProps.cfa,
    comment: nullableNote,
  },
}

const addLinesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: { lines: linesProp },
}

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    kind: { type: 'string', enum: [...RESERVE_LINE_KINDS] },
    status: { type: 'string', enum: [...RESERVE_LINE_STATUSES] },
    supplier: { type: 'string', maxLength: 200 },
    include_done: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const transitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: [...RESERVE_LINE_STATUSES] },
    at: timestampProp,
  },
}

// `supplier` is required and must be non-empty: the report is a letter to ONE
// house, and an unscoped dump is a different (unasked) question.
const reportQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier'],
  properties: {
    supplier: { type: 'string', minLength: 1, maxLength: 200 },
  },
}

const notFound = (reply, what) => {
  reply.code(404)
  return { error: 'Not Found', message: what }
}

export const adminReserveRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/reserves',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { q, kind, status, supplier, include_done, page, limit } = request.query
      const { reserves, total } = await listReserves(pool, {
        q,
        kind,
        status,
        supplier,
        includeDone: include_done,
        page,
        limit,
      })
      return { reserves, meta: { total, page, limit } }
    }
  )

  // The facet the report picker reads: which houses are owed a chase, and how
  // many open lines each holds.
  app.get('/admin/reserves/suppliers', { preHandler: backoffice }, async () =>
    listReserveSuppliers(pool)
  )

  app.get(
    '/admin/reserves/report',
    { preHandler: backoffice, schema: { querystring: reportQuerySchema } },
    async (request) => ({ report: await reserveReport(pool, request.query.supplier) })
  )

  // The same builder as the JSON report, so the file jette sends the house can
  // never disagree with the table she read first. Headers are set only after
  // the build succeeds — an error must leave as JSON, not as a CSV attachment.
  app.get(
    '/admin/reserves/report/export.csv',
    { preHandler: backoffice, schema: { querystring: reportQuerySchema } },
    async (request, reply) => {
      const report = await reserveReport(pool, request.query.supplier)
      reply
        .header('content-type', RESERVE_REPORT_CSV_CONTENT_TYPE)
        .header(
          'content-disposition',
          `attachment; filename="${reserveReportFilename(report.supplier)}"`
        )
      return toReserveReportCsv(report)
    }
  )

  app.get(
    '/admin/reserves/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const reserve = await getReserve(pool, request.params.id)
      if (!reserve) return notFound(reply, `Reserve docket ${request.params.id} not found.`)
      return { reserve }
    }
  )

  app.post(
    '/admin/reserves',
    { preHandler: backoffice, schema: { body: createSchema } },
    async (request, reply) => {
      const reserve = await createReserve(pool, request.body, { user: request.user })
      reply.code(201)
      return { reserve }
    }
  )

  app.patch(
    '/admin/reserves/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: requestPatchSchema } },
    async (request) => ({ reserve: await updateReserve(pool, request.params.id, request.body) })
  )

  // How a docket grows after the fact — the client rings back, or the CRM
  // generates a cutting from a reserve line (a prefilled line carrying
  // source_line_id).
  app.post(
    '/admin/reserves/:id/lines',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: addLinesSchema } },
    async (request) => ({
      reserve: await addReserveLines(pool, request.params.id, request.body.lines),
    })
  )

  app.patch(
    '/admin/reserves/lines/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: linePatchSchema } },
    async (request) => ({
      reserve: await updateReserveLine(pool, request.params.id, request.body),
    })
  )

  // The move. An illegal one — including a move to the state the line is
  // already in — is a 409 from requireTransition, decided against the row the
  // transaction holds locked.
  app.post(
    '/admin/reserves/lines/:id/transition',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: transitionSchema } },
    async (request) => ({
      reserve: await transitionReserveLine(pool, request.params.id, request.body),
    })
  )

  // Refused unless the line is still `requested` or was `cancelled` — the
  // registry's guard, not a rule written here. 'reserve_line' is a code
  // literal, never a path parameter: the registry is not an authorisation
  // boundary.
  app.delete(
    '/admin/reserves/lines/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'reserve_line', request.params.id, { user: request.user })
      )
  )

  // A docket goes only when every line could — the guard walks its lines — and
  // takes them with it (CASCADE). For anything past that, cancelling the lines
  // is the removal that keeps the record.
  app.delete(
    '/admin/reserves/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'reserve_request', request.params.id, { user: request.user })
      )
  )
}
