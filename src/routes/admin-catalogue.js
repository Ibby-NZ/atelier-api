// Back-office catalogue management endpoints: brands, collections, products,
// colourways. All routes are backoffice-only (director inherits via the role
// guard). Handlers stay thin — the rules live in ../catalogue/admin-brands.js
// and ../catalogue/admin-products.js.
//
// Design notes:
//   - SKUs are typed in manually by staff. The CRM's SKU generator is not ported
//     here; the API only enforces uniqueness (a 23505 becomes a 409).
//   - Slugs are server-generated on create and immutable afterwards, so no
//     schema below accepts a `slug`; `additionalProperties: false` turns an
//     attempt into a 400.
//   - `product_type` is likewise create-only: the inventory unit is derived from
//     it, so changing it later would leave stock in the wrong unit.
//   - Hard DELETE goes through the lifecycle registry, never a bare SQL delete:
//     almost every child edge out of the catalogue is CASCADE or SET NULL, so
//     the database would report success while destroying (or silently
//     uncollecting) everything underneath it. The one RESTRICT edge —
//     `order_lines.colourway_id` — is a backstop, not the defence.

import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import {
  listAdminBrands,
  getAdminBrand,
  createBrand,
  updateBrand,
  setBrandArchived,
  listAdminCollections,
  getAdminCollection,
  createCollection,
  updateCollection,
  setCollectionArchived,
  setFeaturedBrands,
  setFeaturedCollections,
  FEATURED_LIMIT,
} from '../catalogue/admin-brands.js'
import {
  listAdminProducts,
  getAdminProduct,
  createProduct,
  updateProduct,
  setProductArchived,
  listAdminColourways,
  getAdminColourway,
  createColourway,
  updateColourway,
  setColourwayArchived,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '../catalogue/admin-products.js'

// Shared property shapes. Nullable variants let a PATCH clear an optional field
// with an explicit null.
const nameProp = { type: 'string', minLength: 1, maxLength: 200 }
const nullableText = { type: ['string', 'null'], maxLength: 2000 }
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
const nullableUrl = { type: ['string', 'null'], maxLength: 1000 }
const currencyProp = { type: 'string', pattern: '^[A-Z]{3}$' }
const nullableCents = { type: ['integer', 'null'], minimum: 0 }
const hexTonesProp = {
  type: ['array', 'null'],
  maxItems: 12,
  items: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
}
// Position in the storefront's featured order. Nullable so an explicit null
// clears it (buildUpdate keeps that distinct from an absent key); `minimum`
// applies to numbers only, so the null arm still passes. Rank 0 is refused here
// as well as by the column CHECK, so it is a 400 rather than an opaque 23514.
const featuredRankProp = { type: ['integer', 'null'], minimum: 1 }
const slugProp = { type: 'string', minLength: 1, maxLength: 200 }

// Spec + pricing fields shared by product create and patch.
const productDetailProps = {
  name: nameProp,
  collection_id: { type: ['integer', 'null'], minimum: 1 },
  composition: nullableShort,
  width: nullableShort,
  application: nullableShort,
  rubs: nullableShort,
  price_band: nullableShort,
  lead_time: nullableShort,
  retail_price_cents: nullableCents,
  trade_price_cents: nullableCents,
  currency: currencyProp,
  hi_res_asset_url: nullableUrl,
}

// :id is coerced to an integer by Fastify; a non-numeric id is a 400 by schema.
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

const brandQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand_id: { type: 'integer', minimum: 1 },
    include_archived: { type: 'boolean', default: false },
  },
}

// For the top-level brand list, which takes no brand_id.
const archivedQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    include_archived: { type: 'boolean', default: false },
  },
}

const brandCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'currency'],
  properties: {
    name: nameProp,
    currency: currencyProp,
    story: nullableText,
    country: nullableShort,
    is_international: { type: 'boolean', default: false },
    // Defaults closed — see createBrand.
    trade_only: { type: 'boolean', default: true },
    website_url: nullableUrl,
  },
}

const brandPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: nameProp,
    currency: currencyProp,
    story: nullableText,
    country: nullableShort,
    is_international: { type: 'boolean' },
    trade_only: { type: 'boolean' },
    website_url: nullableUrl,
    featured_rank: featuredRankProp,
  },
}

const collectionCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['brand_id', 'name'],
  properties: {
    brand_id: { type: 'integer', minimum: 1 },
    name: nameProp,
    description: nullableText,
    image_url: nullableUrl,
  },
}

const collectionPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: nameProp,
    description: nullableText,
    image_url: nullableUrl,
    featured_rank: featuredRankProp,
  },
}

