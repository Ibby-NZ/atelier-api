// Consolidated supplier invoices: read models, the derived variance, and every
// write (W14-US-003/US-004/US-005).
//
// THE PROBLEM THIS EXISTS FOR. Atelier raises purchase orders every day, and
// every two to four weeks ONE supplier sends ONE invoice covering MANY of them.
// W13 groups purchase orders by BRAND and one supplier sells several brands, so
// there are always more purchase orders than invoices — an invoice covering
// purchase orders raised for two houses of one supplier is the NORMAL case, not
// an edge one, and nothing here treats it as exceptional.
//
// Module shape follows `admin-purchase-orders.js` exactly: limits, `httpError`,
// a frozen column whitelist fed to `buildUpdate`, frozen mappers,
// `{ supplier_invoices, total }` with the ROUTE building the meta envelope, and
// `withSupplierInvoiceTxn` mirroring `withPurchaseOrderTxn` (BEGIN, lock the
// header `FOR UPDATE`, run, COMMIT, re-read).
//
// THIS MODULE DELIBERATELY DOES NOT IMPORT `admin-purchase-orders.js`. The
// dependency runs ONE WAY — that module imports `loadInvoiceStateByPurchaseOrderId`
// from here for a purchase order's invoice state — which is the same rule
// `receipts.js` states, and it is what keeps the two out of a cycle.
//
// The invariants this file is responsible for, each as the rule it is enforced
// as:
//
//   1. A PURCHASE ORDER APPEARS ON EXACTLY ONE INVOICE, and the DATABASE says
//      so: `supplier_invoice_allocations.purchase_order_id` is UNIQUE. A
//      re-attach after a correction would double-count that spend in every
//      downstream report with nothing in the data saying which row was the
//      mistake. The second attach is a caught 23505 answered **409 naming the
//      invoice that holds it**, found by a QUERY and never by parsing
//      `error.detail` — that string is a pg display format, not an interface.
//
//   2. AN INVOICE'S SUPPLIER MUST EQUAL EVERY ALLOCATED PURCHASE ORDER'S
//      SUPPLIER, enforced HERE as a **422 naming the purchase order**, not in
//      SQL. Saying it in the schema needs a composite unique on both parents
//      and two chained composite foreign keys to express one sentence, plus a
//      denormalised `supplier_id` on the join that then has its own way of
//      being wrong.
//
//   3. `SUM(allocations.amount)` IS NOT CONSTRAINED AGAINST `total_amount` AND
//      MUST NEVER BE. The unreconciled difference IS the product — the screen
//      exists to show it — so a CHECK would refuse the half-done state the
//      feature is for. `unallocated_amount` is DERIVED here and stored nowhere,
//      and `status = 'matched'` is a judgement a person makes rather than
//      arithmetic anything computes.
//
//   4. FREIGHT AND DUTY ARE RECORDED AND NEVER APPORTIONED (ADR 006). Nothing
//      here pushes a non-line charge down onto a purchase-order line or a
//      range, derives a landed cost, or writes back to a rate, a price or a
//      sell figure. `fx_rate` is likewise recorded RAW and is never multiplied
//      by anything — the FX basis is still owed by the client (A9).
//
//   5. COST FIGURES ARE FINANCE-GATED, and the gate is `loadReportAccess(pool,
//      user)` in the route — never `reportAccess(request.user)`, which reads
//      `can_view_finance` as `undefined` (the guard projects users through
//      `PUBLIC_USER_COLUMNS`, which does not carry it) and would answer false to
//      everyone, silently and for ever. A masked figure is DELETED from the
//      payload, not nulled: a key that survives with an empty value still tells
//      the reader which figures exist.

import { buildUpdate } from '../catalogue/admin-brands.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

/**
 * The vocabulary `supplier_invoices_status_check` holds. Exported so a route
 * spends it as a schema enum instead of keeping a second copy.
 *
 * There is no state machine beside this list, unlike `po-states.js`, because
 * there are no illegal moves: `matched` is a judgement somebody made about a
 * variance and an invoice goes straight back to `disputed` the moment a person
 * spots something. A spine here would be a rule to fight rather than a rule to
 * keep.
 */
export const SUPPLIER_INVOICE_STATUSES = Object.freeze([
  'received',
  'matched',
  'disputed',
])

