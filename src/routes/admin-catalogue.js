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

import {
  listAdminBrands,
  createBrand,
  updateBrand,
  setBrandArchived,
  listAdminCollections,
  createCollection,
  updateCollection,
  setCollectionArchived,
} from '../catalogue/admin-brands.js'
import {
  listAdminProducts,
  getAdminProduct,
  createProduct,
  updateProduct,
  setProductArchived,
  createColourway,
  updateColourway,
  setColourwayArchived,
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
}
