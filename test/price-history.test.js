// W17 — price history. The office goes back to a superseded price 50 to 100
// times a year and today keeps old prices reachable by encoding the year in the
// item code; this suite is what has to hold before that practice can be dropped.
//
// Five things are proved here, and the middle one is the whole reason a trigger
// was chosen over application code:
//   1. the two tables exist with the FK, the CHECK and the index they were
//      specified with (US-001);
//   2. capture happens for EVERY writer — asserted with a BARE SQL UPDATE on a
//      raw pool connection, no application code anywhere in the path (US-003);
//   3. a manual edit without a reason is refused, at the module AND at the
//      database (US-004);
//   4. the importer's rows say which drop they came in on (US-005);
//   5. the as-at lookup answers "what were we paying on <date>" (US-006).
//
// Plus the invariants: append-only (a source scan), and RESTRICT rather than
// CASCADE so a delete cannot destroy the audit.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { deleteOrExplain } from '../src/lifecycle/delete.js'
import { importPriceLists } from '../src/seed/price-lists.js'
import { getRateAsAt, withChangeContext } from '../src/pricing/price-history.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'PHTEST-'
const DOMAIN = 'price-history-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const HISTORY_TABLES = ['price_list_item_price_history', 'product_price_history']

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const insertItem = async (pool, overrides = {}) => {
  const row = {
    supplier: `${PREFIX}Alpha`,
    category: 'fabric',
    code: 'PHT-001',
    code_normalized: 'PHT-001',
    unit: 'metre',
    wholesale_rate: 65,
    currency: 'EUR',
    date_effective: '2023-01-15',
    source_file: 'PHTEST 2023.csv',
    ...overrides,
  }
  const { rows } = await pool.query(
    `INSERT INTO price_list_items
       (supplier, category, code, code_normalized, unit, wholesale_rate,
        currency, date_effective, source_file)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      row.supplier,
      row.category,
      row.code,
      row.code_normalized,
      row.unit,
      row.wholesale_rate,
      row.currency,
      row.date_effective,
      row.source_file,
    ]
  )
  return rows[0].id
}

// History first — the FK is RESTRICT on purpose, so the cleanup would otherwise
// 23503 on its own fixtures.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM price_list_item_price_history
      WHERE price_list_item_id IN
            (SELECT id FROM price_list_items WHERE supplier LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM price_list_items WHERE supplier LIKE $1', [`${PREFIX}%`])
  await pool.query(
    `DELETE FROM product_price_history
      WHERE product_id IN (SELECT id FROM products WHERE slug LIKE $1)`,
    [`${PREFIX.toLowerCase()}%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX.toLowerCase()}%`])
}

// Every .js under src/, so a future module cannot start editing the audit.
const sourceFiles = async (dir, found = []) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'data') continue // vendored snapshots, not house code
      await sourceFiles(full, found)
    } else if (entry.name.endsWith('.js')) {
      found.push(full)
    }
  }
  return found
}

describe('price history', () => {
  let pool
  let app
  let backofficeCookie
  let financeCookie
  let itemId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

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

    // Registered ONCE: register shares a 10/15min/IP bucket.
    const plain = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(plain)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = false WHERE email = $1`,
      [testEmail('boss')]
    )

    const money = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('finance'), password: PASSWORD, name: 'Finance' },
    })
    financeCookie = sessionCookieFrom(money)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = true WHERE email = $1`,
      [testEmail('finance')]
    )
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    itemId = await insertItem(pool)
  })

  // ---------------------------------------------------------------- US-001

  describe('schema', () => {
    it('creates both history tables', async () => {
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [HISTORY_TABLES]
      )
      expect(rows.map((row) => row.table_name).sort()).toEqual([...HISTORY_TABLES].sort())
    })

    // The whole argument for two tables rather than one polymorphic one: a
    // polymorphic key cannot BE a foreign key.
    it('holds a real foreign key on each, and it is RESTRICT not CASCADE', async () => {
      const { rows } = await pool.query(
        `SELECT c.conname, c.confdeltype
           FROM pg_constraint c
          WHERE c.contype = 'f'
            AND c.conname IN ('price_list_item_price_history_price_list_item_id_fkey',
                              'product_price_history_product_id_fkey')`
      )
      expect(rows).toHaveLength(2)
      // 'r' = RESTRICT. 'c' (cascade) would let a delete destroy exactly the
      // history this feature exists to preserve, silently.
      for (const row of rows) {
        expect(row.confdeltype).toBe('r')
      }
    })

    it('has no archived_at on either table — an audit is not soft-deletable', async () => {
      const { rows } = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ANY($1)
            AND column_name = 'archived_at'`,
        [HISTORY_TABLES]
      )
      expect(rows).toEqual([])
    })

    it('indexes (price_list_item_id, changed_at DESC) so the as-at lookup is one scan', async () => {
      const { rows } = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'price_list_item_price_history'`
      )
      expect(
        rows.some(
          (row) =>
            row.indexdef.includes('price_list_item_id') &&
            row.indexdef.includes('changed_at DESC')
        )
      ).toBe(true)
    })

    it('refuses a manual row with no reason, and accepts an import row without one', async () => {
      // Written straight at the table, which is the point: the CHECK holds for
      // psql and the AdminJS panel, not only for the API.
      await expect(
        pool.query(
          `INSERT INTO price_list_item_price_history
             (price_list_item_id, old_rate, new_rate, currency, source, source_file)
           VALUES ($1, 1, 2, 'EUR', 'manual', 'x.csv')`,
          [itemId]
        )
      ).rejects.toMatchObject({ code: '23514' })

      // Whitespace is not a reason either.
      await expect(
        pool.query(
          `INSERT INTO price_list_item_price_history
             (price_list_item_id, old_rate, new_rate, currency, source, source_file, reason)
           VALUES ($1, 1, 2, 'EUR', 'manual', 'x.csv', '   ')`,
          [itemId]
        )
      ).rejects.toMatchObject({ code: '23514' })

      const ok = await pool.query(
        `INSERT INTO price_list_item_price_history
           (price_list_item_id, old_rate, new_rate, currency, source, source_file)
         VALUES ($1, 1, 2, 'EUR', 'import', 'x.csv') RETURNING id`,
        [itemId]
      )
      expect(ok.rows).toHaveLength(1)
    })

    it('refuses an unknown source, so a typo cannot bypass the reason rule', async () => {
      await expect(
        pool.query(
          `INSERT INTO price_list_item_price_history
             (price_list_item_id, old_rate, new_rate, currency, source, source_file)
           VALUES ($1, 1, 2, 'EUR', 'Manual', 'x.csv')`,
          [itemId]
        )
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  // ------------------------------------------------------- US-002 + US-003

  describe('capture is a trigger, so it catches every writer', () => {
    // THE assertion. No route, no domain module, no ORM — a raw connection out
    // of the pool issuing SQL, exactly as a psql session or the AdminJS panel
    // would. If this passes, "every writer is covered" is a fact rather than a
    // hope; nothing else in the suite can establish it.
    it('records a bare SQL UPDATE on a raw connection', async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `SELECT set_config('atelier.change_source', 'manual', true),
                  set_config('atelier.change_reason', 'Typed straight into psql', true)`
        )
        await client.query(
          `UPDATE price_list_items SET wholesale_rate = 99.25 WHERE id = $1`,
          [itemId]
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      const { rows } = await pool.query(
        `SELECT old_rate, new_rate, source, reason, source_file, date_effective
           FROM price_list_item_price_history WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].old_rate)).toBe(65)
      expect(Number(rows[0].new_rate)).toBe(99.25)
      expect(rows[0].source).toBe('manual')
      expect(rows[0].reason).toBe('Typed straight into psql')
      // Copied off the row, not off a setting: one import batch carries 74
      // different drops and the reason has to name the right file.
      expect(rows[0].source_file).toBe('PHTEST 2023.csv')
    })

    it('refuses a rate change that declares no source, and writes nothing', async () => {
      await expect(
        pool.query(`UPDATE price_list_items SET wholesale_rate = 12 WHERE id = $1`, [itemId])
      ).rejects.toMatchObject({ code: 'AT001' })

      const { rows } = await pool.query(
        `SELECT wholesale_rate FROM price_list_items WHERE id = $1`,
        [itemId]
      )
      expect(Number(rows[0].wholesale_rate)).toBe(65)
    })

    it('does not fire when the rate does not move', async () => {
      // An import re-landing 19,500 unchanged rows must cost nothing and must
      // declare nothing.
      await pool.query(
        `UPDATE price_list_items SET description = 'renamed' WHERE id = $1`,
        [itemId]
      )
      await pool.query(
        `UPDATE price_list_items SET wholesale_rate = 65 WHERE id = $1`,
        [itemId]
      )
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM price_list_item_price_history
          WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows[0].n).toBe(0)
    })

    it('does not fire on INSERT — a new row has no old price', async () => {
      const fresh = await insertItem(pool, { code: 'PHT-INS', code_normalized: 'PHT-INS' })
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM price_list_item_price_history
          WHERE price_list_item_id = $1`,
        [fresh]
      )
      expect(rows[0].n).toBe(0)
    })

    it('records the actor, and the declaration dies with the transaction', async () => {
      const { rows: staff } = await pool.query(`SELECT id FROM users WHERE email = $1`, [
        testEmail('boss'),
      ])
      await withChangeContext(
        pool,
        { source: 'manual', reason: 'Exchange rate', userId: staff[0].id },
        (client) =>
          client.query(`UPDATE price_list_items SET wholesale_rate = 70 WHERE id = $1`, [
            itemId,
          ])
      )
      const { rows } = await pool.query(
        `SELECT changed_by_user_id FROM price_list_item_price_history
          WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows[0].changed_by_user_id).toBe(staff[0].id)

      // The next write on a pooled connection must NOT inherit "manual /
      // Exchange rate" — that is what is_local = true buys, and a session-level
      // setting would silently mislabel it.
      await expect(
        pool.query(`UPDATE price_list_items SET wholesale_rate = 71 WHERE id = $1`, [itemId])
      ).rejects.toMatchObject({ code: 'AT001' })
    })

    it('captures a product price change with both prices on the row', async () => {
      const { rows: brand } = await pool.query(
        `INSERT INTO brands (name, slug, currency, trade_only)
         VALUES ($1, $2, 'NZD', false) RETURNING id`,
        [`${PREFIX}House`, `${PREFIX.toLowerCase()}house`]
      )
      const { rows: product } = await pool.query(
        `INSERT INTO products (brand_id, name, slug, product_type, currency,
                               retail_price_cents, trade_price_cents)
         VALUES ($1, 'Velvet', $2, 'fabric', 'NZD', 10000, 6000) RETURNING id`,
        [brand[0].id, `${PREFIX.toLowerCase()}velvet`]
      )
      await withChangeContext(
        pool,
        { source: 'manual', reason: 'Supplier increase' },
        (client) =>
          client.query(`UPDATE products SET retail_price_cents = 12000 WHERE id = $1`, [
            product[0].id,
          ])
      )
      const { rows } = await pool.query(
        `SELECT * FROM product_price_history WHERE product_id = $1`,
        [product[0].id]
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].old_retail_price_cents).toBe(10000)
      expect(rows[0].new_retail_price_cents).toBe(12000)
      // The pair travels together: a row showing one number in isolation cannot
      // say whether the other moved with it.
      expect(rows[0].old_trade_price_cents).toBe(6000)
      expect(rows[0].new_trade_price_cents).toBe(6000)
    })
  })

  // ---------------------------------------------------------------- US-004

  describe('a manual edit demands a reason', () => {
    it('refuses a rate change with no reason (422) and changes nothing', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${itemId}`,
        backofficeCookie,
        { wholesale_rate: 80 }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/reason/i)

      const { rows } = await pool.query(
        `SELECT wholesale_rate FROM price_list_items WHERE id = $1`,
        [itemId]
      )
      expect(Number(rows[0].wholesale_rate)).toBe(65)
    })

    it('refuses a whitespace-only reason', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${itemId}`,
        backofficeCookie,
        { wholesale_rate: 80, reason: '   ' }
      )
      expect(response.statusCode).toBe(422)
    })

    it('accepts the change with a reason and records it as manual', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${itemId}`,
        backofficeCookie,
        { wholesale_rate: 80, reason: 'Exchange rate' }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().item.wholesale_rate).toBe(80)

      const { rows } = await pool.query(
        `SELECT source, reason, changed_by_user_id
           FROM price_list_item_price_history WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].source).toBe('manual')
      expect(rows[0].reason).toBe('Exchange rate')
      expect(rows[0].changed_by_user_id).not.toBeNull()
    })

    // The rule has to be about a CHANGE, not about the presence of a key: the
    // CRM posts the whole form back and restating today's rate is not an edit.
    it('needs no reason when the patch restates the same rate', async () => {
      const response = await inject(
        'PATCH',
        `/admin/price-list-items/${itemId}`,
        backofficeCookie,
        { wholesale_rate: 65, description: 'Same money, new description' }
      )
      expect(response.statusCode).toBe(200)
    })

    it('applies to a product price too', async () => {
      const brand = await inject('POST', '/admin/brands', backofficeCookie, {
        name: `${PREFIX}House`,
        currency: 'NZD',
      })
      const brandId = brand.json().brand.id
      const created = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brandId,
        name: 'Velvet',
        product_type: 'fabric',
        currency: 'NZD',
        retail_price_cents: 10000,
      })
      const productId = created.json().product.id

      const refused = await inject('PATCH', `/admin/products/${productId}`, backofficeCookie, {
        retail_price_cents: 11000,
      })
      expect(refused.statusCode).toBe(422)

      const allowed = await inject('PATCH', `/admin/products/${productId}`, backofficeCookie, {
        retail_price_cents: 11000,
        reason: 'Supplier increase',
      })
      expect(allowed.statusCode).toBe(200)

      // A non-price edit still needs nothing.
      const spec = await inject('PATCH', `/admin/products/${productId}`, backofficeCookie, {
        lead_time: '6 weeks',
      })
      expect(spec.statusCode).toBe(200)

      const history = await inject(
        'GET',
        `/admin/products/${productId}/price-history`,
        backofficeCookie
      )
      expect(history.statusCode).toBe(200)
      expect(history.json().changes).toHaveLength(1)
      expect(history.json().changes[0].reason).toBe('Supplier increase')
    })
  })

  // ---------------------------------------------------------------- US-005

  describe('the importer declares itself', () => {
    it('records source = import with the drop that carried the new rate', async () => {
      const item = {
        supplier: `${PREFIX}Alpha`,
        category: 'fabric',
        code: 'PHT-001',
        code_normalized: 'PHT-001',
        unit: 'metre',
        currency: 'EUR',
        wholesale_rate: 71.5,
        date_effective: '2026-08-12',
        source_file: 'COLEFAX FABRIC PL 2026.csv',
      }
      const summary = await importPriceLists(pool, [item])
      expect(summary.items).toBe(1)

      const { rows } = await pool.query(
        `SELECT old_rate, new_rate, source, source_file, reason, date_effective
           FROM price_list_item_price_history WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].old_rate)).toBe(65)
      expect(Number(rows[0].new_rate)).toBe(71.5)
      expect(rows[0].source).toBe('import')
      expect(rows[0].source_file).toBe('COLEFAX FABRIC PL 2026.csv')
      // The generated note. "The 12 August Colefax file said so" is a better
      // answer than a sentence typed 19,500 times, and the two axes are both in
      // it: the file, and the date the supplier printed on it.
      expect(rows[0].reason).toBe('COLEFAX FABRIC PL 2026.csv said so (effective 2026-08-12)')
    })

    it('writes nothing for a re-import at the same rate', async () => {
      const item = {
        supplier: `${PREFIX}Alpha`,
        category: 'fabric',
        code: 'PHT-001',
        code_normalized: 'PHT-001',
        unit: 'metre',
        currency: 'EUR',
        wholesale_rate: 65,
        source_file: 'PHTEST 2023.csv',
      }
      await importPriceLists(pool, [item])
      await importPriceLists(pool, [item])
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM price_list_item_price_history
          WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows[0].n).toBe(0)
    })
  })

  // ---------------------------------------------------------------- US-006

  describe('the as-at lookup', () => {
    // Three recorded changes at known instants, so "what were we paying on X"
    // has a checkable answer at every point on the line.
    const recordAt = async (id, { rate, at, sourceFile, dateEffective }) => {
      await withChangeContext(pool, { source: 'import' }, async (client) => {
        await client.query(
          `UPDATE price_list_items
              SET wholesale_rate = $2, source_file = $3, date_effective = $4
            WHERE id = $1`,
          [id, rate, sourceFile, dateEffective]
        )
      })
      await pool.query(
        `UPDATE price_list_item_price_history SET changed_at = $2
          WHERE price_list_item_id = $1 AND changed_at > now() - interval '1 minute'`,
        [id, at]
      )
    }

    beforeEach(async () => {
      await recordAt(itemId, {
        rate: 70,
        at: '2023-03-03T10:00:00Z',
        sourceFile: 'PHTEST 2023.csv',
        dateEffective: '2023-01-15',
      })
      await recordAt(itemId, {
        rate: 82,
        at: '2024-06-01T10:00:00Z',
        sourceFile: 'PHTEST 2024.csv',
        dateEffective: '2024-05-01',
      })
      await recordAt(itemId, {
        rate: 95,
        at: '2026-08-12T10:00:00Z',
        sourceFile: 'PHTEST 2026.csv',
        dateEffective: '2026-08-01',
      })
    })

    it('answers with the rate in force on that date', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items/${itemId}/rate?as_at=2023-06-01`,
        financeCookie
      )
      expect(response.statusCode).toBe(200)
      const { rate } = response.json()
      expect(rate.wholesale_rate).toBe(70)
      expect(rate.currency).toBe('EUR')
      // Both axes, side by side: the ledger moved on 3 March 2023, off a list
      // the supplier dated 15 January.
      expect(rate.date_effective).toBe('2023-01-15')
      expect(rate.changed_at).toMatch(/^2023-03-03/)
      expect(rate.source).toBe('import')
      expect(rate.source_file).toBe('PHTEST 2023.csv')
    })

    it('is inclusive of the whole named day', async () => {
      // The change landed at 10:00 on 3 March. `<= as_at::date` would cut at
      // that morning's midnight and answer with the rate the day STARTED on —
      // the same trap buildReportFilters' `to` bound exists to avoid.
      const same = await inject(
        'GET',
        `/admin/price-list-items/${itemId}/rate?as_at=2023-03-03`,
        financeCookie
      )
      expect(same.json().rate.wholesale_rate).toBe(70)

      const before = await inject(
        'GET',
        `/admin/price-list-items/${itemId}/rate?as_at=2023-03-02`,
        financeCookie
      )
      expect(before.statusCode).toBe(404)
    })

    it('picks the newest change at or before the date, never a later one', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items/${itemId}/rate?as_at=2025-12-31`,
        financeCookie
      )
      expect(response.json().rate.wholesale_rate).toBe(82)
    })

    it('404s before the first recorded change, naming the reason', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items/${itemId}/rate?as_at=2020-01-01`,
        financeCookie
      )
      expect(response.statusCode).toBe(404)
      // "No result" and "nothing recorded yet" read identically otherwise, and
      // only the second is something a person can act on.
      expect(response.json().message).toMatch(/earliest recorded change is 2023-03-03/)
    })

    it('404s for an item whose rate has never moved, and says so', async () => {
      const untouched = await insertItem(pool, {
        code: 'PHT-STILL',
        code_normalized: 'PHT-STILL',
      })
      await expect(getRateAsAt(pool, untouched, '2026-01-01')).rejects.toMatchObject({
        statusCode: 404,
      })
      await expect(getRateAsAt(pool, untouched, '2026-01-01')).rejects.toThrow(/never changed/)
    })

    it('404s for an unknown item', async () => {
      const response = await inject(
        'GET',
        '/admin/price-list-items/99999999/rate?as_at=2026-01-01',
        financeCookie
      )
      expect(response.statusCode).toBe(404)
    })

    it('400s a malformed as_at and 400s a missing one', async () => {
      expect(
        (
          await inject(
            'GET',
            `/admin/price-list-items/${itemId}/rate?as_at=June 2023`,
            financeCookie
          )
        ).statusCode
      ).toBe(400)
      expect(
        (await inject('GET', `/admin/price-list-items/${itemId}/rate`, financeCookie))
          .statusCode
      ).toBe(400)
    })

    it('lists every recorded change newest first', async () => {
      const response = await inject(
        'GET',
        `/admin/price-list-items/${itemId}/price-history`,
        financeCookie
      )
      expect(response.statusCode).toBe(200)
      const { changes } = response.json()
      expect(changes.map((change) => change.new_rate)).toEqual([95, 82, 70])
      expect(changes[0].old_rate).toBe(82)
    })

    // A wholesale rate is Atelier's buy side; a run of them is the margin.
    it('refuses a backoffice login with no finance access', async () => {
      expect(
        (
          await inject(
            'GET',
            `/admin/price-list-items/${itemId}/rate?as_at=2023-06-01`,
            backofficeCookie
          )
        ).statusCode
      ).toBe(403)
      expect(
        (
          await inject(
            'GET',
            `/admin/price-list-items/${itemId}/price-history`,
            backofficeCookie
          )
        ).statusCode
      ).toBe(403)
    })

    it('refuses an anonymous caller', async () => {
      expect(
        (await inject('GET', `/admin/price-list-items/${itemId}/rate?as_at=2023-06-01`))
          .statusCode
      ).toBe(401)
    })
  })

  // -------------------------------------------------------------- invariants

  describe('append-only', () => {
    // The audit must not be editable, or it is not an audit: a mis-typed reason
    // is corrected by a NEW row. Same posture as test/suppliers-terms.test.js's
    // ownership scan — a structural assertion, because a behavioural one can
    // only catch the paths somebody thought of.
    it('is never UPDATEd or DELETEd anywhere under src/', async () => {
      const files = await sourceFiles('src')
      const offences = []
      for (const file of files) {
        const source = await readFile(file, 'utf8')
        for (const table of HISTORY_TABLES) {
          const patterns = [
            new RegExp(`UPDATE\\s+${table}\\b`, 'i'),
            new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, 'i'),
          ]
          if (patterns.some((pattern) => pattern.test(source))) {
            offences.push(`${file.split(path.sep).join('/')}: ${table}`)
          }
        }
      }
      expect(offences).toEqual([])
      // A regex that silently matched nothing would pass vacuously, so prove
      // the scan actually reads the files that DO name the tables.
      const mentions = []
      for (const file of files) {
        const source = await readFile(file, 'utf8')
        if (HISTORY_TABLES.some((table) => source.includes(table))) mentions.push(file)
      }
      expect(mentions.length).toBeGreaterThan(0)
    })

    it('has no lifecycle registry entry', async () => {
      const { LIFECYCLE_ENTITY_NAMES } = await import('../src/lifecycle/registry.js')
      for (const table of HISTORY_TABLES) {
        expect(LIFECYCLE_ENTITY_NAMES).not.toContain(table)
      }
    })
  })

  describe('RESTRICT protects the audit', () => {
    it('refuses to delete a price-list item whose rate has moved', async () => {
      await inject('PATCH', `/admin/price-list-items/${itemId}`, backofficeCookie, {
        wholesale_rate: 80,
        reason: 'Exchange rate',
      })

      const result = await deleteOrExplain(pool, 'price_list_item', itemId)
      expect(result.deleted).toBe(false)
      expect(result.status).toBe(409)
      expect(result.archivable).toBe(true)
      expect(result.blockers).toEqual([
        {
          relation: 'price_list_item_price_history',
          label: 'recorded rate changes',
          count: 1,
          capped: false,
        },
      ])

      // The point of RESTRICT: with CASCADE this delete would have returned 200
      // and destroyed the record, and the next import would re-create the row
      // looking new.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM price_list_item_price_history
          WHERE price_list_item_id = $1`,
        [itemId]
      )
      expect(rows[0].n).toBe(1)
    })

    it('still deletes an item whose rate has never moved', async () => {
      const result = await deleteOrExplain(pool, 'price_list_item', itemId)
      expect(result.deleted).toBe(true)
    })
  })
})
