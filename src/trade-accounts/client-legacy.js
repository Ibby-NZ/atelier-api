// The client-facing window on the D365 staging tables: a trade client's own
// cuttings (samples) and invoices.
//
// This is the SAME data the CRM browses through /admin/legacy/*, but it is a
// separate read model on purpose and must stay one. The admin reads exist to
// show staff everything, and `getLegacy` returns the whole `raw` jsonb
// alongside the whitelisted columns — which bypasses every column list there is.
// Widening an admin guard to serve the portal, or reusing an admin projection
// here, would ship the source record verbatim to an external party. The columns
// below are enumerated by hand, and each one is a decision.
//
// SCOPING. Every statement opens with the VIEWER_CTE and joins through it, so
// the predicate is derived from `$1 = the authenticated user id` inside the SQL.
// No function here accepts a customer name. An unlinked or name-ambiguous viewer
// resolves to zero rows and therefore sees nothing — see viewer.js.
//
// MONEY. Legacy totals are `numeric` in the INVOICE'S OWN currency (dollars, not
// NZD cents like `orders.total_cents`). pg returns numeric as a string; they are
// passed through as strings and rendered by the storefront against `currency`.
// Coercing them to Number here would silently round a value the client is
// reconciling against a real Xero invoice.
//
// WHAT IS DELIBERATELY ABSENT. There is no payment state and no balance:
// `status_reason` is 'Sent to Xero' on all 7,002 rows — a dispatch state, not a
// payment one — and FR-8 forbids calling Xero. There are no invoice LINES:
// all four D365 transaction entities export header-only and line import is
// formally shelved (docs/d365-export-analysis.md). The portal must frame this as
// an invoice RECORD, not an account statement.

import { VIEWER_CTE } from './viewer.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

const offsetFor = (page, limit) => (Math.max(page, 1) - 1) * limit

// Cuttings = the sample register. Excluded on purpose: `owner`/`customer_owner`
// (internal attribution, and A6 is unsettled), `created_by`/`modified_by` (staff
// names), `order_stock_check_details` (an internal stock note), `raw`, and
// `comments`.
//
// `comments` deserves its own line because it looks client-safe and is not. It
// is the back office's scratchpad — 1,757 of 1,886 staged rows carry one, and
// they hold staff first names, internal handling instructions, and in several
// current rows a THIRD PARTY's name, email, phone or home address ("samples for
// <name> (<email> <mobile>)"). Serving it would put one client's contact details
// in another client's JSON. Nothing in the storefront rendered it.
const CUTTING_COLUMNS = `k.guid,
        k.name,
        k.range_name,
        k.product,
        k.product_code,
        k.colour_code,
        k.supplier,
        k.quantity,
        k.status,
        k.created_on`

// Invoice headers. Excluded on purpose: `xero_invoice_id`/`xero_interface_error`
// (integration internals), `owner`/`created_by`/`modified_by` (staff),
// `exchange_rate` and every `*_base` total (Atelier's own NZD reporting view of
// a foreign-currency invoice), `sales_invoice_discount_pct` (a commercial term
// the client's own PDF already carries and this screen has no need to restate),
// `status_reason` (see the header note — it is not a payment state), `raw`.
const INVOICE_COLUMNS = `i.guid,
        i.number,
        i.invoice_suffix,
        i.invoice_date,
        i.due_date,
        i.reference,
        i.summary,
        i.sales_order,
        i.currency,
        i.total_ex_gst,
        i.gst,
        i.total_incl_gst,
        i.status`

const toCutting = (row) => ({
  id: row.guid,
  name: row.name,
  range: row.range_name,
  product: row.product,
  product_code: row.product_code,
  colour_code: row.colour_code,
  supplier: row.supplier,
  quantity: row.quantity,
  status: row.status,
  created_on: row.created_on,
})

const toInvoice = (row) => ({
  id: row.guid,
  number: row.number,
  suffix: row.invoice_suffix,
  invoice_date: row.invoice_date,
  due_date: row.due_date,
  reference: row.reference,
  summary: row.summary,
  sales_order: row.sales_order,
  currency: row.currency,
  total_ex_gst: row.total_ex_gst,
  gst: row.gst,
  total_incl_gst: row.total_incl_gst,
  status: row.status,
})

