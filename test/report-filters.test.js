// The pure half of src/reports/. These modules are pure by design, so this suite
// takes no pool, runs no migration and stubs nothing — the moment it needs
// loadConfig() they have stopped being what it claims. Anything only Postgres
// can confirm (the enum copies, the CTE as SQL) is in test/admin-reports.test.js
// beside it.
//
// filters.js — the two properties it exists to hold are:
//   - a filter NAME only ever resolves through the frozen whitelist
//   - a filter VALUE only ever leaves as a $n placeholder
// Everything else here is the parsing contract the reports and their exports
// share, so the table and the CSV cannot disagree about what was filtered.
//
// access.js — a finance column is deleted from every part of the payload, and a
// report that is finance end to end is a 403 rather than an empty table.
//
// revenue-lines.js — the population is one frozen default, overridable, and the
// CTE is the seam a second source unions into.
//
// export.js — the file is rendered from the MASKED envelope's own columns, so a
// withheld figure has no header and no cell, and every value goes through the
// formula guard on its way out.

import { describe, it, expect } from 'vitest'
import {
  FILTER_COLUMNS,
  REPORT_FILTER_NAMES,
  PRODUCT_TYPES,
  ORDER_KINDS,
  ORDER_STATUSES,
  parseReportFilters,
  buildReportFilters,
  partitionFilters,
} from '../src/reports/filters.js'
import { reportAccess, defineColumns, maskReport } from '../src/reports/access.js'
import {
  toReportCsv,
  reportCsvFilename,
  REPORT_CSV_CONTENT_TYPE,
} from '../src/reports/export.js'
import {
  PRODUCT_PERFORMANCE,
  PRODUCT_PERFORMANCE_COLUMNS,
  COVERAGE_NOTE,
  TOTALS_LABELS,
} from '../src/reports/product-performance.js'
import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, clampLimit } from '../src/reports/limits.js'
import {
  STOCK,
  STOCK_COLUMNS,
  STOCK_FILTERS,
  STOCK_COVERAGE_NOTE,
  STOCK_TOTALS_LABELS,
} from '../src/reports/stock.js'
import {
  NOT_INVOICED,
  NOT_INVOICED_COLUMNS,
  NOT_INVOICED_STATUSES,
  NOT_INVOICED_COVERAGE_NOTE,
  INVOICEABLE_KINDS,
} from '../src/reports/not-invoiced.js'
import {
  REVENUE_STATUSES,
  SCOPE_NAME,
  SCOPE_COLUMNS,
  assertScopeSource,
  buildRevenueScope,
} from '../src/reports/revenue-lines.js'

const statusOf = (fn) => {
  try {
    fn()
  } catch (error) {
    return error
  }
  return null
}

