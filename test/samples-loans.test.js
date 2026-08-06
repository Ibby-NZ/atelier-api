import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { rethrowConflict } from '../src/catalogue/admin-brands.js'
import { LEGACY_TABLES } from '../src/seed/legacy-import.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other
// suite here.
const PREFIX = 'w4-loans-test'

// Written by the staging migration and never imported, so it is absent from the
// import column map — declared rather than tolerated, because the point of the
// comparison is that a NEW column fails it.
const STAGED_BUT_NOT_IMPORTED = Object.freeze({
  legacy_sales_orders: ['owning_business_unit'],
})

const IMPORT_STAMP = 'imported_at'

// The columns the order state machine's reservation arithmetic owns. A loan is
// a movement of a physical object, never a quantity.
const STOCK_QUANTITY_COLUMNS = /qty_available|qty_reserved/

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertSample = (pool, barcode) =>
  pool
    .query(`INSERT INTO samples (barcode) VALUES ($1) RETURNING id`, [barcode])
    .then(({ rows }) => rows[0].id)

const insertTradeAccount = (pool, { guid, name }) =>
  pool
    .query(
      `INSERT INTO trade_accounts (legacy_account_guid, legacy_customer_name)
       VALUES ($1, $2) RETURNING id`,
      [guid, name]
    )
    .then(({ rows }) => rows[0].id)

/** Open a loan. `db` is a pool or an open client, so a test can drive two. */
const openLoan = (db, sampleId, holderName, extra = {}) =>
  db
    .query(
      `INSERT INTO sample_loans (sample_id, holder_name, trade_account_id, due_back_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [sampleId, holderName, extra.tradeAccountId ?? null, extra.dueBackAt ?? null]
    )
    .then(({ rows }) => rows[0].id)

const closeLoan = (pool, id) =>
  pool.query(`UPDATE sample_loans SET returned_at = now() WHERE id = $1`, [id])

const cleanup = async (pool) => {
  // Loans first: sample_id is RESTRICT, so a sample cannot go while one points
  // at it and the cleanup itself would 23503.
  await pool.query(
    `DELETE FROM sample_loans WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1)`,
    [`${PREFIX}-%`]
  )
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1`, [`${PREFIX}-%`])
}