// Whole-list reorder bodies. Both accept an EMPTY array — featuring nothing is
// how the office turns a strip off — and both cap the list, so an accidental
// paste of the whole catalogue is a 400 rather than a page of hero slides.
//
// Houses are named by slug; collections by the (brand_slug, slug) PAIR, because
// a collection slug is unique per brand and never globally.
const featuredBrandsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['slugs'],
  properties: {
    slugs: { type: 'array', maxItems: FEATURED_LIMIT, items: slugProp },
  },
}

const featuredCollectionsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['collections'],
  properties: {
    collections: {
      type: 'array',
      maxItems: FEATURED_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['brand_slug', 'slug'],
        properties: { brand_slug: slugProp, slug: slugProp },
      },
    },
  },
}

const productCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['brand_id', 'name', 'product_type', 'currency'],
  properties: {
    ...productDetailProps,
    brand_id: { type: 'integer', minimum: 1 },
    product_type: { type: 'string', enum: ['fabric', 'finished_good'] },
    show_on_website: { type: 'boolean', default: false },
  },
}

// No brand_id and no product_type: both are create-only (see the header).
const productPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    ...productDetailProps,
    show_on_website: { type: 'boolean' },
  },
}

// Colourways are the only catalogue list that pages: one row per SKU makes this
// the largest table in the catalogue, so an unpaged read would be unusable long
// before the colour files land.
const colourwayQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_id: { type: 'integer', minimum: 1 },
    brand_id: { type: 'integer', minimum: 1 },
    q: { type: 'string', maxLength: 200 },
    include_archived: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

const colourwayProps = {
  name: nameProp,
  sku: { type: 'string', minLength: 1, maxLength: 100 },
  hex_tones: hexTonesProp,
  image_url: nullableUrl,
}

const colourwayCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'sku'],
  properties: colourwayProps,
}

const colourwayPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: colourwayProps,
}

