// Check-out and check-in verb routes (W4-US-006).
//
// Four acceptance criteria drive this file, and three of them are statements
// about a status code, so nothing here can be asserted against the module
// alone:
//   1. Both are VERB routes, not a status PATCH — each writes two tables in one
//      transaction.
//   2. `withSampleTxn` mirrors `withOrderTxn`: BEGIN, SELECT … FOR UPDATE, run,
//      COMMIT, re-read.
//   3. "Already out" is a 409 from a CAUGHT 23505 on the partial index, never a
//      pre-check.
//   4. Check-in of a sample that is not out is a 409.
//
// (2) and (3) are about the SQL rather than the answer, so they are asserted
// twice over: against the real database for behaviour, and against a four-line
// recording stub pool for the statement order — which is the only way to prove
// that nothing SELECTs `sample_loans` before the write that decides the answer.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  withSampleTxn,
  checkOutSample,
  checkInSample,
} from '../src/samples/sample-loans.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
// Anchored with no separator, so the pattern matches every name this suite
// writes and not only the ones it inserts.
const PREFIX = 'w4-checkout-test'
const DOMAIN = 'w4-checkout-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const DAY_MS = 86_400_000
const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString()

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Loans first (sample_id is RESTRICT), then samples ahead of brands — a brand
// cascade cannot get past samples.colourway_id, also RESTRICT. trade_accounts
// last: sample_loans.trade_account_id is SET NULL, but the loans are gone by
// then anyway and the guid is unique, so a leaked row 23505s on the next run.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM sample_loans WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM samples WHERE barcode LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM showrooms WHERE name LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1', [
    `${PREFIX}%`,
  ])
}

const insertTradeAccount = (pool, name) =>
  pool
    .query(
      `INSERT INTO trade_accounts (legacy_account_guid, legacy_customer_name)
       VALUES ($1, $2) RETURNING id`,
      // A generated guid rather than a literal one: a fixture that leaked past
      // the cleanup would otherwise 23505 for ever after.
      [randomUUID(), `${PREFIX} ${name}`]
    )
    .then(({ rows }) => rows[0].id)

// A recording stub. `deleteOrExplain` and every module here only ever call
// connect()/query()/release(), so four lines is the whole surface.
const recordingPool = (handler) => {
  const statements = []
  const client = {
    query: async (text, params) => {
      statements.push(text)
      const answer = handler ? handler(text, params) : undefined
      return answer ?? { rows: [{ id: 1 }], rowCount: 1 }
    },
    release: () => {},
  }
  return { statements, pool: { connect: async () => client, query: client.query } }
}