describe('report filters', () => {
  describe('the whitelist', () => {
    it('is frozen, so a caller cannot add a column at runtime', () => {
      expect(Object.isFrozen(FILTER_COLUMNS)).toBe(true)
      expect(Object.isFrozen(REPORT_FILTER_NAMES)).toBe(true)
    })

    it('names exactly the seven filters the reports accept', () => {
      expect([...REPORT_FILTER_NAMES]).toEqual([
        'from',
        'to',
        'brand',
        'product_type',
        'collection',
        'kind',
        'status',
      ])
    })

    // The values are code literals naming a table alias and a column; nothing a
    // client sends can reach them.
    it('maps every name to a trusted alias.column reference', () => {
      for (const column of Object.values(FILTER_COLUMNS)) {
        expect(column).toMatch(/^[a-z]+\.[a-z_]+$/)
      }
      expect(FILTER_COLUMNS.from).toBe('o.created_at')
      expect(FILTER_COLUMNS.to).toBe('o.created_at')
      expect(FILTER_COLUMNS.brand).toBe('b.slug')
    })
  })

  describe('parsing', () => {
    it('returns only the filters actually supplied', () => {
      expect(parseReportFilters({ status: 'paid' })).toEqual({ status: 'paid' })
      expect(parseReportFilters({})).toEqual({})
      expect(parseReportFilters()).toEqual({})
    })

    it('freezes what it returns', () => {
      expect(Object.isFrozen(parseReportFilters({ status: 'paid' }))).toBe(true)
    })

    // Same posture as the public catalogue listing: the whitelist controls which
    // filters exist, so an unknown key is ignored rather than rejected.
    it('ignores an unknown filter name', () => {
      expect(parseReportFilters({ nonsense: 'x', supplier_id: '4', status: 'paid' })).toEqual({
        status: 'paid',
      })
    })

    it('treats an absent or empty value as no filter at all', () => {
      expect(parseReportFilters({ status: '', brand: '   ', kind: null, from: undefined })).toEqual(
        {}
      )
    })

    it('trims a value before validating it', () => {
      expect(parseReportFilters({ status: ' paid ' })).toEqual({ status: 'paid' })
    })

    describe('dates', () => {
      it('accepts a calendar date', () => {
        expect(parseReportFilters({ from: '2026-01-01', to: '2026-08-06' })).toEqual({
          from: '2026-01-01',
          to: '2026-08-06',
        })
      })

      it('rejects a malformed date with a 400 naming the filter', () => {
        const error = statusOf(() => parseReportFilters({ from: '06/08/2026' }))
        expect(error.statusCode).toBe(400)
        expect(error.message).toContain('"from"')
        expect(error.message).toContain('YYYY-MM-DD')
      })

      // The regex alone accepts this; the round trip is what catches it.
      it('rejects a date that is not on the calendar', () => {
        const error = statusOf(() => parseReportFilters({ to: '2026-02-30' }))
        expect(error.statusCode).toBe(400)
        expect(error.message).toContain('"to"')
      })

      it('rejects a timestamp — a report range is a range of days', () => {
        expect(statusOf(() => parseReportFilters({ from: '2026-01-01T09:30:00Z' })).statusCode).toBe(
          400
        )
      })

      // A backwards range's symptom is an empty report, which reads as "no
      // trade" rather than as a typo.
      it('rejects a from later than its to, naming both', () => {
        const error = statusOf(() => parseReportFilters({ from: '2026-08-06', to: '2026-01-01' }))
        expect(error.statusCode).toBe(400)
        expect(error.message).toContain('2026-08-06')
        expect(error.message).toContain('2026-01-01')
      })

      it('allows a single-day range', () => {
        expect(parseReportFilters({ from: '2026-08-06', to: '2026-08-06' })).toEqual({
          from: '2026-08-06',
          to: '2026-08-06',
        })
      })
    })

    describe('brand, the one multi-valued filter', () => {
      it('accepts repeated params', () => {
        expect(parseReportFilters({ brand: ['pierre-frey', 'liberty-london'] }).brand).toEqual([
          'pierre-frey',
          'liberty-london',
        ])
      })

      it('accepts one comma-separated value', () => {
        expect(parseReportFilters({ brand: 'pierre-frey,liberty-london' }).brand).toEqual([
          'pierre-frey',
          'liberty-london',
        ])
      })

      it('keeps a single house as a list, so the clause shape never varies', () => {
        expect(parseReportFilters({ brand: 'pierre-frey' }).brand).toEqual(['pierre-frey'])
      })

      it('drops blank entries and de-duplicates, so one filter set is one query', () => {
        expect(parseReportFilters({ brand: 'pierre-frey,,pierre-frey, liberty-london ' }).brand)
          .toEqual(['pierre-frey', 'liberty-london'])
      })

      it('treats a wholly blank list as absent rather than as "match nothing"', () => {
        expect(parseReportFilters({ brand: ',  ,' })).toEqual({})
        expect(parseReportFilters({ brand: [] })).toEqual({})
      })

      it('rejects an entry that is not a slug', () => {
        const error = statusOf(() => parseReportFilters({ brand: 'Pierre Frey' }))
        expect(error.statusCode).toBe(400)
        expect(error.message).toContain('"brand"')
      })

      it('rejects a non-text entry', () => {
        expect(statusOf(() => parseReportFilters({ brand: [{ slug: 'x' }] })).statusCode).toBe(400)
      })
    })

    describe('the vocabularies', () => {
      it('accepts every product type, kind and status the schema allows', () => {
        for (const value of PRODUCT_TYPES) {
          expect(parseReportFilters({ product_type: value }).product_type).toBe(value)
        }
        for (const value of ORDER_KINDS) {
          expect(parseReportFilters({ kind: value }).kind).toBe(value)
        }
        for (const value of ORDER_STATUSES) {
          expect(parseReportFilters({ status: value }).status).toBe(value)
        }
      })

      it('rejects anything else with a 400 listing what is accepted', () => {
        const error = statusOf(() => parseReportFilters({ status: 'invoiced' }))
        expect(error.statusCode).toBe(400)
        expect(error.message).toContain('"status"')
        expect(error.message).toContain('paid')
      })

      it('rejects an unknown kind and an unknown product type too', () => {
        expect(statusOf(() => parseReportFilters({ kind: 'sample' })).statusCode).toBe(400)
        expect(statusOf(() => parseReportFilters({ product_type: 'wallpaper' })).statusCode).toBe(
          400
        )
      })
    })

    it('caps the echoed value so an error message cannot become a payload', () => {
      const error = statusOf(() => parseReportFilters({ collection: 'X'.repeat(500) }))
      expect(error.statusCode).toBe(400)
      expect(error.message.length).toBeLessThan(200)
    })
  })

  describe('clause building', () => {
    it('binds every value as a placeholder and never writes one into the SQL', () => {
      const filters = parseReportFilters({
        from: '2026-01-01',
        to: '2026-08-06',
        brand: 'pierre-frey,liberty-london',
        product_type: 'fabric',
        collection: 'cappuccino',
        kind: 'checkout',
        status: 'paid',
      })

      const { where, params } = buildReportFilters(filters)

      expect(params).toEqual([
        '2026-01-01',
        '2026-08-06',
        ['pierre-frey', 'liberty-london'],
        'fabric',
        'cappuccino',
        'checkout',
        'paid',
      ])
      for (const value of ['2026-01-01', 'pierre-frey', 'fabric', 'cappuccino', 'paid']) {
        expect(where).not.toContain(value)
      }
      expect(where).toBe(
        [
          'o.created_at >= $1::date',
          'o.created_at < ($2::date + 1)',
          'b.slug = ANY($3::text[])',
          'p.product_type = $4',
          'col.slug = $5',
          'o.kind = $6',
          'o.status = $7',
        ].join(' AND ')
      )
    })

    it('produces nothing at all for an empty filter set', () => {
      expect(buildReportFilters({})).toEqual({ clauses: [], params: [], where: '' })
      expect(buildReportFilters()).toEqual({ clauses: [], params: [], where: '' })
    })

    // The `to` bound is exclusive on the NEXT day, so a report ending today
    // carries today's orders. `<= $n::date` cuts at that morning's midnight.
    it('makes the to bound inclusive of its own day', () => {
      expect(buildReportFilters({ to: '2026-08-06' }).where).toBe('o.created_at < ($1::date + 1)')
    })

    it('numbers placeholders from the params a report has already bound', () => {
      const existing = [42]
      const { where, params } = buildReportFilters({ status: 'paid' }, { params: existing })

      expect(where).toBe('o.status = $2')
      expect(params).toEqual([42, 'paid'])
      // Immutable: the caller's array is copied, never appended to.
      expect(existing).toEqual([42])
    })

    it('copies a multi-value param rather than sharing the parsed array', () => {
      const filters = parseReportFilters({ brand: 'pierre-frey' })
      const { params } = buildReportFilters(filters)

      expect(params[0]).toEqual(['pierre-frey'])
      expect(params[0]).not.toBe(filters.brand)
    })

    it('orders clauses by the whitelist, not by the caller’s key order', () => {
      const a = buildReportFilters({ status: 'paid', from: '2026-01-01' }).where
      const b = buildReportFilters({ from: '2026-01-01', status: 'paid' }).where
      expect(a).toBe(b)
      expect(a).toBe('o.created_at >= $1::date AND o.status = $2')
    })

    // A report whose FROM has no `orders` cannot honour a status filter; saying
    // so is how it avoids emitting a clause against a table it never joined.
    it('honours only the filters the report says it supports', () => {
      const filters = parseReportFilters({ status: 'paid', brand: 'pierre-frey' })

      const { where, params } = buildReportFilters(filters, { names: ['brand'] })

      expect(where).toBe('b.slug = ANY($1::text[])')
      expect(params).toEqual([['pierre-frey']])
    })

    // A code literal, like a lifecycle registry key: a typo here is a bug in the
    // report, so it fails loudly instead of degrading to a 400.
    it('throws a plain error for a filter name the whitelist does not know', () => {
      const error = statusOf(() => buildReportFilters({}, { names: ['supplier'] }))
      expect(error.statusCode).toBeUndefined()
      expect(error.message).toContain('supplier')
    })
  })
})

