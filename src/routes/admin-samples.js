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
// The plugin carries BOTH samples lifecycles: the loan register (`/admin/samples`)
// and showroom stocking (`/admin/sample-orders`, W4-US-007), plus the address
// book they both point at (`/admin/showrooms`, W4-US-008), each in its own block
// at the bottom of the file. One registration in src/app.js, one guard, two
// independent domains that nothing joins.
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
import {
  listSampleOrders,
  getSampleOrder,
  createSampleOrder,
  updateSampleOrder,
  transitionSampleOrder,
  setSampleOrderArchived,
  DEFAULT_PAGE as ORDER_DEFAULT_PAGE,
  DEFAULT_LIMIT as ORDER_DEFAULT_LIMIT,
  MAX_LIMIT as ORDER_MAX_LIMIT,
} from '../samples/sample-orders.js'
import { SAMPLE_ORDER_STATUSES } from '../samples/sample-order-states.js'
import {
  listShowrooms,
  getShowroom,
  createShowroom,
  updateShowroom,
  setShowroomArchived,
  DEFAULT_PAGE as SHOWROOM_DEFAULT_PAGE,
  DEFAULT_LIMIT as SHOWROOM_DEFAULT_LIMIT,
  MAX_LIMIT as SHOWROOM_MAX_LIMIT,
} from '../samples/showrooms.js'
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

// ---------------------------------------------------------------------------
// Showroom stocking: sample orders (W4-US-007).
//
// The second lifecycle, sharing this plugin because it is the same domain and
// the same guard — src/app.js registers `adminSampleRoutes` once and a further
// samples route belongs inside it.
//
// A MOVE IS A VERB, NOT A STATUS PATCH, for the same reason check-out is: it
// writes the state AND the stamp that dates it, and either alone is a row that
// contradicts itself. `status` is therefore absent from the PATCH schema and
// from the module's column whitelist, and `POST /:id/transition` is the only way
// a state changes. The machine itself (which moves are legal) lives in the pure
// ../samples/sample-order-states.js, which the CRM mirrors.
// ---------------------------------------------------------------------------

// NOT nullable, unlike every other ref here: an order with no destination is a
// request nobody can fulfil, so the column is NOT NULL and an explicit null is a
// 400 rather than a way to clear it.
const showroomRef = { type: 'integer', minimum: 1 }

const sampleOrderProps = {
  colourway_id: nullableRef,
  supplier_id: nullableRef,
  label: nullableText,
  notes: { type: ['string', 'null'], maxLength: 5000 },
}

const orderListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    status: { type: 'string', enum: [...SAMPLE_ORDER_STATUSES] },
    showroom_id: { type: 'integer', minimum: 1 },
    supplier_id: { type: 'integer', minimum: 1 },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: ORDER_DEFAULT_PAGE },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: ORDER_MAX_LIMIT,
      default: ORDER_DEFAULT_LIMIT,
    },
  },
}

// No `status`: every order starts `requested`, because one created at `received`
// would carry none of the stamps that say how it got there.
const orderCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['showroom_id'],
  properties: {
    showroom_id: showroomRef,
    ...sampleOrderProps,
    // Back-dating the request itself, mirroring `out_at` on a check-out.
    requested_at: timestampProp,
  },
}

const orderPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    showroom_id: showroomRef,
    ...sampleOrderProps,
  },
}

// The move. `at` dates it and defaults to now(), so an order advanced in the
// system days after the house actually shipped still reads truthfully.
const transitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: [...SAMPLE_ORDER_STATUSES] },
    at: timestampProp,
  },
}

// --- Showrooms (W4-US-008) --------------------------------------------------
// The address book both samples screens read: the register filters and the
// sample form pick a showroom from it, and `AdminShowrooms` edits it. It rides
// in this plugin rather than a file of its own because a showroom exists only to
// be pointed at by these two lifecycles.
// ---------------------------------------------------------------------------

const showroomProps = {
  address: nullableText,
  city: nullableText,
  contact_name: nullableText,
  contact_email: nullableText,
  contact_phone: nullableText,
  notes: { type: ['string', 'null'], maxLength: 5000 },
}

// NOT nullable and required on create: the column is NOT NULL and unique, and a
// showroom nobody can name is a row no screen can offer.
const showroomNameProp = { type: 'string', minLength: 1, maxLength: 500 }

const showroomListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: SHOWROOM_DEFAULT_PAGE },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: SHOWROOM_MAX_LIMIT,
      default: SHOWROOM_DEFAULT_LIMIT,
    },
  },
}

const showroomCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: showroomNameProp,
    ...showroomProps,
  },
}

