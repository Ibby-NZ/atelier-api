// The two movements the sample register records: a sample going out on loan and
// coming back (W4-US-006).
//
// THESE ARE VERBS, NOT A STATUS PATCH, and the reason is that each one writes
// TWO tables and only means anything if both writes land together. Check-out
// opens a `sample_loans` row AND moves `samples.status` to `out`; check-in
// closes the loan AND moves the status back. A PATCH that could write `out`
// would let a screen mark a sample out with no loan behind it — a register
// naming no holder — which is why `WRITABLE_SAMPLE_STATUSES` (admin-samples.js)
// excludes it and why these two functions write `status` themselves rather than
// going through `updateSample`.
//
// "ALREADY OUT" IS A CAUGHT 23505, NEVER A PRE-CHECK. The invariant lives in
// `sample_loans_open_unique` (a UNIQUE index on `sample_id WHERE returned_at IS
// NULL`), because the scanner is a concurrent device: a read-then-insert reads a
// row another transaction is about to write, and two staff scanning one barcode
// out at once would open two loans with nothing in the data to say which was the
// lie. So the second check-out fails at the index and this module maps the 23505
// to a 409 — the same posture a duplicate barcode already takes.
//
// "NOT OUT" IS THE CLOSING UPDATE'S OWN rowCount, also not a pre-check. Closing
// a loan is `UPDATE … WHERE sample_id = $1 AND returned_at IS NULL`; when that
// matches nothing, nothing was out. Reading the row first and then updating it
// would be two statements answering one question.
//
// SAMPLES ARE NOT STOCK. A sample leaving the library is not a sale: nothing
// here reads or writes a quantity, and the order state machine stays the only
// owner of the reservation arithmetic. `test/samples-schema.test.js` scans this
// directory for those columns and `test/samples-checkout.test.js` asserts it
// again at runtime over every statement these two functions issue.

import { getSample } from './admin-samples.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Keyed on the constraint name, house style: an unknown key degrades the
// MESSAGE and never the status.
const CONFLICT_MESSAGES = Object.freeze({
  sample_loans_open_unique:
    'That sample is already out. Check it in before sending it out again.',
})

// 422 rather than 404: the id arrived in a BODY as a business fact about the
// loan, exactly like an unknown `brand_id` on a product create, so it is the
// body that is wrong and not the URL.
const MISSING_PARENT_MESSAGES = Object.freeze({
  sample_loans_trade_account_id_fkey: 'That trade account does not exist.',
})

const rethrowLoanWriteError = (error) => {
  if (error?.code === '23505') {
    throw httpError(
      409,
      CONFLICT_MESSAGES[error.constraint] ?? 'That movement conflicts with one already recorded.'
    )
  }
  if (error?.code === '23503') {
    throw httpError(
      422,
      MISSING_PARENT_MESSAGES[error.constraint] ?? 'A referenced record does not exist.'
    )
  }
  // A timestamp with the right SHAPE and no place in the calendar (2026-02-31).
  // The route's pattern cannot catch that — only Postgres knows the calendar —
  // and a rejected value must not surface as a 500.
  if (error?.code === '22007' || error?.code === '22008') {
    throw httpError(422, 'That timestamp is not a real date.')
  }
  throw error
}

/**
 * Lock the sample row, run a movement inside ONE transaction, and return the
 * fresh sample. 404 when the id is unknown. Mirrors `withOrderTxn`
 * (src/orders/admin-orders.js): BEGIN, SELECT … FOR UPDATE, run, COMMIT,
 * re-read.
 *
 * The lock must be `FOR UPDATE`, never `FOR NO KEY UPDATE`. Inserting a
 * `sample_loans` row takes `FOR KEY SHARE` on the sample it references, and
 * `FOR KEY SHARE` conflicts with `FOR UPDATE` and with nothing weaker — so this
 * is what serialises two movements on one sample, and the weaker mode would
 * leave both of them running side by side. The partial unique index is still
 * the invariant underneath; the lock only decides who waits.
 *
 * The re-read goes back through `getSample` on the POOL, after the commit, so
 * every movement hands the CRM the same shape a plain read does — parents by
 * name, the open loan, the loan count, the derived `overdue` and the history.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {(client: import('pg').PoolClient, sample: { id: number, status: string }) => Promise<void>} fn
 * @param {{ finance?: boolean }} [options] passed to the re-read; cost columns
 *   are selected only for a caller with finance visibility
 * @returns {Promise<object|null>}
 */
