// The Dynamics "Active Product Prices" export, uploaded from the CRM and
// landed in `product_prices` (migration 1791926400000).
//
// The office exports the product prices from Dynamics (the file the client
// sent on 25 Sep 2026 is `Active Product Prices 25-09-2026 12-07-28 PM.xlsx`,
// 21,102 rows) and drops it on the Product prices screen. Validate and apply
// are two routes; apply re-reads the file and re-plans against the live state.
//
// NOTHING HERE WRITES TO A `legacy_*` TABLE. The Dynamics archive holds the
// full product price export with every column; this is a narrower view of the
// same records, and the client asked that the archive be left exactly as it is.
//
// WHY A READER OF ITS OWN. scripts/lib/d365-workbook.js reads an export by the
// archive's column map and refuses a file missing any of its forty-five
// columns — which is every file of this view (sixteen columns). The envelope is
// the same, and so is the rule that matters: columns are found by their D365
// LOGICAL name, never the display name a user can rename or the position.
//
// A FILE WITH ANY BAD ROW IS REFUSED WHOLE, the price-list import's rule, so
// "nothing was dropped" is literally true. A range with no house is NOT a bad
// row: the product lands and prices the moment the house exists, and the plan
// lists every such range.
//
// THE EXCHANGE RATES COME FROM THE EXPORT. It has no rate column, but every
// row states both ends of the exchange: price ex duty = wholesale × (1 −
// range discount) ÷ rate. Voting that per currency, over rows whose house has
// a resolved discount, gives EUR 0.45, USD 0.51 and GBP 0.38 on 97–100% of
// rows — Dynamics' annual table. A currency with no rate on the platform gets
// the voted one (fill-only); a rate finance has set is never replaced, and a
// disagreement is reported for them to decide on the Pricing screen.

import { openWorkbook, sharedStrings, sheetRows, excelDate, excelTimestamp } from '../../scripts/lib/xlsx.js'
import { parseNumber } from '../../scripts/lib/python-format.js'
import { exportedAt } from '../../scripts/lib/d365-workbook.js'
import { CURRENCY_MAP } from '../../scripts/lib/price-template.js'
import { upsertFxRate } from './pricing-parameters.js'
import { AGREEMENT_TOLERANCE, HOME_CURRENCY, createProductPricer, nameKey } from './product-prices.js'

/** The D365 entity the export must be a view of. */
export const PRODUCT_PRICE_ENTITY = 'atelier_productprices'
export const TRACKING_OPTION_ENTITY = 'fulmxero_trackingoption'

export const MAX_REPORTED_ERRORS = 50
export const MAX_REPORTED_CHANGES = 50

/** A voted rate is filled only when this share of its currency's rows agrees. */
export const FX_AGREEMENT = 0.9

const SCHEMA_SHEET = 'xl/worksheets/sheet.xml'
const DATA_SHEET = 'xl/worksheets/sheet2.xml'
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TEXT = 'text'
const NUM = 'num'
const DATE = 'date'
const DATETIME = 'datetime'

/** D365 logical name -> [field, kind]. The view's sixteen columns. */
export const PRODUCT_PRICE_COLUMNS = Object.freeze({
  atelier_productpricesid: ['guid', TEXT],
  checksumLogicalName: ['row_checksum', TEXT],
  modifiedon: ['dynamics_modified_on', DATETIME],
  atelier_description: ['description', TEXT],
  fulmxero_trackingoption1id: ['range_name', TEXT],
  atelier_code: ['code', TEXT],
  fulmxero_trackingoption2id: ['item_type', TEXT],
  atelier_tradesellpricenz: ['dynamics_trade_sell', NUM],
  atelier_dateeffective: ['date_effective', DATE],
  transactioncurrencyid: ['currency_name', TEXT],
  atelier_wholesalerate: ['wholesale_rate', NUM],
  atelier_verticalrepeat: ['vertical_repeat', TEXT],
  atelier_repeat: ['horizontal_repeat', TEXT],
  atelier_priceexdutynz: ['dynamics_price_ex_duty', NUM],
  atelier_priceincldutynz: ['dynamics_price_incl_duty', NUM],
  atelier_freightrate: ['freight_letter', TEXT],
})

