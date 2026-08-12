/**
 * Legacy D365 staging — Xero tracking options (`fulmxero_trackingoption`).
 *
 * The twelfth staging table, and the first one that is a PARAMETER set rather
 * than a transaction or a catalogue row: the incumbent's pricing waterfall
 * inputs, one row per (house x product line) Atelier prices differently. Two
 * saved views over the one entity ("Xero Range", 58 rows; "Xero Type", 17) land
 * here together. See docs/xero-tracking-option-analysis.md.
 *
 * Same conventions as 1785628800000_legacy-d365-staging-round-two: D365 GUID
 * primary key, export row checksum, `source_file`, and a `raw` jsonb holding
 * every non-empty source column by logical name. `modified_on` is a naive
 * `timestamp` — the export writes Excel serials rendered in the exporting user's
 * local time. This view carries no owner/created-by/status-reason tail, so the
 * STAMPS block of its siblings is not spread here; `status` and `modified_on`
 * are all it exports.
 *
 * The columns keep the SOURCE's names and the source's polarity, which matters
 * more here than usual because two of them are mislabelled at the source:
 *
 *  - `clearance` is a PERCENTAGE, though its display name is the only one of the
 *    four percentage columns with no "(%)" suffix. It multiplies (duty-paid
 *    value + freight), verified on 19,197 of 19,201 price rows.
 *  - `freight` is DOLLARS PER UNIT, and the unit is the range's pack type
 *    (per roll, per hide, per metre). It is not, and never was, a percentage.
 *
 * Renaming either to say so — `clearance_percent`, freight in cents — would be
 * this layer stating an interpretation. Staging mirrors D365; the reading lives
 * downstream, exactly as `do_not_email` keeps D365's polarity rather than the
 * "Allow" its own UI prints. The rates are `numeric` for the same reason: they
 * are foreign fractional parameters, not the storefront's integer-cents money.
 *
 * `name` and `tracking_category` are the lookup keys and are indexed. `name`
 * joins `legacy_product_prices.range_name` on 48 of 58 rows, covering 99.6% of
 * the priced corpus; `tracking_category` is what separates the 58 Range rows
 * (every parameter in the file) from the 17 Type rows (no parameters at all).
 * `supplier` is not indexed: it is a lookup exported as a display name, so it is
 * a label rather than a key until the view carries the account number.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */

const AUDIT = {
  source_file: { type: 'text', notNull: true },
  exported_at: { type: 'timestamp' },
  raw: { type: 'jsonb', notNull: true },
  imported_at: { type: 'timestamptz', notNull: true, default: 'now()' },
}

const KEY = {
  guid: { type: 'uuid', primaryKey: true },
  row_checksum: { type: 'text' },
}

const MONEY = { type: 'numeric(18,4)' }
const QTY = { type: 'numeric(18,4)' }
// Percentages follow `manual_duty_pct` / `manual_markup_to_trade_pct`.
const PCT = { type: 'numeric(18,6)' }

export const up = (pgm) => {
  pgm.createTable('legacy_tracking_options', {
    ...KEY,
    // 'Range' or 'Type'. Type rows carry no parameter at all — an importer that
    // loops "for each tracking option, read its rates" writes 17 rows of nulls.
    tracking_category: { type: 'text' },
    name: { type: 'text' },
    // A lookup rendered as the target's display name: the invoicing entity, and
    // the supplier -> brand roll-up A13 asks for, but not a join key.
    supplier: { type: 'text' },

    // The duty LETTER lives on the price row; this is that letter's rate table,
    // per range. Blank letter reads as 0%. B and C are unexercised by either
    // corpus — real parameters, no rows behind them.
    duty_rate_a: PCT,
    duty_rate_b: PCT,
    duty_rate_c: PCT,
    // A percentage despite the label (see above), 10 on 56 of 58 ranges.
    clearance: PCT,
    // Dollars per unit (see above). Blank means UNKNOWN here, unlike blank
    // `discount` and a blank duty letter, which both mean zero.
    freight: MONEY,
    discount: PCT,
    trade_markup: PCT,

    // Stated at this grain on 6 of 58 rows and at item grain on 992 stock items,
    // and the two disagree. Staged as found; neither is a default for the other.
    min_qty_to_avoid_surcharge: QTY,
    surcharge_per_unit: MONEY,

    status: { type: 'text' },
    modified_on: { type: 'timestamp' },
    ...AUDIT,
  })
  pgm.createIndex('legacy_tracking_options', 'name')
  pgm.createIndex('legacy_tracking_options', 'tracking_category')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('legacy_tracking_options')
}