// src/reports/access.js is pure for the same reason filters.js is: what a report
// CONTAINS needs a database, but which of it survives does not — so the masking
// rules are provable on their own here, and the schema agreement that only
// Postgres can confirm stays in test/admin-reports.test.js.
describe('report access and masking', () => {
  const columns = defineColumns([
    { key: 'brand_name', label: 'House' },
    { key: 'qty', label: 'Metres', kind: 'number' },
    { key: 'revenue_cents', label: 'Revenue', kind: 'money' },
    { key: 'cost_cents', label: 'Cost', kind: 'money', finance: true },
    { key: 'margin_cents', label: 'Margin', kind: 'money', finance: true },
  ])

  const report = Object.freeze({
    report: 'product-performance',
    columns,
    rows: [
      { brand_name: 'Pierre Frey', qty: 12, revenue_cents: 240000, cost_cents: 90000, margin_cents: 150000 },
      { brand_name: 'Liberty London', qty: 3, revenue_cents: 60000, cost_cents: 25000, margin_cents: 35000 },
    ],
    totals: { qty: 15, revenue_cents: 300000, cost_cents: 115000, margin_cents: 185000 },
    meta: { coverage: 'live orders only' },
  })

  const FINANCE = Object.freeze({ reports: true, finance: true })
  const STAFF = Object.freeze({ reports: true, finance: false })

  describe('reportAccess', () => {
    it('gives an anonymous caller nothing', () => {
      expect(reportAccess(null)).toEqual({ reports: false, finance: false })
      expect(reportAccess(undefined)).toEqual({ reports: false, finance: false })
    })

    it('gives a client nothing, whatever its flag says', () => {
      expect(reportAccess({ role: 'customer', can_view_finance: true })).toEqual({
        reports: false,
        finance: false,
      })
      expect(
        reportAccess({ role: 'trade', trade_approved: true, can_view_finance: true })
      ).toEqual({ reports: false, finance: false })
    })

    it('opens the reports to staff and the finance columns only on the flag', () => {
      expect(reportAccess({ role: 'backoffice', can_view_finance: false })).toEqual({
        reports: true,
        finance: false,
      })
      expect(reportAccess({ role: 'backoffice', can_view_finance: true })).toEqual({
        reports: true,
        finance: true,
      })
    })

    // The role is not the answer: `backoffice` covers the showroom and the
    // accounts desk alike, and a director whose grant was revoked must lose it.
    it('refuses finance to a director whose flag is false', () => {
      expect(reportAccess({ role: 'director', can_view_finance: false })).toEqual({
        reports: true,
        finance: false,
      })
    })

    // Access is derived from request.user and nothing else. A caller that sends
    // its own answer is sending an opinion, not a fact.
    it('ignores anything but the user’s own role and flag', () => {
      const access = reportAccess({
        role: 'backoffice',
        can_view_finance: false,
        finance: true,
        report_access: { finance: true },
        query: { finance: 'true' },
      })
      expect(access.finance).toBe(false)
    })

    it('is frozen, so a handler cannot widen it after the fact', () => {
      expect(Object.isFrozen(reportAccess({ role: 'director', can_view_finance: true }))).toBe(true)
    })
  })

  describe('defineColumns', () => {
    it('freezes the declaration and defaults kind and finance', () => {
      expect(Object.isFrozen(columns)).toBe(true)
      expect(columns[0]).toEqual({ key: 'brand_name', label: 'House', kind: 'text', finance: false })
    })

    it('refuses a malformed declaration while the report module is loading', () => {
      expect(() => defineColumns([])).toThrow(/at least one column/)
      expect(() => defineColumns([{ key: 'Brand', label: 'House' }])).toThrow(/malformed key/)
      expect(() => defineColumns([{ key: 'qty', label: '  ' }])).toThrow(/no label/)
      expect(() => defineColumns([{ key: 'qty', label: 'Metres', kind: 'currency' }])).toThrow(
        /unknown kind/
      )
      expect(() =>
        defineColumns([
          { key: 'qty', label: 'Metres' },
          { key: 'qty', label: 'Units' },
        ])
      ).toThrow(/declared twice/)
    })
  })

  describe('maskReport', () => {
    it('serves a finance login the whole report and an empty masked list', () => {
      const masked = maskReport(report, FINANCE)

      expect(masked.columns).toHaveLength(5)
      expect(masked.rows[0].cost_cents).toBe(90000)
      expect(masked.totals.margin_cents).toBe(185000)
      expect(masked.meta.masked_columns).toEqual([])
      // The standing note survives masking; it is the report's own.
      expect(masked.meta.coverage).toBe('live orders only')
    })

    // Deleted, not nulled: a key that survives with an empty value still says
    // which figures exist.
    it('deletes the finance columns from columns, every row and totals', () => {
      const masked = maskReport(report, STAFF)

      expect(masked.columns.map((column) => column.key)).toEqual([
        'brand_name',
        'qty',
        'revenue_cents',
      ])
      for (const row of masked.rows) {
        expect(Object.hasOwn(row, 'cost_cents')).toBe(false)
        expect(Object.hasOwn(row, 'margin_cents')).toBe(false)
      }
      expect(Object.hasOwn(masked.totals, 'cost_cents')).toBe(false)
      expect(masked.totals).toEqual({ qty: 15, revenue_cents: 300000 })
    })

    // The epic's key acceptance criterion for this story, asserted the way a
    // reader would check it: no finance key anywhere in the payload.
    it('leaves no finance key anywhere in the serialised payload', () => {
      const body = JSON.stringify(maskReport(report, STAFF))

      expect(body).not.toContain('cost_cents')
      expect(body).not.toContain('margin_cents')
      expect(body).toContain('revenue_cents')
    })

    it('carries the masked columns as labels only', () => {
      const masked = maskReport(report, STAFF)

      expect(masked.meta.masked_columns).toEqual(['Cost', 'Margin'])
      expect(JSON.stringify(masked.meta.masked_columns)).not.toContain('_cents')
    })

    it('leaves the report it was given untouched', () => {
      maskReport(report, STAFF)

      expect(report.rows[0].cost_cents).toBe(90000)
      expect(report.columns).toHaveLength(5)
    })

    // Rows are projected onto the surviving columns, so a key nobody declared
    // cannot ride out of the report on the strength of being forgotten.
    it('projects a row onto the declared columns, in column order', () => {
      const masked = maskReport(
        { ...report, rows: [{ landed_cost_cents: 1, qty: 2, brand_name: 'Liberty London' }] },
        STAFF
      )

      expect(Object.keys(masked.rows[0])).toEqual(['brand_name', 'qty'])
    })

    it('answers 403 with a reason when every column is finance', () => {
      const purchases = {
        report: 'purchases',
        columns: defineColumns([
          { key: 'spend_cents', label: 'Committed spend', kind: 'money', finance: true },
        ]),
        rows: [{ spend_cents: 12000 }],
      }

      const error = statusOf(() => maskReport(purchases, STAFF))

      expect(error.statusCode).toBe(403)
      expect(error.message).toContain('purchases')
      expect(error.message).toContain('finance visibility')
      // …and a finance login still gets it.
      expect(maskReport(purchases, FINANCE).rows).toHaveLength(1)
    })

    // A report can be finance end to end while still carrying a name column;
    // "there is no version of this minus the money" is the report's own
    // statement, not something the column list can be read off.
    it('answers 403 for a report that declares itself finance-only', () => {
      const error = statusOf(() =>
        maskReport(
          { ...report, finance_only: true, finance_reason: 'Committed supplier spend.' },
          STAFF
        )
      )

      expect(error.statusCode).toBe(403)
      expect(error.message).toBe('Committed supplier spend.')
    })

    // 200 with an empty table is indistinguishable from "no trade this month".
    it('never answers a refusal with an empty table', () => {
      const error = statusOf(() =>
        maskReport({ ...report, finance_only: true, rows: [] }, STAFF)
      )
      expect(error.statusCode).toBe(403)
    })

    it('nulls a totals row that masking emptied, rather than serving a blank one', () => {
      const valuation = {
        report: 'stock',
        columns: defineColumns([
          { key: 'sku', label: 'SKU' },
          { key: 'value_cents', label: 'Value', kind: 'money', finance: true },
        ]),
        rows: [{ sku: 'PF-001', value_cents: 5000 }],
        totals: { value_cents: 5000 },
      }

      expect(maskReport(valuation, STAFF).totals).toBeNull()
      expect(maskReport(valuation, FINANCE).totals).toEqual({ value_cents: 5000 })
    })

    // Absent access is no access: a caller that forgot to pass one must not be
    // handed the finance columns by default.
    it('masks when it is given no access at all', () => {
      expect(maskReport(report).meta.masked_columns).toEqual(['Cost', 'Margin'])
    })

    it('throws a plain error for a report that declares no columns', () => {
      const error = statusOf(() => maskReport({ report: 'broken', columns: [] }, FINANCE))
      expect(error.statusCode).toBeUndefined()
      expect(error.message).toContain('broken')
    })
  })
})

