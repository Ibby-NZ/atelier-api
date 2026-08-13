// W18 — self-service price-list import.
//
// The client is taking the import over ("we don't have to come to you"), so the
// CLI's two guarantees have to survive the move to a request: a file either
// lands whole or not at all, and every rate it moves is recorded in the W17
// ledger. The suite below is mostly about the second one and about US-004 — the
// live blocker, where a category the four-value vocabulary has no word for must
// come back with its row number rather than being guessed at or dropped.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { buildWorkbook } from '../scripts/lib/xlsx-write.js'
import { computeWaterfall, pricingInputs, canonical } from '../src/seed/data/pricing.js'
import { nzdMultiplier } from '../src/seed/data/fx.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'W18IMPORT-'
const SUPPLIER = `${PREFIX}Boussac`
const DOMAIN = 'price-list-import-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// The two registered layouts, spelled out as a file rather than imported: the
// header row IS the version, so a test that built it from the registry could not
// fail when the registry drifts from what the client was sent.
const V1_HEADER = [
  'Date Effective', 'Product Range', 'Code', 'Description', 'Item Type',
  'Pack Type', 'Contents', 'Width', 'Repeat', 'Vertical Repeat',
  'Duty Rate', 'Wholesale Rate', 'Currency', 'Freight Rate',
]
const V3_HEADER = [
  'Date Effective', 'Brand', 'Code', 'Description', 'Item Type',
  'Unit', 'Contents', 'Width', 'Horizontal Repeat', 'Vertical Repeat',
  'Pattern Match', 'Duty Rate', 'Wholesale Rate', 'Currency', 'Freight Rate',
  'Supplier', 'Duty Percent',
]

/** One v1 row: only the cells these tests vary are parameters. */
const v1Row = ({ code, itemType = 'Fabrics', rate = '120.50', pack = 'P/M' }) => [
  '01/08/2026', 'Boussac', code, `Design ${code}`, itemType,
  pack, '100% Linen', '140', '', '',
  '', rate, 'Euro', 'A',
]

const v3Row = ({ code, itemType = 'Fabrics', rate = '120.50', supplier = SUPPLIER }) => [
  '01/08/2026', 'Boussac', code, `Design ${code}`, itemType,
  'P/M', '100% Linen', '140', '', '',
  'Straight', '', rate, 'Euro', 'A', supplier, '',
]

const csvFile = (header, rows) =>
  Buffer.from([header, ...rows].map((row) => row.join(',')).join('\r\n') + '\r\n', 'utf8')

const xlsxFile = (header, rows) =>
  buildWorkbook([{ name: 'Sheet1', rows: [header, ...rows] }])

const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM price_list_item_price_history
      WHERE price_list_item_id IN
            (SELECT id FROM price_list_items WHERE supplier LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM price_list_items WHERE supplier LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM price_list_imports WHERE filename LIKE $1', [`${PREFIX}%`])
}

