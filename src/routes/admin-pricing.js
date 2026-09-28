// /admin/pricing/* — the platform's own pricing waterfall and the parameters
// behind it (src/pricing/pricing-parameters.js).
//
//   GET    /admin/pricing/waterfall?brand_id&wholesale_rate[&category&duty_class&freight_class&on]
//   GET    /admin/pricing/parameters/suppliers/:id      the supplier's default set
//   PUT    /admin/pricing/parameters/suppliers/:id      replace it (PUT, not PATCH — see module)
//   DELETE /admin/pricing/parameters/suppliers/:id
//   GET|PUT|DELETE /admin/pricing/parameters/brands/:id  the house's override set
//   GET    /admin/pricing/fx-rates
//   PUT    /admin/pricing/fx-rates/:currency            { rate, set_on?, note? }
//   GET    /admin/pricing/houses/:id                    one house's pricing, as the house page shows it
//   PUT    /admin/pricing/houses/:id                    { parameters, discount_percent?, discount_classes?,
//                                                          freight?, freight_classes? }
//   POST   /admin/pricing/houses/import/validate        the Dynamics tracking-options .xlsx — dry run
//   POST   /admin/pricing/houses/import/apply           the same file — one transaction
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
import { getHousePricing, saveHousePricing } from '../pricing/house-pricing.js'
import { backfillPricingParameters } from '../pricing/parameters-backfill.js'
import { readTrackingOptionsWorkbook } from '../pricing/house-pricing-import.js'
import {
  CLEARANCE_BASES,
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
    clearance_basis: { type: ['string', 'null'], enum: [...CLEARANCE_BASES, null] },
  },
}

// One freight rate as the house page sends it: dollars per unit, dated.
const FREIGHT_RATE_BODY = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['rate', 'unit'],
  properties: {
    rate: { type: 'number', minimum: 0 },
    unit: { type: 'string', minLength: 1, maxLength: 20 },
    effective_from: { type: ['string', 'null'], pattern: ISO_DAY },
    note: { type: ['string', 'null'], maxLength: 1000 },
  },
}

// One house's pricing in one body. `parameters` is the whole override set (PUT
// semantics); the discount and the freight are optional because each lives
// somewhere else and absent means "leave it" — see src/pricing/house-pricing.js.
// The unit is checked against the ledger's vocabulary by createFreightRate, so
// a typo is its 422 rather than a second list here.
const HOUSE_PRICING_BODY = {
  type: 'object',
  additionalProperties: false,
  required: ['parameters'],
  properties: {
    parameters: PARAMETERS_BODY,
    discount_percent: { type: ['number', 'null'], minimum: 0, exclusiveMaximum: 100 },
    freight: FREIGHT_RATE_BODY,
    // A rate per freight letter; each is appended only where it differs from
    // the letter's current rate. Letters left out are left alone — the ledger
    // cannot forget a rate.
    freight_classes: {
      type: 'array',
      maxItems: 26,
      items: {
        ...FREIGHT_RATE_BODY,
        type: 'object',
        required: ['freight_class', 'rate', 'unit'],
        properties: {
          ...FREIGHT_RATE_BODY.properties,
          freight_class: { type: 'string', pattern: '^[A-Za-z]$' },
        },
      },
    },
    // The house's discount classes as a whole set (PUT): an entry with an `id`
    // is that class kept or edited, one without is new, and a class left out
    // is removed. Absent leaves the classes alone.
    discount_classes: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'percent'],
        properties: {
          id: { type: 'integer', minimum: 1 },
          label: { type: 'string', minLength: 1, maxLength: 120 },
          percent: { type: 'number', minimum: 0, exclusiveMaximum: 100 },
          is_default: { type: 'boolean' },
        },
      },
    },
  },
}

