// Back-office sample register JSON API (W4-US-005).
//
// Every route is backoffice-only (director inherits via the role guard): the
// register says where a physical object is and who has it, which is staff
// information and not a client's. Handlers stay thin — the SQL, the derivations
// and the write rules live in ../samples/admin-samples.js.
//
// Three things worth knowing before editing this file:
//   - `GET /admin/samples/by-barcode/:barcode` is an EXACT match, so it answers
//     200 or 404 and NEVER a filtered list. That is the whole contract with the
//     scanner: one scan, one deterministic answer. It is a separate path segment
//     from `/admin/samples/:id`, so the two cannot collide (`:id` is an integer
//     by schema and the barcode is one segment further down).
//   - A duplicate barcode is the database's 23505, mapped to a 409 by the module.
//     A pre-check races the scanner — a concurrent device — and would still need
//     the handler, so there is none.
//   - DELETE goes through the shared lifecycle module and answers a refusal as a
//     VALUE, not an exception: Fastify's error serializer drops custom
//     properties, so a thrown error could not carry `blockers`, which is the
//     entire point of the 409.
//
// Check-out and check-in (W4-US-006) are VERB routes here, not a status PATCH:
// each writes two tables and must be one transaction, so both go through
// `withSampleTxn` in ../samples/sample-loans.js. Their two 409s come from the
// writes themselves — a caught 23505 on the partial index, and a closing UPDATE
// that matched nothing — never from a pre-check.

import {
  listSamples,
  getSample,
  getSampleByBarcode,
  createSample,
  updateSample,
  setSampleArchived,
  SAMPLE_STATUSES,
  WRITABLE_SAMPLE_STATUSES,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../samples/admin-samples.js'
import { checkOutSample, checkInSample } from '../samples/sample-loans.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

// Required on create, editable after — a printed tag can be mistyped.
const barcodeProp = { type: 'string', minLength: 1, maxLength: 200 }

// Optional columns, all nullable in the schema, so a PATCH clears one with an
// explicit null (un-homing a sample from a closed showroom, for instance).
const nullableText = { type: ['string', 'null'], maxLength: 500 }
const nullableRef = { type: ['integer', 'null'], minimum: 1 }

// `out` is deliberately absent: it asserts an open loan exists, and only
// check-out (US-006) writes both tables in the one transaction that makes that
// true. The module refuses it too, because it is also called directly.
const writableStatusProp = { type: 'string', enum: [...WRITABLE_SAMPLE_STATUSES] }

const sampleProps = {
  label: nullableText,
  colourway_id: nullableRef,
  supplier_id: nullableRef,
  showroom_id: nullableRef,
  sample_type: nullableText,
  location: nullableText,
  status: writableStatusProp,
  notes: { type: ['string', 'null'], maxLength: 5000 },
}

// :id is coerced to an integer by Fastify; a non-numeric id is a 400 by schema.
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

const barcodeParamsSchema = {
  type: 'object',
  required: ['barcode'],
  properties: {
    barcode: barcodeProp,
  },
}

// MAX_LIMIT as the schema `maximum` is load-bearing: an over-large limit must be
// a 400, because a silent clamp reports a page size the caller did not ask for.
// The module still clamps, because it is also called directly.
//
// `status` spends the FULL vocabulary, not the writable subset — filtering for
// what is out is the register's headline question, even though nothing may WRITE
// that status here.
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: [...SAMPLE_STATUSES] },
    showroom_id: { type: 'integer', minimum: 1 },
    supplier_id: { type: 'integer', minimum: 1 },
    // Tri-state: absent leaves the list alone, true is the chase list, false is
    // everything not late back (out on time, or on the shelf).
    overdue: { type: 'boolean' },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['barcode'],
  properties: {
    barcode: barcodeProp,
    ...sampleProps,
  },
}

const patchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    barcode: barcodeProp,
    ...sampleProps,
  },
}