/** Without these a row cannot be stored or priced. The rest are optional. */
export const REQUIRED_COLUMNS = Object.freeze([
  'atelier_productpricesid',
  'atelier_code',
  'fulmxero_trackingoption1id',
  'atelier_wholesalerate',
  'transactioncurrencyid',
])

/** The stored columns, in the order the upsert binds them. */
export const STORED_FIELDS = Object.freeze([
  'guid',
  'code',
  'description',
  'range_name',
  'item_type',
  'currency',
  'wholesale_rate',
  'date_effective',
  'horizontal_repeat',
  'vertical_repeat',
  'freight_letter',
  'duty_class',
  'dynamics_price_ex_duty',
  'dynamics_price_incl_duty',
  'dynamics_trade_sell',
  'dynamics_modified_on',
  'row_checksum',
])

const FIELD_TYPES = Object.freeze({
  guid: 'uuid',
  wholesale_rate: 'numeric',
  date_effective: 'date',
  dynamics_price_ex_duty: 'numeric',
  dynamics_price_incl_duty: 'numeric',
  dynamics_trade_sell: 'numeric',
  dynamics_modified_on: 'timestamp',
})

const refuse = (message, errors = []) =>
  Object.assign(new Error(message), {
    statusCode: 422,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    error_count: errors.length,
  })

// "\nELLA STRIPE\n" is how the export writes a code; 92 carry a line break
// inside. A code is one line.
const oneLine = (value) => value.replace(/\s+/g, ' ').trim()

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100
const round3 = (value) => Math.round((value + Number.EPSILON) * 1000) / 1000
const round4 = (value) => Math.round((value + Number.EPSILON) * 10000) / 10000

