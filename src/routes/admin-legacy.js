// Read-only back-office access to the Dynamics-365 staging tables. The CRM
// browses Atelier's real customers / sales orders / stock / prices through these;
// there are deliberately NO write routes (the data is a re-importable mirror of a
// still-live system — see src/legacy/legacy-read.js). All routes are
// backoffice-only; handlers stay thin.

import { LEGACY_ENTITIES, listLegacy, getLegacy } from '../legacy/legacy-read.js'

const entityParamsSchema = {
  type: 'object',
  required: ['entity'],
  properties: {
    entity: { type: 'string', enum: LEGACY_ENTITIES },
  },
}

const guidParamsSchema = {
  type: 'object',
  required: ['entity', 'guid'],
  properties: {
    entity: { type: 'string', enum: LEGACY_ENTITIES },
    // D365 record GUID.
    guid: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
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

export const adminLegacyRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/legacy/:entity',
    { preHandler: backoffice, schema: { params: entityParamsSchema, querystring: listQuerySchema } },
    async (request) => {
      const { items, total, page, limit } = await listLegacy(pool, request.params.entity, {
        q: request.query.q,
        filters: filtersFromQuery(request.query),
        page: request.query.page,
        limit: request.query.limit,
      })
      return { items, meta: { total, page, limit, entity: request.params.entity } }
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
}
