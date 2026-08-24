// The supplier report — the sheet jette closes a shipment against.
//
// "When I close a shipment I need to tell them what cuttings I'm expecting …
// if you have a reserve reference then I know what I'm talking about." So the
// grain is the LINE, the scope is ONE supplier, and the population is the OPEN
// statuses only (requested + confirmed): arrived material is here already and
// dispatched/cancelled lines are history. The columns are the office's current
// spreadsheet plus the three it was missing — one colour per line, the
// customer reference out of the comment, and the comment as a column of its
// own that Excel actually shows.
//
// The rows read the SNAPSHOT columns, never a join back to the price list — a
// re-imported rate must not rewrite what was reserved. Dates leave as
// 'YYYY-MM-DD' text (to_char in the SQL), and the CSV goes through
// src/lib/csv.js so a design name starting '=' cannot become a formula in the
// office's Excel.

import { csvRow } from '../lib/csv.js'
import { OPEN_LINE_STATUSES } from './admin-reserves.js'

export const RESERVE_REPORT_CSV_CONTENT_TYPE = 'text/csv; charset=utf-8'

const LINE_ENDING = '\r\n'

// Labels the HOUSES speak — the CFA vocabulary is carried over from D365
// because the supplier's side of the conversation still uses it.
const CFA_LABELS = Object.freeze({
  not_required: 'Not required',
  required: 'Required',
  ordered: 'Ordered',
  received: 'Received',
  approved: 'Approved by client',
})

const STATUS_LABELS = Object.freeze({
  requested: 'Requested',
  confirmed: 'Confirmed',
  arrived: 'Arrived',
  dispatched: 'Dispatched',
  cancelled: 'Cancelled',
})

const KIND_LABELS = Object.freeze({ reserve: 'Reserve', cutting: 'Cutting' })

// Column order follows the office's current sheet so nobody relearns it:
// range and account first, the house's reply late, the new columns beside
// what they used to be squeezed into.
export const RESERVE_REPORT_COLUMNS = Object.freeze(
  [
    { key: 'kind', label: 'Type' },
    { key: 'range_name', label: 'Range' },
    { key: 'account_name', label: 'Customer' },
    { key: 'contact_name', label: 'Customer Contact' },
    { key: 'product_name', label: 'Product' },
    { key: 'product_code', label: 'Code' },
    { key: 'colour', label: 'Colour' },
    { key: 'qty', label: 'Quantity' },
    { key: 'multiplier', label: 'Copies' },
    { key: 'customer_reference', label: 'Customer Ref' },
    { key: 'reserve_number', label: 'Reserve Number' },
    { key: 'reserved_until', label: 'Reserved Until' },
    { key: 'cfa', label: 'CFA' },
    { key: 'status', label: 'Status' },
    { key: 'comment', label: 'Comment' },
    { key: 'owner_name', label: 'Owner' },
    { key: 'requested_on', label: 'Requested' },
  ].map(Object.freeze)
)

/**
 * The open lines owed by one supplier, docket context joined on, oldest
 * request first (the order a chase reads in). Returns the whole envelope the
 * route serves: { supplier, statuses, columns, rows, total }.
 *
 * @param {import('pg').Pool} pool
 * @param {string} supplier — exact snapshot value, as the facet list returns it
 * @returns {Promise<object>}
 */
export const reserveReport = async (pool, supplier) => {
  const { rows } = await pool.query(
    `SELECT l.kind, l.product_name, l.product_code, l.colour, l.qty,
            l.multiplier, l.customer_reference, l.reserve_number,
            to_char(l.reserved_until, 'YYYY-MM-DD') AS reserved_until,
            l.cfa, l.status, l.comment, l.range_name,
            to_char(l.requested_at, 'YYYY-MM-DD') AS requested_on,
            (l.reserved_until IS NOT NULL
              AND l.reserved_until < CURRENT_DATE) AS expired,
            r.account_name, r.contact_name, r.owner_name
       FROM reserve_lines l
       JOIN reserve_requests r ON r.id = l.request_id
      WHERE l.supplier = $1
        AND l.status = ANY($2::text[])
      ORDER BY l.requested_at, l.id`,
    [supplier, [...OPEN_LINE_STATUSES]]
  )

  return Object.freeze({
    supplier,
    statuses: OPEN_LINE_STATUSES,
    columns: RESERVE_REPORT_COLUMNS,
    rows: rows.map((row) =>
      Object.freeze({
        kind: KIND_LABELS[row.kind] ?? row.kind,
        range_name: row.range_name,
        account_name: row.account_name,
        contact_name: row.contact_name,
        product_name: row.product_name,
        product_code: row.product_code,
        colour: row.colour,
        qty: row.qty,
        multiplier: row.multiplier,
        customer_reference: row.customer_reference,
        reserve_number: row.reserve_number,
        reserved_until: row.reserved_until,
        cfa: row.cfa ? CFA_LABELS[row.cfa] ?? row.cfa : null,
        status: STATUS_LABELS[row.status] ?? row.status,
        comment: row.comment,
        owner_name: row.owner_name,
        requested_on: row.requested_on,
        expired: row.expired,
      })
    ),
    total: rows.length,
  })
}

/**
 * Attachment filename — built from the supplier the way the product sheet
 * builds from the slug, because a supplier NAME is free text and can carry a
 * quote or a CR that would break the disposition header.
 */
export const reserveReportFilename = (supplier) => {
  const slug = String(supplier ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `atelier-reserves-${slug || 'supplier'}.csv`
}

/**
 * The CSV: header row, data rows, then a blank row and a short notes block so
 * the file says what it is when it turns up in an inbox weeks later. A
 * multiplier of 1 prints empty — a Copies column full of 1s reads as data.
 */
export const toReserveReportCsv = (report) => {
  const lines = [csvRow(report.columns.map((column) => column.label))]
  for (const row of report.rows) {
    lines.push(
      csvRow(
        report.columns.map((column) => {
          if (column.key === 'multiplier') {
            return row.multiplier > 1 ? row.multiplier : ''
          }
          return row[column.key]
        })
      )
    )
  }
  lines.push('')
  lines.push(csvRow(['Report', 'Reserves & cuttings expected from supplier']))
  lines.push(csvRow(['Supplier', report.supplier]))
  lines.push(csvRow(['Statuses included', report.statuses.join(', ')]))
  lines.push(csvRow(['Rows', report.total]))
  return lines.join(LINE_ENDING) + LINE_ENDING
}
