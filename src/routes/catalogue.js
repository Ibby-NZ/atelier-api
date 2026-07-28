import {
  listProducts,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  DEFAULT_SORT,
  MAX_LIMIT,
  SORT_KEYS,
} from '../catalogue/products.js'
import { getProductDetail } from '../catalogue/product-detail.js'
import { listBrands, getBrandBySlug } from '../catalogue/brands.js'
import { effectiveRole } from '../auth/guards.js'

// Querystring filters are all optional exact-match strings, plus free-text
// search, sort and pagination. product_type and sort are constrained by enum;
// unknown query params are ignored (the read model's whitelist is the gate).
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
    q: { type: 'string', maxLength: 200 },
    sort: { type: 'string', enum: SORT_KEYS, default: DEFAULT_SORT },
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
  // The listing is public. Like the detail endpoint it is optional-auth: an
  // anonymous request still succeeds, it just never carries trade_price_cents.
  app.get(
    '/catalogue/products',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const { page, limit, sort, ...filters } = request.query
      const user = await app.guards.loadOptionalUser(request)
      const includeTrade = !!user && effectiveRole(user) === 'trade'
      const result = await listProducts(pool, { filters, page, limit, sort, includeTrade })
      return {
        products: result.products,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          sort: result.sort,
        },
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
