/**
 * Shipping-rate read/write model.
 *
 * Rates live in `shipping_rates` as (zone, threshold_qty, rate_cents) tiers.
 * `threshold_qty` is the tier floor: a quote picks the highest threshold that
 * is <= the requested qty (flat rate per zone/tier, meeting decision).
 *
 * Two write paths, deliberately kept apart. The bulk `upsertShippingRates` (the
 * PUT) edits a whole table of tiers at once and is keyed on
 * (zone, threshold_qty); the single-row create/patch below are keyed on `id`,
 * because a CRM screen edits one row and must be told when it collides with an
 * existing tier rather than silently overwriting it.
 */

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The projection every read here returns. `id` is what a single-row PATCH or
// DELETE addresses — the zone/threshold pair is the identity key and is not
// editable, so it can never be used as a stable address.
const RATE_COLUMNS = 'id, zone, threshold_qty, rate_cents'

// threshold_qty is numeric(12,2), which pg hands back as a string ('20.00').
const toShippingRate = (row) => ({
  id: row.id,
  zone: row.zone,
  threshold_qty: Number(row.threshold_qty),
  rate_cents: row.rate_cents,
})

/**
 * Resolve a shipping quote for a zone + quantity.
 * Returns the applicable tier, or null when the zone is unknown.
 *
 * @param {import('pg').Pool} pool
 * @param {{ zone: string, qty: number }} params
 * @returns {Promise<null | { zone: string, qty: number, threshold_qty: number, rate_cents: number }>}
 */
export const getShippingQuote = async (pool, { zone, qty }) => {
  const { rows } = await pool.query(
    `SELECT threshold_qty, rate_cents
       FROM shipping_rates
      WHERE zone = $1
      ORDER BY threshold_qty ASC`,
    [zone]
  )
  if (rows.length === 0) {
    return null
  }

  // Highest tier whose floor is <= qty; fall back to the lowest tier when qty
  // sits below every floor (shouldn't happen while a 0-floor tier exists).
  let applicable = rows[0]
  for (const row of rows) {
    if (Number(row.threshold_qty) <= qty) {
      applicable = row
    }
  }

  return {
    zone,
    qty,
    threshold_qty: Number(applicable.threshold_qty),
    rate_cents: applicable.rate_cents,
  }
}

/**
 * Upsert a batch of shipping-rate tiers (admin edit, no redeploy).
 * Keyed on (zone, threshold_qty) — existing tiers get new rate_cents.
 *
 * @param {import('pg').Pool} pool
 * @param {Array<{ zone: string, threshold_qty: number, rate_cents: number }>} rates
 * @returns {Promise<Array<{ zone: string, threshold_qty: number, rate_cents: number }>>}
 */
export const upsertShippingRates = async (pool, rates) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const rate of rates) {
      await client.query(
        `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
         VALUES ($1, $2, $3)
         ON CONFLICT (zone, threshold_qty)
         DO UPDATE SET rate_cents = EXCLUDED.rate_cents`,
        [rate.zone, rate.threshold_qty, rate.rate_cents]
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }

  return listShippingRates(pool)
}

/**
 * All shipping-rate tiers, zone then threshold ascending.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{ id: number, zone: string, threshold_qty: number, rate_cents: number }>>}
 */
export const listShippingRates = async (pool) => {
  const { rows } = await pool.query(
    `SELECT ${RATE_COLUMNS}
       FROM shipping_rates
      ORDER BY zone ASC, threshold_qty ASC`
  )
  return rows.map((row) => toShippingRate(row))
}

/**
 * Add one tier. A duplicate (zone, threshold_qty) is a 409 rather than an
 * upsert: the bulk PUT is the "make it so" path, and a create that silently
 * overwrote an existing rate would let a mistyped threshold replace a live tier
 * with no trace.
 *
 * @param {import('pg').Pool} pool
 * @param {{ zone: string, threshold_qty: number, rate_cents: number }} input
 * @returns {Promise<{ id: number, zone: string, threshold_qty: number, rate_cents: number }>}
 */
export const createShippingRate = async (pool, { zone, threshold_qty, rate_cents }) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
       VALUES ($1, $2, $3)
       RETURNING ${RATE_COLUMNS}`,
      [zone, threshold_qty, rate_cents]
    )
    return toShippingRate(rows[0])
  } catch (error) {
    // The table has exactly one unique constraint, so an unrecognised
    // constraint name still means the same collision; it degrades the message,
    // never the status (the rethrowConflict posture).
    if (error?.code === '23505') {
      throw httpError(
        409,
        `"${zone}" already has a tier at ${threshold_qty}. Edit that tier's rate instead.`
      )
    }
    throw error
  }
}

/**
 * Patch a tier's price. `rate_cents` is the only editable column: (zone,
 * threshold_qty) is the identity key the quote resolves against and the seed
 * upserts on, so moving either is a delete plus a create, not an edit.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ rate_cents: number }} input
 * @returns {Promise<{ id: number, zone: string, threshold_qty: number, rate_cents: number }>}
 */
export const updateShippingRate = async (pool, id, { rate_cents }) => {
  const { rows } = await pool.query(
    `UPDATE shipping_rates SET rate_cents = $1
      WHERE id = $2
      RETURNING ${RATE_COLUMNS}`,
    [rate_cents, id]
  )
  if (rows.length === 0) {
    throw httpError(404, `Shipping rate ${id} not found.`)
  }
  return toShippingRate(rows[0])
}