// The scope CTE's SQL text is pure — it is built from frozen declarations and
// bound params — so everything except "does Postgres accept it" is provable
// here. That half lives in test/admin-reports.test.js.
describe('the revenue scope', () => {
  it('defaults the population to paid and shipped, and says so in one constant', () => {
    expect([...REVENUE_STATUSES]).toEqual(['paid', 'shipped'])
    expect(Object.isFrozen(REVENUE_STATUSES)).toBe(true)
  })

  it('binds the default population as a placeholder, never as SQL text', () => {
    const { cte, params } = buildRevenueScope()

    expect(cte).toContain('o.status = ANY($1::text[])')
    expect(cte).not.toContain("'paid'")
    expect(params).toEqual([['paid', 'shipped']])
  })

  // Overridable, and by REPLACEMENT: intersecting the two would answer
  // status=requested with zero rows, which reads as "no trade".
  it('lets a status filter replace the default population rather than narrow it', () => {
    const { cte, params } = buildRevenueScope(parseReportFilters({ status: 'requested' }))

    expect(cte).toContain('o.status = $1')
    expect(cte).not.toContain('ANY($1::text[])')
    expect(params).toEqual(['requested'])
  })

  it('keeps every kind, so a request-kind line is in the population', () => {
    const { cte } = buildRevenueScope()
    expect(cte).not.toContain('o.kind =')
  })

  it('carries the per-line quantity, value and unpriced flag', () => {
    const { cte } = buildRevenueScope()

    expect(cte).toContain('(ol.qty * ol.unit_price_cents) AS line_value_cents')
    expect(cte).toContain('(ol.unit_price_cents = 0) AS unpriced')
  })

  it('excludes archived orders and nothing else archived', () => {
    const { cte } = buildRevenueScope()

    expect(cte).toContain('o.archived_at IS NULL')
    expect(cte).not.toContain('p.archived_at')
    expect(cte).not.toContain('b.archived_at')
  })

  it('appends the filters after the population, all bound', () => {
    const filters = parseReportFilters({ brand: 'pierre-frey', from: '2026-01-01' })
    const { cte, params } = buildRevenueScope(filters)

    expect(params).toEqual([['paid', 'shipped'], '2026-01-01', ['pierre-frey']])
    expect(cte).toContain('o.created_at >= $2::date')
    expect(cte).toContain('b.slug = ANY($3::text[])')
  })

  it('numbers its placeholders from the params a report has already bound', () => {
    const existing = ['a-report-of-its-own']
    const { cte, params } = buildRevenueScope({}, { params: existing })

    expect(cte).toContain('o.status = ANY($2::text[])')
    expect(params).toEqual(['a-report-of-its-own', ['paid', 'shipped']])
    expect(existing).toEqual(['a-report-of-its-own'])
  })

  it('names the CTE once, so a report and its export cannot spell it apart', () => {
    expect(buildRevenueScope().cte.startsWith(`${SCOPE_NAME} AS (`)).toBe(true)
  })

  // The seam. One source today, and the shape is what makes the second additive.
  describe('the union seam', () => {
    const source = {
      name: 'legacy lines',
      columns: Object.fromEntries(SCOPE_COLUMNS.map((name) => [name, `l.${name}`])),
      from: 'FROM legacy_sales_invoice_lines l',
      conditions: [],
      statusColumn: null,
      filters: ['from', 'to'],
    }

    it('accepts a second source that emits the contract', () => {
      expect(() => assertScopeSource(source)).not.toThrow()
    })

    // A UNION ALL lines its branches up by POSITION, so agreeing on the names
    // while disagreeing on the order files one house's revenue under another's.
    it('refuses a source whose columns are reordered', () => {
      const reordered = { ...source, columns: { ...source.columns } }
      const [first] = SCOPE_COLUMNS
      delete reordered.columns[first]
      reordered.columns[first] = `l.${first}`

      expect(() => assertScopeSource(reordered)).toThrow(/in that order/)
    })

    it('refuses a source that drops or invents a column', () => {
      const thinner = { ...source, columns: { ...source.columns } }
      delete thinner.columns.unpriced
      expect(() => assertScopeSource(thinner)).toThrow(/must emit exactly/)
    })

    it('refuses a source claiming a filter the whitelist does not know', () => {
      expect(() => assertScopeSource({ ...source, filters: ['salesperson'] })).toThrow(
        /unknown filter/
      )
    })

    it('refuses a source with no FROM clause', () => {
      expect(() => assertScopeSource({ ...source, from: '' })).toThrow(/FROM clause/)
    })
  })
})

