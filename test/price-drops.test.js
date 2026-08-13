// W17 US-007/US-008 — drop detection.
//
// A supplier stops selling a code by simply not listing it again, so absence is
// the only signal there is — and absence is exactly what a re-runnable import
// must not act on by itself. The design splits it in two: the IMPORT records
// what it saw, and a person decides what that means.
//
// The scope is (supplier, category) and the tests below are mostly about why:
// per file has no stable key (a filename carries the year), and per supplier
// would mark a house's whole fabric range discontinued off its wallpaper list.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { importPriceLists } from '../src/seed/price-lists.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'DROPTEST-'
const SUPPLIER = `${PREFIX}Boussac`
const DOMAIN = 'price-drops-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// One import row in the shape the converter emits.
const drop = (code, { category = 'fabric', rate = 50, sourceFile, supplier = SUPPLIER } = {}) => ({
  supplier,
  category,
  code,
  code_normalized: code,
  unit: 'metre',
  currency: 'EUR',
  wholesale_rate: rate,
  source_file: sourceFile,
})

const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM price_list_item_price_history
      WHERE price_list_item_id IN
            (SELECT id FROM price_list_items WHERE supplier LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM price_list_items WHERE supplier LIKE $1', [`${PREFIX}%`])
}

describe('price-list drop detection', () => {
  let pool
  let app
  let backofficeCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const itemsBySupplier = async (supplier = SUPPLIER) => {
    const response = await inject(
      'GET',
      `/admin/price-list-items?supplier=${encodeURIComponent(supplier)}&limit=200`,
      backofficeCookie
    )
    return new Map(response.json().items.map((item) => [item.code, item]))
  }

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
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
  })

  // ---------------------------------------------------------------- US-007

  it('adds the three columns to price_list_items', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'price_list_items'
          AND column_name = ANY($1)`,
      [['last_seen_in_import', 'last_seen_source_file', 'discontinued_at']]
    )
    expect(rows).toHaveLength(3)
    // All nullable: NULL is "no import has ever named this", which is not the
    // same fact as "dropped" and must never be read as one.
    for (const row of rows) {
      expect(row.is_nullable).toBe('YES')
    }
  })

  it('indexes (supplier, category, last_seen_in_import) so `suspect` is cheap', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'price_list_items'`
    )
    expect(
      rows.some(
        (row) =>
          row.indexdef.includes('supplier') &&
          row.indexdef.includes('category') &&
          row.indexdef.includes('last_seen_in_import')
      )
    ).toBe(true)
  })

  // ---------------------------------------------------------------- US-008

  describe('what an import records', () => {
    it('stamps last_seen_in_import and last_seen_source_file on every row it names', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      ])
      const items = await itemsBySupplier()
      expect(items.get('B-1').last_seen_in_import).not.toBeNull()
      expect(items.get('B-1').last_seen_source_file).toBe('BOUSSAC FABRIC PL 2025.csv')
      expect(items.get('B-2').last_seen_source_file).toBe('BOUSSAC FABRIC PL 2025.csv')
    })

    it('keeps rows a later file does not name — the re-runnable invariant is untouched', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      ])
      await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])

      const items = await itemsBySupplier()
      // Keeping B-2 is what preserves the price history this epic just built.
      expect([...items.keys()].sort()).toEqual(['B-1', 'B-2'])
      expect(items.get('B-2').last_seen_source_file).toBe('BOUSSAC FABRIC PL 2025.csv')
    })

    it('flags nothing by itself — an import records, it never decides', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      ])
      await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])

      const items = await itemsBySupplier()
      expect(items.get('B-2').discontinued_at).toBeNull()
      // ...but it IS visible as the derived state, which is the half a partial
      // file would otherwise produce nothing at all from.
      expect(items.get('B-2').suspect).toBe(true)
      expect(items.get('B-1').suspect).toBe(false)
    })

    it('clears discontinued_at for any row the file names again', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      ])
      await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])
      await inject('POST', '/admin/price-list-items/mark-discontinued', backofficeCookie, {
        supplier: SUPPLIER,
        category: 'fabric',
      })
      expect((await itemsBySupplier()).get('B-2').discontinued_at).not.toBeNull()

      // A supplier re-listing a code is the strongest possible statement that
      // it is not discontinued, so the import overrides the staff decision.
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2027.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2027.csv' }),
      ])
      const items = await itemsBySupplier()
      expect(items.get('B-2').discontinued_at).toBeNull()
      expect(items.get('B-2').suspect).toBe(false)
    })
  })

  describe('POST /admin/price-list-items/mark-discontinued', () => {
    it('states coverage before it acts, and marks only what the last file missed', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-3', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      ])
      await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])

      const response = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: SUPPLIER, category: 'fabric' }
      )
      expect(response.statusCode).toBe(200)
      const { result } = response.json()
      expect(result.held).toBe(3)
      // The number that is the whole defence against a partial file.
      expect(result.covered).toBe(1)
      expect(result.marked).toBe(2)
      expect(result.last_source_file).toBe('BOUSSAC FABRIC PL 2026.csv')
      expect(result.message).toContain('covered 1 of the 3')
      expect(result.message).toContain('marked 2 discontinued')

      const items = await itemsBySupplier()
      expect(items.get('B-1').discontinued_at).toBeNull()
      expect(items.get('B-2').discontinued_at).not.toBeNull()
      expect(items.get('B-3').discontinued_at).not.toBeNull()
    })

    // The reason the scope is not per supplier: a house that sends only its
    // wallpaper list in March must not have its fabric range condemned.
    it('never reaches another category of the same supplier', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('W-1', { category: 'wallpaper', sourceFile: 'BOUSSAC WPPR PL 2025.csv' }),
        drop('W-2', { category: 'wallpaper', sourceFile: 'BOUSSAC WPPR PL 2025.csv' }),
      ])
      await importPriceLists(pool, [
        drop('W-1', { category: 'wallpaper', sourceFile: 'BOUSSAC WPPR PL 2026.csv' }),
      ])

      const response = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: SUPPLIER, category: 'wallpaper' }
      )
      expect(response.json().result.marked).toBe(1)

      const items = await itemsBySupplier()
      expect(items.get('B-1').discontinued_at).toBeNull()
      expect(items.get('B-1').suspect).toBe(false)
      expect(items.get('W-2').discontinued_at).not.toBeNull()
    })

    it('never reaches another supplier', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('O-1', { supplier: `${PREFIX}Other`, sourceFile: 'OTHER FABRIC PL 2025.csv' }),
        drop('O-2', { supplier: `${PREFIX}Other`, sourceFile: 'OTHER FABRIC PL 2025.csv' }),
      ])
      await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])

      await inject('POST', '/admin/price-list-items/mark-discontinued', backofficeCookie, {
        supplier: SUPPLIER,
        category: 'fabric',
      })

      const others = await itemsBySupplier(`${PREFIX}Other`)
      expect(others.get('O-1').discontinued_at).toBeNull()
      expect(others.get('O-2').discontinued_at).toBeNull()
      expect(others.get('O-2').suspect).toBe(false)
    })

    it('is idempotent and reports 0 on a second run', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      ])
      await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])

      const first = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: SUPPLIER, category: 'fabric' }
      )
      expect(first.json().result.marked).toBe(1)

      const second = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: SUPPLIER, category: 'fabric' }
      )
      expect(second.json().result.marked).toBe(0)
      // Coverage is still stated: it is a fact about the file, not about what
      // this call happened to change.
      expect(second.json().result.covered).toBe(1)
    })

    it('marks nothing when the latest file covered everything', async () => {
      await importPriceLists(pool, [
        drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' }),
        drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' }),
      ])
      const response = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: SUPPLIER, category: 'fabric' }
      )
      expect(response.json().result).toMatchObject({ held: 2, covered: 2, marked: 0 })
    })

    // Hand-keyed rows have never been imported, so there is nothing to compare
    // against and nothing may be inferred from their absence from a file.
    it('422s when no import has ever covered the (supplier, category)', async () => {
      await pool.query(
        `INSERT INTO price_list_items
           (supplier, category, code, code_normalized, unit, wholesale_rate,
            currency, source_file)
         VALUES ($1, 'fabric', 'H-1', 'H-1', 'metre', 10, 'EUR', 'manual-entry')`,
        [SUPPLIER]
      )
      const response = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: SUPPLIER, category: 'fabric' }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/No import has covered/)
      expect((await itemsBySupplier()).get('H-1').discontinued_at).toBeNull()
    })

    it('422s for a supplier and category holding nothing', async () => {
      const response = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        backofficeCookie,
        { supplier: `${PREFIX}Nobody`, category: 'fabric' }
      )
      expect(response.statusCode).toBe(422)
    })

    it('400s a missing category and an unknown one', async () => {
      expect(
        (
          await inject(
            'POST',
            '/admin/price-list-items/mark-discontinued',
            backofficeCookie,
            { supplier: SUPPLIER }
          )
        ).statusCode
      ).toBe(400)
      expect(
        (
          await inject(
            'POST',
            '/admin/price-list-items/mark-discontinued',
            backofficeCookie,
            { supplier: SUPPLIER, category: 'curtains' }
          )
        ).statusCode
      ).toBe(400)
    })

    it('refuses a non-backoffice caller', async () => {
      const response = await inject(
        'POST',
        '/admin/price-list-items/mark-discontinued',
        undefined,
        { supplier: SUPPLIER, category: 'fabric' }
      )
      expect(response.statusCode).toBe(401)
    })
  })

  // discontinued_at is not archived_at, and conflating them is the mistake this
  // asserts against: one is the supplier's decision, the other is staff taking
  // the row out of their own working list.
  it('leaves a discontinued item fully readable and editable', async () => {
    await importPriceLists(pool, [
      drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
      drop('B-2', { sourceFile: 'BOUSSAC FABRIC PL 2025.csv' }),
    ])
    await importPriceLists(pool, [drop('B-1', { sourceFile: 'BOUSSAC FABRIC PL 2026.csv' })])
    await inject('POST', '/admin/price-list-items/mark-discontinued', backofficeCookie, {
      supplier: SUPPLIER,
      category: 'fabric',
    })

    const items = await itemsBySupplier()
    const dropped = items.get('B-2')
    expect(dropped.discontinued_at).not.toBeNull()
    // Still in the default (unarchived) list, and still archivable separately.
    expect(dropped.archived_at).toBeNull()

    const patched = await inject(
      'PATCH',
      `/admin/price-list-items/${dropped.id}`,
      backofficeCookie,
      { description: 'Still editable' }
    )
    expect(patched.statusCode).toBe(200)
    expect(patched.json().item.discontinued_at).not.toBeNull()
  })
})
