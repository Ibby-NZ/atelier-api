// Price history — the declaration side of the capture triggers, and the reads
// over what they recorded.
//
// CAPTURE ITSELF IS A DATABASE TRIGGER, not code in this file. See the loud
// header in migrations/1788667200000_price-history-triggers.js for why (short
// version: `RETURNING` after `ON CONFLICT DO UPDATE` gives the NEW row, so a JS
// delta needs a second query per chunk and only ever covers the writers somebody
// remembered). What this module owns is the three things a trigger cannot reach
// on its own — who is writing, why, and what to answer when they did not say.
//
//   - `withChangeContext` / `setChangeContext` declare the source, the reason
//     and the actor as TRANSACTION-LOCAL settings the trigger reads back.
//   - `requireChangeReason` is the 422 a manual edit gets without a note. It
//     lives here, called from the domain MODULES rather than from a route, so
//     the rule holds for the CRM, the AdminJS panel and any future caller — the
//     `updateUser` posture.
//   - `rethrowPriceHistory` maps the trigger's own exception ONCE, so no route
//     grows its own copy.
//
// The reads are the point of the whole epic. Atelier goes back to a superseded
// price 50 to 100 times a year and today the only way to reach one is that the
// year is encoded in the item code; `getRateAsAt` is what makes that practice
// droppable.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/** The values `*_price_history.source` accepts, mirroring the column CHECK. */
export const CHANGE_SOURCES = Object.freeze(['import', 'manual'])

/** Longest reason a caller may send. The column is unbounded text. */
export const MAX_REASON_LENGTH = 500

// The four settings the triggers read, set transaction-locally (`is_local` =
// true). Local is not a nicety: pool connections are reused, so a session-level
// setting would label the next unrelated write "manual" with a stale reason.
// An absent value is bound as '' rather than NULL — set_config's NULL handling
// is not worth relying on, and the triggers already NULLIF the empty string.
// The four names are spelt out here and again in the trigger migration: a
// migration is a record of what ran and must not import a constant that can
// later change under it (the rule 1786060800000_client-house-roster.js states).
const CHANGE_CONTEXT_SQL = `SELECT
  set_config('atelier.change_source', $1, true),
  set_config('atelier.change_reason', $2, true),
  set_config('atelier.change_user_id', $3, true),
  set_config('atelier.change_source_file', $4, true)`

/**
 * Declare who is about to change a price and why, for the rest of THIS
 * transaction. The caller must already be inside one — a local setting outside
 * a transaction block dies with the statement that set it, so the write would
 * arrive undeclared and the trigger would refuse it.
 *
 * @param {{ query: Function }} db an open client (or a pool, inside a transaction)
 * @param {{ source: string, reason?: string|null, userId?: number|null,
 *           sourceFile?: string|null }} context
 * @returns {Promise<object>}
 */
export const setChangeContext = (db, { source, reason, userId, sourceFile } = {}) => {
  if (!CHANGE_SOURCES.includes(source)) {
    // A code literal, like a lifecycle registry key: a plain Error (a 500), not
    // something a request can ask for.
    throw new Error(
      `Unknown price change source "${source}". Known: ${CHANGE_SOURCES.join(', ')}.`
    )
  }
  return db.query(CHANGE_CONTEXT_SQL, [
    source,
    reason ?? '',
    userId == null ? '' : String(userId),
    sourceFile ?? '',
  ])
}

/**
 * Run `work(client)` in one transaction with the change context declared. The
 * transaction is what makes the declaration reach the trigger at all.
 *
 * @param {import('pg').Pool} pool
 * @param {object} context see setChangeContext
 * @param {(client: object) => Promise<any>} work
 * @returns {Promise<any>} whatever `work` returned
 */
export const withChangeContext = async (pool, context, work) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await setChangeContext(client, context)
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Surface the original failure, not the rollback's; pg discards the
      // released connection either way. Same posture as importPriceLists.
    }
    throw error
  } finally {
    client.release()
  }
}