const PO_UNIQUE_CONSTRAINT = 'supplier_invoice_allocations_purchase_order_id_key'
const INVOICE_NUMBER_UNIQUE = 'supplier_invoices_supplier_number_unique'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// pg hands numeric back as a string, and `Number(null)` is 0 — which on an
// invoice amount reads as "this purchase order cost nothing". Every NULLABLE
// numeric here goes through this.
const numeric = (value) => (value == null ? null : Number(value))

// Money is `numeric(12,4)`; this only kills the float noise a sum or a
// subtraction of exact decimals leaves behind (1940.0000000000002).
const round4 = (value) => Math.round(value * 10000) / 10000

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

// `suppliers` is deliberately NOT joined: `supplier_name` and `currency` are
// SNAPSHOTS taken at create, exactly as they are on a purchase order. An
// invoice is a document that arrived from a house at a moment, and renaming the
// supplier record next year must not rewrite whose paper this was.
// `supplier_id` stays beside them as the link a report rolls up on.
const INVOICE_FROM = `supplier_invoices si
       LEFT JOIN users u ON u.id = si.created_by`

// `invoice_date::text` is not a nicety. pg's default parser turns a `date` into
// a JS Date at LOCAL midnight, which serialises as "2026-07-31T12:00:00.000Z"
// under a NZ session for an invoice dated the 1st of August — the paper says one
// day and the screen says another. A date is a calendar day and carries no
// instant, so it leaves here as 'YYYY-MM-DD'. Every read of the column does
// this; the filters bind against the column itself and are unaffected.
const INVOICE_COLUMNS = `si.id,
        si.supplier_id,
        si.supplier_name,
        si.invoice_number,
        si.invoice_date::text AS invoice_date,
        si.currency,
        si.total_amount,
        si.freight_amount,
        si.duty_amount,
        si.fx_rate,
        si.status,
        si.notes,
        si.created_by,
        u.name AS created_by_name,
        si.created_at,
        si.updated_at`

// One purchase order's own costed total, and how much of it is unpriced.
//
// `round(… , 2)` PER LINE, then summed, is `toLine`'s arithmetic in
// admin-purchase-orders.js expressed at this grain — the two screens must not
// disagree by a rounding rule about what one purchase order cost. The count is
// what lets the reader tell "€0" from "nobody has priced this": `SUM` skips
// NULLs, so a partly-priced purchase order would otherwise report a partial
// figure as though it were the whole thing.
const PO_COST_LATERAL = `LEFT JOIN LATERAL (
         SELECT SUM(round(l.qty_ordered * l.unit_price, 2)) AS ordered_cost,
                count(*) FILTER (WHERE l.unit_price IS NULL)::int AS unpriced_lines
           FROM purchase_order_lines l
          WHERE l.purchase_order_id = po.id
       ) cost ON true`

// A purchase order's cost as the purchase-order screen states it: ABSENT while
// any line is unpriced, rather than a total that reads as the cost of the whole
// order while describing part of it. Same rule, same wording, one grain up.
const purchaseOrderCost = (row) =>
  row.unpriced_lines > 0 ? null : numeric(row.ordered_cost)

const toAllocation = (row, finance) => {
  const allocation = {
    id: row.id,
    purchase_order_id: row.purchase_order_id,
    po_number: row.po_number,
    brand_id: row.brand_id,
    // The house the purchase order was raised for. ONE INVOICE COVERING TWO
    // BRANDS OF ONE SUPPLIER IS THE ORDINARY CASE, so the screen has to be able
    // to say which of them each line of the bill is.
    brand_name: row.brand_name,
    purchase_order_status: row.purchase_order_status,
    purchase_order_created_at: row.purchase_order_created_at,
    unpriced_lines: row.unpriced_lines,
    notes: row.notes,
    allocated_by: row.allocated_by,
    allocated_by_name: row.allocated_by_name ?? null,
    created_at: row.created_at,
  }
  // DELETED, not nulled.
  if (finance) {
    // NULL is "attached, but nobody has said how much of the total is this
    // one", which is a real and common state — a consolidated invoice often
    // does not break its total down per purchase order at all.
    allocation.amount = numeric(row.amount)
    allocation.purchase_order_cost = purchaseOrderCost(row)
  }
  return Object.freeze(allocation)
}

/**
 * Every allocation for a set of invoices, in one query, grouped by invoice —
 * the batch-load posture the rest of this codebase already takes, so a page of
 * twenty invoices costs one round trip rather than twenty.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {number[]} invoiceIds
 * @param {boolean} finance
 * @returns {Promise<Map<number, object[]>>}
 */