// One statement per read, shaped identically: viewer CTE, inner join on the
// snapshotted name, window-function count so the total costs no second query.
// $1 user id, $2 limit, $3 offset.
const scopedPage = async (pool, { userId, page, limit, columns, from, join, order }) => {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const { rows } = await pool.query(
    `WITH viewer AS (${VIEWER_CTE})
     SELECT ${columns},
            count(*) OVER () AS total_count
       FROM ${from}
       JOIN viewer v ON ${join}
      ORDER BY ${order}
      LIMIT $2 OFFSET $3`,
    [userId, safeLimit, offsetFor(page, safeLimit)]
  )
  if (rows.length > 0) {
    return { rows, total: Number(rows[0].total_count), limit: safeLimit }
  }
  // `count(*) OVER ()` rides on the returned rows, so an empty page carries no
  // total — and page 1 of an unlinked viewer and page 99 of a 681-invoice client
  // are both empty. Reporting 0 for the second would tell a client their history
  // had vanished the moment they paged past the end, so an empty page pays for
  // one COUNT rather than guessing. Page 1 skips it: empty there really is 0.
  if (Math.max(page, 1) === 1) {
    return { rows, total: 0, limit: safeLimit }
  }
  const { rows: counted } = await pool.query(
    `WITH viewer AS (${VIEWER_CTE})
     SELECT count(*) AS total
       FROM ${from}
       JOIN viewer v ON ${join}`,
    [userId]
  )
  return { rows, total: Number(counted[0]?.total ?? 0), limit: safeLimit }
}

/**
 * The signed-in client's cuttings (samples), newest first.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId  the authenticated user id — the ONLY scoping input
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ samples: object[], meta: { total, page, limit } }>}
 */
export const listClientSamples = async (
  pool,
  userId,
  { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = {}
) => {
  const { rows, total, limit: safeLimit } = await scopedPage(pool, {
    userId,
    page,
    limit,
    columns: CUTTING_COLUMNS,
    from: 'legacy_cuttings k',
    join: 'lower(btrim(k.customer)) = lower(btrim(v.customer_name))',
    // created_on NULLS LAST: a row with no date sorts to the end rather than
    // claiming to be the most recent sample the client took.
    order: 'k.created_on DESC NULLS LAST, k.guid',
  })
  return {
    samples: rows.map(toCutting),
    meta: { total, page: Math.max(page, 1), limit: safeLimit },
  }
}

/**
 * The signed-in client's invoice headers, newest first.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ invoices: object[], meta: { total, page, limit } }>}
 */
export const listClientInvoices = async (
  pool,
  userId,
  { page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = {}
) => {
  const { rows, total, limit: safeLimit } = await scopedPage(pool, {
    userId,
    page,
    limit,
    columns: INVOICE_COLUMNS,
    from: 'legacy_sales_invoices i',
    join: 'lower(btrim(i.customer)) = lower(btrim(v.customer_name))',
    order: 'i.invoice_date DESC NULLS LAST, i.guid',
  })
  return {
    invoices: rows.map(toInvoice),
    meta: { total, page: Math.max(page, 1), limit: safeLimit },
  }
}

/**
 * One invoice, BY THE SAME SCOPED QUERY that produced the client's list.
 *
 * This is the ownership check for anything taking an invoice id from the URL.
 * Re-resolving through the viewer join is the point: a GUID is not a secret (it
 * appears in staff screens and exports), so the caller's id must decide, not the
 * path. Returns null for an invoice belonging to anyone else, which the route
 * turns into a 404 — a 403 would confirm the record exists.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} guid
 * @returns {Promise<object|null>}
 */
export const getClientInvoice = async (pool, userId, guid) => {
  const { rows } = await pool.query(
    `WITH viewer AS (${VIEWER_CTE})
     SELECT ${INVOICE_COLUMNS}
       FROM legacy_sales_invoices i
       JOIN viewer v ON lower(btrim(i.customer)) = lower(btrim(v.customer_name))
      WHERE i.guid = $2
      LIMIT 1`,
    [userId, guid]
  )
  return rows[0] ? toInvoice(rows[0]) : null
}

/**
 * Headline counts for the dashboard, in one round trip.
 *
 * Counts only — the dashboard shows "12 invoices on record", not the rows. Both
 * counts go through the same viewer join, so an unlinked client gets zeroes
 * rather than an error.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<{ samples: number, invoices: number, latest_invoice_date: string|null }>}
 */
export const getClientLegacyCounts = async (pool, userId) => {
  const { rows } = await pool.query(
    `WITH viewer AS (${VIEWER_CTE})
     SELECT (SELECT count(*)
               FROM legacy_cuttings k
               JOIN viewer v ON lower(btrim(k.customer)) = lower(btrim(v.customer_name)))
              AS samples,
            (SELECT count(*)
               FROM legacy_sales_invoices i
               JOIN viewer v ON lower(btrim(i.customer)) = lower(btrim(v.customer_name)))
              AS invoices,
            (SELECT max(i.invoice_date)
               FROM legacy_sales_invoices i
               JOIN viewer v ON lower(btrim(i.customer)) = lower(btrim(v.customer_name)))
              AS latest_invoice_date`,
    [userId]
  )
  const row = rows[0] ?? {}
  return {
    samples: Number(row.samples ?? 0),
    invoices: Number(row.invoices ?? 0),
    latest_invoice_date: row.latest_invoice_date ?? null,
  }
}
