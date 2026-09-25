// /admin/freight/* — the freight and landed-cost surface (W16).
//
// Backoffice throughout (director inherits). Three of these routes are gated a
// second time on FINANCE VISIBILITY, and that gate is `loadReportAccess`, never
// `request.user.can_view_finance`: `src/auth/guards.js` loads `request.user`
// through `PUBLIC_USER_COLUMNS`, which is `id, email, name, role,
// trade_approved` and no more — so reading the flag off the request record
// gives `undefined`, which answers false to everyone silently and for ever.
//
// THE LANDED-COST PREVIEW IS THE FIRST SURFACE IN THIS PLATFORM WHERE FINANCE
// MASKING ACTUALLY DELETES SOMETHING. Every report in Epic 5 declares no
// finance column — the stock report's landed cost has no source, and a sell
// value is money but is not a cost — so `maskReport` has never had a column to
// remove. Here every amount in the waterfall is a cost input, so a backoffice
// login without the grant gets the STEPS and none of the money, with
// `meta.masked_columns` saying so. The step names are deliberately not finance:
// knowing that a landed cost has a clearance step is not knowing the clearance.
//
// `.csv` is its own path segment and never a suffix on a param — Fastify folds
// it into the preceding `:param` otherwise and every lookup 404s.

import { defineColumns, loadReportAccess, maskReport } from '../reports/access.js'
import {
  dutyPercentFor,
  listRangeParameters,
  requireRangeParameters,
} from '../pricing/tracking-parameters.js'
import { runFreightRecovery } from '../pricing/freight-recovery.js'
import {
  FREIGHT_BASES,
  FREIGHT_UNITS,
  createFreightRate,
  listFreightRates,
  resolveFreightRate,
  today,
} from '../pricing/freight-rates.js'
import { computeWaterfall } from '../pricing/waterfall.js'
import {
  FREIGHT_RATE_SHEET_FILENAME,
  MAX_REPORTED_CHANGES,
  MAX_REPORTED_ERRORS,
  applyFreightRateSheet,
  getFreightRateSheet,
  toFreightRateCsv,
  validateFreightRateSheet,
} from '../pricing/freight-rate-sheet.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

const ISO_DAY = '^\\d{4}-\\d{2}-\\d{2}$'

// Not an enum: the vocabulary is `product_categories`, a table the office adds
// to (migration 1791379200000), and an Ajv enum is fixed at boot. The value is
// checked against the live list by validateFreightRate and, past that, by the
// column's foreign key.
const categoryProp = { type: 'string', minLength: 1, maxLength: 200 }

// A rate ledger is a few hundred rows a year and a sheet is one row per rate.
const SHEET_BODY_LIMIT = 2 * 1024 * 1024
const SHEET_CONTENT_TYPES = Object.freeze([
  'text/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
])

// Every amount is a COST input, which is what makes this the first payload
// masking has anything to take. The step and its label are not: a reader who
// may not see the clearance may still see that there is a clearance step, and
// without that the masked view is a table of blanks nobody can read.
const PREVIEW_COLUMNS = defineColumns([
  { key: 'step', label: 'Step' },
  { key: 'label', label: 'What it is' },
  { key: 'amount', label: 'Amount', kind: 'money', finance: true },
])

const refusalBody = (report) => ({
  error: 'Unprocessable Entity',
  message:
    `${report.errors.length} row${report.errors.length === 1 ? '' : 's'} could not be read. ` +
    'Nothing has been written.',
  errors: report.errors.slice(0, MAX_REPORTED_ERRORS),
  error_count: report.errors.length,
  summary: report.summary,
})

