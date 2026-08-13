// Pure unit tests for the order-desk filter layer (W12 US-002). No pool, no
// migrations, no app — that is the whole point of the module being pure: the
// whitelist and the ILIKE escaping are provable on their own.

import { describe, it, expect } from 'vitest'
import {
  ORDER_FILTER_COLUMNS,
  ORDER_FILTER_NAMES,
  parseOrderFilters,
  buildOrderFilters,
  escapeLike,
} from '../src/orders/order-filters.js'

describe('ORDER_FILTER_COLUMNS', () => {
  it('is a frozen whitelist of trusted alias.column literals', () => {
    expect(Object.isFrozen(ORDER_FILTER_COLUMNS)).toBe(true)
    for (const columns of Object.values(ORDER_FILTER_COLUMNS)) {
      expect(Object.isFrozen(columns)).toBe(true)
      for (const column of columns) {
        expect(column).toMatch(/^[a-z]+\.[a-z_]+$/)
      }
    }
  })

  it('covers exactly the five filters the order desk offers', () => {
    expect([...ORDER_FILTER_NAMES].sort()).toEqual([
      'client',
      'from',
      'po_number',
      'q',
      'reference',
      'to',
    ])
  })

  // A guest order has no users row, so the LEFT JOIN gives NULL for u.name and
  // u.email. A client search that looked only at those would silently exclude
  // every order placed without a login — which is most of the storefront's.
  it('searches guest_email for the client, because a guest order has no account', () => {
    expect(ORDER_FILTER_COLUMNS.client).toContain('o.guest_email')
    expect(ORDER_FILTER_COLUMNS.q).toContain('o.guest_email')
  })
})

describe('parseOrderFilters', () => {
  it('returns only the filters actually supplied, frozen', () => {
    const filters = parseOrderFilters({ reference: 'Hutchinson lounge' })
    expect(filters).toEqual({ reference: 'Hutchinson lounge' })
    expect(Object.isFrozen(filters)).toBe(true)
  })

  it('ignores an unknown filter name rather than rejecting it', () => {
    expect(parseOrderFilters({ nonsense: 'x', reference: 'a' })).toEqual({
      reference: 'a',
    })
  })

  it('treats a blank or whitespace value as absent, never as "match nothing"', () => {
    expect(parseOrderFilters({ q: '', client: '   ', reference: null })).toEqual({})
  })

  it('trims a search term', () => {
    expect(parseOrderFilters({ q: '  PO-4471  ' }).q).toBe('PO-4471')
  })

  it('keeps the term RAW — the escaping belongs to the clause builder', () => {
    expect(parseOrderFilters({ reference: '100%_A' }).reference).toBe('100%_A')
  })

  it('400s a term that is not text', () => {
    expect(() => parseOrderFilters({ q: ['a', 'b'] })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })

  it('400s an over-long term', () => {
    expect(() => parseOrderFilters({ q: 'x'.repeat(201) })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })

  it('accepts a calendar date range', () => {
    expect(parseOrderFilters({ from: '2026-08-01', to: '2026-08-31' })).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    })
  })

  it('400s a malformed date and an impossible one', () => {
    expect(() => parseOrderFilters({ from: '01/08/2026' })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
    // The regex accepts it; the round trip is what rejects it.
    expect(() => parseOrderFilters({ from: '2026-02-30' })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })

  it('400s a backwards range rather than answering with an empty list', () => {
    expect(() => parseOrderFilters({ from: '2026-08-31', to: '2026-08-01' })).toThrow(
      /is after/
    )
  })

  it('names the offending filter and echoes a capped preview of the value', () => {
    let error
    try {
      parseOrderFilters({ from: 'yesterday' })
    } catch (caught) {
      error = caught
    }
    expect(error.message).toContain('"from"')
    expect(error.message).toContain('yesterday')
  })
})

describe('escapeLike', () => {
  // The security property of this module. A reference is free text a person
  // typed, so an unescaped `%` is a search that quietly answers with the wrong
  // orders — every order, in fact.
  it('escapes the LIKE metacharacters and the escape character itself', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('A_1')).toBe('A\\_1')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })

  it('escapes in a single pass, so an escape is never re-escaped', () => {
    expect(escapeLike('50%_off')).toBe('50\\%\\_off')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Hutchinson lounge')).toBe('Hutchinson lounge')
  })
})

describe('buildOrderFilters', () => {
  it('binds a term as a contains pattern with the metacharacters escaped', () => {
    const { where, params } = buildOrderFilters(parseOrderFilters({ reference: '100%_A' }))
    expect(params).toEqual(['%100\\%\\_A%'])
    expect(where).toBe(`o.client_reference ILIKE $1 ESCAPE '\\'`)
  })

  it("puts ESCAPE '\\' on every ILIKE it emits", () => {
    const { where } = buildOrderFilters(
      parseOrderFilters({ q: 'x', client: 'y', reference: 'z', po_number: 'w' })
    )
    const ilikes = where.match(/ILIKE/g) ?? []
    const escapes = where.match(/ESCAPE '\\'/g) ?? []
    expect(ilikes.length).toBeGreaterThan(1)
    expect(escapes).toHaveLength(ilikes.length)
  })

  it('parenthesises a multi-column OR group so it cannot swallow the next AND', () => {
    const { where } = buildOrderFilters(parseOrderFilters({ client: 'ada', reference: 'r' }))
    expect(where.startsWith('(')).toBe(true)
    expect(where).toContain(') AND o.client_reference ILIKE')
  })

  it('never puts a value into the SQL text', () => {
    const evil = "'; DROP TABLE orders; --"
    const { where, params } = buildOrderFilters(parseOrderFilters({ q: evil }))
    expect(where).not.toContain('DROP')
    expect(params[0]).toContain(evil)
  })

  it('builds the date range as a half-open interval on the NEXT day', () => {
    const { where, params } = buildOrderFilters(
      parseOrderFilters({ from: '2026-08-01', to: '2026-08-31' })
    )
    // `<= to::date` would cut the range at that morning's midnight and silently
    // drop the whole last day — orders.created_at is a timestamptz.
    expect(where).toBe('o.created_at >= $1::date AND o.created_at < ($2::date + 1)')
    expect(params).toEqual(['2026-08-01', '2026-08-31'])
  })

  it('appends to the caller\'s params without mutating the array it was given', () => {
    const params = ['requested']
    const built = buildOrderFilters(parseOrderFilters({ reference: 'r' }), { params })
    expect(params).toEqual(['requested'])
    expect(built.params).toEqual(['requested', '%r%'])
    expect(built.where).toContain('$2')
  })

  it('emits clauses in whitelist order, so one filter set is always one SQL string', () => {
    const filters = { po_number: 'p', q: 'x', from: '2026-01-01' }
    const a = buildOrderFilters(parseOrderFilters(filters))
    const b = buildOrderFilters(parseOrderFilters({ from: '2026-01-01', q: 'x', po_number: 'p' }))
    expect(a.where).toBe(b.where)
    expect(a.params).toEqual(b.params)
  })

  it('builds nothing from no filters', () => {
    expect(buildOrderFilters()).toEqual({ clauses: [], params: [], where: '' })
  })
})
