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
import { listCategories, createCategory } from '../catalogue/categories.js'
import { UNITS } from '../../scripts/lib/price-template.js'
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
import { addBrandSupplier, removeBrandSupplier } from '../suppliers/brand-suppliers.js'
import {
  listAdminProducts,
  countAdminProductsByCategory,
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
import { listProductPriceHistory, MAX_REASON_LENGTH } from '../pricing/price-history.js'

// Shared property shapes. Nullable variants let a PATCH clear an optional field
// with an explicit null.
const nameProp = { type: 'string', minLength: 1, maxLength: 200 }
const nullableText = { type: ['string', 'null'], maxLength: 2000 }
const nullableShort = { type: ['string', 'null'], maxLength: 200 }
const classLetterProp = { type: ['string', 'null'], enum: ['A', 'B', 'C', 'D', 'E', null] }
const dutyLetterProp = { type: ['string', 'null'], enum: ['A', 'B', 'C', null] }
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
// W21's two reporting dimensions. Nullable so a PATCH can clear one; a bare ''
// also clears (reportingLabelFrom stores NULL — the columns' CHECKs refuse a
// blank). MUST be declared here as well as in the module whitelists: Ajv's
// removeAdditional STRIPS an unlisted body key rather than 400ing it, so a
// column added to a whitelist alone would answer 200 having written nothing.
const reportingLabelProp = { type: ['string', 'null'], maxLength: 100 }
// NOT an enum, and that is the change migration 1791379200000 makes: the
// vocabulary is `product_categories`, a table the office adds to, and an Ajv
// enum is fixed at boot — a category added at 10am would be refused by a schema
// compiled at 9. The value is checked by the column's foreign key instead, which
// cannot go stale, and `rethrowConflict` turns its 23503 into a 422 naming the
// Categories screen. Nullable because uncategorised is a real state.
const categoryProp = { type: ['string', 'null'], maxLength: 200 }

// Spec + pricing fields shared by product create and patch.
const productDetailProps = {
  name: nameProp,
  collection_id: { type: ['integer', 'null'], minimum: 1 },
  // Free text (the office writes `RAMM, SON & CROCKER`), never a slug or an FK.
  product_range: reportingLabelProp,
  // The merchandising axis, checked against `product_categories` by the column's
  // foreign key rather than by a schema enum (see categoryProp). Nullable so a
  // PATCH can put a design back to uncategorised — which is a real state, not a
  // gap: NULL means nobody has looked at the row, and `misc` means somebody did
  // and the vocabulary had no word for it.
  category: categoryProp,
  // Free text, not an enum: the size vocabulary is per category and open-ended
  // (single/double/queen/king for bed linen, face/hand/bath/bath sheet for
  // towels), so an enum would need a migration every time the office stocked a
  // new one. Same posture as product_range above.
  size: nullableShort,
  // What the product is priced and freighted per (the column's CHECK, restated
  // so a typo is a 400 naming the choices rather than a 500).
  unit: { type: ['string', 'null'], enum: [...UNITS, null] },
  // The house's discount and freight class the product is priced at (A–E;
  // null is the default class / every-class freight). The column CHECKs are
  // the real gate.
  discount_class: classLetterProp,
  freight_class: classLetterProp,
  // The house's duty band (A–C); null is no duty.
  duty_class: dutyLetterProp,
  // Sales prose — `nullableText` like collections.description, not one of the
  // short spec fields beside it.
  description: nullableText,
  composition: nullableShort,
  width: nullableShort,
  application: nullableShort,
  rubs: nullableShort,
  price_band: nullableShort,
  lead_time: nullableShort,
  retail_price_cents: nullableCents,
  trade_price_cents: nullableCents,
  // Supplier currency, four decimals like the price lists' own wholesale_rate.
  wholesale_rate: { type: ['number', 'null'], minimum: 0 },
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

// The product list pages and filters like the colourway one below: the CRM
// reads it a screen at a time. A price band arrives as a cents range (or
// `unpriced` for "No price"); the CRM owns the band arithmetic.
const productQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    brand_id: { type: 'integer', minimum: 1 },
    include_archived: { type: 'boolean', default: false },
    q: { type: 'string', maxLength: 200 },
    category: { type: 'string', maxLength: 100 },
    uncategorised: { type: 'boolean', default: false },
    price_min_cents: { type: 'integer', minimum: 0 },
    price_max_cents: { type: 'integer', minimum: 0 },
    unpriced: { type: 'boolean', default: false },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
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
    headline: nullableShort,
    story: nullableText,
    country: nullableShort,
    is_international: { type: 'boolean', default: false },
    // Defaults closed — see createBrand.
    trade_only: { type: 'boolean', default: true },
    bespoke: { type: 'boolean', default: false },
    website_url: nullableUrl,
    image_url: nullableUrl,
    logo_url: nullableUrl,
    brand_code: reportingLabelProp,
  },
}

const brandPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: nameProp,
    currency: currencyProp,
    headline: nullableShort,
    story: nullableText,
    country: nullableShort,
    is_international: { type: 'boolean' },
    trade_only: { type: 'boolean' },
    bespoke: { type: 'boolean' },
    website_url: nullableUrl,
    image_url: nullableUrl,
    logo_url: nullableUrl,
    featured_rank: featuredRankProp,
    // Nullable on purpose: clearing it is how the office says "nobody invoices
    // this house yet". An unknown id is a 422 from the FK, not a silent no-op.
    supplier_id: { type: ['integer', 'null'], minimum: 1 },
    // A duplicate under the same supplier is a 409 from the partial unique
    // index, phrased in admin-brands.js's CONFLICT_MESSAGES.
    brand_code: reportingLabelProp,
  },
}

const brandSupplierBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['supplier_id'],
  properties: { supplier_id: { type: 'integer', minimum: 1 } },
}

const brandSupplierParamsSchema = {
  type: 'object',
  required: ['id', 'supplierId'],
  properties: {
    id: { type: 'integer', minimum: 1 },
    supplierId: { type: 'integer', minimum: 1 },
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
    // Card checkout sells it; off, it can only be quoted (1 Oct 2026).
    sell_retail: { type: 'boolean', default: false },
  },
}

// No brand_id and no product_type: both are create-only (see the header).
//
// `reason` is not a column — it is the note recorded against a price change,
// and a patch that MOVES retail_price_cents or trade_price_cents is refused
// without it (422, raised in updateProduct so the rule holds for every caller).
// It has to be declared here or Ajv's removeAdditional strips it silently and
// every price edit fails as though the client had sent nothing.
const productPatchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    ...productDetailProps,
    show_on_website: { type: 'boolean' },
    sell_retail: { type: 'boolean' },
    reason: { type: 'string', maxLength: MAX_REASON_LENGTH },
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
  // Null (or absent) sells at the product's price.
  retail_price_cents: nullableCents,
  trade_price_cents: nullableCents,
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
  properties: {
    ...colourwayProps,
    // The variation's own class letters; null is its product's. Setting one
    // prices the variation at it; clearing both sends it back to the product's
    // price (src/pricing/product-reprice.js).
    discount_class: classLetterProp,
    freight_class: classLetterProp,
    duty_class: dutyLetterProp,
  },
}

// A category is created from its label alone. The slug is derived and immutable,
// the same posture as a brand's or a collection's: it is the value stored on
// three tables, so it can never be a thing staff retype.
const categoryCreateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 60 },
  },
}

// The category key is its slug, not an integer — the one DELETE in this file
// whose params are text.
const categoryParamsSchema = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: slugProp,
  },
}

export const adminCatalogueRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // The merchandising vocabulary, which the office now maintains itself. Read
  // by every screen that offers a category, so it is a plain list with the
  // product count beside each row — the count is what says in advance whether
  // the Delete below will be accepted.
  app.get('/admin/categories', { preHandler: backoffice }, async () => ({
    categories: await listCategories(pool),
  }))

  app.post(
    '/admin/categories',
    { preHandler: backoffice, schema: { body: categoryCreateSchema } },
    async (request, reply) => {
      const category = await createCategory(pool, request.body)
      reply.code(201)
      return { category }
    }
  )

  // Hard delete, through the same registry every other DELETE here uses. All
  // three referencing columns are ON DELETE RESTRICT, so the database would
  // refuse anyway; the probes are what turn that into a 409 naming what still
  // carries the category and how many of them there are. There is no archive
  // arm — a category is a word, not a record with a history.
  app.delete(
    '/admin/categories/:slug',
    { preHandler: backoffice, schema: { params: categoryParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'category', request.params.slug, {
          user: request.user,
        })
      )
  )

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

  // A house's ADDITIONAL suppliers (migration 1791638400000). The main one
  // stays `supplier_id` on PATCH above; these are the others that also
  // invoice it. Same guard as that PATCH: who invoices a house is not a rate.
  app.post(
    '/admin/brands/:id/suppliers',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: brandSupplierBodySchema } },
    async (request, reply) => {
      await addBrandSupplier(pool, request.params.id, request.body.supplier_id)
      reply.code(201)
      return { brand: await getAdminBrand(pool, request.params.id) }
    }
  )

  app.delete(
    '/admin/brands/:id/suppliers/:supplierId',
    { preHandler: backoffice, schema: { params: brandSupplierParamsSchema } },
    async (request) => {
      await removeBrandSupplier(pool, request.params.id, request.params.supplierId)
      return { brand: await getAdminBrand(pool, request.params.id) }
    }
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
    { preHandler: backoffice, schema: { querystring: productQuerySchema } },
    async (request) => {
      const { page, limit } = request.query
      const { items, total, maxPriceCents } = await listAdminProducts(pool, {
        brandId: request.query.brand_id,
        includeArchived: request.query.include_archived,
        q: request.query.q,
        category: request.query.category,
        uncategorised: request.query.uncategorised,
        priceMinCents: request.query.price_min_cents,
        priceMaxCents: request.query.price_max_cents,
        unpriced: request.query.unpriced,
        page,
        limit,
      })
      return {
        products: items,
        meta: { total, page, limit, max_price_cents: maxPriceCents },
      }
    }
  )

  // Static, so it must be declared before the parametric read below wins the
  // route. The Categories screen's rows: one count per category.
  app.get(
    '/admin/products/categories',
    { preHandler: backoffice, schema: { querystring: brandQuerySchema } },
    async (request) => ({
      categories: await countAdminProductsByCategory(pool, {
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
      product: await updateProduct(pool, request.params.id, request.body, {
        user: request.user,
      }),
    })
  )

  // What the client asked for in as many words: on the product, date changed,
  // old price, new price and a short reason. No finance gate — a retail or
  // trade figure is money and is not a cost, the line src/reports/access.js
  // draws and the CRM's REPORT_POLICY already applies. The buy-side history
  // (/admin/price-list-items/:id/price-history) is the one that is gated.
  app.get(
    '/admin/products/:id/price-history',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const product = await getAdminProduct(pool, request.params.id)
      if (!product) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Product ${request.params.id} not found.`,
        }
      }
      return { changes: await listProductPriceHistory(pool, request.params.id) }
    }
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