const NO_REASON_MESSAGE =
  'A price change needs a short reason — "supplier increase", "exchange rate", ' +
  'whatever it actually was. It is recorded against the old and new price so ' +
  'the change can be explained later.'

/**
 * The mandatory note on a MANUAL price change. An import never comes through
 * here: it cannot type a reason 19,500 times, so the trigger builds one per row
 * from the file name and the effective date instead.
 *
 * Called from the domain modules (updatePriceListItem, updateProduct), never
 * from a route — the `updateUser` rule, so it holds for every caller. The
 * table's own CHECK is the backstop behind it.
 *
 * @param {unknown} reason
 * @returns {string} the trimmed reason
 * @throws a 422 when it says nothing
 */
export const requireChangeReason = (reason) => {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  if (trimmed === '') {
    throw httpError(422, NO_REASON_MESSAGE)
  }
  return trimmed.slice(0, MAX_REASON_LENGTH)
}

/**
 * Map the capture triggers' refusals onto 422s, once, for every write path.
 *
 * RETURNS for anything else rather than rethrowing, so a caller chains it in
 * front of its existing handler: `raisePriceHistoryError(error); return
 * rethrowConflict(error)`. AT001 is the platform's own SQLSTATE (see the
 * trigger migration) — matching it rather than every RAISE is what keeps an
 * unrelated database error a 500.
 *
 * @param {any} error
 * @returns {void} unless it is one of ours, in which case it throws a 422
 */
export const raisePriceHistoryError = (error) => {
  if (error?.code === 'AT001') {
    throw httpError(
      422,
      'That price change was refused because nothing declared where it came ' +
        'from, so it could not be recorded. This is a wiring fault, not a bad ' +
        'value — see src/pricing/price-history.js.'
    )
  }
  if (error?.code === '23514' && String(error.constraint ?? '').endsWith('_manual_reason_check')) {
    throw httpError(422, NO_REASON_MESSAGE)
  }
}

// Newest first, and capped: the history of one row is a screen, not a ledger to
// stream. Nothing pages it today.
export const HISTORY_LIMIT = 200

const toRateChange = (row) =>
  Object.freeze({
    id: row.id,
    old_rate: Number(row.old_rate),
    new_rate: Number(row.new_rate),
    currency: row.currency,
    // The two axes, side by side and never conflated: `changed_at` is when OUR
    // ledger moved, `date_effective` is what the supplier's paper said.
    changed_at: row.changed_at,
    date_effective: row.date_effective,
    source: row.source,
    source_file: row.source_file,
    reason: row.reason,
    changed_by_user_id: row.changed_by_user_id,
    changed_by_name: row.changed_by_name ?? null,
  })

const toProductPriceChange = (row) =>
  Object.freeze({
    id: row.id,
    old_retail_price_cents: row.old_retail_price_cents,
    new_retail_price_cents: row.new_retail_price_cents,
    old_trade_price_cents: row.old_trade_price_cents,
    new_trade_price_cents: row.new_trade_price_cents,
    currency: row.currency,
    changed_at: row.changed_at,
    source: row.source,
    source_file: row.source_file,
    reason: row.reason,
    changed_by_user_id: row.changed_by_user_id,
    changed_by_name: row.changed_by_name ?? null,
  })

// `date_effective::text`, deliberately. pg maps a `date` to a JS Date at LOCAL
// midnight, which JSON.stringify then renders in UTC — so 2023-01-15 leaves a
// NZ server as "2023-01-14T11:00:00.000Z", a day early and wearing a time it
// never had. That matters more here than anywhere else in the API: this whole
// epic exists so a person can ask what a price was on a given day. Casting in
// SQL is what makes the answer the calendar day the supplier printed.
// (`toPriceListItem` still passes the raw column through — a pre-existing wart
// on a different payload, and not this story's to change.)
const RATE_HISTORY_COLUMNS = `h.id, h.old_rate, h.new_rate, h.currency,
  h.date_effective::text AS date_effective,
  h.changed_at, h.source, h.source_file, h.reason, h.changed_by_user_id,
  u.name AS changed_by_name`

