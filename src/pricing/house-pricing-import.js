// The Dynamics "Active Tracking Options" workbook, uploaded from the CRM and
// read into the range rows the pricing backfill plans from.
//
// The office exports the tracking options from Dynamics (the file the client
// sent on 25 Sep 2026 is `Active Tracking Options 25-09-2026 10-58-14 AM.xlsx`)
// and drops it on the Houses screen; the API applies each range's figures to
// its house. No shell, no `incoming/`, no staging round trip — the deployed
// API has none of the three, which is the same reason the price-list import
// and the freight sheet are uploads.
//
// ONE READER. The bytes go through scripts/lib/d365-workbook.js, the reader the
// CLI converter uses for the same export, and each record through
// `toRangeParameters`, the mapper the staged rows use — so an uploaded file and
// a staged one cannot be read two ways. Columns are found by their D365
// LOGICAL name, never the display name or the position.
//
// NOTHING HERE WRITES TO `legacy_tracking_options`. Staging mirrors Dynamics
// and is loaded by the director's import; this upload writes the platform's
// own parameters (through parameters-backfill.js) and nothing else.

import { d365WorkbookEntity, readD365Workbook } from '../../scripts/lib/d365-workbook.js'
import { RANGE_CATEGORY, toRangeParameters } from './tracking-parameters.js'

/** The D365 entity the export must be a view of. */
export const TRACKING_OPTION_ENTITY = 'fulmxero_trackingoption'

export const MAX_REPORTED_ERRORS = 50

const refuse = (message, errors = []) =>
  Object.assign(new Error(message), {
    statusCode: 422,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    error_count: errors.length,
  })

// A .xlsx is a zip; anything else is refused before the zip reader has to
// explain itself in its own words.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/**
 * The Range rows of one uploaded tracking-options export, in the shape
 * `listRangeParameters` serves. Throws a 422 carrying `errors` for a file that
 * is not that export, or has a cell that cannot be read.
 *
 * @param {Buffer} buffer the .xlsx bytes
 * @param {string} [filename] the file's name — the export stamp is read from it
 * @returns {{ ranges: object[], exported_at: string|null, rows: number }}
 */
export const readTrackingOptionsWorkbook = (buffer, filename = 'tracking-options.xlsx') => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw refuse('That file is empty.')
  if (!buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    throw refuse(
      'That is not an Excel workbook. Export the tracking options from Dynamics ("Export to Excel") and upload the .xlsx as it arrives.'
    )
  }

  const unreadable = (error) =>
    refuse(
      `That workbook is not a Dynamics export this screen can read (${error.message}). ` +
        'Upload the "Active Tracking Options" export as Dynamics saved it — do not re-save it from Excel.'
    )

  // The entity first: another export would otherwise fail on the column check
  // with a list of every column the tracking options do not have.
  let entity
  try {
    entity = d365WorkbookEntity(buffer)
  } catch (error) {
    throw unreadable(error)
  }
  if (entity !== TRACKING_OPTION_ENTITY) {
    throw refuse(
      `That is a Dynamics "${entity}" export, not the tracking options. ` +
        'Export the tracking options (the Range list with duty, clearance, freight, discount and markup).'
    )
  }

  const errors = []
  let read
  try {
    read = readD365Workbook(buffer, filename, errors)
  } catch (error) {
    throw unreadable(error)
  }
  if (errors.length > 0) {
    throw refuse(
      `${errors.length} cell${errors.length === 1 ? '' : 's'} could not be read. Nothing has been written.`,
      errors
    )
  }

  // Type rows carry no parameter at all (all ten numeric columns empty on all
  // 17), so only Range rows are pricing.
  const ranges = read.records
    .map((record) => Object.fromEntries(record))
    .filter((row) => row.tracking_category === RANGE_CATEGORY)
    .map(toRangeParameters)

  if (ranges.length === 0) {
    throw refuse('That export has no Range rows — nothing in it can be applied to a house.')
  }
  return {
    ranges,
    rows: read.records.length,
    exported_at: read.records[0]?.get('exported_at') ?? null,
  }
}