export const withSampleTxn = async (pool, id, fn, options) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, status FROM samples WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const sample = rows[0]
    if (!sample) {
      throw httpError(404, `Sample ${id} not found.`)
    }
    await fn(client, sample)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getSample(pool, id, options)
}

/**
 * Send a sample out: open a loan and move the sample to `out`, in one
 * transaction. A sample that is already out is a 409 from the index.
 *
 * `holder_name` is the snapshot — whoever took it, as given at the counter —
 * and is required, because a loan that cannot say who has the sample answers
 * nothing. `trade_account_id` links the company where the borrower is a linked
 * trade client; most are not (an architect, a stylist, Atelier's own staff), so
 * it is optional and the name is never joined for.
 *
 * `due_back_at` is optional on purpose: plenty of samples go out with no date
 * agreed, and inventing one would make them overdue on a deadline nobody set.
 *
 * No guard refuses a `missing` or `retired` sample, deliberately. Those are
 * statements staff made about the object, and a missing sample that someone has
 * just scanned out has by definition been found — refusing it would make the
 * register argue with the person holding the thing. Archived rows go out too,
 * for the same reason `by-barcode` returns them.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ holder_name: string, trade_account_id?: number, due_back_at?: string,
 *           out_at?: string, notes?: string }} input
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export const checkOutSample = (pool, id, input, options) =>
  withSampleTxn(
    pool,
    id,
    async (client) => {
      try {
        await client.query(
          `INSERT INTO sample_loans
             (sample_id, trade_account_id, holder_name, out_at, due_back_at, notes)
           VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5::timestamptz, $6)`,
          [
            id,
            input.trade_account_id ?? null,
            input.holder_name,
            input.out_at ?? null,
            input.due_back_at ?? null,
            input.notes ?? null,
          ]
        )
      } catch (error) {
        // Always throws; control never returns here.
        rethrowLoanWriteError(error)
      }

      // The second table. `status` is written here rather than through
      // `updateSample`, which refuses `out` outright — this transaction is the
      // only place the assertion "it is out" can be made true.
      await client.query(
        `UPDATE samples SET status = 'out', updated_at = now() WHERE id = $1`,
        [id]
      )
    },
    options
  )

/**
 * Take a sample back in: close the open loan and move the sample to
 * `in_library`, in one transaction. A sample that is not out is a 409.
 *
 * `returned_at` is optional and defaults to now(), mirroring `out_at`, so a
 * movement recorded after the fact can carry the day it happened. Nothing
 * refuses a returned date earlier than the loan's `out_at` — a back-dated
 * correction has to stay possible, the same reason `sample_orders` carries no
 * CHECK tying a status to its stamp.
 *
 * The loan's own `notes` are not rewritten: they are what was typed when the
 * sample went out, and a loan is append-only history rather than a row a later
 * movement edits.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ returned_at?: string }} [input]
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export const checkInSample = (pool, id, input = {}, options) =>
  withSampleTxn(
    pool,
    id,
    async (client) => {
      let closed
      try {
        closed = await client.query(
          `UPDATE sample_loans
              SET returned_at = COALESCE($2::timestamptz, now()), updated_at = now()
            WHERE sample_id = $1 AND returned_at IS NULL`,
          [id, input.returned_at ?? null]
        )
      } catch (error) {
        rethrowLoanWriteError(error)
      }

      // The UPDATE's own answer, not a pre-check: nothing matched means nothing
      // was out. The transaction holds the sample locked, so no concurrent
      // check-out can open a loan between the two statements.
      if (closed.rowCount === 0) {
        throw httpError(409, `Sample ${id} is not out, so there is nothing to check in.`)
      }

      await client.query(
        `UPDATE samples SET status = 'in_library', updated_at = now() WHERE id = $1`,
        [id]
      )
    },
    options
  )