export const adminFreightRoutes = async (app, { pool }) => {
  app.addContentTypeParser(
    [...SHEET_CONTENT_TYPES],
    { parseAs: 'buffer', bodyLimit: SHEET_BODY_LIMIT },
    (request, body, done) => done(null, body)
  )

  const backoffice = app.guards.requireRole('backoffice')

  // The finance grant is revocable and is recomputed per request, so a grant
  // taken away in the back office reaches this route on the next call rather
  // than at the account's next sign-in.
  const requireFinance = async (request) => {
    const access = await loadReportAccess(pool, request.user)
    if (!access.finance) {
      throw httpError(
        403,
        'Freight parameters and landed costs are cost figures. Your account does not have ' +
          'finance visibility.'
      )
    }
    return access
  }

  // --- US-002: the incumbent's parameters ----------------------------------
  app.get(
    '/admin/freight/parameters',
    {
      preHandler: backoffice,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 200 },
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
        },
      },
    },
    async (request) => {
      await requireFinance(request)
      const { q, page, limit } = request.query
      const { parameters, total } = await listRangeParameters(pool, { q, page, limit })
      return {
        parameters,
        meta: {
          total,
          page: page ?? 1,
          limit: limit ?? parameters.length,
          // Type rows carry no parameter at all — all ten numeric columns are
          // empty on all 17 — so they are a vocabulary, not a rate table, and
          // this list is Range rows only. Stated in the payload because a
          // reader counting 58 against the file's 75 should know why.
          scope: 'Range rows only — Type rows carry no pricing parameter.',
        },
      }
    }
  )

  // --- US-003: the recovery report, which is what answers F1 ----------------
  app.get('/admin/freight/recovery', { preHandler: backoffice }, async (request) => {
    await requireFinance(request)
    return runFreightRecovery(pool)
  })

  // --- US-007: the landed-cost preview --------------------------------------
  app.get(
    '/admin/freight/landed-preview',
    {
      preHandler: backoffice,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['range', 'wholesale_rate'],
          properties: {
            range: { type: 'string', minLength: 1, maxLength: 200 },
            wholesale_rate: { type: 'number', minimum: 0 },
            duty_class: { type: 'string', pattern: '^[A-Za-z]$' },
            category: categoryProp,
            supplier_id: { type: 'integer', minimum: 1 },
            on: { type: 'string', pattern: ISO_DAY },
            // The inputs that still have no source anywhere. Supplied by hand
            // so the office can try a number; ABSENT is the honest default and
            // is what puts them in `missing` rather than a guessed constant.
            fx_rate: { type: 'number', exclusiveMinimum: 0 },
            fx_margin_percent: { type: 'number', minimum: 0 },
            handling: { type: 'number', minimum: 0 },
            retail_markup: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
    },
    async (request) => {
      // NOT `requireFinance` — this is the one route in the epic that MASKS
      // rather than refuses. Every amount is a `finance` column and the step
      // names are not, so a back-office login without the grant gets the shape
      // of the waterfall with none of the money and `meta.masked_columns`
      // saying which figures were withheld. maskReport would still 403 if the
      // report ever became finance end to end (every column `finance`), which
      // is the structural rule rather than a second guard here.
      const access = await loadReportAccess(pool, request.user)
      const query = request.query
      const on = query.on ?? today()

      const parameters = await requireRangeParameters(pool, query.range)
      const duty = dutyPercentFor(parameters, query.duty_class ?? null)

      // The scope the caller asked at. Nothing here picks between a supplier
      // rate and a range rate — that choice is the question that is out with
      // the client, so the caller names one and the resolver answers it.
      const scope =
        query.supplier_id == null
          ? { range_name: parameters.name }
          : { supplier_id: query.supplier_id }
      const freight = await resolveFreightRate(pool, {
        ...scope,
        category: query.category ?? null,
        on,
      })

      const waterfall = computeWaterfall({
        wholesale_rate: query.wholesale_rate,
        currency: null,
        discount_percent: parameters.discount_percent,
        fx_rate: query.fx_rate ?? null,
        fx_margin_percent: query.fx_margin_percent ?? null,
        duty_percent: duty.percent,
        // A missing rate is null, never zero — see src/pricing/freight-rates.js.
        freight: freight.rate?.rate ?? null,
        freight_basis: freight.rate?.basis ?? 'dollar',
        freight_unit: freight.rate?.unit ?? null,
        clearance_percent: parameters.clearance_percent,
        handling: query.handling ?? null,
        trade_markup_percent: parameters.trade_markup_percent,
        retail_markup: query.retail_markup ?? null,
      })

      // The report envelope every /admin/reports payload already uses, so the
      // CRM's cell pipeline renders it with no second renderer — and so
      // maskReport is what decides what leaves the building.
      return maskReport(
        {
          report: 'landed-cost-preview',
          title: `Landed cost — ${parameters.name}`,
          columns: PREVIEW_COLUMNS,
          rows: waterfall.steps,
          totals: null,
          meta: {
            range: parameters.name,
            supplier: parameters.supplier,
            category: query.category ?? null,
            duty_class: query.duty_class ?? null,
            // Reasons and names only. No figure appears in meta — meta is not
            // projected by maskReport, so a cost parked here would survive the
            // mask and be the one leak this route exists to prevent.
            duty_reason: duty.reason,
            freight_reason: freight.reason,
            freight_unit: waterfall.freight_unit,
            freight_scope: query.supplier_id == null ? 'range' : 'supplier',
            missing: waterfall.missing,
            as_at: on,
            note:
              'No freight rate is stored anywhere until the client resolves the rate grain. ' +
              'A missing input is named rather than treated as zero.',
          },
        },
        access
      )
    }
  )

  // --- US-008: the rate ledger, append-only ---------------------------------
  app.get(
    '/admin/freight/rates',
    {
      preHandler: backoffice,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            supplier_id: { type: 'integer', minimum: 1 },
            range_name: { type: 'string', maxLength: 200 },
            category: categoryProp,
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request) => {
      const { rates, total } = await listFreightRates(pool, request.query)
      return {
        rates,
        meta: {
          total,
          page: request.query.page ?? 1,
          limit: request.query.limit ?? rates.length,
          // Append-only is not obvious from a list that looks like any other,
          // and the CRM renders this note beside the table.
          note: 'Append-only: a new rate never overwrites the old one. Correct a rate by dating a new one.',
        },
      }
    }
  )

  app.post(
    '/admin/freight/rates',
    {
      preHandler: backoffice,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['rate', 'effective_from'],
          properties: {
            supplier_id: { type: 'integer', minimum: 1 },
            range_name: { type: 'string', minLength: 1, maxLength: 200 },
            category: categoryProp,
            // The letter the rate is for; absent or blank is every class. The
            // module raises the case and refuses anything else in words.
            freight_class: { type: ['string', 'null'], maxLength: 1 },
            basis: { type: 'string', enum: [...FREIGHT_BASES] },
            rate: { type: 'number', minimum: 0 },
            unit: { type: 'string', enum: [...FREIGHT_UNITS] },
            effective_from: { type: 'string', pattern: ISO_DAY },
            note: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const rate = await createFreightRate(pool, request.body)
      reply.code(201)
      return rate
    }
  )

  // There is deliberately no PATCH and no DELETE here. FR-192: a rate carries
  // `effective_from` and a new rate never overwrites the old one — that is what
  // makes the >=5% annual uplift auditable and what lets a 2024 landed cost be
  // reconciled. A correction is a POST with a later date.

  // --- US-009: the CSV round trip -------------------------------------------
  app.get('/admin/freight/rates/export.csv', { preHandler: backoffice }, async (request, reply) => {
    const sheet = await getFreightRateSheet(pool)
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${FREIGHT_RATE_SHEET_FILENAME}"`)
    return toFreightRateCsv(sheet)
  })

  app.post(
    '/admin/freight/rates/validate',
    { preHandler: backoffice, bodyLimit: SHEET_BODY_LIMIT },
    async (request, reply) => {
      const report = await validateFreightRateSheet(pool, request.body)
      if (report.errors.length > 0) {
        reply.code(422)
        return refusalBody(report)
      }
      return {
        summary: report.summary,
        changes: report.changes.slice(0, MAX_REPORTED_CHANGES),
      }
    }
  )

  app.post(
    '/admin/freight/rates/apply',
    { preHandler: backoffice, bodyLimit: SHEET_BODY_LIMIT },
    async (request, reply) => {
      const report = await applyFreightRateSheet(pool, request.body)
      if (report.errors.length > 0) {
        reply.code(422)
        return refusalBody(report)
      }
      return {
        applied: report.applied,
        summary: report.summary,
        changes: report.changes.slice(0, MAX_REPORTED_CHANGES),
      }
    }
  )
}
