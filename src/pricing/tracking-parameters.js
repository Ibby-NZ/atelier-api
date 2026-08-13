// The incumbent's pricing parameters, read out of `legacy_tracking_options`
// (W16 US-002). Read-only: this module never writes to the staging mirror.
//
// STAGING KEEPS THE SOURCE'S NAMES; THIS IS WHERE THE READING LIVES. Two of the
// source's columns are mislabelled and the migration deliberately did not
// correct them (`src/legacy/CLAUDE.md`: staging mirrors D365):
//
//   - `clearance` is a PERCENTAGE. It is the only one of the four percentage
//     columns whose display name carries no "(%)", and it multiplies
//     (duty-paid value + freight), not the goods alone — verified on 19,197 of
//     19,201 price rows. Read as dollars it turns a $10 clearance into a $1
//     error on a cheap fabric and a $50 error on an expensive one, in the same
//     direction as the real fee, so it looks plausible everywhere. It comes out
//     of here as `clearance_percent`.
//   - `freight` is DOLLARS PER UNIT and never was a percentage. It comes out as
//     `freight_per_unit`, and the unit is the range's own pack type, which this
//     table does not state — see FR-187 and `supplier_freight_rates.unit`.
//
// BLANK MEANS THREE DIFFERENT THINGS AND ONE COALESCE FOR ALL OF THEM IS WRONG.
//
//   - blank `discount` is ZERO. All 4,638 rows belonging to a blank-discount
//     range show an export/wholesale ratio of exactly 1.000. `discount_stated`
//     carries the provenance so a reader can still tell the two apart.
//   - a blank DUTY LETTER on the price row is 0%, verified on all 17,749 such
//     rows. That resolution is `dutyPercentFor` below, not a column here.
//   - blank `freight` is UNKNOWN. HAMAM's is empty while its own price rows
//     imply $50/$17/$9/$5 by letter. It stays null and never becomes zero:
//     `Number(null)` is 0 and a zero freight rate reads as free shipping from
//     Italy.
//
// A `Type` ROW IS A VOCABULARY ENTRY, NOT A RATE. All ten numeric columns and
// the supplier column are empty on all 17 of them, verified cell by cell — Type
// exists to tag a line for Xero reporting and every pricing parameter in the
// incumbent hangs off the Range. So the parameter read model reads Range rows
// ONLY. An importer or a reader that loops "for each tracking option, read its
// rates" produces 17 rows of nulls that read as duty-free.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/** The tracking category that carries every parameter in the file. */
export const RANGE_CATEGORY = 'Range'
/** The one that carries none. Exported so a caller can say why it is excluded. */
export const TYPE_CATEGORY = 'Type'

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 200

// pg hands `numeric` back as a string, and `Number(null)` is 0 — which on a
// duty band, a markup or a freight figure is a wrong number that looks right.
const numeric = (value) => (value == null ? null : Number(value))

const PARAMETER_COLUMNS = `guid, tracking_category, name, supplier,
  duty_rate_a, duty_rate_b, duty_rate_c, clearance, freight, discount,
  trade_markup, min_qty_to_avoid_surcharge, surcharge_per_unit,
  status, modified_on`

/**
 * One staged row as a parameter set. Frozen, and built fresh — never a mutation
 * of the row pg handed back.
 */
const toParameters = (row) =>
  Object.freeze({
    guid: row.guid,
    name: row.name,
    // A lookup exported as its target's DISPLAY NAME: the invoicing entity, and
    // the supplier -> brand roll-up A13 asked for, but not a join key (8 of 28
    // match a live supplier, `supplier_aliases` is empty, `short_code` and
    // `d365_token` are NULL on all 40 rows). `name` is the key.
    supplier: row.supplier,

    // The duty LETTER is on the price row and the RATE is on the range: both
    // are needed and neither is sufficient. A band that is blank means the
    // range has NO DEFINED DUTY for that letter, not 0% — see dutyPercentFor.
    duty_rate_a: numeric(row.duty_rate_a),
    duty_rate_b: numeric(row.duty_rate_b),
    duty_rate_c: numeric(row.duty_rate_c),

    clearance_percent: numeric(row.clearance),
    // Dollars per unit. NULL is UNKNOWN and must never be read as free.
    freight_per_unit: numeric(row.freight),

    discount_percent: row.discount == null ? 0 : Number(row.discount),
    discount_stated: row.discount != null,

    trade_markup_percent: numeric(row.trade_markup),

    // Stated at this grain on 6 of 58 ranges and at ITEM grain on 992 stock
    // items, and the two disagree — 935 of those items belong to a range with
    // no rule here. Neither is a default for the other; both are reported.
    min_qty_to_avoid_surcharge: numeric(row.min_qty_to_avoid_surcharge),
    surcharge_per_unit: numeric(row.surcharge_per_unit),

    status: row.status,
    modified_on: row.modified_on,
  })

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

