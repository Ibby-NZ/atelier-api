// /admin/pricing/* — the platform's own pricing waterfall and the parameters
// behind it (src/pricing/pricing-parameters.js).
//
//   GET    /admin/pricing/waterfall?brand_id&wholesale_rate[&category&duty_class&on]
//   GET    /admin/pricing/parameters/suppliers/:id      the supplier's default set
//   PUT    /admin/pricing/parameters/suppliers/:id      replace it (PUT, not PATCH — see module)
//   DELETE /admin/pricing/parameters/suppliers/:id
//   GET|PUT|DELETE /admin/pricing/parameters/brands/:id  the house's override set
//   GET    /admin/pricing/fx-rates
//   PUT    /admin/pricing/fx-rates/:currency            { rate, set_on?, note? }
//
// EVERY ROUTE IS FINANCE-GATED, reads included, through `requireFinance` — the
// one gate, recomputed per request. Every figure here is a cost input (what
// Atelier pays, what it adds), and there is no useful masked view of a
// parameter editor: a back-office login without the grant gets a 403 that
// says what it needed, which the CRM renders as a locked panel.
//
// Body schemas are structural only. Fastify's Ajv strips unknown keys rather
// than rejecting them, so PARAMETER_COLUMNS in the module is the real gate on
// what reaches SQL; the schema's job is types and non-negativity.

import { requireFinance } from '../reports/access.js'
import {
  NUMERIC_PARAMETERS,
  OVERRIDABLE_INPUTS,
  deleteBrandParameters,
  deleteSupplierParameters,
  getBrandParameters,
  getSupplierParameters,
  listFxRates,
  previewWaterfall,
  upsertBrandParameters,
  upsertFxRate,
  upsertSupplierParameters,
} from '../pricing/pricing-parameters.js'

const ISO_DAY = '^\\d{4}-\\d{2}-\\d{2}$'

const ID_PARAMS = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer', minimum: 1 } },
}

const PARAMETERS_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      NUMERIC_PARAMETERS.map((column) => [column, { type: ['number', 'null'], minimum: 0 }])
    ),
    note: { type: ['string', 'null'], maxLength: 1000 },
  },
}

const FINANCE_MESSAGE =
  'Pricing parameters and the waterfall are cost figures. Your account does not have finance visibility.'

export const adminPricingRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')
  const finance = requireFinance(pool, FINANCE_MESSAGE)
  // Role first (sets request.user), then the finance grant on top of it.
  const guarded = [backoffice, finance]

  // --- the waterfall ------------------------------------------------------------
  app.get(
    '/admin/pricing/waterfall',
    {
      preHandler: guarded,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['brand_id', 'wholesale_rate'],
          properties: {
            brand_id: { type: 'integer', minimum: 1 },
            wholesale_rate: { type: 'number', minimum: 0 },
            // Free text: a terms tier is matched against it case-insensitively,
            // and the freight ledger's category enum is checked by the resolver.
            category: { type: 'string', maxLength: 40 },
            duty_class: { type: 'string', pattern: '^[A-Za-z]$' },
            on: { type: 'string', pattern: ISO_DAY },
            // What-if values for this preview only (the screen's Manual mode).
            // They stand in for the resolved input, source `manual`, and
            // nothing is written.
            ...Object.fromEntries(
              OVERRIDABLE_INPUTS.map((key) => [key, { type: 'number', minimum: 0 }])
            ),
          },
        },
      },
    },
    async (request) => {
      const { brand_id, wholesale_rate, category, duty_class, on, ...rest } = request.query
      const overrides = Object.fromEntries(
        OVERRIDABLE_INPUTS.filter((key) => rest[key] !== undefined).map((key) => [key, rest[key]])
      )
      return previewWaterfall(pool, {
        brandId: brand_id,
        wholesaleRate: wholesale_rate,
        category: category ?? null,
        dutyClass: duty_class ?? null,
        on: on ?? null,
        overrides,
      })
    }
  )

  // --- parameter rows, per scope --------------------------------------------------
  const scopeRoutes = (path, { get, put, remove }) => {
    app.get(`/admin/pricing/parameters/${path}/:id`, { preHandler: guarded, schema: { params: ID_PARAMS } },
      async (request) => ({ parameters: await get(pool, request.params.id) })
    )
    app.put(
      `/admin/pricing/parameters/${path}/:id`,
      { preHandler: guarded, schema: { params: ID_PARAMS, body: PARAMETERS_BODY } },
      async (request) => ({ parameters: await put(pool, request.params.id, request.body ?? {}) })
    )
    app.delete(`/admin/pricing/parameters/${path}/:id`, { preHandler: guarded, schema: { params: ID_PARAMS } },
      async (request) => ({ deleted: await remove(pool, request.params.id) })
    )
  }
  scopeRoutes('suppliers', {
    get: getSupplierParameters,
    put: upsertSupplierParameters,
    remove: deleteSupplierParameters,
  })
  scopeRoutes('brands', {
    get: getBrandParameters,
    put: upsertBrandParameters,
    remove: deleteBrandParameters,
  })

  // --- exchange rates ------------------------------------------------------------
  app.get('/admin/pricing/fx-rates', { preHandler: guarded }, async () => ({
    rates: await listFxRates(pool),
  }))

  app.put(
    '/admin/pricing/fx-rates/:currency',
    {
      preHandler: guarded,
      schema: {
        params: {
          type: 'object',
          required: ['currency'],
          properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' } },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['rate'],
          properties: {
            rate: { type: 'number', exclusiveMinimum: 0 },
            set_on: { type: ['string', 'null'], pattern: ISO_DAY },
            note: { type: ['string', 'null'], maxLength: 1000 },
          },
        },
      },
    },
    async (request) => ({
      rate: await upsertFxRate(pool, request.params.currency, request.body),
    })
  )
}
