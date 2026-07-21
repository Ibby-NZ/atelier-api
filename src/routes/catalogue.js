import { listProducts, DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT } from '../catalogue/products.js'
import { getProductDetail } from '../catalogue/product-detail.js'
import { listBrands, getBrandBySlug } from '../catalogue/brands.js'
import { effectiveRole } from '../auth/guards.js'

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

const slugParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slug'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 200 },
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

  // Product detail is public, but trade pricing is only revealed to approved
  // trade users. Optional-auth: an anonymous or non-trade request still succeeds,
  // it just never carries trade_price_cents.
  app.get(
    '/catalogue/products/:slug',
    { schema: { params: slugParamsSchema } },
    async (request, reply) => {
      const user = await app.guards.loadOptionalUser(request)
      const includeTrade = !!user && effectiveRole(user) === 'trade'
      const product = await getProductDetail(pool, request.params.slug, { includeTrade })
      if (!product) {
        return reply.code(404).send({ error: 'Product not found.' })
      }
      return { product }
    }
  )

  app.get('/catalogue/brands', async () => ({ brands: await listBrands(pool) }))

  app.get(
    '/catalogue/brands/:slug',
    { schema: { params: slugParamsSchema } },
    async (request, reply) => {
      const brand = await getBrandBySlug(pool, request.params.slug)
      if (!brand) {
        return reply.code(404).send({ error: 'Brand not found.' })
      }
      return { brand }
    }
  )
}
