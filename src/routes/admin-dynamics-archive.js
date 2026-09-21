// /admin/dynamics/* — the Dynamics archive the CRM's Archive page reads: every
// legacy_* staging table, every column, filterable on any of them. Read-only;
// corrections still go through /admin/legacy/:entity, which is why the describe
// read carries each entity's `read_entity` (null for the eight without one).
//
// Backoffice, like the curated legacy reads. Commercial columns are gated on
// WRITE there, not on read, and the same holds here.

import {
  ARCHIVE_ENTITIES,
  MAX_LIMIT,
  countArchive,
  describeArchive,
  facetArchive,
  getArchive,
  listArchive,
} from '../legacy/archive-read.js'

const GUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

const entityParams = {
  type: 'object',
  required: ['entity'],
  properties: { entity: { type: 'string', enum: ARCHIVE_ENTITIES } },
}

const guidParams = {
  type: 'object',
  required: ['entity', 'guid'],
  properties: {
    entity: { type: 'string', enum: ARCHIVE_ENTITIES },
    guid: { type: 'string', pattern: GUID_PATTERN },
  },
}

// `filter` is `column:op:value`, repeatable. Ajv coerces a lone string to a
// one-element array (Fastify's default `coerceTypes: 'array'`), so `?filter=a`
// and `?filter=a&filter=b` both arrive as arrays.
const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: 200 },
    filter: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
    sort: { type: 'string', maxLength: 100 },
    dir: { type: 'string', enum: ['asc', 'desc'] },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 50 },
  },
}

const facetQuery = {
  type: 'object',
  required: ['column'],
  additionalProperties: false,
  properties: { column: { type: 'string', maxLength: 100 } },
}

export const adminDynamicsArchiveRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get('/admin/dynamics', { preHandler: backoffice }, async () => {
    const counts = await countArchive(pool)
    return {
      entities: describeArchive().map((entity) => ({ ...entity, total: counts[entity.entity] })),
    }
  })

  app.get(
    '/admin/dynamics/:entity',
    { preHandler: backoffice, schema: { params: entityParams, querystring: listQuery } },
    async (request) => {
      const { entity } = request.params
      const { q, filter, sort, dir, page, limit } = request.query
      const result = await listArchive(pool, entity, { q, filters: filter ?? [], sort, dir, page, limit })
      return {
        items: result.items,
        meta: { total: result.total, page: result.page, limit: result.limit, entity, sort: result.sort },
      }
    }
  )

  app.get(
    '/admin/dynamics/:entity/facets',
    { preHandler: backoffice, schema: { params: entityParams, querystring: facetQuery } },
    async (request) => ({
      column: request.query.column,
      values: await facetArchive(pool, request.params.entity, request.query.column),
    })
  )

  app.get(
    '/admin/dynamics/:entity/:guid',
    { preHandler: backoffice, schema: { params: guidParams } },
    async (request) => ({ record: await getArchive(pool, request.params.entity, request.params.guid) })
  )
}
