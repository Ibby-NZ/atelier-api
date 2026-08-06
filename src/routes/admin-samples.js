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