// product-performance.js — the declarations, which are the half of the report
// that needs no database. Everything the query answers is in
// test/admin-reports.test.js, against real orders.
describe('product performance', () => {
  it('declares its columns once, validated at module load', () => {
    expect(PRODUCT_PERFORMANCE).toBe('product-performance')
    expect(PRODUCT_PERFORMANCE_COLUMNS.map((column) => column.key)).toEqual([
      'brand_name',
      'product_name',
      'product_type',
      'currency',
      'orders',
      'qty',
      'value_cents',
      'unpriced_lines',
    ])
  })

  // A sell value is money and is not a cost. The CRM's own policy leaves a sell
  // "Value" column open to every staff login and masks the landed ones; this
  // report has no cost column at all, so it survives a non-finance login whole.
  it('declares no finance column, so nothing here is masked away', () => {
    expect(PRODUCT_PERFORMANCE_COLUMNS.filter((column) => column.finance)).toEqual([])
  })

  it('types the money and the counts, so one cell pipeline can render them', () => {
    const kinds = Object.fromEntries(
      PRODUCT_PERFORMANCE_COLUMNS.map((column) => [column.key, column.kind])
    )

    expect(kinds).toMatchObject({
      brand_name: 'text',
      value_cents: 'money',
      qty: 'number',
      orders: 'number',
    })
  })

  // The coverage note travels in the payload rather than in a screen's footnote,
  // because the CSV is the copy that leaves the building.
  it('states that the historic Dynamics sales are header-only and excluded', () => {
    expect(COVERAGE_NOTE).toMatch(/header-only/)
    expect(COVERAGE_NOTE).toMatch(/no pre-launch sale is included/)
  })

  // A totals row is a row, so its label travels as data in the first two
  // columns — that is what lets one renderer and one CSV writer handle it.
  it('labels the totals row in the columns the table leads with', () => {
    const [first, second] = PRODUCT_PERFORMANCE_COLUMNS
    expect(Object.keys(TOTALS_LABELS)).toEqual([first.key, second.key])
  })

  it('bounds the table’s default page below its maximum', () => {
    expect(DEFAULT_ROW_LIMIT).toBeLessThanOrEqual(MAX_ROW_LIMIT)
  })
})

