// The report CSV writer — the form a report leaves the building in.
//
// It takes a MASKED report envelope and nothing else, which is what makes the
// file and the screen incapable of disagreeing: the same builder produced both,
// maskReport narrowed both, and this module only re-renders what survived. It
// issues no query, decides no access and knows no report by name.
//
// Four properties it exists to hold:
//
//   - THE COLUMNS ARE THE ENVELOPE'S. The header row is `columns.map(label)` and
//     every cell is read by that column's key, in that order — so a finance
//     column maskReport deleted has no header here and no value anywhere in the
//     file. There is no second list of what a report contains.
//
//   - EVERY CELL GOES THROUGH `csvCell` (src/lib/csv.js). Design and house names
//     are staff-typed free text via PATCH /admin/products and the file is built
//     to open in Excel, where a name beginning `=` is live code. Nothing here
//     may pre-format a value into a string and hand it over already joined.
//
//   - THE FILE SAYS WHAT IT IS. A CSV is the copy that leaves the building, and
//     one that does not state its coverage, its filters and what was withheld
//     from it is read as covering everything. Those notes go BELOW the data:
//     the header has to stay on line 1 for anything reading the file
//     mechanically, and in a spreadsheet they sit under the table where a reader
//     looks for a footnote anyway.
//
//   - A `money` COLUMN IS WRITTEN IN UNITS, NOT CENTS. `kind` is declared once
//     for the table and the file alike (src/reports/access.js), and 100000 in a
//     column labelled "Sales" is a wrong figure to every human who opens it.
//     The row carries its own `currency` column; this writer never guesses one.
//
// Consequence to know: `csvCell` neutralises a leading `-`, so a negative money
// figure is written `'-50.00` and Excel shows it as text. That is the formula
// guard working as designed and is deliberately not special-cased here — the
// guard is widened in one place or not at all. No report emits a negative today.

import { csvRow } from '../lib/csv.js'

export const REPORT_CSV_CONTENT_TYPE = 'text/csv; charset=utf-8'

// CRLF and a trailing newline, matching the trade price-list download: a file
// that ends mid-row makes some importers drop the last one.
const LINE_ENDING = '\r\n'

// A report's own name, which is a module constant in every report file rather
// than anything a caller sends. Checked anyway, because it reaches a
// Content-Disposition header: a plain Error (a 500) is the right answer to a
// code literal that has stopped being filename-safe, exactly as requireEntity
// answers an unknown registry key.
const REPORT_NAME = /^[a-z][a-z0-9-]*$/

/**
 * The download filename.
 *
 * @param {object} report a built report envelope
 * @returns {string}
 */
export const reportCsvFilename = (report) => {
  const name = report?.report
  if (typeof name !== 'string' || !REPORT_NAME.test(name)) {
    throw new Error(`Report name is not filename-safe: ${JSON.stringify(name)}`)
  }
  return `atelier-${name}.csv`
}

// Cents to units, at the scale the office reads. A non-numeric value is handed
// on untouched rather than becoming NaN — a wrong-looking cell is recoverable,
// where "NaN" in a money column is not.
const moneyCell = (value) => {
  const cents = Number(value)
  return Number.isFinite(cents) ? (cents / 100).toFixed(2) : value
}

// An absent key is an empty cell, never a zero. A totals row deliberately omits
// a figure that cannot be added (metres and units do not sum), and writing 0
// there would state a total nobody computed.
const cellOf = (row, column) => {
  const value = row?.[column.key]
  if (value === undefined || value === null) {
    return null
  }
  return column.kind === 'money' ? moneyCell(value) : value
}

// What was asked for, in the file that answers it. `filters` is the frozen
// output of parseReportFilters, so every value here has already been validated
// into its canonical shape.
const filterSummary = (filters) => {
  const entries = Object.entries(filters ?? {})
  if (entries.length === 0) {
    return 'none'
  }
  return entries
    .map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(', ') : value}`)
    .join('; ')
}

/**
 * The note rows under the table. The first is empty, which is what separates
 * them from the data in a spreadsheet.
 */
const notesOf = (report) => {
  const meta = report?.meta ?? {}
  const notes = [[], ['Report', report?.title ?? report?.report], ['Filters', filterSummary(meta.filters)]]

  // A filter the report could not honour (a date range on the stock snapshot,
  // say) narrowed nothing, so it is absent from `Filters` above — and a reader
  // who typed one would take that as the file having been filtered by it. Named
  // here for the same reason the withheld columns are.
  const ignored = meta.ignored_filters ?? []
  if (ignored.length > 0) {
    notes.push(['Filters ignored', ignored.join(', ')])
  }

  if (meta.coverage?.note) {
    notes.push(['Coverage', meta.coverage.note])
  }

  // Labels only, because that is all maskReport put on the payload — the KEY of
  // a withheld figure is the machine name of something this caller may not have.
  // Saying so is what stops a masked export reading as a complete one.
  const masked = meta.masked_columns ?? []
  if (masked.length > 0) {
    notes.push(['Columns withheld', masked.join(', ')])
  }

  return notes
}

/**
 * Render a masked report envelope as CSV: the column labels, every row, the
 * totals row, then the notes.
 *
 * The totals row is a row — its label travels as data in the report's own first
 * columns — so it needs no second rule here and a figure it deliberately lacks
 * comes out as an empty cell.
 *
 * @param {object} report the output of maskReport
 * @returns {string}
 */
export const toReportCsv = (report) => {
  const columns = report?.columns
  if (!Array.isArray(columns) || columns.length === 0) {
    // A code fault, not a caller's: without columns there is no header and no
    // cell order, and a file built from the rows' own keys would vary per row.
    throw new Error(`Report "${report?.report ?? 'unknown'}" declares no columns.`)
  }

  const lines = [csvRow(columns.map((column) => column.label))]

  for (const row of report.rows ?? []) {
    lines.push(csvRow(columns.map((column) => cellOf(row, column))))
  }

  if (report.totals) {
    lines.push(csvRow(columns.map((column) => cellOf(report.totals, column))))
  }

  for (const note of notesOf(report)) {
    lines.push(csvRow(note))
  }

  return `${lines.join(LINE_ENDING)}${LINE_ENDING}`
}
