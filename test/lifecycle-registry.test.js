import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  LIFECYCLE_ENTITIES,
  LIFECYCLE_ENTITY_NAMES,
  assertEntity,
} from '../src/lifecycle/registry.js'

// Registry safety (W1-US-003). The registry is the one place in this codebase
// where identifiers are interpolated into SQL rather than bound as parameters —
// they are frozen code literals, and these tests are what keeps that true. A
// malformed probe would not fail loudly at runtime; it would quietly answer the
// wrong question, and a delete would proceed.

const PROBE_SQL_PATTERN = /^SELECT 1 FROM [a-z_ ]/
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/

const entries = Object.entries(LIFECYCLE_ENTITIES)
const allProbes = entries.flatMap(([name, entity]) =>
  entity.probes.map((probe) => [`${name}.${probe.relation}`, probe])
)

describe('registry shape', () => {
  it('registers at least the nine live entities plus the archive-only order', () => {
    expect(LIFECYCLE_ENTITY_NAMES.length).toBeGreaterThanOrEqual(10)
    expect(allProbes.length).toBeGreaterThan(0)
  })

  it.each(entries)('%s declares lower_snake_case identifiers', (name, entity) => {
    expect(name).toMatch(IDENTIFIER_PATTERN)
    expect(entity.table).toMatch(IDENTIFIER_PATTERN)
    expect(entity.idColumn).toMatch(IDENTIFIER_PATTERN)
    expect(typeof entity.archivable).toBe('boolean')
    expect(typeof entity.label).toBe('string')
    expect(entity.label).not.toBe('')
  })

  it.each(allProbes)('probe %s is a bare existence select taking only $1', (_key, probe) => {
    expect(probe.sql).toMatch(PROBE_SQL_PATTERN)
    // Exactly one placeholder, and it is the parent id. Anything else and the
    // one-round-trip UNION ALL in delete.js would bind the wrong value.
    expect(probe.sql.match(/\$\d+/g)).toEqual(['$1'])
    // No stray semicolon could turn the wrapped subquery into a second statement.
    expect(probe.sql).not.toContain(';')
  })

  it.each(allProbes)('probe %s has a safe relation name and a human label', (_key, probe) => {
    expect(probe.relation).toMatch(IDENTIFIER_PATTERN)
    expect(typeof probe.label).toBe('string')
    expect(probe.label).not.toBe('')
  })

  it.each(entries)('%s declares each relation once', (_name, entity) => {
    const relations = entity.probes.map((probe) => probe.relation)
    // The relation keys the UNION ALL result, so a duplicate makes two probes
    // indistinguishable and one of them is silently dropped.
    expect(new Set(relations).size).toBe(relations.length)
  })

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(LIFECYCLE_ENTITIES)).toBe(true)
    for (const [, entity] of entries) {
      expect(Object.isFrozen(entity)).toBe(true)
      expect(Object.isFrozen(entity.probes)).toBe(true)
      for (const probe of entity.probes) expect(Object.isFrozen(probe)).toBe(true)
    }
  })
})

