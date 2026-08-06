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

import { describe, it, expect } from 'vitest'
import {
  FILTER_COLUMNS,
  REPORT_FILTER_NAMES,
  PRODUCT_TYPES,
  ORDER_KINDS,
  ORDER_STATUSES,
  parseReportFilters,
  buildReportFilters,
} from '../src/reports/filters.js'
import { reportAccess, defineColumns, maskReport } from '../src/reports/access.js'
import {
  PRODUCT_PERFORMANCE,
  PRODUCT_PERFORMANCE_COLUMNS,
  COVERAGE_NOTE,
  TOTALS_LABELS,
  DEFAULT_ROW_LIMIT,
  MAX_ROW_LIMIT,
} from '../src/reports/product-performance.js'
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