// Fastify's bundled Ajv carries no `format` keywords (the same reason the auth
// schemas use EMAIL_PATTERN and `date_effective` uses an explicit YYYY-MM-DD
// pattern), so a timestamp is validated with a pattern here: a date, optionally
// with a time and an offset. The pattern can only police the SHAPE — only
// Postgres knows the calendar — so `2026-02-31` gets through it and comes back
// as a 422 from the module's 22007 mapping.
const timestampProp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$',
}

// The snapshot: whoever took it, as given at the counter. Required, because a
// loan that cannot say who has the sample answers nothing.
const checkOutSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['holder_name'],
  properties: {
    holder_name: { type: 'string', minLength: 1, maxLength: 500 },
    // The company, where the borrower is a linked trade client. Most are not.
    trade_account_id: { type: 'integer', minimum: 1 },
    // Optional on purpose: plenty of samples go out with no date agreed, and
    // inventing one would make them overdue on a deadline nobody set.
    due_back_at: timestampProp,
    out_at: timestampProp,
    notes: { type: 'string', maxLength: 5000 },
  },
}

// Everything is optional — the common check-in is a bare POST with no body at
// all, which Fastify hands the handler as null, hence the union type. (An
// object-only schema would 400 the most ordinary call this route receives.)
// `returned_at` exists so a movement recorded after the fact carries the day it
// happened.
const checkInSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    returned_at: timestampProp,
  },
}

const notFound = (reply, what) => {
  reply.code(404)
  return { error: 'Not Found', message: what }
}

export const adminSampleRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/samples',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { q, status, showroom_id, supplier_id, overdue, include_archived, page, limit } =
        request.query
      const { samples, total } = await listSamples(pool, {
        q,
        status,
        showroomId: showroom_id,
        supplierId: supplier_id,
        overdue,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { samples, meta: { total, page, limit } }
    }
  )

  // The scanner's route. One row or a 404 — never a list, and never a prefix
  // match, so a tag that is one character short of a real one cannot silently
  // resolve to its neighbour. Archived samples are returned deliberately: a
  // scanned object exists whatever the CRM list is currently showing.
  app.get(
    '/admin/samples/by-barcode/:barcode',
    { preHandler: backoffice, schema: { params: barcodeParamsSchema } },
    async (request, reply) => {
      const sample = await getSampleByBarcode(pool, request.params.barcode)
      if (!sample) {
        return notFound(reply, `No sample carries the barcode ${request.params.barcode}.`)
      }
      return { sample }
    }
  )

  app.get(
    '/admin/samples/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const sample = await getSample(pool, request.params.id)
      if (!sample) return notFound(reply, `Sample ${request.params.id} not found.`)
      return { sample }
    }
  )

  app.post(
    '/admin/samples',
    { preHandler: backoffice, schema: { body: createSchema } },
    async (request, reply) => {
      const sample = await createSample(pool, request.body)
      reply.code(201)
      return { sample }
    }
  )

  app.patch(
    '/admin/samples/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchSchema } },
    async (request) => ({
      sample: await updateSample(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/samples/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const sample = await setSampleArchived(pool, request.params.id, true)
      if (!sample) return notFound(reply, `Sample ${request.params.id} not found.`)
      return { sample }
    }
  )

  app.post(
    '/admin/samples/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const sample = await setSampleArchived(pool, request.params.id, false)
      if (!sample) return notFound(reply, `Sample ${request.params.id} not found.`)
      return { sample }
    }
  )

  // The two movements. Verbs rather than a status PATCH because each writes two
  // tables and only means anything if both writes land together — see
  // ../samples/sample-loans.js. Both answer with the same `{ sample }` shape
  // every other write here does, so a screen re-renders one thing.
  app.post(
    '/admin/samples/:id/check-out',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: checkOutSchema } },
    async (request) => ({
      sample: await checkOutSample(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/samples/:id/check-in',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: checkInSchema } },
    async (request) => ({
      sample: await checkInSample(pool, request.params.id, request.body ?? {}),
    })
  )

  // 'sample' is a code literal, never a path parameter: the registry is not an
  // authorisation boundary, so an entity name taken from the URL would let a
  // caller choose which table gets deleted from.
  app.delete(
    '/admin/samples/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'sample', request.params.id, {
          user: request.user,
        })
      )
  )
}
