/**
 * Shipping-rate read/write model.
 *
 * Rates live in `shipping_rates` as (zone, threshold_qty, rate_cents) tiers.
 * `threshold_qty` is the tier floor: a quote picks the highest threshold that
 * is <= the requested qty (flat rate per zone/tier, meeting decision).
 */

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
 * @returns {Promise<Array<{ zone: string, threshold_qty: number, rate_cents: number }>>}
 */
export const listShippingRates = async (pool) => {
  const { rows } = await pool.query(
    `SELECT zone, threshold_qty, rate_cents
       FROM shipping_rates
      ORDER BY zone ASC, threshold_qty ASC`
  )
  return rows.map((row) => ({
    zone: row.zone,
    threshold_qty: Number(row.threshold_qty),
    rate_cents: row.rate_cents,
  }))
}