/**
 * The parameter sets, one per (house x product line) Atelier prices
 * differently. Range rows only — see the header on Type.
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, page?: number, limit?: number }} [options]
 * @returns {Promise<{ parameters: object[], total: number }>}
 */
export const listRangeParameters = async (pool, { q, page, limit } = {}) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT

  const params = [RANGE_CATEGORY]
  let where = 'WHERE tracking_category = $1'
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    where += ` AND (name ILIKE $${params.length} ESCAPE '\\'
      OR supplier ILIKE $${params.length} ESCAPE '\\')`
  }

  const { rows: counted } = await pool.query(
    `SELECT count(*)::int AS total FROM legacy_tracking_options ${where}`,
    params
  )
  const { rows } = await pool.query(
    `SELECT ${PARAMETER_COLUMNS} FROM legacy_tracking_options
     ${where}
     ORDER BY name ASC, guid ASC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, (safePage - 1) * safeLimit]
  )

  return { parameters: rows.map(toParameters), total: counted[0].total }
}

/**
 * One range's parameters by name, case-insensitively — `name` is a spelling and
 * it is the join key into all three range corpora (99.6% of the priced rows).
 * Null when the range has no parameter row at all, which is a real state:
 * BOUSSAC has 64 priced rows, 43 stock items and no row here.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export const getRangeParameters = async (db, name) => {
  const { rows } = await db.query(
    `SELECT ${PARAMETER_COLUMNS} FROM legacy_tracking_options
      WHERE tracking_category = $1 AND lower(btrim(name)) = lower(btrim($2))
      ORDER BY guid ASC
      LIMIT 1`,
    [RANGE_CATEGORY, String(name ?? '')]
  )
  return rows[0] ? toParameters(rows[0]) : null
}

/**
 * Every Range name, for a picker. Cheap and unpaginated on purpose: there are
 * 58 of them and there have been 58 since the file was written.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<string[]>}
 */
export const listRangeNames = async (pool) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT name FROM legacy_tracking_options
      WHERE tracking_category = $1 AND name IS NOT NULL
      ORDER BY name ASC`,
    [RANGE_CATEGORY]
  )
  return rows.map((row) => row.name)
}

const BAND_BY_LETTER = Object.freeze({ A: 'duty_rate_a', B: 'duty_rate_b', C: 'duty_rate_c' })

/**
 * The duty percentage a price row's letter resolves to against its range.
 *
 * Returns a REASON rather than a number wherever one cannot be stated, for the
 * same argument the freight resolver makes: a duty of zero is a real rate and a
 * missing one is not, and `Number(null)` cannot tell them apart.
 *
 *   - no parameter row at all -> null, `no_parameters`
 *   - a BLANK letter -> 0, verified on all 17,749 blank-letter rows
 *   - a letter outside A/B/C -> null, `unknown_duty_class` (the corpus carries
 *     only `A`, but the column accepts any single uppercase letter)
 *   - a letter whose band is BLANK -> null, `duty_band_not_set`. Two of the 58
 *     ranges have a blank A band, and a row pointing at one has no defined duty
 *     rather than no duty.
 *
 * Bands B and C are real parameters that NEITHER corpus exercises — not one row
 * in `legacy_product_prices` or `price_list_items` carries `B` or `C` — so
 * nothing validates them and nobody should assume the corpus proves them right.
 *
 * @param {object|null} parameters output of getRangeParameters
 * @param {string|null} letter `price_list_items.duty_class` / `duty_rate`
 * @returns {{ percent: number|null, reason: string|null }}
 */
export const dutyPercentFor = (parameters, letter) => {
  if (!parameters) return { percent: null, reason: 'no_parameters' }

  const stated = typeof letter === 'string' ? letter.trim().toUpperCase() : ''
  if (stated === '') return { percent: 0, reason: null }

  const column = BAND_BY_LETTER[stated]
  if (!column) return { percent: null, reason: 'unknown_duty_class' }

  const band = parameters[column]
  if (band == null) return { percent: null, reason: 'duty_band_not_set' }
  return { percent: band, reason: null }
}

/**
 * The parameter set a landed-cost preview needs, or a 404 naming the range.
 * Thrown rather than returned because a caller that asked for a named range and
 * got null has nothing to preview.
 *
 * @param {{ query: Function }} db
 * @param {string} name
 */
export const requireRangeParameters = async (db, name) => {
  const parameters = await getRangeParameters(db, name)
  if (!parameters) {
    throw httpError(404, `No pricing parameters staged for range "${name}".`)
  }
  return parameters
}
