// Back-office access to the Dynamics-365 staging tables, and the office's own
// corrections to them.
//
// The staging tables stay read-only: every write here lands in `d365_overrides`
// (migration 1787025600000), outside the legacy_ namespace, because
// `importLegacyEntity` upserts every mapped column to EXCLUDED on the D365 GUID
// and the import re-runs until cutover — anything written onto a staging row is
// destroyed by the next `npm run import:legacy` with no error at all.
//
// WHY THE PRIVILEGES ARE SPLIT THREE WAYS. Reads and clerical corrections are
// `backoffice`; a correction to a commercial column additionally needs
// `can_view_finance`; raising a record, suppressing one and restoring one are
// `director`.
//   - `backoffice` covers the showroom as well as the accounts desk, which is
//     precisely why users.can_view_finance exists as a second, explicit,
//     revocable permission. A login that may not SEE a cost figure in a report
//     must not be able to SET one here.
//   - A correction is DURABLE in a way the bulk import is not: it survives every
//     re-import and masks the upstream value indefinitely. Blast radius and
//     durability, not batch size, are what made `POST /admin/legacy/import/:entity`
//     director-only, and on both axes raising or suppressing a client record is
//     the narrower privilege rather than the wider one.
//   - Fixing a phone number taken down wrong is ordinary back-office work — the
//     same argument that makes `email` editable on `PATCH /admin/users/:id` —
//     so the clerical case is not pushed behind a director.
// Opening a permission later is cheap; discovering that a showroom login rewrote
// a customer's credit limit is not.
//
// These routes deliberately carry no `config.rateLimit`: the limiter is
// `global: false` and admin routes are gated by their guard, the convention
// every other single-row admin write in this API follows. The bulk import route
// beside them keeps its own bucket because it is a bulk path.

import {
  LEGACY_ENTITIES,
  listLegacy,
  getLegacy,
} from '../legacy/legacy-read.js'
import {
  SUPPRESSION_WARNING,
  createLocalLegacyRecord,
  setLegacyOverrides,
  setLegacySuppressed,
} from '../legacy/legacy-overrides.js'
import { touchesCommercial } from '../legacy/override-schema.js'
import { loadReportAccess } from '../reports/access.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

const entityParamsSchema = {
  type: 'object',
  required: ['entity'],
  properties: {
    entity: { type: 'string', enum: LEGACY_ENTITIES },
  },
}

const GUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

const guidParamsSchema = {
  type: 'object',
  required: ['entity', 'guid'],
  properties: {
    entity: { type: 'string', enum: LEGACY_ENTITIES },
    // D365 record GUID, or one minted here for a locally raised record.
    guid: { type: 'string', pattern: GUID_PATTERN },
  },
}

// One permissive querystring covering every entity's filters (each entity only
// applies the filter keys in its own whitelist; extras are ignored).
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    include_archived: { type: 'boolean', default: false },
    is_customer: { type: 'boolean' },
    is_supplier: { type: 'boolean' },
    customer_type: { type: 'string', maxLength: 100 },
    owner: { type: 'string', maxLength: 200 },
    status_reason: { type: 'string', maxLength: 100 },
    pricing_type: { type: 'string', maxLength: 100 },
    supplier: { type: 'string', maxLength: 200 },
    item_type: { type: 'string', maxLength: 100 },
    product_price_list: { type: 'string', maxLength: 200 },
    range_name: { type: 'string', maxLength: 200 },
  },
}

// Filter keys the module understands (everything in listQuerySchema except the
// pagination/search controls); passed through to the entity's own whitelist.
const FILTER_KEYS = [
  'is_customer', 'is_supplier', 'customer_type', 'owner', 'status_reason',
  'pricing_type', 'supplier', 'item_type', 'product_price_list', 'range_name',
]

const filtersFromQuery = (query) => {
  const filters = {}
  for (const key of FILTER_KEYS) {
    if (query[key] !== undefined) filters[key] = query[key]
  }
  return filters
}

// A free-form column -> value map. It is typed rather than closed: with
// `additionalProperties: false` Ajv's `removeAdditional` would STRIP every key
// and hand the handler `{}`, a 200 that wrote nothing. Declaring the value type
// keeps the keys and lets the column whitelist in src/legacy/override-schema.js
// be the real gate — which is where an unknown column becomes a 422 naming it.
// The values are deliberately left UNTYPED by the schema, and both halves of
// that matter.
//
// Not `additionalProperties: false`: Ajv runs `removeAdditional: true`, so it
// would STRIP every key and hand the handler `{}` — a 200 that wrote nothing.
//
// Not a union type either. Fastify's Ajv runs `coerceTypes: true`, and against
// `['string','number','boolean','null']` (or the `anyOf` spelling of it) a
// deliberate `null` matches the string branch and arrives as `''`. That is the
// exact bug this layer exists to avoid — a cleared field silently becoming an
// empty string instead of an override to NULL — introduced by the schema rather
// than by the SQL. So the type check lives where the column whitelist already
// is, in src/legacy/override-schema.js, which answers 422 naming the column.
// The house rule stands: do not rely on schema strictness to reject a field.
const valuesSchema = { type: 'object', minProperties: 1 }