describe('sample loans schema migration', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup(pool)
  })

  it('creates the sample_loans table', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'sample_loans'`
    )
    expect(rows).toHaveLength(1)
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('indexes open loans only, and uniquely', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'sample_loans_open_unique'`
    )
    expect(rows).toHaveLength(1)
    // Both halves matter: UNIQUE is the invariant, and the predicate is what
    // lets a returned sample go out again.
    expect(rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(rows[0].indexdef).toMatch(/\(sample_id\)/)
    expect(rows[0].indexdef).toMatch(/WHERE \(returned_at IS NULL\)/)
  })

  it('refuses a second open loan on the same sample', async () => {
    const sampleId = await insertSample(pool, `${PREFIX}-0001`)
    await openLoan(pool, sampleId, 'Ana at the counter')
    await expect(openLoan(pool, sampleId, 'Someone else')).rejects.toMatchObject({
      code: '23505',
      constraint: 'sample_loans_open_unique',
    })
  })

  it('lets one of two concurrent check-outs open the loan and refuses the other', async () => {
    // The scanner is a concurrent device. Two staff scanning the same barcode
    // out at once must produce one loan and one 409 — from the index, never
    // from a pre-check that reads a row the other transaction is about to
    // write.
    const sampleId = await insertSample(pool, `${PREFIX}-0002`)
    const first = await pool.connect()
    const second = await pool.connect()
    let conflict = null
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      await openLoan(first, sampleId, 'Scanner A')
      // The second INSERT blocks on the index until the first transaction
      // commits, then raises. Give it a moment to actually reach the wait, so
      // the test exercises contention rather than a tidy sequence.
      const blocked = openLoan(second, sampleId, 'Scanner B').catch((error) => {
        conflict = error
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      await first.query('COMMIT')
      await blocked
      await second.query('ROLLBACK')
    } finally {
      first.release()
      second.release()
    }

    expect(conflict).toMatchObject({
      code: '23505',
      constraint: 'sample_loans_open_unique',
    })

    // 23505 is what the database says; 409 is what the caller gets, through the
    // house mapper. US-006's check-out route keys its own message on this
    // constraint name.
    let mapped = null
    try {
      rethrowConflict(conflict)
    } catch (error) {
      mapped = error
    }
    expect(mapped?.statusCode).toBe(409)

    const { rows } = await pool.query(
      `SELECT holder_name FROM sample_loans WHERE sample_id = $1`,
      [sampleId]
    )
    expect(rows).toEqual([{ holder_name: 'Scanner A' }])
  })

  it('lets a returned sample go out again, and keeps both movements', async () => {
    const sampleId = await insertSample(pool, `${PREFIX}-0003`)
    const firstLoan = await openLoan(pool, sampleId, 'First borrower')
    await closeLoan(pool, firstLoan)
    await openLoan(pool, sampleId, 'Second borrower')
    const { rows } = await pool.query(
      `SELECT holder_name, returned_at IS NULL AS still_out
       FROM sample_loans WHERE sample_id = $1 ORDER BY id`,
      [sampleId]
    )
    expect(rows).toEqual([
      { holder_name: 'First borrower', still_out: false },
      { holder_name: 'Second borrower', still_out: true },
    ])
  })

  it('allows any number of closed loans on one sample', async () => {
    // The index is partial for exactly this reason — a plain unique on
    // sample_id would allow one loan per sample for all time.
    const sampleId = await insertSample(pool, `${PREFIX}-0004`)
    for (const holder of ['One', 'Two', 'Three']) {
      const id = await openLoan(pool, sampleId, holder)
      await closeLoan(pool, id)
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS loans FROM sample_loans WHERE sample_id = $1`,
      [sampleId]
    )
    expect(rows[0].loans).toBe(3)
  })

  it('refuses to delete a sample that has loans', async () => {
    // History is a record, not an owned child: CASCADE would silently destroy
    // the answer to "where did that hanger go?".
    const sampleId = await insertSample(pool, `${PREFIX}-0005`)
    const loanId = await openLoan(pool, sampleId, 'Still holding it')
    await closeLoan(pool, loanId)
    await expect(pool.query(`DELETE FROM samples WHERE id = $1`, [sampleId])).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('requires a holder name', async () => {
    const sampleId = await insertSample(pool, `${PREFIX}-0006`)
    await expect(
      pool.query(`INSERT INTO sample_loans (sample_id) VALUES ($1)`, [sampleId])
    ).rejects.toMatchObject({ code: '23502' })
  })

  it('defaults out_at and leaves the loan open', async () => {
    const sampleId = await insertSample(pool, `${PREFIX}-0007`)
    const id = await openLoan(pool, sampleId, 'Ana at the counter')
    const { rows } = await pool.query(
      `SELECT out_at IS NOT NULL AS has_out_at, due_back_at, returned_at
       FROM sample_loans WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({ has_out_at: true, due_back_at: null, returned_at: null })
  })

  it('keeps the holder name when the trade account is renamed', async () => {
    const sampleId = await insertSample(pool, `${PREFIX}-0008`)
    const tradeAccountId = await insertTradeAccount(pool, {
      guid: '2f6b1d24-1f2a-4f0e-9a3d-7c1f0a5b2e01',
      name: `${PREFIX} Kedgley Architects`,
    })
    const id = await openLoan(pool, sampleId, 'Kedgley Architects (Sam)', { tradeAccountId })
    // A trade account's own name is itself a snapshot re-taken at link time, so
    // the loan may not join for its holder.
    await pool.query(`UPDATE trade_accounts SET legacy_customer_name = $1 WHERE id = $2`, [
      `${PREFIX} Kedgley Architects Ltd`,
      tradeAccountId,
    ])
    const { rows } = await pool.query(
      `SELECT holder_name, trade_account_id FROM sample_loans WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({ holder_name: 'Kedgley Architects (Sam)', trade_account_id: tradeAccountId })
  })

  it('keeps the loan and its holder name when the trade account goes', async () => {
    const sampleId = await insertSample(pool, `${PREFIX}-0009`)
    const tradeAccountId = await insertTradeAccount(pool, {
      guid: '2f6b1d24-1f2a-4f0e-9a3d-7c1f0a5b2e02',
      name: `${PREFIX} Unlinked Studio`,
    })
    const id = await openLoan(pool, sampleId, 'Unlinked Studio (Jo)', { tradeAccountId })
    await pool.query(`DELETE FROM trade_accounts WHERE id = $1`, [tradeAccountId])
    const { rows } = await pool.query(
      `SELECT holder_name, trade_account_id FROM sample_loans WHERE id = $1`,
      [id]
    )
    expect(rows[0]).toEqual({ holder_name: 'Unlinked Studio (Jo)', trade_account_id: null })
  })

  it('derives overdue at read time and stores no flag', async () => {
    // A stored boolean is wrong from the first minute nobody runs the job that
    // would maintain it, so there is no column to store one in.
    const sampleId = await insertSample(pool, `${PREFIX}-0010`)
    await openLoan(pool, sampleId, 'Late borrower', {
      dueBackAt: new Date(Date.now() - 86_400_000).toISOString(),
    })
    const { rows } = await pool.query(
      `SELECT returned_at IS NULL AND due_back_at < now() AS overdue
       FROM sample_loans WHERE sample_id = $1`,
      [sampleId]
    )
    expect(rows[0].overdue).toBe(true)

    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_loans'`
    )
    const stored = columns.rows
      .map((row) => row.column_name)
      .filter((name) => /overdue|is_out|archived_at/.test(name))
    expect(stored).toEqual([])
  })

  it('carries no comments column', async () => {
    // `legacy_cuttings.comments` holds third parties' names, emails, phones and
    // home addresses. Nothing here is a place to copy it into.
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_loans'
         AND column_name = 'comments'`
    )
    expect(rows).toEqual([])
  })

  it('gives sample_loans no quantity columns', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_loans'`
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.map((row) => row.column_name).filter((name) => STOCK_QUANTITY_COLUMNS.test(name)))
      .toEqual([])
  })

  it('adds no column to any legacy_ table', async () => {
    // The legacy import upserts every mapped column to EXCLUDED, so state
    // stored on a staging row is destroyed by the next `npm run import:legacy`.
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'legacy\\_%'`
    )
    const live = new Map()
    for (const row of rows) {
      if (!live.has(row.table_name)) live.set(row.table_name, [])
      live.get(row.table_name).push(row.column_name)
    }
    // A map that found no staging tables would pass every check below vacuously.
    expect(live.size).toBe(Object.keys(LEGACY_TABLES).length)

    const unexpected = []
    for (const spec of Object.values(LEGACY_TABLES)) {
      const declared = new Set([
        ...Object.keys(spec.columns),
        IMPORT_STAMP,
        ...(STAGED_BUT_NOT_IMPORTED[spec.table] ?? []),
      ])
      for (const column of live.get(spec.table) ?? []) {
        if (!declared.has(column)) unexpected.push(`${spec.table}.${column}`)
      }
    }
    expect(unexpected).toEqual([])
  })
})