describe('assertEntity rejects what it must', () => {
  // The real registry is validated at import time, so a bad entry cannot be
  // observed any other way — these synthetic entries are the proof the validator
  // actually bites rather than being decorative.
  const valid = {
    table: 'brands',
    idColumn: 'id',
    label: 'house',
    archivable: true,
    probes: [{ relation: 'products', label: 'products', sql: 'SELECT 1 FROM products WHERE brand_id = $1' }],
  }

  it('accepts a well-formed entry', () => {
    expect(() => assertEntity('brand', valid)).not.toThrow()
  })

  it.each([
    ['an uppercase table', { ...valid, table: 'Brands' }, /table must be/],
    ['a table with a quote in it', { ...valid, table: 'brands"; drop' }, /table must be/],
    ['an uppercase id column', { ...valid, idColumn: 'ID' }, /idColumn must be/],
    ['a missing archivable flag', { ...valid, archivable: undefined }, /archivable must be/],
    ['a non-boolean deletable flag', { ...valid, deletable: 'no' }, /deletable must be/],
    ['an empty label', { ...valid, label: '' }, /label must be/],
    ['a non-function guard', { ...valid, guard: 'nope' }, /guard must be/],
    ['probes that are not an array', { ...valid, probes: {} }, /probes must be/],
    [
      'a probe that is not a bare existence select',
      { ...valid, probes: [{ relation: 'products', label: 'products', sql: 'DELETE FROM products WHERE brand_id = $1' }] },
      /must start "SELECT 1 FROM/,
    ],
    [
      'a probe binding a second placeholder',
      { ...valid, probes: [{ relation: 'products', label: 'products', sql: 'SELECT 1 FROM products WHERE brand_id = $1 AND x = $2' }] },
      /exactly one placeholder/,
    ],
    [
      'a probe binding the wrong placeholder',
      { ...valid, probes: [{ relation: 'products', label: 'products', sql: 'SELECT 1 FROM products WHERE brand_id = $2' }] },
      /exactly one placeholder/,
    ],
    [
      'a probe with an unsafe relation name',
      { ...valid, probes: [{ relation: 'pro ducts', label: 'products', sql: 'SELECT 1 FROM products WHERE brand_id = $1' }] },
      /must be lower_snake_case/,
    ],
    [
      'the same relation declared twice',
      {
        ...valid,
        probes: [
          { relation: 'products', label: 'products', sql: 'SELECT 1 FROM products WHERE brand_id = $1' },
          { relation: 'products', label: 'other', sql: 'SELECT 1 FROM products WHERE collection_id = $1' },
        ],
      },
      /declared twice/,
    ],
  ])('rejects %s', (_case, entity, pattern) => {
    expect(() => assertEntity('brand', entity)).toThrow(pattern)
  })

  it('rejects an unsafe entity name', () => {
    expect(() => assertEntity('Brand', valid)).toThrow(/name must be/)
  })
})

describe('registry matches the live schema', () => {
  let pool
  let columns

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
    const { rows } = await pool.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'`
    )
    columns = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))
  })

  afterAll(() => pool.end())

  it.each(entries)('%s: its table and id column exist', (_name, entity) => {
    expect(columns.has(`${entity.table}.${entity.idColumn}`)).toBe(true)
  })

  it.each(entries)('%s: archivable agrees with the archived_at column', (_name, entity) => {
    // Not decoration: `archivable` is what a blocked delete reports back to the
    // CRM, which offers "Archive instead" on the strength of it.
    expect(columns.has(`${entity.table}.archived_at`)).toBe(entity.archivable)
  })
})

describe('no caller derives an entity name from a request', () => {
  // src/lifecycle/ defines the contract (its own parameter is called
  // `entityName`); the callers are what this polices.
  const SRC = new URL('../src/', import.meta.url).pathname
  const CALL_SITE = /\b(deleteOrExplain|setArchived)\(\s*[^,)]+,\s*([^,)]+)/g

  const callSites = readdirSync(SRC, { recursive: true })
    .filter(
      (file) =>
        typeof file === 'string' &&
        file.endsWith('.js') &&
        !file.startsWith('lifecycle/') &&
        !file.startsWith('seed/data/')
    )
    .flatMap((file) => {
      const source = readFileSync(join(SRC, file), 'utf8')
      return [...source.matchAll(CALL_SITE)].map((match) => ({
        file,
        fn: match[1],
        argument: match[2].trim(),
      }))
    })

  it('finds the call sites at all, so a silent zero cannot pass this suite', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(8)
  })

  it('passes a single-quoted literal that is a registry key, never an expression', () => {
    for (const site of callSites) {
      // A path parameter would let a client choose which table is written to or
      // deleted from. requireEntity throws on an unknown name, but "brand" vs
      // "user" are both known — the registry is not an authorisation boundary.
      expect(
        /^'[a-z][a-z0-9_]*'$/.test(site.argument),
        `${site.file}: ${site.fn}() takes ${site.argument}, which is not a string literal`
      ).toBe(true)
      expect(LIFECYCLE_ENTITY_NAMES).toContain(site.argument.slice(1, -1))
    }
  })
})
