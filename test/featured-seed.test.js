import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The behavioural half of this story lives in test/seed.test.js — feature a real
// house, reseed, assert the rank stood. This half asserts the MECHANISM, because
// the behavioural test can only see what the seed did to rows it upserts: it
// would keep passing if `featured_rank` were added to an INSERT column list with
// a null beside it, which reads as "the seed owns this column" to the next
// person to extend the set list.
const SEED_SOURCE = readFileSync(new URL('../src/seed/seed.js', import.meta.url), 'utf8')

// `INSERT INTO <table> (<columns>) … ON CONFLICT (…) DO UPDATE SET <set list>`
// (or DO NOTHING), captured per table so an assertion can name a set list rather
// than scanning the whole file — a file-wide `includes` cannot tell an INSERT
// column from a refreshed one, and those are the two different mistakes here.
const UPSERT_PATTERN =
  /INSERT INTO (\w+) \(([^)]+)\)[\s\S]*?ON CONFLICT \([^)]+\) DO (?:NOTHING|UPDATE SET([\s\S]*?)(?:\n\s*RETURNING|`))/g

const namesIn = (clause) =>
  (clause ?? '').split(/[\s,=]+/).filter((token) => /^[a-z][a-z0-9_]*$/.test(token))

const upserts = new Map(
  [...SEED_SOURCE.matchAll(UPSERT_PATTERN)].map((match) => [
    match[1],
    Object.freeze({
      columns: namesIn(match[2]),
      // undefined for DO NOTHING — an empty set list and no set list at all are
      // different statements and must not collapse into each other here.
      refreshed: match[3] === undefined ? null : namesIn(match[3]),
    }),
  ])
)

describe('featured_rank stays out of the seed', () => {
  // A regex that silently matches nothing passes every per-statement assertion
  // below vacuously, so the extraction itself is asserted first.
  it('finds every upsert the seed runs', () => {
    expect([...upserts.keys()].sort()).toEqual([
      'brands',
      'collections',
      'colourways',
      'inventory',
      'products',
      'shipping_rates',
    ])
  })

  // Absent from the INSERT list as well as the DO UPDATE list — unlike
  // trade_only, which is written once at INSERT. Nothing in the vendored
  // catalogue knows which houses the office wants to lead with, so a fresh
  // `npm run seed` leaves every row NULL and the migration is the only thing
  // that features anything.
  it('never writes featured_rank on brands or collections, on insert or refresh', () => {
    for (const table of ['brands', 'collections']) {
      expect(upserts.get(table).columns).not.toContain('featured_rank')
      expect(upserts.get(table).refreshed).not.toContain('featured_rank')
    }
  })

  // The posture, spelled out: an office decision survives a reseed either by
  // being absent from the refresh (trade_only, featured_rank) or by the whole
  // row being left alone (inventory, shipping_rates). Both halves are asserted
  // so a later edit that "tidied" one into the other would fail here.
  it('keeps the same posture as trade_only, inventory and shipping_rates', () => {
    expect(upserts.get('brands').columns).toContain('trade_only')
    expect(upserts.get('brands').refreshed).not.toContain('trade_only')

    for (const table of ['inventory', 'shipping_rates']) {
      expect(upserts.get(table).refreshed).toBeNull()
    }
  })
})