const createBodySchema = {
  type: 'object',
  required: ['values'],
  additionalProperties: false,
  properties: { values: valuesSchema },
}

const patchBodySchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    set: valuesSchema,
    revert: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', maxLength: 100 },
    },
  },
}

export const adminLegacyRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')
  const director = app.guards.requireRole('director')

  // `can_view_finance` is not on request.user — guards load it through
  // PUBLIC_USER_COLUMNS, which deliberately does not carry the flag — so it is
  // fetched keyed on the id the SESSION resolved. Fails closed: a row that has
  // gone has no finance.
  const requireFinanceFor = async (request, entity, columns) => {
    if (!touchesCommercial(entity, columns)) return
    const access = await loadReportAccess(pool, request.user)
    if (!access.finance) {
      throw httpError(
        403,
        'Editing a commercial column needs finance access. Ask a director.'
      )
    }
  }

  app.get(
    '/admin/legacy/:entity',
    { preHandler: backoffice, schema: { params: entityParamsSchema, querystring: listQuerySchema } },
    async (request) => {
      const { items, total, page, limit, merged } = await listLegacy(pool, request.params.entity, {
        q: request.query.q,
        filters: filtersFromQuery(request.query),
        page: request.query.page,
        limit: request.query.limit,
        includeArchived: request.query.include_archived,
      })
      return {
        items,
        // `merged` tells the CRM whether any correction is in play for this
        // entity at all, so a browser can label the view rather than presenting
        // corrected values as D365 truth.
        meta: { total, page, limit, entity: request.params.entity, merged },
      }
    }
  )

  app.get(
    '/admin/legacy/:entity/:guid',
    { preHandler: backoffice, schema: { params: guidParamsSchema } },
    async (request, reply) => {
      const record = await getLegacy(pool, request.params.entity, request.params.guid)
      if (!record) {
        reply.code(404)
        return { error: 'Not Found', message: `No ${request.params.entity} record ${request.params.guid}.` }
      }
      return { record }
    }
  )

  // Raise a record D365 does not have. Director-only: this invents a customer,
  // a price row or a stock item that no export will ever confirm.
  app.post(
    '/admin/legacy/:entity',
    { preHandler: director, schema: { params: entityParamsSchema, body: createBodySchema } },
    async (request, reply) => {
      const record = await createLocalLegacyRecord(pool, request.params.entity, {
        values: request.body.values,
        userId: request.user.id,
      })
      reply.code(201)
      return { record }
    }
  )

  // Correct a record. `revert` drops a correction and returns the column to
  // whatever the staging row currently says — which is the only way back, since
  // an explicit null in `set` is a deliberate override TO empty.
  app.patch(
    '/admin/legacy/:entity/:guid',
    { preHandler: backoffice, schema: { params: guidParamsSchema, body: patchBodySchema } },
    async (request) => {
      const { entity, guid } = request.params
      const { set = {}, revert = [] } = request.body
      await requireFinanceFor(request, entity, [...Object.keys(set), ...revert])
      const record = await setLegacyOverrides(pool, entity, guid, {
        set,
        revert,
        userId: request.user.id,
      })
      return { record }
    }
  )

  // Hide a record. Deliberately NOT routed through src/lifecycle/: that module's
  // registry keys an entity on a single scalar `idColumn` (assertEntity enforces
  // `/^[a-z][a-z0-9_]*$/` and a probe with exactly one `$1`) and `deleteOrExplain`
  // takes one id, so a composite (entity, guid) cannot be expressed there. Nor is
  // this a hard delete: no legacy_ table has an `archived_at`, the staging row is
  // owned by the import, and a `DELETE FROM legacy_accounts` would be undone by
  // the next export. The success shape still matches `replyDelete`'s, widened by
  // the single additive `warning` key — the REIMPORT_WARNING precedent.
  app.delete(
    '/admin/legacy/:entity/:guid',
    { preHandler: director, schema: { params: guidParamsSchema } },
    async (request) => {
      const { entity, guid } = request.params
      await setLegacySuppressed(pool, entity, guid, { archived: true, userId: request.user.id })
      return { deleted: { entity, guid }, warning: SUPPRESSION_WARNING }
    }
  )

  app.post(
    '/admin/legacy/:entity/:guid/restore',
    { preHandler: director, schema: { params: guidParamsSchema } },
    async (request) => {
      const { entity, guid } = request.params
      const record = await setLegacySuppressed(pool, entity, guid, {
        archived: false,
        userId: request.user.id,
      })
      return { record }
    }
  )
}