const loadAllocationsByInvoiceId = async (db, invoiceIds, finance) => {
  if (invoiceIds.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT a.id,
            a.supplier_invoice_id,
            a.purchase_order_id,
            a.amount,
            a.notes,
            a.allocated_by,
            a.created_at,
            au.name AS allocated_by_name,
            po.po_number,
            po.brand_id,
            po.status AS purchase_order_status,
            po.created_at AS purchase_order_created_at,
            b.name AS brand_name,
            cost.ordered_cost,
            COALESCE(cost.unpriced_lines, 0) AS unpriced_lines
       FROM supplier_invoice_allocations a
       JOIN purchase_orders po ON po.id = a.purchase_order_id
       JOIN brands b ON b.id = po.brand_id
       LEFT JOIN users au ON au.id = a.allocated_by
       ${PO_COST_LATERAL}
      WHERE a.supplier_invoice_id = ANY($1::int[])
      ORDER BY po.po_number`,
    [invoiceIds]
  )
  const byInvoice = new Map()
  for (const row of rows) {
    const allocation = toAllocation(row, finance)
    const existing = byInvoice.get(row.supplier_invoice_id)
    if (existing) existing.push(allocation)
    else byInvoice.set(row.supplier_invoice_id, [allocation])
  }
  return byInvoice
}

/**
 * THE DERIVED VARIANCE, and every figure beside it (FR-154). Reported on
 * screen, written NOWHERE.
 *
 * Two different differences live here and they answer different questions:
 *
 *   - `unallocated_amount` = the invoice total less what has been apportioned
 *     to purchase orders so far. This is a measure of HOW FAR THROUGH the
 *     reconciliation the office is, and the whole reason no CHECK ties the sum
 *     to the total: the half-done state is the state the screen exists for.
 *
 *   - `variance` = the invoice total less what those purchase orders SAID THEY
 *     WOULD COST. This is the commercial question — did the house bill what
 *     they quoted — and it is `null` while any attached purchase order carries
 *     an unpriced line, because a variance against a partial cost reads as a
 *     discrepancy that is really a missing price. `unpriced_purchase_orders`
 *     says how many, so the screen can tell the reader which it is.
 *
 * The variance is measured against the FULL invoice total, freight and duty
 * INCLUDED. Nothing here decides which part of a total is goods: apportioning a
 * non-line charge is the rule the client still owes (ADR 006 / A9), and a
 * variance quietly computed against `total - freight - duty` would be this API
 * inventing that rule and hiding it inside a subtraction. `freight_amount` and
 * `duty_amount` travel beside the variance so a person can do it themselves.
 */
const summarise = (allocations, totalAmount, finance) => {
  const summary = { allocation_count: allocations.length }
  if (!finance) return summary

  const stated = allocations.filter((allocation) => allocation.amount !== null)
  const allocated = round4(
    stated.reduce((sum, allocation) => sum + allocation.amount, 0)
  )
  const unpricedOrders = allocations.filter(
    (allocation) => allocation.purchase_order_cost === null
  ).length
  const cost =
    unpricedOrders > 0
      ? null
      : round4(
          allocations.reduce((sum, allocation) => sum + allocation.purchase_order_cost, 0)
        )

  summary.allocated_amount = allocated
  // How many attached purchase orders carry no stated amount on this bill. A
  // count rather than a silence: `Number(null)` is 0, so an unstated amount
  // contributes nothing to the sum and would otherwise be invisible.
  summary.unstated_allocations = allocations.length - stated.length
  summary.unallocated_amount = round4(totalAmount - allocated)
  summary.purchase_orders_cost = cost
  summary.unpriced_purchase_orders = unpricedOrders
  summary.variance = cost === null ? null : round4(totalAmount - cost)
  return summary
}

const toSupplierInvoice = (row, allocations, finance) => {
  const totalAmount = Number(row.total_amount)
  const invoice = {
    id: row.id,
    supplier_id: row.supplier_id,
    // The snapshot, as the paper said on the day.
    supplier_name: row.supplier_name,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    currency: row.currency,
    status: row.status,
    notes: row.notes,
    created_by: row.created_by,
    created_by_name: row.created_by_name ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...summarise(allocations, totalAmount, finance),
    purchase_orders: Object.freeze(allocations),
  }
  if (finance) {
    invoice.total_amount = totalAmount
    // Recorded, never apportioned; recorded, never interpreted.
    invoice.freight_amount = numeric(row.freight_amount)
    invoice.duty_amount = numeric(row.duty_amount)
    invoice.fx_rate = numeric(row.fx_rate)
  }
  return Object.freeze(invoice)
}

// Filter names are trusted column references; every VALUE flows through a $n
// placeholder. Shape copied from `buildWhere` in admin-purchase-orders.js.
const buildWhere = ({ supplierId, status, from, to, q }) => {
  const clauses = []
  const params = []
  if (supplierId) {
    params.push(supplierId)
    clauses.push(`si.supplier_id = $${params.length}`)
  }
  if (status) {
    params.push(status)
    clauses.push(`si.status = $${params.length}`)
  }
  if (from) {
    params.push(from)
    clauses.push(`si.invoice_date >= $${params.length}::date`)
  }
  if (to) {
    // `invoice_date` is a DATE, so a plain `<=` is correct here and the
    // next-day-exclusive rule the timestamptz filters follow would be wrong:
    // it would silently include the day AFTER the one asked for.
    params.push(to)
    clauses.push(`si.invoice_date <= $${params.length}::date`)
  }
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, (match) => `\\${match}`)}%`)
    clauses.push(`si.invoice_number ILIKE $${params.length} ESCAPE '\\'`)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

const pageOf = ({ page, limit }) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  return { safePage, safeLimit, offset: (safePage - 1) * safeLimit }
}

