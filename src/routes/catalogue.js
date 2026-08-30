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
import { listCollections, getCollection } from '../catalogue/collections.js'
import { canSeeTradeCatalogue, canSeeTradePricing } from '../catalogue/visibility.js'
import { CATEGORIES } from '../../scripts/lib/price-template.js'

// Every public route below resolves the optional session ONCE and derives both
// gates from it. They are not the same gate (see catalogue/visibility.js):
// `includeTrade` is the price (approved trade only), `includeTradeOnly` is
// which houses are visible at all (approved trade AND staff).
const viewerGates = (user) => ({
  includeTrade: canSeeTradePricing(user),
  includeTradeOnly: canSeeTradeCatalogue(user),
})

// The message a signed-out visitor gets for a represented house's product. It
// names no detail of the product — only that the library it belongs to is open
// to trade accounts, and where to apply.
const TRADE_ONLY_MESSAGE =
  'This design is part of our trade library. Sign in with an approved trade account, or apply for one, to view it.'

// Querystring filters are all optional exact-match strings, plus free-text
// search, sort and pagination. product_type and sort are constrained by enum;
// unknown query params are ignored (the read model's whitelist is the gate).
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: 'string', maxLength: 200 },
    collection: { type: 'string', maxLength: 200 },
    application: { type: 'string', maxLength: 200 },
    composition: { type: 'string', maxLength: 200 },
    width: { type: 'string', maxLength: 200 },
    price_band: { type: 'string', maxLength: 200 },
    lead_time: { type: 'string', maxLength: 200 },
    size: { type: 'string', maxLength: 200 },
    product_type: { type: 'string', enum: ['fabric', 'finished_good'] },
    // Derived from the stored vocabulary, never retyped — the same posture
    // src/routes/admin-price-lists.js takes with CURRENCY_ENUM. A value the
    // database could not hold is a 400 here rather than a query that matches
    // nothing and reads like an empty catalogue.
    category: { type: 'string', enum: [...CATEGORIES] },
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

// The house slug keeps the name `slug` deliberately: Fastify's router rejects
// two different parameter names in the same path position, so renaming it here
// would break /catalogue/brands/:slug.
const brandCollectionParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slug', 'collectionSlug'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 200 },
    collectionSlug: { type: 'string', minLength: 1, maxLength: 200 },
  },
}

const collectionQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand: { type: 'string', maxLength: 200 },
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
      const gates = viewerGates(user)
      const result = await listProducts(pool, { filters, page, limit, sort, ...gates })
      return {
        products: result.products,
        meta: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          sort: result.sort,
          // The storefront needs to know it is looking at the public subset, or
          // it presents the house's own workroom as if it were the whole
          // library. Never a secret — it is the invitation to apply for trade.
          trade_gated: result.trade_gated,
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
      const gates = viewerGates(user)
      const { product, restricted } = await getProductDetail(
        pool,
        request.params.slug,
        gates
      )
      // 403, not 404: the product exists and its URL is shareable, so pretending
      // otherwise would render a dead page for a shopper who was sent the link —
      // and the storefront's server-side render carries no session cookie, so a
      // trade customer's own product page would 404 in the HTML. `trade_only`
      // lets the page draw the application invitation rather than an error.
      if (restricted) {
        return reply
          .code(403)
          .send({ error: TRADE_ONLY_MESSAGE, message: TRADE_ONLY_MESSAGE, trade_only: true })
      }
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

  // Collection navigation. Neither route returns products: the grid for a
  // collection is GET /catalogue/products?brand=&collection=, which keeps
  // filtering, sorting, paging and the trade-price gate in one place.
  app.get(
    '/catalogue/collections',
    { schema: { querystring: collectionQuerySchema } },
    async (request) => {
      const user = await app.guards.loadOptionalUser(request)
      return {
        collections: await listCollections(pool, {
          brandSlug: request.query.brand,
          includeTradeOnly: canSeeTradeCatalogue(user),
        }),
      }
    }
  )

  // Brand-scoped because a collection slug is only unique within its house.
  app.get(
    '/catalogue/brands/:slug/collections/:collectionSlug',
    { schema: { params: brandCollectionParamsSchema } },
    async (request, reply) => {
      const user = await app.guards.loadOptionalUser(request)
      const collection = await getCollection(
        pool,
        request.params.slug,
        request.params.collectionSlug,
        { includeTradeOnly: canSeeTradeCatalogue(user) }
      )
      if (!collection) {
        return reply.code(404).send({ error: 'Collection not found.' })
      }
      return { collection }
    }
  )
}