// `name` is patchable — it is not a slug, nothing addresses a showroom by it,
// and a typo taken down over the phone otherwise stands forever. Typed
// `string` rather than `['string','null']` so clearing it is a 400 here rather
// than a 23502 the module has to map.
const showroomPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: showroomNameProp,
    ...showroomProps,
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

  // --- Sample orders (W4-US-007) -------------------------------------------

  app.get(
    '/admin/sample-orders',
    { preHandler: backoffice, schema: { querystring: orderListQuerySchema } },
    async (request) => {
      const { q, status, showroom_id, supplier_id, include_archived, page, limit } = request.query
      const { sample_orders, total } = await listSampleOrders(pool, {
        q,
        status,
        showroomId: showroom_id,
        supplierId: supplier_id,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { sample_orders, meta: { total, page, limit } }
    }
  )

  app.get(
    '/admin/sample-orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const sampleOrder = await getSampleOrder(pool, request.params.id)
      if (!sampleOrder) return notFound(reply, `Sample order ${request.params.id} not found.`)
      return { sample_order: sampleOrder }
    }
  )

  app.post(
    '/admin/sample-orders',
    { preHandler: backoffice, schema: { body: orderCreateSchema } },
    async (request, reply) => {
      const sampleOrder = await createSampleOrder(pool, request.body)
      reply.code(201)
      return { sample_order: sampleOrder }
    }
  )

  app.patch(
    '/admin/sample-orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: orderPatchSchema } },
    async (request) => ({
      sample_order: await updateSampleOrder(pool, request.params.id, request.body),
    })
  )

  // The move. An illegal one — including a move to the state the order is
  // already in, and any move out of `displayed`/`cancelled` — is a 409 from
  // `requireTransition`, decided against the row this transaction holds locked.
  app.post(
    '/admin/sample-orders/:id/transition',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: transitionSchema } },
    async (request) => ({
      sample_order: await transitionSampleOrder(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/sample-orders/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const sampleOrder = await setSampleOrderArchived(pool, request.params.id, true)
      if (!sampleOrder) return notFound(reply, `Sample order ${request.params.id} not found.`)
      return { sample_order: sampleOrder }
    }
  )

  app.post(
    '/admin/sample-orders/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const sampleOrder = await setSampleOrderArchived(pool, request.params.id, false)
      if (!sampleOrder) return notFound(reply, `Sample order ${request.params.id} not found.`)
      return { sample_order: sampleOrder }
    }
  )

  // Refused unless the order is still `requested` or was `cancelled` — the
  // registry's guard, not a rule written here, so the CRM's confirm dialog reads
  // the same envelope every other blocked delete produces.
  app.delete(
    '/admin/sample-orders/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'sample_order', request.params.id, {
          user: request.user,
        })
      )
  )

  // --- Showrooms (W4-US-008) ------------------------------------------------

  app.get(
    '/admin/showrooms',
    { preHandler: backoffice, schema: { querystring: showroomListQuerySchema } },
    async (request) => {
      const { q, include_archived, page, limit } = request.query
      const { showrooms, total } = await listShowrooms(pool, {
        q,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { showrooms, meta: { total, page, limit } }
    }
  )

  // The by-id read is where the child counts live — the CRUD kit forbids a
  // pre-flight "can I delete this" GET, so this is the only advance warning a
  // screen gets that Delete will be refused.
  app.get(
    '/admin/showrooms/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const showroom = await getShowroom(pool, request.params.id)
      if (!showroom) return notFound(reply, `Showroom ${request.params.id} not found.`)
      return { showroom }
    }
  )

  app.post(
    '/admin/showrooms',
    { preHandler: backoffice, schema: { body: showroomCreateSchema } },
    async (request, reply) => {
      const showroom = await createShowroom(pool, request.body)
      reply.code(201)
      return { showroom }
    }
  )

  app.patch(
    '/admin/showrooms/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: showroomPatchSchema } },
    async (request) => ({
      showroom: await updateShowroom(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/showrooms/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const showroom = await setShowroomArchived(pool, request.params.id, true)
      if (!showroom) return notFound(reply, `Showroom ${request.params.id} not found.`)
      return { showroom }
    }
  )

  app.post(
    '/admin/showrooms/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const showroom = await setShowroomArchived(pool, request.params.id, false)
      if (!showroom) return notFound(reply, `Showroom ${request.params.id} not found.`)
      return { showroom }
    }
  )

  // Blocked by anything standing in the showroom or addressed to it. The
  // `samples` probe is the load-bearing one: that FK is SET NULL, so an unprobed
  // delete would report success while silently un-homing every sample.
  app.delete(
    '/admin/showrooms/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'showroom', request.params.id, {
          user: request.user,
        })
      )
  )
}
