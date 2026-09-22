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
//   - Hard DELETE goes through the lifecycle registry, never a bare SQL delete.
//     It is the one delete here whose success is qualified — see REIMPORT_WARNING.

import {
  listPriceListItems,
  getPriceListItem,
  createPriceListItem,
  updatePriceListItem,
  setPriceListItemArchived,
  markPriceListItemsDiscontinued,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../pricing/admin-price-lists.js'
import { getRateAsAt, listRateHistory, MAX_REASON_LENGTH } from '../pricing/price-history.js'
import { UNITS, CURRENCIES, CLASS_LETTER } from '../../scripts/lib/price-template.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import { requireFinance } from '../reports/access.js'

// A price-list item is the one row in this API whose deletion is not durable:
// `npm run import:pricing` upserts on (supplier, category, code) and keeps rows
// absent from later files, so the next import re-creates a deleted row verbatim
// while leaving an archived one archived. Staff cannot be expected to know that,
// so the 200 says it — the CRM renders the message in its toast.
const REIMPORT_WARNING =
  'Deleted, but not permanently: npm run import:pricing re-creates this row from ' +
  'the supplier file. Archive it instead if the removal must survive a re-import.'

// Derived from the shared vocabularies rather than re-typed: a hand-entered item
// must be exactly as valid as an imported one, and these lists had already
// drifted from the column CHECKs once.
const UNIT_ENUM = [...UNITS]
const CURRENCY_ENUM = [...CURRENCIES]

// Required-field shapes.
const supplierProp = { type: 'string', minLength: 1, maxLength: 200 }
const codeProp = { type: 'string', minLength: 1, maxLength: 200 }
// NOT an enum since migration 1791379200000: `price_list_items.category`
// references `product_categories`, a table the office adds to, and an Ajv enum
// is fixed at boot. An unknown value is a 422 from the foreign key, phrased by
// admin-brands.js's REFERENCE_MESSAGES.
const categoryProp = { type: 'string', minLength: 1, maxLength: 200 }
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
    category: { type: 'string', minLength: 1, maxLength: 200 },
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
//
// `reason` is NOT a column — it is the note recorded against a rate change, and
// a patch that MOVES `wholesale_rate` is refused without it (422, raised in
// src/pricing/admin-price-lists.js so the rule holds for every caller). It has
// to be listed here or Ajv's removeAdditional would silently strip it and every
// price change would fail as though the client had sent nothing.
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
    reason: { type: 'string', maxLength: MAX_REASON_LENGTH },
    ...optionalProps,
  },
}

// The as-at lookup's only parameter. Same YYYY-MM-DD pattern as date_effective —
// Fastify's bundled Ajv has no `format` keywords.
const asAtQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['as_at'],
  properties: {
    as_at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
}

// Drop detection is scoped to (supplier, category) and both are required: per
// file has no stable key (filenames carry the year) and per supplier would mark
// a house's whole fabric range discontinued off its wallpaper list.
const markDiscontinuedSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier', 'category'],
  properties: {
    supplier: supplierProp,
    category: categoryProp,
  },
}

export const adminPriceListRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // A wholesale rate is Atelier's BUY side, and its history is a run of them —
  // the margin falls straight out of one divided into the matching trade price.
  // So the two history reads sit behind finance visibility as well as the
  // backoffice guard. The gate itself is `src/reports/access.js`'s, shared with
  // the import routes rather than copied: it resolves the flag through the
  // DATABASE, never off `request.user`, and that distinction is the whole of it.
  const financeOnly = requireFinance(
    pool,
    'Reading what a rate used to be needs finance access. Ask a director.'
  )

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
    // `{ user: request.user }` is what puts a name on the change the capture
    // trigger records, and it is passed uniformly — the same ctx shape every
    // DELETE route hands deleteOrExplain.
    async (request) => ({
      item: await updatePriceListItem(pool, request.params.id, request.body, {
        user: request.user,
      }),
    })
  )

  // THE AS-AT LOOKUP — the reason this epic exists. "What were we paying for
  // this on 1 June 2023?" is one indexed query, which is what lets the office
  // stop encoding the year in an item code to keep an old price reachable.
  //
  // A date before anything was recorded is a 404 that names WHICH reason it is
  // (never changed / the ledger starts later), because "no result" and "nothing
  // recorded yet" read identically on a screen and only one is actionable.
  app.get(
    '/admin/price-list-items/:id/rate',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, querystring: asAtQuerySchema },
    },
    async (request) => {
      await financeOnly(request)
      return { rate: await getRateAsAt(pool, request.params.id, request.query.as_at) }
    }
  )

  // Every recorded change for one item, newest first: date changed, old rate,
  // new rate, reason — the four things the client asked to be able to see.
  app.get(
    '/admin/price-list-items/:id/price-history',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      await financeOnly(request)
      const item = await getPriceListItem(pool, request.params.id)
      if (!item) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Price-list item ${request.params.id} not found.`,
        }
      }
      return { changes: await listRateHistory(pool, request.params.id) }
    }
  )

  // Drop detection, and it is a POST because it is a DECISION: an import records
  // what it saw and flags nothing. The body is the (supplier, category) scope,
  // and the response states coverage before the count it acted on.
  app.post(
    '/admin/price-list-items/mark-discontinued',
    { preHandler: backoffice, schema: { body: markDiscontinuedSchema } },
    async (request) => ({
      result: await markPriceListItemsDiscontinued(pool, request.body),
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

  // A rate row now has ONE dependant: its recorded price history, whose FK is
  // ON DELETE RESTRICT precisely so a delete cannot destroy the audit (W17). So
  // this route's refusals are 404 and a 409 naming the recorded changes, and the
  // success envelope below is unreachable for any item whose rate has ever
  // moved. That is correct: the reason to keep the row IS the history.
  // `replyDelete` still sends the refusal, so its shape stays identical to every
  // other delete; only the 200 is widened, by the one additive `warning` key.
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
