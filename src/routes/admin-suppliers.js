// Back-office supplier JSON API. Every route is backoffice-only (director
// inherits via the role guard) — a supplier record names the freight agent, the
// Incoterm, the internal PO address and how each house is discounted, so there
// is no viewer for it below staff. Handlers stay thin; the SQL and the rules
// live in ../suppliers/admin-suppliers.js.
//
// Three things worth knowing before editing this file:
//   - `slug` is never accepted from the client. It is derived from the name on
//     create and NOT recomputed on rename — it is the stable key the backfill
//     and any later import address a supplier by.
//   - A duplicate is always the database's 23505, mapped to a 409 by the module.
//     A pre-check races and would still need the handler, so there is none.
//   - DELETE goes through the shared lifecycle module and answers a refusal as a
//     VALUE, not an exception: Fastify's error serializer drops custom
//     properties, so a thrown error could not carry `blockers`, which is the
//     entire point of the 409.

import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  setSupplierArchived,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../suppliers/admin-suppliers.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

// Mirrors `suppliers_discount_method_check`. The database owns the vocabulary —
// this is the boundary copy that turns a typo into a 400 instead of letting a
// 23514 surface as a 500, exactly as CATEGORY_ENUM does in admin-price-lists.js.
// `test/suppliers-routes.test.js` compares it to the live CHECK definition, so
// widening one side without the other fails rather than drifting quietly.
export const DISCOUNT_METHOD_ENUM = Object.freeze(['averaged', 'per-brand'])

// Required on create, editable after.
const nameProp = { type: 'string', minLength: 1, maxLength: 200 }

// Optional columns. Nullable so a PATCH can clear one with an explicit null —
// every one of them is nullable in the schema, `currency` deliberately so:
// blank means "no invoice on file yet", and defaulting it from `country` is the
// exact mistake the column exists to prevent.
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
const nullableToken = { type: ['string', 'null'], maxLength: 32 }
const nullableEmail = { type: ['string', 'null'], maxLength: 254 }
const discountMethodProp = {
  type: ['string', 'null'],
  enum: [...DISCOUNT_METHOD_ENUM, null],
}

const supplierProps = {
  short_code: nullableToken,
  d365_token: nullableToken,
  country: nullableShort,
  currency: nullableShort,
  agent: nullableShort,
  incoterm: nullableShort,
  po_email: nullableEmail,
  discount_method: discountMethodProp,
}

// :id is coerced to an integer by Fastify; a non-numeric id is a 400 by schema.
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// No `slug`: server-derived. Ajv strips it rather than rejecting it (this
// codebase's `removeAdditional` gotcha), which is why it is simply absent from
// the module's INSERT column list too.
const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: nameProp,
    ...supplierProps,
  },
}

const patchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: nameProp,
    ...supplierProps,
  },
}

const notFound = (reply, id) => {
  reply.code(404)
  return { error: 'Not Found', message: `Supplier ${id} not found.` }
}

export const adminSupplierRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/suppliers',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { q, include_archived, page, limit } = request.query
      const { suppliers, total } = await listSuppliers(pool, {
        q,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { suppliers, meta: { total, page, limit } }
    }
  )

  app.get(
    '/admin/suppliers/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier = await getSupplier(pool, request.params.id)
      if (!supplier) return notFound(reply, request.params.id)
      return { supplier }
    }
  )

  app.post(
    '/admin/suppliers',
    { preHandler: backoffice, schema: { body: createSchema } },
    async (request, reply) => {
      const supplier = await createSupplier(pool, request.body)
      reply.code(201)
      return { supplier }
    }
  )

  app.patch(
    '/admin/suppliers/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchSchema } },
    async (request) => ({
      supplier: await updateSupplier(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/suppliers/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier = await setSupplierArchived(pool, request.params.id, true)
      if (!supplier) return notFound(reply, request.params.id)
      return { supplier }
    }
  )

  app.post(
    '/admin/suppliers/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const supplier = await setSupplierArchived(pool, request.params.id, false)
      if (!supplier) return notFound(reply, request.params.id)
      return { supplier }
    }
  )

  // 'supplier' is a code literal, never a path parameter: the registry is not an
  // authorisation boundary, so an entity name taken from the URL would let a
  // caller choose which table gets deleted from.
  app.delete(
    '/admin/suppliers/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'supplier', request.params.id, {
          user: request.user,
        })
      )
  )
}
