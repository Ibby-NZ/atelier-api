/**
 * One supplier file, read end to end through its adapter.
 *
 * `sheetReadings` classifies a row; this is what turns a whole workbook into the
 * three things the converter has to report — the colourways, the rows declined
 * and why, and every row that could not be mapped at all.
 *
 * NOTHING IS THROWN FOR A BAD ROW OR A BAD SHEET. A file that cannot be read is
 * a file the operator has to fix, and fixing it means seeing all of it: the
 * first unmappable row is rarely the only one, and a supplier who renamed one
 * column usually renamed three. The converter aborts the file on any error and
 * writes nothing — see scripts/convert-colour-files.js.
 */
import { sheetReadings } from './records.js'
import { sheetRates } from './rates.js'

/** Reason -> how many rows it declined, in first-seen order. */
const tally = (counts, reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1)

/**
 * Count one opened sheet's readings, whatever they are readings OF.
 *
 * `rows` and `records` differ on purpose. Madeaux prints one row per design and
 * names its colours inside a cell, so a row there is worth several colourways;
 * a banner is worth none. The same counting serves the rate pass, where a row is
 * worth one rate or none — what makes either summary trustworthy is that it is
 * exhaustive: rows in = entries out + skips + errors.
 */
const countReadings = (sheet, readings, toEntry) => {
  const entries = []
  const errors = []
  const skips = new Map()
  let rows = 0
  let previous = 0
  for (const reading of readings) {
    if (reading.rowNumber !== previous) rows += 1
    previous = reading.rowNumber
    if (reading.error !== undefined) errors.push(reading.error)
    else if (reading.skip !== undefined) tally(skips, reading.skip)
    else entries.push(toEntry(reading))
  }
  return Object.freeze({
    name: sheet.name,
    headerRow: sheet.headerRow,
    rows,
    records: entries.length,
    skips: Object.freeze([...skips]),
    entries,
    errors,
  })
}

/** One declared colourway sheet. */
export const readSheet = (workbook, spec) => {
  const sheet = workbook.open(spec)
  return countReadings(sheet, sheetReadings(sheet, spec, workbook.source), (reading) => ({
    sheet: sheet.name,
    rowNumber: reading.rowNumber,
    record: reading.record,
  }))
}

/** One declared rate sheet. Its entries are rates, which carry their own coordinate. */
export const readRateSheet = (workbook, spec, supplier) => {
  const sheet = workbook.open(spec)
  return countReadings(
    sheet,
    sheetRates(sheet, spec, workbook.source, supplier),
    (reading) => reading.rate,
  )
}

/**
 * Every declared sheet of one workbook.
 *
 * A sheet that cannot be OPENED — renamed, or its header no longer matching the
 * declared labels — is an error of the same kind as an unmappable row: it is
 * recorded (openSheet's message already begins `file:sheet:`) and the remaining
 * sheets are still read, so one renamed column does not hide the other eight.
 */
const readSheets = (workbook, adapter, specs, read) => {
  const sheets = []
  const entries = []
  const errors = []
  for (const spec of specs) {
    let reading
    try {
      reading = read(workbook, spec)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    sheets.push(reading)
    entries.push(...reading.entries)
    errors.push(...reading.errors)
  }
  return Object.freeze({
    file: workbook.source,
    supplier: adapter.supplier,
    sheets: Object.freeze(sheets),
    entries: Object.freeze(entries),
    errors: Object.freeze(errors),
  })
}

export const readColourFile = (workbook, adapter) =>
  readSheets(workbook, adapter, adapter.sheets, readSheet)

/**
 * Every declared RATE sheet of one workbook, or nothing when the adapter
 * declares none.
 *
 * A file with no `rateSheets` is not an omission to fix here: the de Le Cuona
 * PDF has no extraction path at all, and a workbook that genuinely prints no
 * 2026 rate has nothing to emit. The converter reports the count either way, so
 * a file that silently stopped yielding rates is visible.
 */
export const readRateFile = (workbook, adapter) =>
  readSheets(workbook, adapter, adapter.rateSheets ?? [], (book, spec) =>
    readRateSheet(book, spec, adapter.supplier))