/**
 * Filtered, paginated supplier invoices (FR-160), newest first, each carrying
 * the purchase orders it covers and its derived variance.
 *
 * @param {import('pg').Pool} pool
 * @param {{ supplierId?: number, status?: string, from?: string, to?: string,
 *           q?: string, page?: number, limit?: number, finance?: boolean }} [options]
 * @returns {Promise<{ supplier_invoices: object[], total: number }>}
 */
export const listSupplierInvoices = async (pool, options = {}) => {
  const { finance = false } = options
  const { safeLimit, offset } = pageOf(options)
  const { where, params } = buildWhere(options)

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM ${INVOICE_FROM} ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${INVOICE_COLUMNS}
       FROM ${INVOICE_FROM}
       ${where}
      ORDER BY si.invoice_date DESC, si.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  const allocations = await loadAllocationsByInvoiceId(
    pool,
    rows.map((row) => row.id),
    finance
  )

  return {
    supplier_invoices: rows.map((row) =>
      toSupplierInvoice(row, allocations.get(row.id) ?? [], finance)
    ),
    total: countResult.rows[0].total,
  }
}

/**
 * One invoice with the purchase orders it covers, or null when it does not
 * exist. Reads through `db` (pool or open client) so it can reflect an open
 * transaction.
 *
 * @param {{ query: Function }} db
 * @param {number} id
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export const getSupplierInvoice = async (db, id, { finance = false } = {}) => {
  const { rows } = await db.query(
    `SELECT ${INVOICE_COLUMNS} FROM ${INVOICE_FROM} WHERE si.id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) return null
  const allocations = await loadAllocationsByInvoiceId(db, [id], finance)
  return toSupplierInvoice(row, allocations.get(id) ?? [], finance)
}

/**
 * A purchase order's invoice state, batch-loaded by purchase-order id.
 *
 * Imported by `admin-purchase-orders.js` so the buying desk can see that a
 * purchase order has already been billed without a second screen. The
 * dependency runs one way — nothing here imports that module.
 *
 * @param {{ query: Function }} db
 * @param {number[]} purchaseOrderIds
 * @param {boolean} finance
 * @returns {Promise<Map<number, object>>}
 */
