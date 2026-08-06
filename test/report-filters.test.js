// src/reports/filters.js is pure by design, so this suite takes no pool, runs no
// migration and stubs nothing. The two properties it exists to hold are:
//   - a filter NAME only ever resolves through the frozen whitelist
//   - a filter VALUE only ever leaves as a $n placeholder
// Everything else here is the parsing contract the reports and their exports
// share, so the table and the CSV cannot disagree about what was filtered.

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