/** "Pound Sterling" -> GBP. NZ$ is the home currency, not a price-list one. */
export const currencyCode = (name) => {
  const key = String(name ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
  if (key === 'new zealand dollar' || key === 'nzd') return HOME_CURRENCY
  return CURRENCY_MAP.get(key) ?? null
}

/**
 * Dynamics charged duty on a row when its two prices differ (1.05 on every
 * dutied row of the 25 Sep export). The narrow view carries no Duty Rate
 * letter, and the only letter the corpus has ever used is A.
 */
export const inferDutyClass = (exDuty, inclDuty) =>
  exDuty != null && inclDuty != null && exDuty > 0 && inclDuty - exDuty > exDuty * 0.005 ? 'A' : null

// The first cell of sheet.xml: '<entity>:<signature>:<logical>=<Display>&...'.
const readSchema = (zip, strings) => {
  for (const [, cells] of sheetRows(zip, SCHEMA_SHEET, strings)) {
    const header = cells.get(0) ?? ''
    const first = header.indexOf(':')
    const second = header.indexOf(':', first + 1)
    if (first === -1 || second === -1) break
    return {
      entity: header.slice(0, first),
      logicalNames: header.slice(second + 1).split('&').map((pair) => pair.split('=')[0]),
    }
  }
  throw new Error('no D365 schema map in sheet.xml — is this a dynamic worksheet export?')
}

const coerce = (value, kind) => {
  if (kind === NUM) return parseNumber(value)
  if (kind === DATE) return excelDate(parseNumber(value))
  if (kind === DATETIME) return excelTimestamp(parseNumber(value))
  return oneLine(value)
}

/**
 * The rows of one uploaded product-prices export, ready to store. Throws a 422
 * carrying `errors` for a file that is not that export or has a row that
 * cannot be read.
 *
 * @param {Buffer} buffer the .xlsx bytes
 * @param {string} [filename] the file's name — the export stamp is read from it
 * @returns {{ rows: object[], rows_read: number, exported_at: string|null }}
 */
export const readProductPricesWorkbook = (buffer, filename = 'product-prices.xlsx') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw refuse('That file is empty.')
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw refuse(
      'That is not an Excel workbook. Export the product prices from Dynamics ("Export to Excel") and upload the .xlsx as it arrives.'
    )
  }
  const unreadable = (error) =>
    refuse(
      `That workbook is not a Dynamics export this screen can read (${error.message}). ` +
        'Upload the "Active Product Prices" export as Dynamics saved it — do not re-save it from Excel.'
    )

  let zip
  let strings
  let schema
  try {
    zip = openWorkbook(buffer)
    strings = sharedStrings(zip)
    schema = readSchema(zip, strings)
  } catch (error) {
    throw unreadable(error)
  }
  if (schema.entity === TRACKING_OPTION_ENTITY) {
    throw refuse(
      'That is the tracking options (ranges) export. Upload it on a house page under Houses — this screen takes the product prices.'
    )
  }
  if (schema.entity !== PRODUCT_PRICE_ENTITY) {
    throw refuse(
      `That is a Dynamics "${schema.entity}" export, not the product prices. ` +
        'Export the product prices (the Code, Range, Wholesale Rate and Currency list).'
    )
  }
  const missing = REQUIRED_COLUMNS.filter((column) => !schema.logicalNames.includes(column))
  if (missing.length > 0) {
    throw refuse(
      `That export is missing ${missing.length === 1 ? 'a column' : 'columns'} the prices need: ${missing.join(', ')}. ` +
        'Add them to the Dynamics view and export again.'
    )
  }

  const errors = []
  const rows = []
  const seen = new Map()
  let rowsRead = 0
  try {
    for (const [line, cells] of sheetRows(zip, DATA_SHEET, strings)) {
      if (line === 1) continue // the display-name header row
      const errorsBefore = errors.length
      const record = {}
      for (const [index, logical] of schema.logicalNames.entries()) {
        const mapped = PRODUCT_PRICE_COLUMNS[logical]
        if (!mapped) continue
        const value = String(cells.get(index) ?? '').trim()
        if (value === '') continue
        const [field, kind] = mapped
        try {
          record[field] = coerce(value, kind)
        } catch (error) {
          errors.push(`row ${line}: ${field.replace(/_/g, ' ')}: ${error.message}`)
        }
      }
      // A trailing blank row is formatting, not a record.
      if (Object.keys(record).length === 0 && errors.length === errorsBefore) continue
      rowsRead += 1
      // A cell that did not read has been reported already; its row is not
      // checked a second time over the same field.
      if (errors.length > errorsBefore) continue

      const problems = []
      if (!record.guid || !UUID.test(record.guid)) problems.push('no Dynamics record id')
      if (!record.code) problems.push('no code')
      if (!record.range_name) problems.push('no range')
      if (record.wholesale_rate == null) problems.push('no wholesale rate')
      else if (record.wholesale_rate < 0) problems.push('a negative wholesale rate')
      const currency = currencyCode(record.currency_name)
      if (!currency) problems.push(`a currency this platform does not price in ("${record.currency_name ?? ''}")`)
      if (record.guid && seen.has(record.guid.toLowerCase())) {
        problems.push(`the same Dynamics record as row ${seen.get(record.guid.toLowerCase())}`)
      }
      if (problems.length > 0) {
        errors.push(`row ${line}${record.code ? ` (${record.code})` : ''}: ${problems.join(', ')}`)
        continue
      }
      seen.set(record.guid.toLowerCase(), line)

      rows.push(
        Object.freeze({
          guid: record.guid.toLowerCase(),
          code: record.code,
          description: record.description ?? null,
          range_name: record.range_name,
          item_type: record.item_type ?? null,
          currency,
          wholesale_rate: round4(record.wholesale_rate),
          date_effective: record.date_effective ?? null,
          horizontal_repeat: record.horizontal_repeat ?? null,
          vertical_repeat: record.vertical_repeat ?? null,
          freight_letter: record.freight_letter ? record.freight_letter.toUpperCase() : null,
          duty_class: inferDutyClass(record.dynamics_price_ex_duty ?? null, record.dynamics_price_incl_duty ?? null),
          dynamics_price_ex_duty: record.dynamics_price_ex_duty == null ? null : round2(record.dynamics_price_ex_duty),
          dynamics_price_incl_duty: record.dynamics_price_incl_duty == null ? null : round2(record.dynamics_price_incl_duty),
          dynamics_trade_sell: record.dynamics_trade_sell == null ? null : round2(record.dynamics_trade_sell),
          dynamics_modified_on: record.dynamics_modified_on ?? null,
          row_checksum: record.row_checksum ?? null,
        })
      )
    }
  } catch (error) {
    throw unreadable(error)
  }

  if (errors.length > 0) {
    throw refuse(
      `${errors.length} row${errors.length === 1 ? '' : 's'} could not be read. Nothing has been written.`,
      errors
    )
  }
  if (rows.length === 0) throw refuse('That export has no product rows.')
  return Object.freeze({
    rows: Object.freeze(rows),
    rows_read: rowsRead,
    exported_at: exportedAt(filename.replace(/\.xlsx$/i, '')),
  })
}