export const adminCatalogueRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/brands',
    { preHandler: backoffice, schema: { querystring: archivedQuerySchema } },
    async (request) => ({
      brands: await listAdminBrands(pool, {
        includeArchived: request.query.include_archived,
      }),
    })
  )

  // Single-row reads. The CRM re-reads a row after a write rather than refetching
  // the list, so these carry what the list cannot: the brand's collections, and
  // the child counts that say in advance whether a DELETE will be accepted.
  app.get(
    '/admin/brands/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const brand = await getAdminBrand(pool, request.params.id)
      if (!brand) {
        reply.code(404)
        return { error: 'Not Found', message: `Brand ${request.params.id} not found.` }
      }
      return { brand }
    }
  )

  app.post(
    '/admin/brands',
    { preHandler: backoffice, schema: { body: brandCreateSchema } },
    async (request, reply) => {
      const brand = await createBrand(pool, request.body)
      reply.code(201)
      return { brand }
    }
  )

  app.patch(
    '/admin/brands/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: brandPatchSchema } },
    async (request) => ({
      brand: await updateBrand(pool, request.params.id, request.body),
    })
  )

  // Whole-list featured reorder. PUT rather than PATCH because the body IS the
  // list: anything absent from it stops being featured. A static path segment
  // beats a parametric one in Fastify's router, and nothing else registers PUT
  // under /admin/brands, so this can never be read as `:id`.
  app.put(
    '/admin/brands/featured',
    { preHandler: backoffice, schema: { body: featuredBrandsBodySchema } },
    async (request) => ({ brands: await setFeaturedBrands(pool, request.body.slugs) })
  )

  app.put(
    '/admin/collections/featured',
    { preHandler: backoffice, schema: { body: featuredCollectionsBodySchema } },
    async (request) => ({
      collections: await setFeaturedCollections(pool, request.body.collections),
    })
  )

  app.get(
    '/admin/collections',
    { preHandler: backoffice, schema: { querystring: brandQuerySchema } },
    async (request) => ({
      collections: await listAdminCollections(pool, {
        brandId: request.query.brand_id,
        includeArchived: request.query.include_archived,
      }),
    })
  )

  app.get(
    '/admin/collections/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const collection = await getAdminCollection(pool, request.params.id)
      if (!collection) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Collection ${request.params.id} not found.`,
        }
      }
      return { collection }
    }
  )

  app.post(
    '/admin/collections',
    { preHandler: backoffice, schema: { body: collectionCreateSchema } },
    async (request, reply) => {
      const collection = await createCollection(pool, request.body)
      reply.code(201)
      return { collection }
    }
  )

  app.patch(
    '/admin/collections/:id',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: collectionPatchSchema },
    },
    async (request) => ({
      collection: await updateCollection(pool, request.params.id, request.body),
    })
  )

  app.get(
    '/admin/products',
    { preHandler: backoffice, schema: { querystring: brandQuerySchema } },
    async (request) => ({
      products: await listAdminProducts(pool, {
        brandId: request.query.brand_id,
        includeArchived: request.query.include_archived,
      }),
    })
  )

  app.get(
    '/admin/products/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const product = await getAdminProduct(pool, request.params.id)
      if (!product) {
        reply.code(404)
        return { error: 'Not Found', message: `Product ${request.params.id} not found.` }
      }
      return { product }
    }
  )

  app.post(
    '/admin/products',
    { preHandler: backoffice, schema: { body: productCreateSchema } },
    async (request, reply) => {
      const product = await createProduct(pool, request.body)
      reply.code(201)
      return { product }
    }
  )

  app.patch(
    '/admin/products/:id',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: productPatchSchema },
    },
    async (request) => ({
      product: await updateProduct(pool, request.params.id, request.body),
    })
  )

  // The SKU-level browse. Colourways are reachable through their product, but a
  // staff member holding a SKU does not know which design it belongs to — so
  // this list carries the design and house on every row, and pages.
  app.get(
    '/admin/colourways',
    { preHandler: backoffice, schema: { querystring: colourwayQuerySchema } },
    async (request) => {
      const { product_id, brand_id, q, include_archived, page, limit } = request.query
      const { items, total } = await listAdminColourways(pool, {
        productId: product_id,
        brandId: brand_id,
        q,
        includeArchived: include_archived,
        page,
        limit,
      })
      return { colourways: items, meta: { total, page, limit } }
    }
  )

  app.get(
    '/admin/colourways/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const colourway = await getAdminColourway(pool, request.params.id)
      if (!colourway) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Colourway ${request.params.id} not found.`,
        }
      }
      return { colourway }
    }
  )

  // Nested under the product: the handler needs the parent both to 404 on an
  // unknown product and to derive the inventory unit from its product_type.
  app.post(
    '/admin/products/:id/colourways',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: colourwayCreateSchema },
    },
    async (request, reply) => {
      const colourway = await createColourway(pool, request.params.id, request.body)
      reply.code(201)
      return { colourway }
    }
  )

  app.patch(
    '/admin/colourways/:id',
    {
      preHandler: backoffice,
      schema: { params: idParamsSchema, body: colourwayPatchSchema },
    },
    async (request) => ({
      colourway: await updateColourway(pool, request.params.id, request.body),
    })
  )

  // Archive / restore. Archiving is the storefront admin's "delete": it is a
  // soft delete (sets archived_at), reversible via restore, and never removes a
  // row that commerce records may still reference. The module functions throw a
  // 404 when the id is unknown.
  app.post(
    '/admin/brands/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({ brand: await setBrandArchived(pool, request.params.id, true) })
  )
  app.post(
    '/admin/brands/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({ brand: await setBrandArchived(pool, request.params.id, false) })
  )

  app.post(
    '/admin/collections/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      collection: await setCollectionArchived(pool, request.params.id, true),
    })
  )
  app.post(
    '/admin/collections/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      collection: await setCollectionArchived(pool, request.params.id, false),
    })
  )

  app.post(
    '/admin/products/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      product: await setProductArchived(pool, request.params.id, true),
    })
  )
  app.post(
    '/admin/products/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      product: await setProductArchived(pool, request.params.id, false),
    })
  )

  app.post(
    '/admin/colourways/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      colourway: await setColourwayArchived(pool, request.params.id, true),
    })
  )
  app.post(
    '/admin/colourways/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request) => ({
      colourway: await setColourwayArchived(pool, request.params.id, false),
    })
  )

  // Hard delete. The counterpart to archive above, for a row created in error
  // that no commerce record has touched yet — a test house, a mistyped
  // collection. `deleteOrExplain` probes first and *returns* its refusal, so the
  // handler pipes the result straight to `replyDelete`: a 409 has to carry
  // `blockers`, and Fastify's error serializer drops custom properties off a
  // thrown error.
  //
  // The entity name is a code literal in each call, never `:entity` from the
  // URL — the registry knows 'brand' and 'user' alike, so it is not an
  // authorisation boundary (test/lifecycle-registry.test.js asserts the literal).
  app.delete(
    '/admin/brands/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'brand', request.params.id, { user: request.user })
      )
  )

  app.delete(
    '/admin/collections/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'collection', request.params.id, {
          user: request.user,
        })
      )
  )

  // A product owns its colourways and their stock rows (both CASCADE), so those
  // go with it; what it must never take with it is commerce record. The probes
  // reach the grandchildren through the colourways — order lines, and stock that
  // is on hand or reserved — because the cascade would otherwise destroy them
  // and report success.
  app.delete(
    '/admin/products/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'product', request.params.id, { user: request.user })
      )
  )

  app.delete(
    '/admin/colourways/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'colourway', request.params.id, {
          user: request.user,
        })
      )
  )
}