describe('sample check-out and check-in', () => {
  let pool
  let app
  let backofficeCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const createSample = async (barcode, body = {}) => {
    const response = await inject('POST', '/admin/samples', backofficeCookie, {
      barcode,
      ...body,
    })
    expect(response.statusCode).toBe(201)
    return response.json().sample
  }

  const checkOut = (id, body) =>
    inject('POST', `/admin/samples/${id}/check-out`, backofficeCookie, body)

  const checkIn = (id, body) =>
    inject('POST', `/admin/samples/${id}/check-in`, backofficeCookie, body)

  const loanRowsFor = (sampleId) =>
    pool
      .query(
        `SELECT id, holder_name, trade_account_id, out_at, due_back_at, returned_at, notes
           FROM sample_loans WHERE sample_id = $1 ORDER BY id ASC`,
        [sampleId]
      )
      .then(({ rows }) => rows)

  const statusOf = (sampleId) =>
    pool
      .query('SELECT status FROM samples WHERE id = $1', [sampleId])
      .then(({ rows }) => rows[0].status)

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

    // Registered ONCE — register shares a 10/15min/IP rate-limit bucket, so
    // re-registering per test would 429 and yield no cookie.
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

  describe('POST /admin/samples/:id/check-out', () => {
    it('writes both tables and returns the sample in the read shape', async () => {
      const sample = await createSample(`${PREFIX}-0001`, { label: 'Atlas hanger' })
      const due = daysFromNow(7)

      const response = await checkOut(sample.id, {
        holder_name: 'Kedgley Architects (Sam)',
        due_back_at: due,
        notes: 'For the Ponsonby job.',
      })
      expect(response.statusCode).toBe(200)

      const body = response.json().sample
      // The one shape every write here returns: parents by name, the open loan,
      // the loan count, the derived overdue and the history.
      expect(body).toMatchObject({
        id: sample.id,
        status: 'out',
        overdue: false,
        loan_count: 1,
      })
      expect(body.open_loan).toMatchObject({ holder_name: 'Kedgley Architects (Sam)' })
      expect(body.loans).toHaveLength(1)

      // Table one: the loan.
      const loans = await loanRowsFor(sample.id)
      expect(loans).toHaveLength(1)
      expect(loans[0].holder_name).toBe('Kedgley Architects (Sam)')
      expect(loans[0].returned_at).toBeNull()
      expect(loans[0].notes).toBe('For the Ponsonby job.')
      expect(new Date(loans[0].due_back_at).toISOString()).toBe(new Date(due).toISOString())

      // Table two: the sample.
      expect(await statusOf(sample.id)).toBe('out')
    })

    it('links a trade account while the holder stays a snapshot', async () => {
      const sample = await createSample(`${PREFIX}-0002`)
      const tradeAccountId = await insertTradeAccount(pool, 'Kedgley Architects')

      const response = await checkOut(sample.id, {
        holder_name: 'Kedgley Architects (Sam)',
        trade_account_id: tradeAccountId,
      })
      expect(response.statusCode).toBe(200)

      const loans = await loanRowsFor(sample.id)
      expect(loans[0].trade_account_id).toBe(tradeAccountId)
      expect(loans[0].holder_name).toBe('Kedgley Architects (Sam)')
    })

    it('goes out with no due date agreed, and is not overdue for it', async () => {
      const sample = await createSample(`${PREFIX}-0003`)
      const response = await checkOut(sample.id, { holder_name: 'Walk-in' })
      expect(response.statusCode).toBe(200)

      const body = response.json().sample
      expect(body.open_loan.due_back_at).toBeNull()
      // A NULL comparison yields NULL, not false — COALESCE is what makes this
      // an actual boolean rather than a JS null.
      expect(body.overdue).toBe(false)
    })

    it('shows overdue from the loan the moment the due date has passed', async () => {
      const sample = await createSample(`${PREFIX}-0004`)
      const response = await checkOut(sample.id, {
        holder_name: 'Late Studio',
        due_back_at: daysFromNow(-2),
      })
      expect(response.json().sample.overdue).toBe(true)
    })

    it('records a movement after the fact with its own out_at', async () => {
      const sample = await createSample(`${PREFIX}-0005`)
      const when = daysFromNow(-5)
      await checkOut(sample.id, { holder_name: 'Yesterday', out_at: when })

      const loans = await loanRowsFor(sample.id)
      expect(new Date(loans[0].out_at).toISOString()).toBe(new Date(when).toISOString())
    })

    it('sends out a sample marked missing — it has just been found', async () => {
      // No guard refuses this, deliberately: a missing sample somebody has
      // scanned out is by definition no longer missing, and refusing would make
      // the register argue with the person holding the thing.
      const sample = await createSample(`${PREFIX}-0006`, { status: 'missing' })
      const response = await checkOut(sample.id, { holder_name: 'Found it' })
      expect(response.statusCode).toBe(200)
      expect(response.json().sample.status).toBe('out')
    })

    it('answers 404 for an unknown sample', async () => {
      const response = await checkOut(999_999_999, { holder_name: 'Nobody' })
      expect(response.statusCode).toBe(404)
    })

    it('requires a holder name', async () => {
      const sample = await createSample(`${PREFIX}-0007`)
      expect((await checkOut(sample.id, {})).statusCode).toBe(400)
      expect((await checkOut(sample.id, { holder_name: '' })).statusCode).toBe(400)
      // Nothing was written by either refusal.
      expect(await loanRowsFor(sample.id)).toHaveLength(0)
      expect(await statusOf(sample.id)).toBe('in_library')
    })

    it('answers 422 for a trade account that does not exist', async () => {
      const sample = await createSample(`${PREFIX}-0008`)
      const response = await checkOut(sample.id, {
        holder_name: 'Ghost',
        trade_account_id: 999_999_999,
      })
      expect(response.statusCode).toBe(422)
      // The whole transaction rolled back: no loan, and the status did not move.
      expect(await loanRowsFor(sample.id)).toHaveLength(0)
      expect(await statusOf(sample.id)).toBe('in_library')
    })

    it('rejects a malformed timestamp at the schema and an impossible one at the database', async () => {
      const sample = await createSample(`${PREFIX}-0009`)
      const shape = await checkOut(sample.id, {
        holder_name: 'Typo',
        due_back_at: 'next tuesday',
      })
      expect(shape.statusCode).toBe(400)

      // The pattern can only police the shape; only Postgres knows the calendar.
      const calendar = await checkOut(sample.id, {
        holder_name: 'Typo',
        due_back_at: '2026-02-31',
      })
      expect(calendar.statusCode).toBe(422)
      expect(await loanRowsFor(sample.id)).toHaveLength(0)
    })
  })

  describe('"already out" is a caught 23505, never a pre-check', () => {
    it('answers 409 on a second check-out', async () => {
      const sample = await createSample(`${PREFIX}-0100`)
      expect((await checkOut(sample.id, { holder_name: 'First' })).statusCode).toBe(200)

      const second = await checkOut(sample.id, { holder_name: 'Second' })
      expect(second.statusCode).toBe(409)
      expect(second.json().message).toMatch(/already out/i)

      // One loan, and it is the first holder's. A second row would make the
      // register name the wrong person for ever.
      const loans = await loanRowsFor(sample.id)
      expect(loans).toHaveLength(1)
      expect(loans[0].holder_name).toBe('First')
    })

    it('holds under two concurrent check-outs of the one barcode', async () => {
      // The scanner is a concurrent device. Two staff, one tag, at once.
      const sample = await createSample(`${PREFIX}-0101`)
      const [a, b] = await Promise.all([
        checkOut(sample.id, { holder_name: 'Counter A' }),
        checkOut(sample.id, { holder_name: 'Counter B' }),
      ])

      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
      expect(await loanRowsFor(sample.id)).toHaveLength(1)
      expect(await statusOf(sample.id)).toBe('out')
    })

    it('issues no SELECT of sample_loans before the INSERT that decides it', async () => {
      // A pre-check would read a row another transaction is about to write, so
      // the ONLY correct implementation is to let the index refuse the insert.
      // That is a claim about the SQL, not about the answer, so it is asserted
      // over the statements themselves.
      const { statements, pool: stub } = recordingPool()
      await checkOutSample(stub, 1, { holder_name: 'Stub' })

      const insertAt = statements.findIndex((sql) => /INSERT INTO sample_loans/i.test(sql))
      expect(insertAt).toBeGreaterThan(-1)
      expect(statements.slice(0, insertAt).filter((sql) => /sample_loans/i.test(sql))).toEqual([])
    })
  })

  describe('POST /admin/samples/:id/check-in', () => {
    it('closes the loan, brings the sample back and needs no body', async () => {
      const sample = await createSample(`${PREFIX}-0200`)
      await checkOut(sample.id, { holder_name: 'Kedgley Architects (Sam)' })

      const response = await checkIn(sample.id)
      expect(response.statusCode).toBe(200)

      const body = response.json().sample
      expect(body).toMatchObject({ status: 'in_library', overdue: false, loan_count: 1 })
      expect(body.open_loan).toBeNull()

      const loans = await loanRowsFor(sample.id)
      expect(loans).toHaveLength(1)
      expect(loans[0].returned_at).not.toBeNull()
      // The loan's own note is what was typed when it went out; a later movement
      // does not rewrite history.
      expect(loans[0].holder_name).toBe('Kedgley Architects (Sam)')
      expect(await statusOf(sample.id)).toBe('in_library')
    })

    it('records a return after the fact with its own returned_at', async () => {
      const sample = await createSample(`${PREFIX}-0201`)
      await checkOut(sample.id, { holder_name: 'Away', out_at: daysFromNow(-10) })
      const when = daysFromNow(-3)

      const response = await checkIn(sample.id, { returned_at: when })
      expect(response.statusCode).toBe(200)

      const loans = await loanRowsFor(sample.id)
      expect(new Date(loans[0].returned_at).toISOString()).toBe(new Date(when).toISOString())
    })

    it('answers 409 when the sample is not out', async () => {
      const sample = await createSample(`${PREFIX}-0202`)
      const response = await checkIn(sample.id)
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/not out/i)
      // Nothing moved: the status write is inside the transaction that failed.
      expect(await statusOf(sample.id)).toBe('in_library')
    })

    it('answers 409 on a second check-in of the same loan', async () => {
      const sample = await createSample(`${PREFIX}-0203`)
      await checkOut(sample.id, { holder_name: 'Once' })
      expect((await checkIn(sample.id)).statusCode).toBe(200)

      const again = await checkIn(sample.id)
      expect(again.statusCode).toBe(409)
      // Still exactly one loan, still closed once.
      expect(await loanRowsFor(sample.id)).toHaveLength(1)
    })

    it('answers 404 for an unknown sample', async () => {
      expect((await checkIn(999_999_999)).statusCode).toBe(404)
    })

    it('lets the sample go out again — the unique index is PARTIAL', async () => {
      const sample = await createSample(`${PREFIX}-0204`)
      await checkOut(sample.id, { holder_name: 'First' })
      await checkIn(sample.id)

      const again = await checkOut(sample.id, { holder_name: 'Second' })
      expect(again.statusCode).toBe(200)

      const body = again.json().sample
      expect(body.status).toBe('out')
      // Append-only history: two movements, the first one closed.
      expect(body.loan_count).toBe(2)
      expect(body.open_loan.holder_name).toBe('Second')

      const loans = await loanRowsFor(sample.id)
      expect(loans.map((loan) => loan.returned_at === null)).toEqual([false, true])
    })

    it('issues no SELECT of sample_loans before the UPDATE that decides it', async () => {
      // "Not out" is the closing UPDATE's own rowCount, not a read-then-write.
      const { statements, pool: stub } = recordingPool()
      await checkInSample(stub, 1)

      const updateAt = statements.findIndex((sql) => /UPDATE sample_loans/i.test(sql))
      expect(updateAt).toBeGreaterThan(-1)
      expect(statements.slice(0, updateAt).filter((sql) => /sample_loans/i.test(sql))).toEqual([])
    })
  })

  describe('withSampleTxn', () => {
    it('mirrors withOrderTxn: BEGIN, SELECT FOR UPDATE, run, COMMIT, re-read', async () => {
      const { statements, pool: stub } = recordingPool()
      await checkOutSample(stub, 1, { holder_name: 'Stub' })

      expect(statements[0]).toBe('BEGIN')
      expect(statements[1]).toMatch(/SELECT[\s\S]*FROM samples[\s\S]*FOR UPDATE/i)
      // FOR UPDATE, never FOR NO KEY UPDATE: inserting a sample_loans row takes
      // FOR KEY SHARE on the sample, which conflicts with FOR UPDATE and with
      // nothing weaker — the weaker mode would let both movements run at once.
      expect(statements[1]).not.toMatch(/FOR NO KEY UPDATE/i)
      expect(statements[2]).toMatch(/INSERT INTO sample_loans/i)
      expect(statements[3]).toMatch(/UPDATE samples SET status = 'out'/i)
      expect(statements[4]).toBe('COMMIT')
      // The re-read happens after the commit, through the read model.
      expect(statements.slice(5).some((sql) => /FROM samples s/i.test(sql))).toBe(true)
    })

    it('puts the check-in pair in the same one transaction', async () => {
      const { statements, pool: stub } = recordingPool()
      await checkInSample(stub, 1)

      expect(statements[0]).toBe('BEGIN')
      expect(statements[1]).toMatch(/FROM samples[\s\S]*FOR UPDATE/i)
      expect(statements[2]).toMatch(/UPDATE sample_loans[\s\S]*returned_at IS NULL/i)
      expect(statements[3]).toMatch(/UPDATE samples SET status = 'in_library'/i)
      expect(statements[4]).toBe('COMMIT')
    })

    it('rolls back when the second write fails, so neither table moves', async () => {
      // The failure that matters is the one AFTER the loan insert — the window
      // a two-statement handler outside a transaction would leave open. Only a
      // stub can reach it.
      const { statements, pool: stub } = recordingPool((sql) => {
        if (/UPDATE samples SET status/i.test(sql)) {
          throw Object.assign(new Error('boom'), { code: 'XX000' })
        }
        return undefined
      })

      await expect(checkOutSample(stub, 1, { holder_name: 'Stub' })).rejects.toThrow('boom')
      expect(statements).toContain('ROLLBACK')
      expect(statements).not.toContain('COMMIT')
    })

    it('answers 404 without running the movement at all', async () => {
      const { statements, pool: stub } = recordingPool((sql) =>
        /FOR UPDATE/i.test(sql) ? { rows: [], rowCount: 0 } : undefined
      )

      await expect(withSampleTxn(stub, 7, async () => {
        throw new Error('the movement must not run')
      })).rejects.toMatchObject({ statusCode: 404 })
      expect(statements).toContain('ROLLBACK')
    })
  })

  describe('invariants', () => {
    it('reads and writes no stock, over every statement both movements issue', async () => {
      // Samples are not inventory. The static source scan in
      // test/samples-schema.test.js globs src/samples/**; this is the runtime
      // counterpart for the two writes this story adds.
      const { statements, pool: stub } = recordingPool()
      await checkOutSample(stub, 1, { holder_name: 'Stub' })
      await checkInSample(stub, 1)

      // A recorder that captured nothing would pass every check below vacuously.
      expect(statements.length).toBeGreaterThan(0)
      expect(statements.some((sql) => /sample_loans/i.test(sql))).toBe(true)
      const offending = statements.filter(
        (sql) =>
          /qty_available|qty_reserved/.test(sql) ||
          /(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i.test(sql)
      )
      expect(offending).toEqual([])
    })

    it('leaves `out` unwritable by PATCH — the verbs are the only way in', async () => {
      const sample = await createSample(`${PREFIX}-0300`)
      const patched = await inject('PATCH', `/admin/samples/${sample.id}`, backofficeCookie, {
        status: 'out',
      })
      expect(patched.statusCode).toBe(400)
      // And the register agrees: nothing is out, because no loan was written.
      expect(await statusOf(sample.id)).toBe('in_library')
      expect(await loanRowsFor(sample.id)).toHaveLength(0)
    })
  })
})