// --- planning -----------------------------------------------------------------

const STORED_SELECT = `SELECT guid::text AS guid, code, description, range_name, item_type,
  currency, wholesale_rate, to_char(date_effective, 'YYYY-MM-DD') AS date_effective,
  horizontal_repeat, vertical_repeat, freight_letter, duty_class,
  dynamics_price_ex_duty, dynamics_price_incl_duty, dynamics_trade_sell,
  to_char(dynamics_modified_on, 'YYYY-MM-DD HH24:MI:SS') AS dynamics_modified_on, row_checksum
  FROM product_prices`

const NUMERIC_FIELDS = new Set(['wholesale_rate', 'dynamics_price_ex_duty', 'dynamics_price_incl_duty', 'dynamics_trade_sell'])

// One comparable string per row: numerics at the column's own scale, the rest
// as text, so a re-import of the same file finds every row unchanged.
const fingerprint = (row) =>
  JSON.stringify(
    STORED_FIELDS.map((field) => {
      const value = row[field]
      if (value == null) return null
      return NUMERIC_FIELDS.has(field) ? round4(Number(value)) : String(value)
    })
  )

/**
 * The FX vote: for each currency, the rate the rows imply once their house's
 * discount is taken off, and how many rows agree with the winner.
 */
const voteRates = (priced) => {
  const votes = new Map()
  for (const { row, pricing } of priced) {
    if (row.currency === HOME_CURRENCY) continue
    const discount = pricing.inputs?.discount_percent
    const exDuty = row.dynamics_price_ex_duty
    if (!discount || discount.value == null || !row.wholesale_rate || !exDuty) continue
    const implied = round3((row.wholesale_rate * (1 - discount.value / 100)) / exDuty)
    const tally = votes.get(row.currency) ?? new Map()
    tally.set(implied, (tally.get(implied) ?? 0) + 1)
    votes.set(row.currency, tally)
  }
  const result = new Map()
  for (const [currency, tally] of votes) {
    const total = [...tally.values()].reduce((sum, count) => sum + count, 0)
    const [rate, count] = [...tally].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]
    result.set(currency, { rate, rows: count, voted: total, share: count / total })
  }
  return result
}

/**
 * What applying the file would do. Reads only.
 *
 * @param {{ query: Function }} db
 * @param {{ rows: object[] }} read what readProductPricesWorkbook returned
 */
