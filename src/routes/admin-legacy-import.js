// The one write path into the Dynamics-365 staging tables.
//
// Why it exists: the normalised exports live under incoming/ (gitignored, client
// PII), so a deploy can never carry them and `npm run import:legacy` on the
// server would find an empty directory. Where there is no shell on the box, an
// authenticated HTTPS request is the only channel left — so the push runs from
// a workstation that has the files and streams them up in gzipped batches
// (see src/seed/push-legacy.js).
//
// Deliberately separate from src/routes/admin-legacy.js: those GET routes stay
// read-only, and this one is DIRECTOR-only rather than backoffice, because bulk
// -writing client records is a narrower privilege than browsing them.
//
// Safe to re-run at any point: importLegacyEntity upserts on the D365 GUID in a
// single transaction per batch, so a retry after a dropped connection re-applies
// the same batch instead of duplicating it.

import {
  LEGACY_TABLES,
  importLegacyEntity,
  validateLegacyRecords,
} from '../seed/legacy-import.js'
import { decodeImportPayload } from '../legacy/import-payload.js'

export const LEGACY_IMPORT_ENTITIES = Object.freeze(Object.keys(LEGACY_TABLES))

// Room for a gzipped batch many times over. The compressed body is what counts
// here; the decompressed cap lives in decodeImportPayload.
const BODY_LIMIT = 8 * 1024 * 1024

const paramsSchema = {
  type: 'object',
  required: ['entity'],
  properties: {
    // Note these are the export/table entity names (product_prices,
    // sales_orders), NOT the read routes' URL vocabulary (prices, sales-orders).
    entity: { type: 'string', enum: LEGACY_IMPORT_ENTITIES },
  },
}

export const adminLegacyImportRoutes = async (app, { pool }) => {
  // Encapsulated to this plugin, exactly like the Stripe webhook's buffer
  // parser: no other route's body handling changes.
  app.addContentTypeParser(
    'application/gzip',
    { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const director = app.guards.requireRole('director')

  app.post(
    '/admin/legacy/import/:entity',
    {
      preHandler: director,
      bodyLimit: BODY_LIMIT,
      // A full refresh is ~56 batches; this leaves room for retries and for a
      // second run in the same window without unblocking a credential-stuffer.
      config: { rateLimit: { max: 600, timeWindow: '10 minutes' } },
      schema: { params: paramsSchema },
    },
    async (request) => {
      const { entity } = request.params
      const records = decodeImportPayload(request.body)

      // Field-level rejection before any SQL runs (bad GUID, unknown column,
      // duplicate key within the batch) — a business-rule failure, not a
      // malformed request.
      try {
        validateLegacyRecords(entity, records)
      } catch (error) {
        throw Object.assign(new Error(error.message), { statusCode: 422 })
      }

      const summary = await importLegacyEntity(pool, entity, records)
      request.log.info(
        { entity: summary.entity, table: summary.table, records: summary.records },
        'legacy staging import batch applied'
      )
      return summary
    }
  )
}