// The upload is the workbook's raw bytes, like the price-list import and the
// product sheet — no multipart parser in this API. A browser reports a .xlsx
// as the first type; a client that will not guess sends octet-stream. The
// parser is encapsulated to this plugin, so no other route's body changes.
const IMPORT_CONTENT_TYPES = Object.freeze([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
])
// The export is a few dozen rows (16 KB on 25 Sep 2026); 2 MB is generous.
const IMPORT_BODY_LIMIT = 2 * 1024 * 1024

const IMPORT_QUERY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Replace saved values the export disagrees with (default: fill blanks only).
    overwrite: { type: 'boolean' },
    // Read for the export stamp only; bounded and free of control characters
    // and path separators, the price-list import's rule.
    filename: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f/\\\\]+$' },
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
            // Which of the house's suppliers to price through (main when
            // absent), and the product whose chosen discount tier applies.
            supplier_id: { type: 'integer', minimum: 1 },
            product_id: { type: 'integer', minimum: 1 },
            // Free text: a terms tier is matched against it case-insensitively,
            // and the freight ledger's category enum is checked by the resolver.
            category: { type: 'string', maxLength: 40 },
            duty_class: { type: 'string', pattern: '^[A-Za-z]$' },
            // The line's freight letter: the house's rate for it wins over the
            // house's every-class rate.
            freight_class: { type: 'string', pattern: '^[A-Za-z]$' },
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
      const { brand_id, wholesale_rate, supplier_id, product_id, category, duty_class, freight_class, on, ...rest } =
        request.query
      const overrides = Object.fromEntries(
        OVERRIDABLE_INPUTS.filter((key) => rest[key] !== undefined).map((key) => [key, rest[key]])
      )
      return previewWaterfall(pool, {
        brandId: brand_id,
        wholesaleRate: wholesale_rate,
        supplierId: supplier_id ?? null,
        productId: product_id ?? null,
        category: category ?? null,
        dutyClass: duty_class ?? null,
        freightClass: freight_class ? freight_class.toUpperCase() : null,
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

  // --- one house, as its own page shows it ---------------------------------------
  app.get('/admin/pricing/houses/:id', { preHandler: guarded, schema: { params: ID_PARAMS } },
    async (request) => ({ pricing: await getHousePricing(pool, request.params.id) })
  )

  // Three homes, one transaction: a refused discount must not leave the
  // parameter set saved without it.
  app.put(
    '/admin/pricing/houses/:id',
    { preHandler: guarded, schema: { params: ID_PARAMS, body: HOUSE_PRICING_BODY } },
    async (request) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const pricing = await saveHousePricing(client, request.params.id, request.body ?? {})
        await client.query('COMMIT')
        return { pricing }
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // surface the original failure
        }
        throw error
      } finally {
        client.release()
      }
    }
  )

  // --- the Dynamics tracking-options export, uploaded ------------------------------
  // Validate and apply are two routes, never a `?dry_run=` flag: a request that
  // can write must not be one query parameter away from one that cannot. Apply
  // takes the FILE again and re-plans against the live state — never a plan the
  // client sends back.
  app.addContentTypeParser(
    [...IMPORT_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: IMPORT_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const importFile = (dryRun) => async (request, reply) => {
    let read
    try {
      read = readTrackingOptionsWorkbook(request.body, request.query.filename)
    } catch (error) {
      if (error.statusCode !== 422) throw error
      // Fastify's default serialiser would drop the per-cell list; the office
      // needs it to find the row again.
      reply.code(422)
      return { message: error.message, errors: error.errors ?? [], error_count: error.error_count ?? 0 }
    }
    const result = await backfillPricingParameters(pool, {
      rangeParameters: read.ranges,
      overwrite: request.query.overwrite === true,
      dryRun,
    })
    return { exported_at: read.exported_at, ...result }
  }

  for (const [step, dryRun] of [['validate', true], ['apply', false]]) {
    app.post(
      `/admin/pricing/houses/import/${step}`,
      { preHandler: guarded, bodyLimit: IMPORT_BODY_LIMIT, schema: { querystring: IMPORT_QUERY } },
      importFile(dryRun)
    )
  }
}