export const planProductPricesImport = async (db, read) => {
  // --- the rows: new, changed, unchanged, and the ones the file no longer has
  const { rows: stored } = await db.query(STORED_SELECT)
  const existing = new Map(stored.map((row) => [row.guid, row]))
  const inFile = new Set(read.rows.map((row) => row.guid))
  const newRows = []
  const changedRows = []
  const unchangedGuids = []
  const wholesaleChanges = []
  for (const row of read.rows) {
    const before = existing.get(row.guid)
    if (!before) {
      newRows.push(row)
    } else if (fingerprint(before) !== fingerprint(row)) {
      changedRows.push(row)
      if (round4(Number(before.wholesale_rate)) !== round4(row.wholesale_rate) || before.currency !== row.currency) {
        wholesaleChanges.push(
          Object.freeze({
            code: row.code,
            range_name: row.range_name,
            currency: row.currency,
            from: Number(before.wholesale_rate),
            from_currency: before.currency,
            to: row.wholesale_rate,
          })
        )
      }
    } else {
      unchangedGuids.push(row.guid)
    }
  }
  const notInFile = stored.filter((row) => !inFile.has(row.guid)).length

  // --- price every row through its house, as it stands today
  const pricer = createProductPricer(db)
  const priced = []
  for (const row of read.rows) priced.push({ row, pricing: await pricer.price(row) })

  // --- the exchange rates the export implies, against the platform's
  const current = await pricer.loadRates()
  const voted = voteRates(priced)
  const currencies = [...new Set(read.rows.map((row) => row.currency))].sort()
  const fx = currencies.map((currency) => {
    const rows = read.rows.filter((row) => row.currency === currency).length
    if (currency === HOME_CURRENCY) {
      return Object.freeze({ currency, rows, implied: 1, share: 1, current: 1, action: 'home' })
    }
    const vote = voted.get(currency) ?? null
    const rate = current.get(currency) ?? null
    const clear = vote != null && vote.share >= FX_AGREEMENT
    let action
    if (rate) action = clear && Math.abs(rate.rate - vote.rate) > 0.0005 ? 'differs' : 'keep'
    else action = clear ? 'fill' : 'unclear'
    return Object.freeze({
      currency,
      rows,
      implied: vote?.rate ?? null,
      share: vote ? round3(vote.share) : null,
      current: rate?.rate ?? null,
      action,
    })
  })
  const fxFills = fx.filter((line) => line.action === 'fill')

  // --- re-price with the rates this import would fill, so the comparison below
  // is what the office will see after applying
  let final = priced
  if (fxFills.length > 0) {
    const planned = new Map(current)
    for (const line of fxFills) planned.set(line.currency, { rate: line.implied, set_on: null, planned: true })
    const repricer = await pricer.withRates(planned)
    final = []
    for (const row of read.rows) final.push({ row, pricing: await repricer.price(row) })
  }

  // --- by house: how many price, how many agree with Dynamics' own figure
  const byRange = new Map()
  for (const { row, pricing } of final) {
    const key = nameKey(row.range_name)
    const entry = byRange.get(key) ?? {
      range_name: row.range_name,
      house: pricing.house,
      products: 0,
      priced: 0,
      agree: 0,
      differ: 0,
      missing: new Map(),
    }
    entry.products += 1
    if (pricing.status === 'priced') {
      entry.priced += 1
      if (pricing.agrees === true) entry.agree += 1
      if (pricing.agrees === false) entry.differ += 1
    }
    for (const name of pricing.missing) entry.missing.set(name, (entry.missing.get(name) ?? 0) + 1)
    byRange.set(key, entry)
  }
  const ranges = [...byRange.values()]
    .sort((left, right) => left.range_name.localeCompare(right.range_name))
    .map((entry) =>
      Object.freeze({
        ...entry,
        missing: Object.freeze([...entry.missing.keys()].sort()),
      })
    )
  const totals = ranges.reduce(
    (sum, entry) => ({
      priced: sum.priced + entry.priced,
      agree: sum.agree + entry.agree,
      differ: sum.differ + entry.differ,
    }),
    { priced: 0, agree: 0, differ: 0 }
  )

  return Object.freeze({
    rows_read: read.rows_read,
    rows_new: newRows.length,
    rows_changed: changedRows.length,
    rows_unchanged: unchangedGuids.length,
    rows_not_in_file: notInFile,
    wholesale_changes: Object.freeze(wholesaleChanges.slice(0, MAX_REPORTED_CHANGES)),
    wholesale_change_count: wholesaleChanges.length,
    ranges_without_house: Object.freeze(
      ranges
        .filter((entry) => !entry.house)
        .map((entry) => Object.freeze({ range_name: entry.range_name, products: entry.products }))
    ),
    fx: Object.freeze(fx),
    comparison: Object.freeze({
      products: read.rows.length,
      ...totals,
      tolerance: AGREEMENT_TOLERANCE,
      ranges: Object.freeze(ranges),
    }),
    // For apply; not serialised by the route.
    writes: Object.freeze({ newRows, changedRows, unchangedGuids, fxFills }),
  })
}