// export.js — the CSV writer. Pure: it takes a masked envelope and returns text,
// so everything about the file's shape is provable here. What only Postgres can
// answer — that the file carries the same population the table does, and more
// rows than a limited page — is in test/admin-reports.test.js beside it.
describe('the report CSV writer', () => {
  const COLUMNS = defineColumns([
    { key: 'brand_name', label: 'House' },
    { key: 'product_name', label: 'Design' },
    { key: 'qty', label: 'Quantity', kind: 'number' },
    { key: 'value_cents', label: 'Sales', kind: 'money' },
    { key: 'landed_cents', label: 'Landed', kind: 'money', finance: true },
  ])

  const report = (overrides = {}) =>
    Object.freeze({
      report: 'test-report',
      title: 'A test report',
      columns: COLUMNS,
      rows: [
        {
          brand_name: 'Pierre Frey',
          product_name: 'Atlas',
          qty: 2,
          value_cents: 100000,
          landed_cents: 40000,
        },
      ],
      totals: { brand_name: 'All houses', value_cents: 100000, landed_cents: 40000 },
      meta: {
        filters: { from: '2026-01-01', brand: ['pierre-frey', 'liberty-london'] },
        coverage: { note: 'Live platform orders only.' },
        masked_columns: [],
      },
      ...overrides,
    })

  // The file split back into rows, the way the reader's spreadsheet reads it.
  const linesOf = (csv) => csv.split('\r\n')

  describe('the table it writes', () => {
    it('takes its header from the columns, in declaration order', () => {
      expect(linesOf(toReportCsv(report()))[0]).toBe('House,Design,Quantity,Sales,Landed')
    })

    it('writes one row per row, cells in column order', () => {
      expect(linesOf(toReportCsv(report()))[1]).toBe('Pierre Frey,Atlas,2,1000.00,400.00')
    })

    it('appends the totals row as a row, with no second rule', () => {
      expect(linesOf(toReportCsv(report()))[2]).toBe('All houses,,,1000.00,400.00')
    })

    // A totals row deliberately omits a figure that cannot be added — metres and
    // units do not sum — and a 0 there would state a total nobody computed.
    it('writes an absent key as an empty cell, never as a zero', () => {
      expect(linesOf(toReportCsv(report()))[2].split(',')[2]).toBe('')
    })

    it('ends with a trailing newline, so an importer cannot drop the last row', () => {
      expect(toReportCsv(report())).toMatch(/\r\n$/)
    })
  })

  // The reason src/lib/csv.js was extracted in US-001: a design name is
  // staff-typed free text and this file is built to open in Excel.
  describe('the escaping it inherits', () => {
    it('neutralises a product name beginning with =', () => {
      const csv = toReportCsv(
        report({ rows: [{ brand_name: 'House', product_name: '=HYPERLINK("http://x")' }] })
      )
      expect(linesOf(csv)[1]).toBe('House,"\'=HYPERLINK(""http://x"")",,,')
    })

    it('neutralises the other formula lead-ins too', () => {
      for (const prefix of ['+', '-', '@', '\t', '\r']) {
        const csv = toReportCsv(report({ rows: [{ brand_name: `${prefix}cut to order` }] }))
        expect(csv).toContain(`'${prefix}cut to order`)
      }
    })

    it('quotes a value carrying a comma, per RFC 4180', () => {
      const csv = toReportCsv(report({ rows: [{ brand_name: 'Linen, washed' }] }))
      expect(linesOf(csv)[1]).toBe('"Linen, washed",,,,')
    })
  })

  // `kind` is declared once for the table and the file alike, which is what lets
  // the writer tell a figure from a name without a second list.
  describe('the money it renders', () => {
    it('writes a money column in units at two decimal places, never in cents', () => {
      expect(linesOf(toReportCsv(report({ rows: [{ value_cents: 4998 }] })))[1]).toBe(',,,49.98,')
    })

    it('hands a non-numeric money value on untouched rather than writing NaN', () => {
      expect(linesOf(toReportCsv(report({ rows: [{ value_cents: 'unknown' }] })))[1]).toBe(
        ',,,unknown,'
      )
    })

    it('leaves a number column alone', () => {
      expect(linesOf(toReportCsv(report({ rows: [{ qty: 2.5 }] })))[1]).toBe(',,2.5,,')
    })
  })

  // A masked export must not read as a complete one. The header IS the masked
  // envelope's columns, so a deleted column has no header and no cell anywhere.
  describe('what a masked report exports', () => {
    const maskedCsv = (finance) =>
      toReportCsv(
        maskReport(report(), reportAccess({ role: 'backoffice', can_view_finance: finance }))
      )

    it('gives a non-finance caller no finance header', () => {
      expect(linesOf(maskedCsv(false))[0]).toBe('House,Design,Quantity,Sales')
    })

    it('gives a non-finance caller no finance VALUE anywhere in the file', () => {
      expect(maskedCsv(false)).not.toContain('400.00')
      expect(maskedCsv(false)).not.toContain('40000')
    })

    it('says which columns were withheld, by label', () => {
      expect(maskedCsv(false)).toContain('Columns withheld,Landed')
    })

    it('gives a finance caller the whole file, with no withheld note', () => {
      expect(linesOf(maskedCsv(true))[0]).toBe('House,Design,Quantity,Sales,Landed')
      expect(maskedCsv(true)).not.toContain('Columns withheld')
    })
  })

  // The CSV is the copy that leaves the building: a file that does not say what
  // it covers is read as covering everything.
  describe('the notes below the table', () => {
    it('separates itself from the data with a blank row', () => {
      const lines = linesOf(toReportCsv(report()))
      expect(lines.indexOf('')).toBe(3)
    })

    it('names the report and states its coverage', () => {
      const csv = toReportCsv(report())
      expect(csv).toContain('Report,A test report')
      expect(csv).toContain('Coverage,Live platform orders only.')
    })

    it('states the filters the file was built with, multi-value ones included', () => {
      expect(toReportCsv(report())).toContain(
        'Filters,"from=2026-01-01; brand=pierre-frey, liberty-london"'
      )
    })

    it('says so plainly when nothing was filtered', () => {
      expect(toReportCsv(report({ meta: { filters: {} } }))).toContain('Filters,none')
    })

    it('omits the coverage line when the report states none', () => {
      expect(toReportCsv(report({ meta: { filters: {} } }))).not.toContain('Coverage,')
    })
  })

  describe('the filename and the content type', () => {
    it('builds the filename from the report’s own name', () => {
      expect(reportCsvFilename({ report: 'product-performance' })).toBe(
        'atelier-product-performance.csv'
      )
    })

    // A report's name is a module constant, so a value that is not filename-safe
    // is a code fault (a 500) rather than a caller's 400 — the posture
    // requireEntity takes for a registry key.
    it('throws on a report name that could reach the header as anything else', () => {
      for (const name of ['Product Performance', 'a"b', '../etc', '', undefined, 42]) {
        expect(() => reportCsvFilename({ report: name })).toThrow(/filename-safe/)
      }
    })

    it('declares UTF-8, because a house name is not ASCII', () => {
      expect(REPORT_CSV_CONTENT_TYPE).toBe('text/csv; charset=utf-8')
    })
  })

  // Without columns there is no header and no cell order, and a file built from
  // the rows' own keys would vary per row.
  it('refuses a report that declares no columns', () => {
    expect(() => toReportCsv({ report: 'empty', columns: [] })).toThrow(/declares no columns/)
  })
})

