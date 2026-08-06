// Back-office supplier price-list JSON API. All routes are backoffice-only
// (director inherits via the role guard). Handlers stay thin — the SQL + rules
// live in ../pricing/admin-price-lists.js.
//
// Notes mirroring the catalogue-admin conventions:
//   - `code_normalized` and `source_file` are never accepted from the client, so
//     no schema below lists them; `additionalProperties: false` (Ajv strips the
//     extra keys) keeps a stray one from mattering.
//   - `supplier` is create-only: it is part of the identity key, so the PATCH
//     schema omits it.
//   - Fastify's bundled Ajv has no `format` keywords (same reason the auth
//     schemas use EMAIL_PATTERN), so `date_effective` is validated with an
//     explicit YYYY-MM-DD pattern rather than `format: 'date'`.
//   - Hard DELETE goes through the lifecycle registry, never a bare SQL delete.
//     It is the one delete here whose success is qualified — see REIMPORT_WARNING.

import {
  listPriceListItems,
  getPriceListItem,
  createPriceListItem,
  updatePriceListItem,
  setPriceListItemArchived,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../pricing/admin-price-lists.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'

// A price-list item is the one row in this API whose deletion is not durable:
// `npm run import:pricing` upserts on (supplier, category, code) and keeps rows
// absent from later files, so the next import re-creates a deleted row verbatim
// while leaving an archived one archived. Staff cannot be expected to know that,
// so the 200 says it — the CRM renders the message in its toast.
const REIMPORT_WARNING =
  'Deleted, but not permanently: npm run import:pricing re-creates this row from ' +
  'the supplier file. Archive it instead if the removal must survive a re-import.'

const CATEGORY_ENUM = ['fabric', 'wallpaper', 'trimming', 'accessory']
const UNIT_ENUM = ['metre', 'yard', 'roll', 'piece', 'hide', 'panel']
const CURRENCY_ENUM = ['EUR', 'USD', 'GBP']
const FREIGHT_CLASS_ENUM = ['A', 'B', 'C', 'D', 'E']

// Required-field shapes.
const supplierProp = { type: 'string', minLength: 1, maxLength: 200 }
const codeProp = { type: 'string', minLength: 1, maxLength: 200 }
const categoryProp = { type: 'string', enum: CATEGORY_ENUM }
const unitProp = { type: 'string', enum: UNIT_ENUM }
const currencyProp = { type: 'string', enum: CURRENCY_ENUM }
// numeric(12,4) CHECK wholesale_rate > 0 — reject <= 0 at the boundary.
const wholesaleRateProp = { type: 'number', exclusiveMinimum: 0 }

// Optional text shapes. Nullable so a PATCH can clear an optional field with an
// explicit null (the columns are nullable in the schema).
const nullableText = { type: ['string', 'null'], maxLength: 2000 }
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
const freightClassProp = { type: ['string', 'null'], enum: [...FREIGHT_CLASS_ENUM, null] }
const dateProp = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

// Optional properties shared by create and patch.
const optionalProps = {
  product_range: nullableText,
  description: nullableText,
  contents: nullableText,
  width: nullableShort,
  repeat: nullableShort,
  vertical_repeat: nullableShort,
  duty_class: nullableShort,
  freight_class: freightClassProp,
  date_effective: dateProp,
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
    supplier: { type: 'string', maxLength: 200 },
    category: { type: 'string', enum: CATEGORY_ENUM },
    q: { type: 'string', maxLength: 200 },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'category', 'code', 'unit', 'wholesale_rate', 'currency'],
  properties: {
    supplier: supplierProp,
    category: categoryProp,
    code: codeProp,
    unit: unitProp,
    wholesale_rate: wholesaleRateProp,
    currency: currencyProp,
    ...optionalProps,
  },
}

// No `supplier`: it is create-only (part of the identity key). `category`, `code`
// and the enum fields are editable; each is optional here (minProperties:1
// enforces at-least-one).
const patchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    category: categoryProp,
    code: codeProp,
    unit: unitProp,
    wholesale_rate: wholesaleRateProp,
    currency: currencyProp,
    ...optionalProps,
  },
}

export const adminPriceListRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/price-list-items',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { supplier, category, q, include_archived, page, limit } = request.query
      const { items, total } = await listPriceListItems(pool, {
        supplier,
        category,
        q,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { items, meta: { total, page, limit } }
    }
  )

  // One row by id. No archived filter: the CRM re-reads the row it just archived
  // to render the new state, and a 404 there would read as "someone deleted it".
  app.get(
    '/admin/price-list-items/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const item = await getPriceListItem(pool, request.params.id)
      if (!item) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Price-list item ${request.params.id} not found.`,
        }
      }
      return { item }
    }
  )

  app.post(
    '/admin/price-list-items',
    { preHandler: backoffice, schema: { body: createSchema } },
    async (request, reply) => {
      const item = await createPriceListItem(pool, request.body)
      reply.code(201)
      return { item }
    }
  )

  app.patch(
    '/admin/price-list-items/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: patchSchema } },
    async (request) => ({
      item: await updatePriceListItem(pool, request.params.id, request.body),
    })
  )

  app.post(
    '/admin/price-list-items/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const item = await setPriceListItemArchived(pool, request.params.id, true)
      if (!item) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Price-list item ${request.params.id} not found.`,
        }
      }
      return { item }
    }
  )

  app.post(
    '/admin/price-list-items/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const item = await setPriceListItemArchived(pool, request.params.id, false)
      if (!item) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Price-list item ${request.params.id} not found.`,
        }
      }
      return { item }
    }
  )

  // A rate row has no dependants — nothing in the schema references
  // price_list_items — so the registry entry carries no probes and no guard, and
  // the only refusal left is 404. `replyDelete` still sends it, so the refusal
  // shape stays identical to every other delete; only the success envelope is
  // widened, by the one additive `warning` key.
  app.delete(
    '/admin/price-list-items/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const result = await deleteOrExplain(pool, 'price_list_item', request.params.id, {
        user: request.user,
      })
      if (!result.deleted) return replyDelete(reply, result)
      return { deleted: { entity: result.entity, id: result.id }, warning: REIMPORT_WARNING }
    }
  )
}