// --- applying -------------------------------------------------------------------

const CHUNK = 2000

const upsertRows = async (client, rows, importId) => {
  for (let at = 0; at < rows.length; at += CHUNK) {
    const chunk = rows.slice(at, at + CHUNK)
    const columns = STORED_FIELDS.map((field) => chunk.map((row) => row[field] ?? null))
    const unnest = STORED_FIELDS.map((field, index) => `$${index + 1}::${FIELD_TYPES[field] ?? 'text'}[]`)
    const importParam = `$${STORED_FIELDS.length + 1}`
    await client.query(
      `INSERT INTO product_prices (${STORED_FIELDS.join(', ')}, first_import_id, last_import_id)
       SELECT ${STORED_FIELDS.map((field) => `b.${field}`).join(', ')}, ${importParam}, ${importParam}
         FROM unnest(${unnest.join(', ')}) AS b(${STORED_FIELDS.join(', ')})
       ON CONFLICT (guid) DO UPDATE SET
         ${STORED_FIELDS.filter((field) => field !== 'guid').map((field) => `${field} = EXCLUDED.${field}`).join(',\n         ')},
         last_import_id = EXCLUDED.last_import_id,
         updated_at = now()`,
      [...columns, importId]
    )
  }
}

/**
 * Apply the file: one transaction — the import log, every new and changed row,
 * the unchanged rows marked as seen, and the exchange rates the platform had
 * none for.
 *
 * @param {import('pg').Pool} pool
 * @param {{ rows: object[], rows_read: number, exported_at: string|null }} read
 * @param {{ filename: string, userId?: number|null }} meta
 */
export const applyProductPricesImport = async (pool, read, { filename, userId = null }) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // One import at a time: two concurrent uploads would each plan against a
    // table the other is rewriting.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('product_prices_import'))`)
    const plan = await planProductPricesImport(client, read)
    const { rows: logged } = await client.query(
      `INSERT INTO product_price_imports
         (imported_by_user_id, filename, exported_at, rows_read, rows_new, rows_changed, rows_unchanged)
       VALUES ($1, $2, $3::timestamp, $4, $5, $6, $7) RETURNING id`,
      [userId, filename, read.exported_at, plan.rows_read, plan.rows_new, plan.rows_changed, plan.rows_unchanged]
    )
    const importId = logged[0].id
    await upsertRows(client, [...plan.writes.newRows, ...plan.writes.changedRows], importId)
    if (plan.writes.unchangedGuids.length > 0) {
      await client.query(
        `UPDATE product_prices SET last_import_id = $1 WHERE guid = ANY($2::uuid[])`,
        [importId, plan.writes.unchangedGuids]
      )
    }
    // Fill-only, and re-checked here inside the lock: the plan read the rates
    // before this transaction could see a rate finance saved a second ago.
    const filled = []
    for (const line of plan.writes.fxFills) {
      const { rows } = await client.query(`SELECT 1 FROM fx_rates WHERE currency = $1`, [line.currency])
      if (rows.length > 0) continue
      await upsertFxRate(client, line.currency, {
        rate: line.implied,
        note: `From the Dynamics product prices export (${filename})`,
      })
      filled.push(line.currency)
    }
    await client.query('COMMIT')
    return Object.freeze({ import_id: importId, fx_filled: Object.freeze(filled), plan })
  } catch (error) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // surface the original failure
    }
    throw error
  } finally {
    client.release()
  }
}