// W5-US-007 — the two live-data reports. Their SQL is measured against real rows
// in test/admin-reports.test.js; what is provable without a database is what each
// one DECLARES: which filters it can honour, which columns it has, which
// population it is of, and what its file says about all three.
describe('W5-US-007 — stock and not-invoiced, declared', () => {
  describe('the shared row limit', () => {
    // Three reports spend these now. A per-report copy is how one of them would
    // quietly start answering with a different page than its neighbours.
    it('defaults a table to a page and caps it', () => {
      expect(clampLimit(undefined)).toBe(DEFAULT_ROW_LIMIT)
      expect(clampLimit(MAX_ROW_LIMIT + 500)).toBe(MAX_ROW_LIMIT)
      expect(clampLimit(0)).toBe(1)
      expect(clampLimit(25)).toBe(25)
    })

    // The export's contract, and the one value the table route's schema cannot
    // produce — which is what makes "the export is not the current page" true.
    it('passes null through as every row', () => {
      expect(clampLimit(null)).toBeNull()
    })
  })

  describe('partitionFilters', () => {
    const supplied = parseReportFilters({
      from: '2026-01-01',
      brand: 'pierre-frey',
      status: 'paid',
    })

    it('keeps what a report can honour and names what it cannot', () => {
      const { honoured, ignored } = partitionFilters(supplied, STOCK_FILTERS)

      expect(honoured).toEqual({ brand: ['pierre-frey'] })
      expect([...ignored]).toEqual(['from', 'status'])
    })

    it('honours everything when a report declines nothing', () => {
      const { honoured, ignored } = partitionFilters(supplied)

      expect(Object.keys(honoured).sort()).toEqual(['brand', 'from', 'status'])
      expect([...ignored]).toEqual([])
    })

    it('freezes both halves, so neither can be widened after the fact', () => {
      const { honoured, ignored } = partitionFilters(supplied, STOCK_FILTERS)

      expect(Object.isFrozen(honoured)).toBe(true)
      expect(Object.isFrozen(ignored)).toBe(true)
    })

    it('reports nothing ignored when nothing was supplied', () => {
      expect(partitionFilters({}, STOCK_FILTERS).ignored).toEqual([])
    })
  })

  describe('the stock report’s declaration', () => {
    it('names itself something filename-safe', () => {
      expect(reportCsvFilename({ report: STOCK })).toBe('atelier-stock.csv')
    })

    it('declares the holding, its allocation and what is left of it', () => {
      expect(STOCK_COLUMNS.map((column) => column.key)).toEqual([
        'sku',
        'brand_name',
        'product_name',
        'colourway_name',
        'unit',
        'on_hand',
        'allocated',
        'available',
      ])
    })

    // Nothing in this schema holds a landed cost, and the only cost data Atelier
    // has keys on a supplier code that may not be joined to a colourway — so the
    // honest report carries no valuation and therefore no finance column.
    // Masking removes nothing from it, which US-008 has to know.
    it('declares no finance column, because it states no cost', () => {
      expect(STOCK_COLUMNS.some((column) => column.finance)).toBe(false)
      expect(STOCK_COLUMNS.some((column) => column.kind === 'money')).toBe(false)
    })

    it('says in the payload that it carries no valuation, rather than leaving a gap', () => {
      expect(STOCK_COVERAGE_NOTE).toMatch(/no landed cost/i)
      expect(STOCK_COVERAGE_NOTE).toMatch(/A1/)
    })

    // Its FROM starts at `inventory` and has no `orders` in it, so a lifecycle
    // filter there would be a broken query rather than a narrowing.
    it('honours only the filters whose columns it has', () => {
      expect([...STOCK_FILTERS]).toEqual(['brand', 'product_type', 'collection'])
      for (const name of STOCK_FILTERS) {
        expect(REPORT_FILTER_NAMES).toContain(name)
      }
    })

    it('builds clauses for the three it honours, and refuses a name nobody declared', () => {
      const filters = parseReportFilters({ brand: 'pierre-frey', product_type: 'fabric' })
      const built = buildReportFilters(filters, { names: STOCK_FILTERS })

      expect(built.where).toBe('b.slug = ANY($1::text[]) AND p.product_type = $2')
      expect(() => buildReportFilters(filters, { names: ['invented'] })).toThrow(
        /Unknown report filter/
      )
    })

    it('labels its totals row without putting a figure in the label', () => {
      expect(STOCK_TOTALS_LABELS).toEqual({ sku: 'All holdings', brand_name: 'All houses' })
      expect(Object.isFrozen(STOCK_TOTALS_LABELS)).toBe(true)
    })
  })

  describe('the not-invoiced report’s declaration', () => {
    it('names itself something filename-safe', () => {
      expect(reportCsvFilename({ report: NOT_INVOICED })).toBe('atelier-not-invoiced.csv')
    })

    it('declares the order, the line and the stock behind it', () => {
      expect(NOT_INVOICED_COLUMNS.map((column) => column.key)).toEqual([
        'order_number',
        'placed_at',
        'status',
        'kind',
        'client',
        'brand_name',
        'product_name',
        'sku',
        'product_type',
        'qty',
        'on_hand',
      ])
    })

    // A request line is created at unit_price_cents = 0 and nothing on this
    // platform ever fills it in, so a "Value" column would be a column of zeros
    // under a money heading — a wrong figure to every human who reads it.
    it('states no money at all, and says why in its coverage note', () => {
      expect(NOT_INVOICED_COLUMNS.some((column) => column.kind === 'money')).toBe(false)
      expect(NOT_INVOICED_COLUMNS.some((column) => column.finance)).toBe(false)
      expect(NOT_INVOICED_COVERAGE_NOTE).toMatch(/never what it is worth/)
    })

    // An order is awaiting an invoice from the moment it is placed, so the
    // revenue scope's paid/shipped default is the wrong window for it.
    it('covers every live status and not the declined one', () => {
      expect([...NOT_INVOICED_STATUSES]).toEqual(['requested', 'confirmed', 'paid', 'shipped'])
      expect(NOT_INVOICED_STATUSES).not.toContain('declined')
      for (const status of NOT_INVOICED_STATUSES) {
        expect(ORDER_STATUSES).toContain(status)
      }
    })

    // A definition of the report, not an overridable default: a card checkout is
    // paid at Stripe and is never invoiced through this platform, so counting one
    // would report every web sale as an unbilled receivable.
    it('covers the invoiceable kinds only, and says so in the note', () => {
      expect([...INVOICEABLE_KINDS]).toEqual(['order_request', 'backorder_request'])
      expect(INVOICEABLE_KINDS).not.toContain('checkout')
      for (const kind of INVOICEABLE_KINDS) {
        expect(ORDER_KINDS).toContain(kind)
      }
      expect(NOT_INVOICED_COVERAGE_NOTE).toMatch(/Card checkouts/)
    })
  })

  // The scope's lifecycle window is a DEFAULT like the revenue one, so a report
  // states its own rather than growing a second join tree — and a status filter
  // still replaces whichever default is in play.
  describe('the scope’s declarable population', () => {
    it('binds the revenue statuses when a report states none', () => {
      expect(buildRevenueScope({}).params).toEqual([[...REVENUE_STATUSES]])
    })

    it('binds a report’s own statuses when it states them', () => {
      const { cte, params } = buildRevenueScope({}, { statuses: NOT_INVOICED_STATUSES })

      expect(params).toEqual([[...NOT_INVOICED_STATUSES]])
      expect(cte).toContain('o.status = ANY($1::text[])')
    })

    it('lets a status filter replace a report’s own default, never intersect it', () => {
      const filters = parseReportFilters({ status: 'confirmed' })
      const { cte, params } = buildRevenueScope(filters, { statuses: NOT_INVOICED_STATUSES })

      expect(params).toEqual(['confirmed'])
      expect(cte).not.toContain('ANY($1::text[])')
    })

    // The three columns the invoice queue reads out of the shared population,
    // rather than out of a second join tree a future D365 source would then have
    // to be unioned into twice.
    it('carries the order’s customer and its invoice reference', () => {
      for (const name of ['user_id', 'guest_email', 'invoice_ref']) {
        expect(SCOPE_COLUMNS).toContain(name)
      }
      expect(buildRevenueScope({}).cte).toContain('o.xero_invoice_ref AS invoice_ref')
    })
  })

  // A filter the report could not honour narrowed nothing, so it is absent from
  // `Filters` — and a reader who typed one would take that as the file having
  // been filtered by it.
  describe('what a report with ignored filters exports', () => {
    const COLUMNS = defineColumns([{ key: 'sku', label: 'SKU' }])

    const report = (meta) =>
      Object.freeze({
        report: 'stock',
        title: 'Stock holdings by colourway',
        columns: COLUMNS,
        rows: [{ sku: 'AT-1' }],
        totals: null,
        meta: { masked_columns: [], ...meta },
      })

    it('names the filters it could not honour, under the ones it did', () => {
      const csv = toReportCsv(
        report({ filters: { brand: ['pierre-frey'] }, ignored_filters: ['from', 'status'] })
      )

      expect(csv).toContain('Filters,brand=pierre-frey')
      expect(csv).toContain('Filters ignored,"from, status"')
    })

    it('omits the line entirely when every filter was honoured', () => {
      expect(toReportCsv(report({ filters: {}, ignored_filters: [] }))).not.toContain(
        'Filters ignored'
      )
    })

    it('omits it for a report that has no opinion about ignored filters', () => {
      expect(toReportCsv(report({ filters: {} }))).not.toContain('Filters ignored')
    })
  })
})
