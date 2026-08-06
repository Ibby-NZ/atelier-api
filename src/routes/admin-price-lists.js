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
//   - The category/unit/currency enums and the class-letter pattern come from
//     scripts/lib/price-template.js, the converter's vocabulary module, so a
//     hand-keyed item is validated by exactly the rules an imported one is.

import {
  listPriceListItems,
  createPriceListItem,
  updatePriceListItem,
  setPriceListItemArchived,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../pricing/admin-price-lists.js'
import { CATEGORIES, UNITS, CURRENCIES, CLASS_LETTER } from '../../scripts/lib/price-template.js'

// Derived from the shared vocabularies rather than re-typed: a hand-entered item
// must be exactly as valid as an imported one, and these lists had already
// drifted from the column CHECKs once.
const CATEGORY_ENUM = [...CATEGORIES]
const UNIT_ENUM = [...UNITS]
const CURRENCY_ENUM = [...CURRENCIES]

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
// Both class columns CHECK a single uppercase letter, so the schema says the
// same thing and a bad letter is a 400 here rather than an opaque 23514 at the
// database. `pattern` only applies to strings, so null still clears the field.
const classLetterProp = { type: ['string', 'null'], pattern: CLASS_LETTER.source }
const dateProp = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }

// Optional properties shared by create and patch.
const optionalProps = {
  product_range: nullableText,
  description: nullableText,
  contents: nullableText,
  width: nullableShort,
  repeat: nullableShort,
  vertical_repeat: nullableShort,
  duty_class: classLetterProp,
  freight_class: classLetterProp,
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
}
