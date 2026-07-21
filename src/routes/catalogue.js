import { listProducts, DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT } from '../catalogue/products.js'

// Querystring filters are all optional exact-match strings, plus pagination.
// product_type is constrained; unknown query params are rejected by Ajv.
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: 'string', maxLength: 200 },
    application: { type: 'string', maxLength: 200 },
    composition: { type: 'string', maxLength: 200 },
    width: { type: 'string', maxLength: 200 },
    price_band: { type: 'string', maxLength: 200 },
    lead_time: { type: 'string', maxLength: 200 },
    product_type: { type: 'string', enum: ['fabric', 'finished_good'] },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

export const catalogueRoutes = async (app, { pool }) => {
  app.get(
    '/catalogue/products',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const { page, limit, ...filters } = request.query
      const result = await listProducts(pool, { filters, page, limit })
      return {
        products: result.products,
        meta: { total: result.total, page: result.page, limit: result.limit },
      }
    }
  )
}
