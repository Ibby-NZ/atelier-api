// /admin/inventory/stock-levels/* — Dynamics' Stock View, uploaded from the
// CRM's Products list (src/catalogue/stock-levels-import.js).
//
//   POST /admin/inventory/stock-levels/validate   the dry run; writes nothing
//   POST /admin/inventory/stock-levels/apply      stock onto the matched variations, one transaction
//
// DIRECTOR-ONLY, the bulk-load posture of the colours upload beside it. Its
// own plugin because it registers a raw-body parser for the workbook.

import { applyStockLevels, omitStockWrites, planStockLevels, readStockLevelsWorkbook } from '../catalogue/stock-levels-import.js'

const IMPORT_CONTENT_TYPES = Object.freeze([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])
// The 28 Sep 2026 Stock View is 1.2 MB for 7,750 items.
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024

const IMPORT_QUERY = {
  type: 'object',
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f/\\\\]+$' },
  },
}

export const adminStockLevelRoutes = async (app, { pool }) => {
  const director = app.guards.requireRole('director')

  app.addContentTypeParser(
    [...IMPORT_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const readUpload = (request, reply) => {
    const filename = request.query?.filename ?? 'stock-view.xlsx'
    try {
      return { filename, read: readStockLevelsWorkbook(request.body) }
    } catch (error) {
      if (error.statusCode !== 422) throw error
      // The default serialiser would drop the per-row list.
      reply.code(422)
      return { refusal: { message: error.message, errors: error.errors ?? [], error_count: error.error_count ?? 0 } }
    }
  }

  const options = { preHandler: director, bodyLimit: IMPORT_BODY_LIMIT, schema: { querystring: IMPORT_QUERY } }

  app.post('/admin/inventory/stock-levels/validate', options, async (request, reply) => {
    const { read, filename, refusal } = readUpload(request, reply)
    if (refusal) return refusal
    return { filename, ...omitStockWrites(await planStockLevels(pool, read.rows)) }
  })

  app.post('/admin/inventory/stock-levels/apply', options, async (request, reply) => {
    const { read, filename, refusal } = readUpload(request, reply)
    if (refusal) return refusal
    return { filename, ...(await applyStockLevels(pool, read.rows)) }
  })
}
