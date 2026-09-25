// /admin/catalogue/colours/import/* — the Supplier Colours workbook, uploaded
// from the CRM's Products list (src/catalogue/supplier-colours-import.js).
//
//   POST /admin/catalogue/colours/import/validate?filename=   the dry run; writes nothing
//   POST /admin/catalogue/colours/import/apply?filename=      the colourway import, one transaction
//
// DIRECTOR-ONLY. One file creates thousands of designs and colourways in the
// catalogue — the same bulk-write posture as the Dynamics import and the
// cutover merge (back office may browse and edit; a director loads in bulk).
// Nothing here is a cost figure, so the finance grant is not asked for.
//
// Its own plugin because it registers a raw-body parser for the workbook, and a
// parser is encapsulated to the plugin that registers it.

import {
  applySupplierColours,
  planSupplierColours,
  readSupplierColoursWorkbook,
} from '../catalogue/supplier-colours-import.js'
import { applyProductSync } from '../pricing/product-price-sync.js'

const IMPORT_CONTENT_TYPES = Object.freeze([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])
// The 25 Sep 2026 workbook is 1.3 MB for 50,575 rows.
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024

const IMPORT_QUERY = {
  type: 'object',
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f/\\\\]+$' },
  },
}

export const adminSupplierColourRoutes = async (app, { pool }) => {
  const director = app.guards.requireRole('director')

  app.addContentTypeParser(
    [...IMPORT_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const readUpload = (request, reply) => {
    const filename = request.query?.filename ?? 'supplier-colours.xlsx'
    try {
      return { filename, read: readSupplierColoursWorkbook(request.body, filename) }
    } catch (error) {
      if (error.statusCode !== 422) throw error
      // The default serialiser would drop the per-row list.
      reply.code(422)
      return { refusal: { message: error.message, errors: error.errors ?? [], error_count: error.error_count ?? 0 } }
    }
  }

  const options = { preHandler: director, bodyLimit: IMPORT_BODY_LIMIT, schema: { querystring: IMPORT_QUERY } }

  app.post('/admin/catalogue/colours/import/validate', options, async (request, reply) => {
    const { read, filename, refusal } = readUpload(request, reply)
    if (refusal) return refusal
    return { filename, sheet: read.sheet, ...(await planSupplierColours(pool, read)) }
  })

  app.post('/admin/catalogue/colours/import/apply', options, async (request, reply) => {
    const { read, filename, refusal } = readUpload(request, reply)
    if (refusal) return refusal
    const { plan, summary } = await applySupplierColours(pool, read)
    // A design this file just created has no price; one a product price names
    // takes its trade price, wholesale rate and category from it — fill-only,
    // the same step the product-prices upload ends with. Only counts travel
    // back: this route is not finance-gated.
    const synced = await applyProductSync(pool, { sourceFile: filename, userId: request.user?.id ?? null })
    return {
      filename,
      sheet: read.sheet,
      ...plan,
      applied: {
        colourways: summary.colourways,
        products: summary.products,
        stock_rows_created: summary.inventoryCreated,
        products_priced: synced.trade_filled,
      },
    }
  })
}