export const loadInvoiceStateByPurchaseOrderId = async (db, purchaseOrderIds, finance) => {
  if (!Array.isArray(purchaseOrderIds) || purchaseOrderIds.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT a.purchase_order_id,
            a.amount,
            si.id,
            si.invoice_number,
            -- A calendar day, never an instant. See INVOICE_COLUMNS.
            si.invoice_date::text AS invoice_date,
            si.status,
            si.supplier_name
       FROM supplier_invoice_allocations a
       JOIN supplier_invoices si ON si.id = a.supplier_invoice_id
      WHERE a.purchase_order_id = ANY($1::int[])`,
    [purchaseOrderIds]
  )
  // One row per purchase order by construction — `purchase_order_id` is UNIQUE.
  return new Map(
    rows.map((row) => {
      const state = {
        id: row.id,
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date,
        status: row.status,
        supplier_name: row.supplier_name,
      }
      if (finance) state.amount = numeric(row.amount)
      return [row.purchase_order_id, Object.freeze(state)]
    })
  )
}

/**
 * Purchase orders no invoice covers yet, for the supplier whose bill is on the
 * desk (US-003, US-005).
 *
 * THIS IS A SEARCH RATHER THAN A JOIN, DELIBERATELY. It is an open question
 * whether a supplier's consolidated invoice quotes Atelier's purchase-order
 * numbers at all (FR-158); where it does not, the office matches by DATE AND
 * AMOUNT off the paper, so what the screen needs is a way to find candidates —
 * not a join that assumes the reference is there. `q` covers the case where the
 * number IS quoted, and it is one filter among several rather than the model.
 *
 * `amount_min`/`amount_max` are two plain bounds and not a "tolerance": a
 * tolerance is a policy (absolute? percentage? of which figure?) nobody has
 * settled, and two numbers let the screen apply whichever one it likes without
 * this module having an opinion. **It does not solve the subset-sum** — finding
 * WHICH COMBINATION of purchase orders adds up to the invoice total is
 * combinatorial and nobody asked for it; the office ticks candidates off.
 *
 * `cancelled` purchase orders are excluded: an order the office says never
 * happened is not something a house will bill for, and leaving them in would
 * put permanent noise in every search.
 *
 * @param {import('pg').Pool} pool
 * @param {{ supplierId?: number, brandId?: number, status?: string, from?: string,
 *           to?: string, q?: string, amountMin?: number, amountMax?: number,
 *           page?: number, limit?: number, finance?: boolean }} [options]
 * @returns {Promise<{ purchase_orders: object[], total: number }>}
 */
export const listUnbilledPurchaseOrders = async (pool, options = {}) => {
  const { supplierId, brandId, status, from, to, q, amountMin, amountMax, finance = false } =
    options
  const { safeLimit, offset } = pageOf(options)

  if ((amountMin != null || amountMax != null) && !finance) {
    // A search BY amount over cost figures is finance end to end, so it is
    // refused with a reason rather than served narrowed by a figure the caller
    // may not see — "no rows" and "you may not see this" are indistinguishable
    // on a screen and only the second is something a person can act on. The
    // posture `maskReport` takes for a finance-only report.
    throw httpError(
      403,
      'Matching a purchase order by amount searches on what Atelier paid, and ' +
        'your account does not have finance visibility. Search by house and ' +
        'date instead.'
    )
  }

  const clauses = [
    // The whole definition of "unbilled": no invoice claims it.
    `NOT EXISTS (SELECT 1 FROM supplier_invoice_allocations a
                  WHERE a.purchase_order_id = po.id)`,
    `po.status <> 'cancelled'`,
  ]
  const params = []
  const add = (value, clause) => {
    params.push(value)
    clauses.push(clause(params.length))
  }
  if (supplierId) add(supplierId, (n) => `po.supplier_id = $${n}`)
  if (brandId) add(brandId, (n) => `po.brand_id = $${n}`)
  if (status) add(status, (n) => `po.status = $${n}`)
  if (from) add(from, (n) => `po.created_at >= $${n}::date`)
  // Exclusive on the NEXT day, never `<= to::date`: `created_at` is timestamptz,
  // so `<=` cuts the range at that morning's midnight and silently drops the
  // whole last day.
  if (to) add(to, (n) => `po.created_at < ($${n}::date + 1)`)
  if (q) {
    add(
      `%${q.replace(/[%_\\]/g, (match) => `\\${match}`)}%`,
      (n) => `po.po_number ILIKE $${n} ESCAPE '\\'`
    )
  }
  // The costed total, matched against what the paper says. A purchase order
  // with an unpriced line has no total to match on, so a bounded search
  // excludes it rather than treating a partial figure as the whole.
  if (amountMin != null) add(amountMin, (n) => `cost.ordered_cost >= $${n}`)
  if (amountMax != null) add(amountMax, (n) => `cost.ordered_cost <= $${n}`)

  const from_ = `purchase_orders po
       JOIN brands b ON b.id = po.brand_id
       ${PO_COST_LATERAL}`
  const where = `WHERE ${clauses.join(' AND ')}`

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM ${from_} ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT po.id,
            po.po_number,
            po.brand_id,
            b.name AS brand_name,
            po.supplier_id,
            po.supplier_name,
            po.currency,
            po.status,
            po.created_at,
            po.expected_at,
            cost.ordered_cost,
            COALESCE(cost.unpriced_lines, 0) AS unpriced_lines
       FROM ${from_}
       ${where}
      ORDER BY po.created_at DESC, po.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return {
    purchase_orders: rows.map((row) => {
      const purchaseOrder = {
        id: row.id,
        po_number: row.po_number,
        brand_id: row.brand_id,
        brand_name: row.brand_name,
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name,
        currency: row.currency,
        status: row.status,
        created_at: row.created_at,
        expected_at: row.expected_at,
        unpriced_lines: row.unpriced_lines,
      }
      if (finance) purchaseOrder.ordered_cost = purchaseOrderCost(row)
      return Object.freeze(purchaseOrder)
    }),
    total: countResult.rows[0].total,
  }
}

// ---------------------------------------------------------------------------
// The transaction wrapper
// ---------------------------------------------------------------------------

/**
 * Lock the invoice, run a mutation inside one transaction, and return the fresh
 * document. 404 when the id is unknown.
 *
 * `FOR UPDATE`, never `FOR NO KEY UPDATE`: an INSERT of an allocation inside
 * the same transaction takes `FOR KEY SHARE` on the invoice row it references,
 * and `FOR KEY SHARE` conflicts with `FOR UPDATE` and with nothing weaker — so
 * the weaker mode would let two attaches to one invoice run side by side. The
 * same rule `withPurchaseOrderTxn` and `src/lifecycle/delete.js` state.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {(client: object, invoice: object) => Promise<void>} fn
 * @param {{ finance?: boolean }} [options]
 */
export const withSupplierInvoiceTxn = async (pool, id, fn, { finance = false } = {}) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, supplier_id, supplier_name, invoice_number, status
         FROM supplier_invoices
        WHERE id = $1
        FOR UPDATE`,
      [id]
    )
    const invoice = rows[0]
    if (!invoice) {
      throw httpError(404, `Supplier invoice ${id} not found.`)
    }
    await fn(client, invoice)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getSupplierInvoice(pool, id, { finance })
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// A duplicate invoice number for the same house, and a date pg could not parse.
// Both must answer 4xx: the route's date pattern can only police the SHAPE
// (Fastify's bundled Ajv carries no `format` keywords), so `2026-02-31` reaches
// pg as a 22007 and would otherwise surface as a 500.
const rethrowWriteError = async (pool, error, context) => {
  if (error?.code === '23505' && error.constraint === INVOICE_NUMBER_UNIQUE) {
    // Named from the ROW ON FILE, not from what this caller typed. The number
    // is keyed by hand off a piece of paper, so the collision is usually a
    // difference in case or spacing — echoing the caller's own spelling back
    // reads as though the two are unrelated. Asked on the POOL: an update's
    // transaction is already doomed by the time this runs.
    const { rows } = await pool.query(
      `SELECT invoice_number, invoice_date::text AS invoice_date
         FROM supplier_invoices
        WHERE supplier_id = $1 AND lower(btrim(invoice_number)) = lower(btrim($2))`,
      [context.supplierId, context.invoiceNumber ?? '']
    )
    const existing = rows[0]
    throw httpError(
      409,
      existing
        ? `${context.supplierName} invoice ${existing.invoice_number} is already on ` +
            `file, dated ${existing.invoice_date}. An invoice number is unique to the ` +
            'house that issued it, so this is the same bill keyed twice.'
        : `${context.supplierName} has already sent an invoice with that number.`
    )
  }
  if (error?.code === '22007' || error?.code === '22008') {
    throw httpError(422, `"${context.invoiceDate}" is not a real date.`)
  }
  throw error
}

/**
 * Enter an invoice that has arrived from a house.
 *
 * `supplier_id` IS a parameter here, unlike on a purchase order. A purchase
 * order is addressed to the house Atelier picked by choosing a BRAND, so its
 * supplier is a derivation with a right answer the client cannot see; an
 * invoice ARRIVES from a house, and the house is the primary fact on the paper.
 * What replaces the derivation is invariant 2 — every purchase order attached
 * to it must belong to the same supplier.
 *
 * @param {import('pg').Pool} pool
 * @param {object} input
 * @param {{ user?: object|null, finance?: boolean }} [ctx]
 */
export const createSupplierInvoice = async (
  pool,
  input,
  { user = null, finance = false } = {}
) => {
  const { rows: suppliers } = await pool.query(
    `SELECT id, name, currency FROM suppliers WHERE id = $1`,
    [input.supplier_id]
  )
  const supplier = suppliers[0]
  if (!supplier) {
    throw httpError(422, `Supplier ${input.supplier_id} does not exist.`)
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO supplier_invoices
         (supplier_id, supplier_name, invoice_number, invoice_date, currency,
          total_amount, freight_amount, duty_amount, fx_rate, status, notes, created_by)
       VALUES ($1, $2, btrim($3), $4, $5, $6, $7, $8, $9, COALESCE($10, 'received'), $11, $12)
       RETURNING id`,
      [
        supplier.id,
        // The snapshot. Never joined for afterwards.
        supplier.name,
        input.invoice_number,
        input.invoice_date,
        // The house's invoicing currency unless the paper says otherwise.
        input.currency ?? supplier.currency,
        input.total_amount,
        input.freight_amount ?? null,
        input.duty_amount ?? null,
        input.fx_rate ?? null,
        input.status ?? null,
        input.notes ?? null,
        user?.id ?? null,
      ]
    )
    return getSupplierInvoice(pool, rows[0].id, { finance })
  } catch (error) {
    return await rethrowWriteError(pool, error, {
      supplierId: supplier.id,
      supplierName: supplier.name,
      invoiceNumber: input.invoice_number,
      invoiceDate: input.invoice_date,
    })
  }
}

// What staff may correct on an invoice.
//
// `supplier_id` IS ABSENT AND MUST STAY ABSENT. Moving an invoice to another
// house would leave every already-attached purchase order belonging to the old
// one — invariant 2 broken retroactively, silently, by a field that looks like
// a typo fix. An invoice keyed against the wrong house is deleted and re-entered
// (it can only have been keyed minutes ago; anything attached to it blocks the
// delete and has to be detached first, which is exactly the review that should
// happen). `created_by` is absent for the reason every attribution column is:
// it records what happened, not what somebody would prefer.
export const SUPPLIER_INVOICE_UPDATE_COLUMNS = Object.freeze([
  'invoice_number',
  'invoice_date',
  'currency',
  'total_amount',
  'freight_amount',
  'duty_amount',
  'fx_rate',
  'status',
  'notes',
])

/**
 * Correct an invoice's header.
 *
 * `status` IS in the whitelist, and that is not a contradiction of "verbs, not
 * status PATCHes". That rule is about a move that writes TWO tables or writes a
 * state and the stamp that dates it — `send`, `close` and `cancel` on a purchase
 * order. Here the move writes one column of one row and dates nothing, and
 * `matched` is a judgement rather than a transition, so a verb route would be
 * ceremony around an UPDATE. Attaching and detaching ARE verbs, for exactly the
 * reason the rule states.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} patch
 * @param {{ finance?: boolean }} [options]
 */
export const updateSupplierInvoice = (pool, id, patch, { finance = false } = {}) =>
  withSupplierInvoiceTxn(
    pool,
    id,
    async (client, invoice) => {
      const { sets, params } = buildUpdate(patch, SUPPLIER_INVOICE_UPDATE_COLUMNS)
      try {
        await client.query(
          `UPDATE supplier_invoices SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $${params.length + 1}`,
          [...params, id]
        )
      } catch (error) {
        await rethrowWriteError(pool, error, {
          supplierId: invoice.supplier_id,
          supplierName: invoice.supplier_name,
          invoiceNumber: patch.invoice_number,
          invoiceDate: patch.invoice_date,
        })
      }
    },
    { finance }
  )

// Which invoice already holds this purchase order. Answered by a QUERY rather
// than by parsing `error.detail`, because that string is a pg display format and
// not an interface.
const describeExistingInvoice = async (db, purchaseOrderId) => {
  const { rows } = await db.query(
    `SELECT si.invoice_number, si.supplier_name, po.po_number
       FROM supplier_invoice_allocations a
       JOIN supplier_invoices si ON si.id = a.supplier_invoice_id
       JOIN purchase_orders po ON po.id = a.purchase_order_id
      WHERE a.purchase_order_id = $1`,
    [purchaseOrderId]
  )
  const hit = rows[0]
  return httpError(
    409,
    hit
      ? `${hit.po_number} is already on invoice ${hit.invoice_number} from ` +
          `${hit.supplier_name}. A purchase order appears on exactly one invoice — ` +
          'detach it from that one first if this is where it belongs.'
      : 'That purchase order is already on another invoice.'
  )
}

/**
 * Put a purchase order on an invoice (FR-151/152/153).
 *
 * A VERB, not a PATCH: it writes the join and it is the act that says this
 * spend is on this bill, so it is attributed and it is refused for its own
 * reasons rather than sharing a body with an unrelated edit.
 *
 * Three refusals, each naming what a person has to do about it:
 *   - an unknown purchase order is a 422;
 *   - one belonging to another supplier is a 422 NAMING THE PURCHASE ORDER and
 *     both houses (invariant 2 — the rule the schema deliberately does not
 *     hold);
 *   - one already on an invoice is a 409 NAMING THAT INVOICE (invariant 1 — the
 *     rule the schema does hold, caught as a 23505).
 *
 * @param {import('pg').Pool} pool
 * @param {number} invoiceId
 * @param {{ purchase_order_id: number, amount?: number|null, notes?: string|null }} input
 * @param {{ user?: object|null, finance?: boolean }} [ctx]
 */
export const attachPurchaseOrder = (
  pool,
  invoiceId,
  input,
  { user = null, finance = false } = {}
) =>
  withSupplierInvoiceTxn(
    pool,
    invoiceId,
    async (client, invoice) => {
      const { rows } = await client.query(
        `SELECT id, po_number, supplier_id, supplier_name
           FROM purchase_orders
          WHERE id = $1`,
        [input.purchase_order_id]
      )
      const purchaseOrder = rows[0]
      if (!purchaseOrder) {
        throw httpError(422, `Purchase order ${input.purchase_order_id} does not exist.`)
      }
      if (purchaseOrder.supplier_id !== invoice.supplier_id) {
        throw httpError(
          422,
          `${purchaseOrder.po_number} was raised for ${purchaseOrder.supplier_name}, ` +
            `and this invoice is from ${invoice.supplier_name}. A house can only ` +
            'bill for what was ordered from it.'
        )
      }
      try {
        await client.query(
          `INSERT INTO supplier_invoice_allocations
             (supplier_invoice_id, purchase_order_id, amount, notes, allocated_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            invoiceId,
            purchaseOrder.id,
            // NULL, never 0: "nobody has said how much of this bill is this
            // purchase order" and "this purchase order was charged at nil" are
            // different facts, and `Number(null)` is 0.
            input.amount ?? null,
            input.notes ?? null,
            user?.id ?? null,
          ]
        )
      } catch (error) {
        if (error?.code === '23505' && error.constraint === PO_UNIQUE_CONSTRAINT) {
          // The transaction is doomed either way, so ask on the POOL rather
          // than on the aborted client.
          throw await describeExistingInvoice(pool, purchaseOrder.id)
        }
        throw error
      }
    },
    { finance }
  )

/**
 * Take a purchase order off an invoice.
 *
 * A HARD DELETE OF THE ROW, not a stamp. `purchase_order_id` is plainly UNIQUE
 * rather than partially unique (see the migration): a released-then-re-attached
 * shape is exactly what lets two live rows exist for one purchase order, which
 * is the double-count the constraint is there to prevent. What makes the detach
 * "an explicit act that is recorded" (FR-159) is that it is a route of its own
 * — nobody detaches as a side effect of saving a form.
 *
 * @param {import('pg').Pool} pool
 * @param {number} invoiceId
 * @param {number} purchaseOrderId
 * @param {{ finance?: boolean }} [options]
 */
export const detachPurchaseOrder = (pool, invoiceId, purchaseOrderId, { finance = false } = {}) =>
  withSupplierInvoiceTxn(
    pool,
    invoiceId,
    async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM supplier_invoice_allocations
          WHERE supplier_invoice_id = $1 AND purchase_order_id = $2`,
        [invoiceId, purchaseOrderId]
      )
      if (rowCount === 0) {
        throw httpError(404, `Purchase order ${purchaseOrderId} is not on this invoice.`)
      }
    },
    { finance }
  )
