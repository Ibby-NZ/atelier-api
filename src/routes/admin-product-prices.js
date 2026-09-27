// /admin/product-prices/* — the Dynamics product prices, re-imported, each
// priced through its house's range parameters (src/pricing/product-prices.js).
//
//   GET  /admin/product-prices                 a page, each row with its price
//        ?q&range&brand_id&design&currency&include_previous&page&limit
//   GET  /admin/product-prices/ranges          the ranges named, and each one's house
//   GET  /admin/product-prices/imports         who imported which export, when
//   GET  /admin/product-prices/:id             one row with its full waterfall
//   POST /admin/product-prices/import/validate the "Active Product Prices" .xlsx — dry run
//   POST /admin/product-prices/import/apply    the same file — one transaction, then
//                                              a product for every row the catalogue
//                                              lacks, then the prices onto them, fill-only
//   POST /admin/product-prices/:id/apply-to-product  { product_id } — replace one
//                                              product's prices with this row's
//
// FINANCE-GATED, reads included: a wholesale rate is Atelier's buy side and a
// landed cost is its cost, the reason every /admin/pricing/* route sits behind
// the same gate. Role first (it sets request.user), then the grant.
//
// Its own plugin, because it registers a raw-body content-type parser for the
// workbook and a parser is encapsulated to the plugin that registers it — the
// house import registers the same two types inside /admin/pricing, and the two
// scopes never meet.

import { requireFinance } from '../reports/access.js'
import {
  MAX_LIMIT,
  getProductPrice,
  listProductPriceImports,
  listProductPriceRanges,
  listProductPrices,
} from '../pricing/product-prices.js'
import { applyPriceToProduct, applyProductSync } from '../pricing/product-price-sync.js'
import { createProductsFromPrices, omitWrites, planPriceCatalogue } from '../catalogue/product-price-catalogue.js'
import {
  applyProductPricesImport,
  planProductPricesImport,
  readProductPricesWorkbook,
} from '../pricing/product-prices-import.js'

const IMPORT_CONTENT_TYPES = Object.freeze([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])
// The 25 Sep 2026 export is 3.9 MB for 21,102 rows; room for the list to grow.
const IMPORT_BODY_LIMIT = 32 * 1024 * 1024

const FINANCE_MESSAGE =
  'Product prices carry cost figures — wholesale rates and landed costs. Your account does not have finance visibility.'

const ID_PARAMS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

const LIST_QUERY = {
  type: 'object',
  properties: {
    q: { type: 'string', maxLength: 200 },
    range: { type: 'string', maxLength: 200 },
    brand_id: { type: 'integer', minimum: 1 },
    design: { type: 'string', maxLength: 300 },
    currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
    include_previous: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
    page: { type: 'integer', minimum: 1 },
  },
}

const IMPORT_QUERY = {
  type: 'object',
  properties: {
    // Stored on the import log and read for the export stamp; bounded and free
    // of control characters and path separators, the price-list import's rule.
    filename: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f/\\\\]+$' },
  },
}

// The plan's write lists are for apply, not for the wire.
const report = ({ writes: _writes, ...plan }) => plan

export const adminProductPriceRoutes = async (app, { pool }) => {
  const guarded = [app.guards.requireRole('backoffice'), requireFinance(pool, FINANCE_MESSAGE)]

  app.get('/admin/product-prices', { preHandler: guarded, schema: { querystring: LIST_QUERY } },
    async (request) => listProductPrices(pool, request.query ?? {})
  )

  app.get('/admin/product-prices/ranges', { preHandler: guarded },
    async () => ({ ranges: await listProductPriceRanges(pool) })
  )

  app.get('/admin/product-prices/imports', { preHandler: guarded },
    async () => ({ imports: await listProductPriceImports(pool) })
  )

  app.get('/admin/product-prices/:id', { preHandler: guarded, schema: { params: ID_PARAMS } },
    async (request) => ({ product_price: await getProductPrice(pool, request.params.id) })
  )

  // --- the export, uploaded -------------------------------------------------------
  // Validate and apply are two routes, never a `?dry_run=` flag: a request that
  // can write must not be one query parameter away from one that cannot. Apply
  // takes the FILE again and re-plans against the live state.
  app.addContentTypeParser(
    [...IMPORT_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const readUpload = (request, reply) => {
    const filename = request.query?.filename ?? 'product-prices.xlsx'
    try {
      return { filename, read: readProductPricesWorkbook(request.body, filename) }
    } catch (error) {
      if (error.statusCode !== 422) throw error
      // Fastify's default serialiser would drop the per-row list; the office
      // needs it to find the row again.
      reply.code(422)
      return { refusal: { message: error.message, errors: error.errors ?? [], error_count: error.error_count ?? 0 } }
    }
  }

  const importOptions = { preHandler: guarded, bodyLimit: IMPORT_BODY_LIMIT, schema: { querystring: IMPORT_QUERY } }

  app.post('/admin/product-prices/import/validate', importOptions, async (request, reply) => {
    const { read, filename, refusal } = readUpload(request, reply)
    if (refusal) return refusal
    const plan = await planProductPricesImport(pool, read)
    const products = await planPriceCatalogue(pool, read.rows)
    return { filename, exported_at: read.exported_at, ...report(plan), products: omitWrites(products) }
  })

  app.post('/admin/product-prices/import/apply', importOptions, async (request, reply) => {
    const { read, filename, refusal } = readUpload(request, reply)
    if (refusal) return refusal
    const applied = await applyProductPricesImport(pool, read, { filename, userId: request.user?.id ?? null })
    // Every row is a product (product-price-catalogue.js): the ones the
    // catalogue does not hold yet are created, hidden.
    const products = await createProductsFromPrices(pool, read.rows)
    // Then onto the catalogue: every product a row names gets its trade price,
    // wholesale rate and category where it has none (fill-only — a price the
    // office typed is kept and reported).
    const catalogue = await applyProductSync(pool, { sourceFile: filename, userId: request.user?.id ?? null })
    return {
      filename,
      exported_at: read.exported_at,
      import_id: applied.import_id,
      fx_filled: applied.fx_filled,
      fx_updated: applied.fx_updated,
      ...report(applied.plan),
      products,
      catalogue,
    }
  })

  // --- one price onto one catalogue product -----------------------------------------
  // The product page's "Set as the trade price": replaces what the product
  // carries with this row's range price, recorded as a manual move with a reason.
  app.post(
    '/admin/product-prices/:id/apply-to-product',
    {
      preHandler: guarded,
      schema: {
        params: ID_PARAMS,
        body: { type: 'object', required: ['product_id'], properties: { product_id: { type: 'integer', minimum: 1 } } },
      },
    },
    async (request) => ({
      catalogue: await applyPriceToProduct(pool, {
        productPriceId: request.params.id,
        productId: request.body.product_id,
        userId: request.user?.id ?? null,
      }),
    })
  )
}