/**
 * THE AS-AT LOOKUP — the feature this epic exists for.
 *
 * "What were we paying for this on 1 June 2023?" is one indexed query: the
 * newest recorded change for the item at or before that date. The index is
 * (price_list_item_id, changed_at DESC), so it is one scan and one row.
 *
 * The bound is `< as_at + 1 day`, not `<= as_at`: `changed_at` is a timestamptz
 * and `as_at` is a calendar day, so `<=` would cut the range at that morning's
 * midnight and answer with the rate the day STARTED on. This is the same
 * next-day-exclusive rule buildReportFilters applies to its `to` bound, and it
 * means the answer is the rate the named day ENDED on.
 *
 * A date before anything was recorded is a 404 that says which of the two
 * reasons it is — the item's rate has never moved, or the ledger only starts
 * later. "No result" and "nothing recorded yet" are indistinguishable otherwise,
 * and only the second is something a person can act on.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id price_list_items.id
 * @param {string} asAt YYYY-MM-DD
 * @returns {Promise<Readonly<object>>}
 */
export const getRateAsAt = async (pool, id, asAt) => {
  const { rows } = await pool.query(
    `SELECT ${RATE_HISTORY_COLUMNS}
       FROM price_list_item_price_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.price_list_item_id = $1
        AND h.changed_at < ($2::date + 1)
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT 1`,
    [id, asAt]
  )

  if (rows[0]) {
    const change = toRateChange(rows[0])
    return Object.freeze({
      price_list_item_id: id,
      as_at: asAt,
      wholesale_rate: change.new_rate,
      currency: change.currency,
      date_effective: change.date_effective,
      changed_at: change.changed_at,
      source: change.source,
      source_file: change.source_file,
      reason: change.reason,
      changed_by_user_id: change.changed_by_user_id,
      changed_by_name: change.changed_by_name,
    })
  }

  // Only on a miss: which of the three "no answer" cases is it?
  const { rows: why } = await pool.query(
    `SELECT p.id, p.wholesale_rate, p.currency,
            count(h.id)::int AS changes,
            min(h.changed_at) AS earliest
       FROM price_list_items p
       LEFT JOIN price_list_item_price_history h ON h.price_list_item_id = p.id
      WHERE p.id = $1
      GROUP BY p.id, p.wholesale_rate, p.currency`,
    [id]
  )
  const item = why[0]
  if (!item) {
    throw httpError(404, `Price-list item ${id} not found.`)
  }
  if (item.changes === 0) {
    throw httpError(
      404,
      `The rate for price-list item ${id} has never changed since price history ` +
        `recording began, so there is nothing recorded as at ${asAt}. Its current ` +
        `rate (${Number(item.wholesale_rate)} ${item.currency}) is the only one this ` +
        'ledger has ever held.'
    )
  }
  throw httpError(
    404,
    `Nothing is recorded for price-list item ${id} at or before ${asAt}. The ` +
      `earliest recorded change is ${new Date(item.earliest).toISOString().slice(0, 10)}.`
  )
}

/**
 * Every recorded rate change for one item, newest first. What the CRM's price
 * history tab lists: date changed, old rate, new rate, reason.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<ReadonlyArray<object>>}
 */
export const listRateHistory = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${RATE_HISTORY_COLUMNS}
       FROM price_list_item_price_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.price_list_item_id = $1
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT ${HISTORY_LIMIT}`,
    [id]
  )
  return Object.freeze(rows.map(toRateChange))
}

/**
 * Every recorded price change for one product, newest first. Both prices ride
 * on every row — a row showing one number in isolation cannot say whether the
 * other moved with it.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<ReadonlyArray<object>>}
 */
export const listProductPriceHistory = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT h.id, h.old_retail_price_cents, h.new_retail_price_cents,
            h.old_trade_price_cents, h.new_trade_price_cents, h.currency,
            h.changed_at, h.source, h.source_file, h.reason, h.changed_by_user_id,
            u.name AS changed_by_name
       FROM product_price_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
      WHERE h.product_id = $1
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT ${HISTORY_LIMIT}`,
    [id]
  )
  return Object.freeze(rows.map(toProductPriceChange))
}