describe('self-service price-list import', () => {
  let pool
  let app
  let financeCookie
  let noFinanceCookie

  const upload = (path, bytes, query, cookie = financeCookie) =>
    app.inject({
      method: 'POST',
      url: `/admin/price-lists/import/${path}?${new URLSearchParams(query)}`,
      headers: { cookie, 'content-type': 'text/csv' },
      payload: bytes,
    })

  const itemsHeld = async () => {
    const { rows } = await pool.query(
      'SELECT code, wholesale_rate, category, source_file FROM price_list_items WHERE supplier LIKE $1 ORDER BY code',
      [`${PREFIX}%`]
    )
    return rows
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

    // Registered once, never per test: register and login share one
    // 10-per-15-min bucket per app instance.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Liz' },
    })
    financeCookie = sessionCookieFrom(boss)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = true WHERE email = $1`,
      [testEmail('boss')]
    )

    const showroom = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('showroom'), password: PASSWORD, name: 'Showroom' },
    })
    noFinanceCookie = sessionCookieFrom(showroom)
    await pool.query(
      `UPDATE users SET role = 'backoffice', can_view_finance = false WHERE email = $1`,
      [testEmail('showroom')]
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
  })

  // ---------------------------------------------------------------- US-001

  it('records who imported which file, when, and how it accounted for itself', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'price_list_imports'
        ORDER BY column_name`
    )
    expect(rows.map((row) => row.column_name)).toEqual([
      'created_at', 'filename', 'id', 'imported_by_user_id', 'rows_duplicate',
      'rows_imported', 'rows_read', 'rows_skipped', 'template_version',
    ])
    // Only the importer is nullable: an account can be deleted and the business
    // record survives it (ON DELETE SET NULL). Everything else is a fact about
    // the file and must be stated.
    const nullable = rows.filter((row) => row.is_nullable === 'YES').map((row) => row.column_name)
    expect(nullable).toEqual(['imported_by_user_id'])
  })

  // ---------------------------------------------------------------- US-002

  it('reports what would change and writes nothing', async () => {
    const file = `${PREFIX}v3 PL 2026.csv`
    await upload('apply', csvFile(V3_HEADER, [v3Row({ code: 'AAA', rate: '100' })]), { filename: file })

    const held = await itemsHeld()
    const dry = await upload(
      'validate',
      csvFile(V3_HEADER, [
        v3Row({ code: 'AAA', rate: '150' }), // a rate that MOVED
        v3Row({ code: 'BBB', rate: '90' }), // brand new
      ]),
      { filename: file }
    )

    expect(dry.statusCode).toBe(200)
    const body = dry.json()
    expect(body.summary).toMatchObject({ rows: 2, imported: 2, created: 1, changed: 1, unchanged: 0 })
    expect(body.changes).toEqual([
      expect.objectContaining({ code: 'AAA', from: 100, to: 150, row: 2 }),
    ])
    // The dry run is a dry run: the ledger is byte-for-byte what it was.
    expect(await itemsHeld()).toEqual(held)
  })

  it('accounts for every line of the file: rows === imported + skipped + duplicates + failed', async () => {
    const response = await upload(
      'validate',
      csvFile(V3_HEADER, [
        v3Row({ code: 'AAA' }),
        v3Row({ code: 'AAA' }), // exact repeat — collapses
        v3Row({ code: 'CCC', rate: '0' }), // price on application — skipped, not an error
        [],
        v3Row({ code: 'DDD' }),
      ]),
      { filename: `${PREFIX}balance PL.csv` }
    )
    const { summary } = response.json()
    // The blank line is not a row anybody typed and is not counted.
    expect(summary.rows).toBe(4)
    expect(summary.imported + summary.skipped + summary.duplicates + summary.failed)
      .toBe(summary.rows)
    expect(summary).toMatchObject({ imported: 2, skipped: 1, duplicates: 1, failed: 0 })
  })

  it('reads an .xlsx as readily as a .csv — the format is sniffed from the bytes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/admin/price-lists/import/validate?filename=${PREFIX}book.xlsx`,
      headers: {
        cookie: financeCookie,
        // Deliberately the WRONG content type for a workbook: the parser only
        // has to let the bytes through, and "PK\x03\x04" is what decides.
        'content-type': 'application/octet-stream',
      },
      // An Excel serial, because a workbook stores a date as a number.
      payload: xlsxFile(V3_HEADER, [
        ['46235', 'Boussac', 'XL1', 'Design XL1', 'Fabrics', 'P/M', '100% Linen', '140',
          '', '', 'Straight', '', '77.25', 'Euro', 'A', SUPPLIER, ''],
      ]),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().summary).toMatchObject({ rows: 1, imported: 1, created: 1 })
  })

  it('refuses a header no registered template declares, naming the accepted ones', async () => {
    const response = await upload(
      'validate',
      csvFile(['Code', 'Price'], [['A', '1']]),
      { filename: `${PREFIX}wrong.csv` }
    )
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/Unexpected header row on line 1/)
    expect(response.json().message).toMatch(/v1 .*v3/s)
  })

  it('refuses a v1 file with no supplier stated, because v1 has no Supplier column', async () => {
    const response = await upload(
      'validate',
      csvFile(V1_HEADER, [v1Row({ code: 'AAA' })]),
      { filename: `${PREFIX}v1 PL.csv` }
    )
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toMatch(/no Supplier column/)
  })

  // ---------------------------------------------------------------- US-003

  it('applies in one transaction, logs the import, and records the rate move in the W17 ledger', async () => {
    const file = `${PREFIX}Boussac FABRIC PL 2026.csv`
    const first = await upload('apply', csvFile(V3_HEADER, [
      v3Row({ code: 'AAA', rate: '100' }),
      v3Row({ code: 'BBB', rate: '200' }),
    ]), { filename: file })
    expect(first.statusCode).toBe(200)
    expect(first.json().applied).toBe(2)
    expect(first.json().import).toMatchObject({
      filename: file,
      template_version: 'v3',
      rows_read: 2,
      rows_imported: 2,
      rows_skipped: 0,
      rows_duplicate: 0,
    })

    // A new row has no old price, so nothing is captured on the first landing —
    // the trigger only ever records an UPDATE.
    const { rows: none } = await pool.query(
      `SELECT * FROM price_list_item_price_history h
         JOIN price_list_items p ON p.id = h.price_list_item_id
        WHERE p.supplier LIKE $1`,
      [`${PREFIX}%`]
    )
    expect(none).toHaveLength(0)

    const second = await upload('apply', csvFile(V3_HEADER, [
      v3Row({ code: 'AAA', rate: '135.75' }),
      v3Row({ code: 'BBB', rate: '200' }),
    ]), { filename: file })
    expect(second.statusCode).toBe(200)
    expect(second.json().summary).toMatchObject({ changed: 1, unchanged: 1, created: 0 })

    const { rows: history } = await pool.query(
      `SELECT h.old_rate, h.new_rate, h.source, h.source_file, h.reason,
              h.changed_by_user_id, u.email
         FROM price_list_item_price_history h
         JOIN price_list_items p ON p.id = h.price_list_item_id
         LEFT JOIN users u ON u.id = h.changed_by_user_id
        WHERE p.supplier LIKE $1`,
      [`${PREFIX}%`]
    )
    expect(history).toHaveLength(1)
    expect(Number(history[0].old_rate)).toBe(100)
    expect(Number(history[0].new_rate)).toBe(135.75)
    // `source = 'import'` and a reason the TRIGGER generated per row out of that
    // row's own provenance — not a sentence this route made up.
    expect(history[0].source).toBe('import')
    expect(history[0].source_file).toBe(file)
    expect(history[0].reason).toBe(`${file} said so (effective 2026-08-01)`)
    // What the CLI cannot supply and this path can: who did it.
    expect(history[0].email).toBe(testEmail('boss'))
  })

  it('is idempotent: re-applying the same file moves no rate and writes no history', async () => {
    const file = `${PREFIX}same PL.csv`
    const bytes = csvFile(V3_HEADER, [v3Row({ code: 'AAA', rate: '100' })])
    await upload('apply', bytes, { filename: file })
    const again = await upload('apply', bytes, { filename: file })

    expect(again.json().summary).toMatchObject({ created: 0, changed: 0, unchanged: 1 })
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM price_list_item_price_history h
         JOIN price_list_items p ON p.id = h.price_list_item_id
        WHERE p.supplier LIKE $1`,
      [`${PREFIX}%`]
    )
    expect(rows[0].n).toBe(0)
    // A second import genuinely happened, so it is a second row in the log.
    const { rows: imports } = await pool.query(
      'SELECT count(*)::int AS n FROM price_list_imports WHERE filename = $1',
      [file]
    )
    expect(imports[0].n).toBe(2)
  })

  it('refuses a file with any row error WHOLE, and logs no import', async () => {
    const file = `${PREFIX}broken PL.csv`
    const response = await upload('apply', csvFile(V3_HEADER, [
      v3Row({ code: 'AAA', rate: '100' }),
      v3Row({ code: 'BBB', rate: 'not a number' }),
    ]), { filename: file })

    expect(response.statusCode).toBe(422)
    expect(response.json().message).toMatch(/1 row of "?.*broken PL\.csv"? could not be read/)
    // file:line, the converter's own coordinate.
    expect(response.json().errors[0]).toMatchObject({ row: 3 })
    expect(response.json().errors[0].message).toContain(`${file}:3:`)

    // Neither the good row nor the log row landed.
    expect(await itemsHeld()).toHaveLength(0)
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM price_list_imports WHERE filename = $1',
      [file]
    )
    expect(rows[0].n).toBe(0)
  })

  it('refuses two different rates for one code, naming both rows', async () => {
    const response = await upload('validate', csvFile(V3_HEADER, [
      v3Row({ code: 'AAA', rate: '100' }),
      v3Row({ code: 'AAA', rate: '200' }),
    ]), { filename: `${PREFIX}clash PL.csv` })

    expect(response.statusCode).toBe(422)
    expect(response.json().errors[0].message).toMatch(/stated differently here and on row 2/)
  })

  // ---------------------------------------------------------------- US-004

  it('reports an unmappable category per row, with the value and the row number', async () => {
    const file = `${PREFIX}leather PL.csv`
    const response = await upload('validate', csvFile(V3_HEADER, [
      v3Row({ code: 'AAA' }),
      v3Row({ code: 'LEA', itemType: 'Leather' }),
      v3Row({ code: 'SAM', itemType: 'Samples and Displays' }),
      v3Row({ code: 'THR', itemType: 'Throws/Blankets' }),
    ]), { filename: file })

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.unmappable_category_count).toBe(3)
    expect(body.unmappable_categories).toEqual([
      { row: 3, value: 'Leather' },
      { row: 4, value: 'Samples and Displays' },
      { row: 5, value: 'Throws/Blankets' },
    ])
    // Never dropped: each one is a row error too, so the file cannot be applied.
    expect(body.error_count).toBe(3)
    expect(body.errors[0].message).toContain(`${file}:3:`)
    expect(body.errors[0].message).toMatch(/fabric, wallpaper, trimming, accessory/)
  })

  it('never absorbs a stated-but-unknown category into the fallback', async () => {
    // The trap this check exists for: mapV1 resolves
    // `CATEGORY_BY_ITEM_TYPE.get(cell) ?? fileCategory`, so with a fallback
    // stated a "Leather" row would import silently AS a fabric.
    const response = await upload('validate', csvFile(V3_HEADER, [
      v3Row({ code: 'LEA', itemType: 'Leather' }),
    ]), { filename: `${PREFIX}absorb PL.csv`, category: 'fabric' })

    expect(response.statusCode).toBe(422)
    expect(response.json().unmappable_categories).toEqual([{ row: 2, value: 'Leather' }])
  })

  it('does use the fallback for a BLANK category cell — a file that did not say', async () => {
    const response = await upload('apply', csvFile(V3_HEADER, [
      v3Row({ code: 'BLK', itemType: '' }),
    ]), { filename: `${PREFIX}blank PL.csv`, category: 'wallpaper' })

    expect(response.statusCode).toBe(200)
    expect((await itemsHeld())[0].category).toBe('wallpaper')
  })

  // ------------------------------------------------------------ access

  it('needs finance access, not merely backoffice — a rate is cost data', async () => {
    for (const path of ['validate', 'apply']) {
      const response = await upload(
        path,
        csvFile(V3_HEADER, [v3Row({ code: 'AAA' })]),
        { filename: `${PREFIX}gated PL.csv` },
        noFinanceCookie
      )
      expect(response.statusCode).toBe(403)
    }
    const list = await app.inject({
      method: 'GET',
      url: '/admin/price-lists/imports',
      headers: { cookie: noFinanceCookie },
    })
    expect(list.statusCode).toBe(403)
  })

  it('lists applied imports newest first, with the name of whoever ran them', async () => {
    await upload('apply', csvFile(V3_HEADER, [v3Row({ code: 'AAA' })]), {
      filename: `${PREFIX}first PL.csv`,
    })
    await upload('apply', csvFile(V3_HEADER, [v3Row({ code: 'BBB' })]), {
      filename: `${PREFIX}second PL.csv`,
    })

    const response = await app.inject({
      method: 'GET',
      url: '/admin/price-lists/imports',
      headers: { cookie: financeCookie },
    })
    expect(response.statusCode).toBe(200)
    const mine = response.json().imports.filter((row) => row.filename.startsWith(PREFIX))
    expect(mine.map((row) => row.filename)).toEqual([
      `${PREFIX}second PL.csv`,
      `${PREFIX}first PL.csv`,
    ])
    expect(mine[0].imported_by_name).toBe('Liz')
  })
})

// ---------------------------------------------------------------- US-005/006
//
// Pure — no database. The waterfall preview is arithmetic and its step ORDER is
// the whole of what these two stories change.

describe('the pricing waterfall preview', () => {
  it('states no duty: the 7% placeholder is deleted, not corrected to 5%', () => {
    // Deleted rather than set to 0.05 because the real table is per RANGE — a
    // flat 5% on duty class A with per-range exceptions — so a single constant
    // is the wrong shape whatever number is in it.
    expect(pricingInputs.duty).toBeUndefined()
    expect(Object.hasOwn(pricingInputs, 'duty')).toBe(false)
  })

  it('strikes duty BEFORE freight and clearance OVER both', () => {
    // (price incl duty + freight$) × (1 + clearance%) — the incumbent's engine,
    // which reproduces 19,197 of 19,201 usable corpus rows.
    const result = computeWaterfall({
      wholesaleForeign: 100,
      currency: 'EUR',
      forexMargin: 0,
      discountChain: [],
      freightMode: 'dollar',
      freightDollar: 10,
      clearance: 0.02,
      duty: 0.05,
      handling: 0,
      retailMarkup: null,
      tradeMarkup: 0,
      tradeMarkupMode: 'percent',
      tiers: [{ name: 'Tier 1', pct: 0 }, { name: 'Tier 2', pct: 0 }],
    })
    // The UNROUNDED wholesale: every reported figure is round2'd, so deriving
    // the expectation from `result.wholesale` would compare against a number
    // the implementation never used.
    const wholesale = 100 * nzdMultiplier('EUR', { withMargin: false })
    expect(result.priceInclDuty).toBeCloseTo(wholesale * 1.05, 2)
    expect(result.cogs).toBeCloseTo((wholesale * 1.05 + 10) * 1.02, 2)

    // The order the previous implementation used, kept here as the thing that
    // must NOT come back: clearance and freight first, duty struck last.
    const wrong = (wholesale * 1.02 + 10) * 1.05
    expect(result.cogs).not.toBeCloseTo(wrong, 2)
  })

  it('renamed priceExDuty to priceInclDuty, because the value changed sides', () => {
    expect(canonical.priceInclDuty).toBeDefined()
    expect(canonical.priceExDuty).toBeUndefined()
    // With no duty stated the step is a pass-through, which is the honest
    // preview until the broker's table arrives.
    expect(canonical.priceInclDuty).toBeCloseTo(canonical.supplierDiscounted, 2)
  })
})
