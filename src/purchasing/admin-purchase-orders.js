// Back-office purchase orders: read models, the derivation, and every write.
//
// Module shape follows `src/pricing/admin-price-lists.js` and
// `src/suppliers/admin-suppliers.js` — limits, `httpError`, a frozen column
// whitelist fed to a dynamic SET clause, a frozen mapper, and
// `{ purchase_orders, total }` with the ROUTE building the meta envelope.
// `withPurchaseOrderTxn` mirrors `withOrderTxn` (src/orders/admin-orders.js)
// exactly: BEGIN, lock the header `FOR UPDATE`, run, COMMIT, re-read.
//
// The invariants this file is responsible for, each as the rule it is enforced
// as rather than as a preference:
//
//   1. `supplier_id` COMES FROM THE HOUSE AND IS NEVER TRUSTED FROM A CLIENT.
//      A manual create may NAME one of the house's suppliers (main or
//      additional, migration 1791638400000) and anything else is a 422; absent,
//      and on plan/generate, it is the main `brands.supplier_id`. There is
//      nothing a CHECK could catch here — every supplier id is a valid supplier
//      id — so an unchecked value produces a well-formed purchase order
//      addressed to the wrong house. A brand with no supplier is a **422 naming
//      the brand**.
//
//   2. THE ANTI-DOUBLE-ORDER GUARANTEE IS A DATABASE INDEX, NOT THIS FILE.
//      `purchase_order_line_allocations_open_unique` is a partial unique index
//      on `order_line_id WHERE released_at IS NULL`. The candidate query's
//      `NOT EXISTS` makes the DRY RUN honest; it is not the guard, because it
//      reads rows another transaction is about to write. The derivation is
//      exactly what two staff run at once at 5pm, so the second run is a caught
//      23505 answered **409 naming the purchase order that already covers the
//      line** — the `sample_loans_open_unique` posture.
//
//   3. `SUM(allocations.qty) <= qty_ordered`, ENFORCED WITH THE LINE LOCKED
//      `FOR UPDATE`. An aggregate cannot be a CHECK — a CHECK sees one row and
//      this rule is over a set — so the lock is what makes it hold under two
//      concurrent allocations. `<=`, not `=`: the unallocated remainder is a
//      deliberate stock buy. ONE helper (`insertAllocation`) is the only path
//      that writes an allocation, and the same lock guards a `qty_ordered` being
//      edited DOWNWARDS, which is the other way the sum can be broken.
//
//   4. RECEIPT STATE IS DERIVED, NEVER STORED. `qty_received` is
//      `COALESCE(SUM(r.qty), 0)` over the append-only ledger, computed here at
//      read time. There is no counter column and there must never be one.
//      `status` holds only what a person did, and **`closed` is not `full`**.
//
//   5. NOTHING HERE WRITES AN INVENTORY QUANTITY. `moveReservation` stays the
//      sole writer of `qty_reserved` / `qty_available`. The word `inventory`
//      does not appear in a SQL position anywhere in this domain, and
//      `test/purchasing.test.js` asserts that by source scan and by statement
//      scan rather than by everyone remembering.
//
//   6. COST FIGURES ARE FINANCE-GATED through `loadReportAccess` — never
//      `reportAccess(request.user)`, which reads `can_view_finance` as
//      `undefined` (the guard projects users through `PUBLIC_USER_COLUMNS`,
//      which does not carry it) and would answer false to everyone, silently.
//      A masked figure is DELETED from the payload, not nulled: a key that
//      survives with an empty value still tells the reader which figures exist.
//      The projection posture `maskReport` takes, applied by construction here
//      because a purchase order is not a report envelope.

import { buildUpdate } from '../catalogue/admin-brands.js'
// The candidate predicate is IMPORTED, never retyped: `reserves(kind)` is what
// makes a card checkout ineligible by construction (it arrived paid with stock
// already decremented, so it is not demand to buy against), and `HELD_STATUSES`
// is where that demand is still live. A local copy of either is how the
// derivation and the reservation model start disagreeing about what is owed.
import { RESERVING_KINDS, HELD_STATUSES, canTransition } from '../orders/order-states.js'
// A purchase order raised FROM a sales order moves that order to back_order —
// through the one transition, so the machine, the audit row and the letter
// are the same as a move made by hand.
import { setOrderStatus } from '../orders/admin-orders.js'
import { planPurchaseOrders } from './po-plan.js'
import { loadReceiptsByLineId } from './receipts.js'
import { supplierForBrand } from '../suppliers/brand-suppliers.js'
// W14. The dependency runs ONE WAY — `supplier-invoices.js` imports nothing
// from here — so a purchase order can say which bill it is on without the two
// modules forming a cycle. Same rule `receipts.js` states in the other
// direction.
import { loadInvoiceStateByPurchaseOrderId } from './supplier-invoices.js'
import {
  STATUS_STAMPS,
  receiptState,
  rollUpReceiptState,
  requireStatus,
  requireTransition,
} from './po-states.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

// The format, spelled here and NOT as a column DEFAULT, so there is one copy of
// it — the `GENERATED_BARCODE` posture in src/samples/admin-samples.js. A
// SEQUENCE, never `max + 1`: max-plus-one reads the whole table, serialises
// every insert behind that read, and races anyway. Gaps are the price and are
// the correct trade — a gap in a purchase-order number is not a missing purchase
// order, and the sequence does not reset per year.
const PO_NUMBER = `'PO-' || lpad(nextval('purchase_orders_number_seq')::text, 6, '0')`

const OPEN_ALLOCATION_UNIQUE = 'purchase_order_line_allocations_open_unique'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// pg hands numeric back as a string, and `Number(null)` is 0 — which on a
// purchase price reads as "the house is giving it to us". Every NULLABLE numeric
// in this domain goes through this; the plain `Number()` rule is for a value
// already known to be present.
const numeric = (value) => (value == null ? null : Number(value))

const round2 = (value) => Math.round(value * 100) / 100

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

// `suppliers` is deliberately NOT joined. Supplier name, currency, agent,
// Incoterm and PO email are SNAPSHOTS taken at create: a purchase order is a
// document addressed to a house at a moment, and re-pointing a brand at a new
// distributor next year must not rewrite who last year's orders were addressed
// to. `supplier_id` stays as the link a report rolls up on. Same argument as
// `sample_loans.holder_name`.
//
// `brands` IS joined: the brand is the grouping key rather than part of the
// document, and a screen listing purchase orders needs the house's name.
const PO_FROM = `purchase_orders po
       JOIN brands b ON b.id = po.brand_id
       LEFT JOIN users u ON u.id = po.created_by`

const PO_COLUMNS = `po.id,
        po.po_number,
        po.brand_id,
        b.name AS brand_name,
        b.slug AS brand_slug,
        po.supplier_id,
        po.supplier_name,
        po.currency,
        po.agent,
        po.incoterm,
        po.po_email,
        po.status,
        po.sent_at,
        po.paid_at,
        po.closed_at,
        po.cancelled_at,
        po.expected_at,
        po.created_by,
        u.name AS created_by_name,
        po.notes,
        po.xero_bill_id,
        po.xero_bill_ref,
        po.xero_bill_status,
        po.xero_bill_paid_at,
        po.created_at,
        po.updated_at`

// Received quantity is a CORRELATED SCALAR SUBQUERY rather than an aggregate
// join, for the reason `loan_count` states in src/samples/admin-samples.js: an
// aggregate join needs a GROUP BY over every selected column and can multiply
// rows. It is indexed (`purchase_order_receipts_purchase_order_line_id_index`).
const LINE_COLUMNS = `l.id,
        l.purchase_order_id,
        l.colourway_id,
        l.qty_ordered,
        l.unit_price,
        l.is_sample,
        l.sample_barcode,
        l.supplier_code,
        l.notes,
        c.sku,
        c.name AS colourway_name,
        p.name AS product_name,
        (SELECT COALESCE(SUM(r.qty), 0)
           FROM purchase_order_receipts r
          WHERE r.purchase_order_line_id = l.id) AS qty_received`

const LINE_FROM = `purchase_order_lines l
       JOIN colourways c ON c.id = l.colourway_id
       JOIN products p ON p.id = c.product_id`

const loadAllocationsByLineId = async (db, lineIds) => {
  if (lineIds.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT a.id,
            a.purchase_order_line_id,
            a.order_line_id,
            a.qty,
            a.released_at,
            ol.order_id,
            o.order_number,
            o.status AS order_status
       FROM purchase_order_line_allocations a
       JOIN order_lines ol ON ol.id = a.order_line_id
       JOIN orders o ON o.id = ol.order_id
      WHERE a.purchase_order_line_id = ANY($1::int[])
      ORDER BY a.id`,
    [lineIds]
  )
  const byLine = new Map()
  for (const row of rows) {
    const allocation = Object.freeze({
      id: row.id,
      order_line_id: row.order_line_id,
      order_id: row.order_id,
      order_number: row.order_number,
      order_status: row.order_status,
      qty: Number(row.qty),
      released_at: row.released_at,
    })
    const existing = byLine.get(row.purchase_order_line_id)
    if (existing) existing.push(allocation)
    else byLine.set(row.purchase_order_line_id, [allocation])
  }
  return byLine
}

const toLine = (row, allocations, receipts, finance) => {
  const ordered = Number(row.qty_ordered)
  const received = Number(row.qty_received)
  const unitPrice = numeric(row.unit_price)
  const line = {
    id: row.id,
    colourway_id: row.colourway_id,
    sku: row.sku,
    colourway_name: row.colourway_name,
    product_name: row.product_name,
    // Not money and not masked: which lines are samples, and which tag each one
    // names, is what a receipting screen needs whoever is holding it. The PRICE
    // of a sample line is `unit_price` and is finance-gated like every other.
    is_sample: row.is_sample === true,
    sample_barcode: row.sample_barcode,
    supplier_code: row.supplier_code,
    notes: row.notes,
    qty_ordered: ordered,
    qty_received: round2(received),
    // The per-line backorder balance (FR-146). Never clamped at zero: an
    // over-receipt is a legitimate negative outstanding and hiding it destroys
    // exactly the discrepancy the office needs to take up with the house.
    qty_outstanding: round2(ordered - received),
    receipt_state: receiptState(ordered, received),
    allocations: Object.freeze(allocations ?? []),
    allocated_qty: round2(
      (allocations ?? [])
        .filter((allocation) => allocation.released_at === null)
        .reduce((sum, allocation) => sum + allocation.qty, 0)
    ),
    receipts: Object.freeze(receipts ?? []),
  }
  // DELETED, not nulled: a key that survives with an empty value still tells the
  // reader which figures exist and is one grep away from being counted.
  if (finance) {
    line.unit_price = unitPrice
    line.line_cost = unitPrice === null ? null : round2(ordered * unitPrice)
  }
  return Object.freeze(line)
}

const summarise = (lines, finance) => {
  const costs = lines.map((line) => (finance ? line.line_cost : null))
  const summary = {
    line_count: lines.length,
    qty_ordered: round2(lines.reduce((sum, line) => sum + line.qty_ordered, 0)),
    qty_received: round2(lines.reduce((sum, line) => sum + line.qty_received, 0)),
    qty_outstanding: round2(lines.reduce((sum, line) => sum + line.qty_outstanding, 0)),
    receipt_state: rollUpReceiptState(lines.map((line) => line.receipt_state)),
  }
  if (finance) {
    // A total over lines that are not all priced would read as the cost of the
    // whole order while describing part of it — the "figure that cannot be
    // added is ABSENT" rule the reporting layer already applies. `unpriced_lines`
    // is what lets a screen say why.
    const unpriced = costs.filter((cost) => cost === null).length
    summary.unpriced_lines = unpriced
    summary.total_cost =
      unpriced > 0 ? null : round2(costs.reduce((sum, cost) => sum + cost, 0))
  }
  return summary
}

const toPurchaseOrder = (row, lines, finance, invoice) =>
  Object.freeze({
    id: row.id,
    po_number: row.po_number,
    brand_id: row.brand_id,
    brand_name: row.brand_name,
    brand_slug: row.brand_slug,
    supplier_id: row.supplier_id,
    // The snapshot, as the paper said on the day.
    supplier_name: row.supplier_name,
    currency: row.currency,
    agent: row.agent,
    incoterm: row.incoterm,
    po_email: row.po_email,
    status: row.status,
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    closed_at: row.closed_at,
    cancelled_at: row.cancelled_at,
    expected_at: row.expected_at,
    created_by: row.created_by,
    created_by_name: row.created_by_name ?? null,
    notes: row.notes,
    // The Xero BILL raised for this order (the buy-side twin of
    // `orders.xero_invoice_id`), and Xero's own answer about it, mirrored by the
    // sync. Beside `status`, never in it: whether the bill is paid is a fact
    // about the bank, not a move a person made here.
    xero_bill_id: row.xero_bill_id ?? null,
    xero_bill_ref: row.xero_bill_ref ?? null,
    xero_bill_status: row.xero_bill_status ?? null,
    xero_bill_paid_at: row.xero_bill_paid_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Which supplier invoice, if any, has already billed for this purchase
    // order (W14-US-003). `null` is "not billed yet", which is what the
    // matching search lists. It is a whole object rather than a bare id because
    // the one thing a buyer asks is WHICH bill, and the invoice number is what
    // is written on the paper in their hand. The amount inside it is
    // finance-gated by the loader.
    supplier_invoice: invoice ?? null,
    ...summarise(lines, finance),
    lines: Object.freeze(lines),
  })

// One batch load for a page of purchase orders: lines, then their allocations
// and receipts. Three round trips whatever the page size — the `loadLinesByOrderId`
// posture, rather than one query per order.
const loadLinesByPurchaseOrderId = async (db, purchaseOrderIds, finance, { withReceipts }) => {
  if (purchaseOrderIds.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT ${LINE_COLUMNS}
       FROM ${LINE_FROM}
      WHERE l.purchase_order_id = ANY($1::int[])
      ORDER BY l.id`,
    [purchaseOrderIds]
  )
  const lineIds = rows.map((row) => row.id)
  const allocations = await loadAllocationsByLineId(db, lineIds)
  const receipts = withReceipts ? await loadReceiptsByLineId(db, lineIds) : new Map()

  const byPurchaseOrder = new Map()
  for (const row of rows) {
    const line = toLine(row, allocations.get(row.id), receipts.get(row.id), finance)
    const existing = byPurchaseOrder.get(row.purchase_order_id)
    if (existing) existing.push(line)
    else byPurchaseOrder.set(row.purchase_order_id, [line])
  }
  return byPurchaseOrder
}

// Filter names are trusted column references; every VALUE flows through a $n
// placeholder. Shape copied from `buildWhere` in admin-price-lists.js.
const buildWhere = ({ supplierId, brandId, status, from, to }) => {
  const clauses = []
  const params = []
  if (supplierId) {
    params.push(supplierId)
    clauses.push(`po.supplier_id = $${params.length}`)
  }
  if (brandId) {
    params.push(brandId)
    clauses.push(`po.brand_id = $${params.length}`)
  }
  if (status) {
    params.push(status)
    clauses.push(`po.status = $${params.length}`)
  }
  if (from) {
    params.push(from)
    clauses.push(`po.created_at >= $${params.length}::date`)
  }
  if (to) {
    // Exclusive on the NEXT day, never `<= to::date`. `created_at` is
    // timestamptz, so `<= to::date` cuts the range at that morning's midnight
    // and silently drops the whole last day — the rule src/reports/filters.js
    // states, applied here for the same reason.
    params.push(to)
    clauses.push(`po.created_at < ($${params.length}::date + 1)`)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/**
 * Filtered, paginated purchase orders (FR-145), newest first, each carrying its
 * lines and their derived receipt figures.
 *
 * @param {import('pg').Pool} pool
 * @param {{ supplierId?: number, brandId?: number, status?: string,
 *           from?: string, to?: string, page?: number, limit?: number,
 *           finance?: boolean }} [options]
 * @returns {Promise<{ purchase_orders: object[], total: number }>}
 */
export const listPurchaseOrders = async (pool, options = {}) => {
  const { page, limit, finance = false } = options
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildWhere(options)

  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM ${PO_FROM} ${where}`,
    params
  )

  const { rows } = await pool.query(
    `SELECT ${PO_COLUMNS}
       FROM ${PO_FROM}
       ${where}
      ORDER BY po.created_at DESC, po.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  // The list carries no receipt LEDGER — the figures it needs are derived from
  // the SUM, and shipping every movement of every line into a list screen is
  // weight nobody reads. The detail read carries them.
  const linesByPurchaseOrder = await loadLinesByPurchaseOrderId(
    pool,
    rows.map((row) => row.id),
    finance,
    { withReceipts: false }
  )
  const invoices = await loadInvoiceStateByPurchaseOrderId(
    pool,
    rows.map((row) => row.id),
    finance
  )

  return {
    purchase_orders: rows.map((row) =>
      toPurchaseOrder(
        row,
        linesByPurchaseOrder.get(row.id) ?? [],
        finance,
        invoices.get(row.id)
      )
    ),
    total: countResult.rows[0].total,
  }
}

/**
 * One purchase order with its lines, allocations and the full receipt ledger,
 * or null when it does not exist. Reads through `db` (pool or open client) so it
 * can reflect an open transaction.
 *
 * @param {{ query: Function }} db
 * @param {number} id
 * @param {{ finance?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export const getPurchaseOrder = async (db, id, { finance = false } = {}) => {
  const { rows } = await db.query(
    `SELECT ${PO_COLUMNS} FROM ${PO_FROM} WHERE po.id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) return null
  const lines = await loadLinesByPurchaseOrderId(db, [id], finance, { withReceipts: true })
  const invoices = await loadInvoiceStateByPurchaseOrderId(db, [id], finance)
  return toPurchaseOrder(row, lines.get(id) ?? [], finance, invoices.get(id))
}

// ---------------------------------------------------------------------------
// The transaction wrapper
// ---------------------------------------------------------------------------

/**
 * Lock the purchase order, run a mutation inside one transaction, and return the
 * fresh document. 404 when the id is unknown.
 *
 * `FOR UPDATE`, never `FOR NO KEY UPDATE`: an INSERT of a line or an allocation
 * inside the same transaction takes `FOR KEY SHARE` on the row it references,
 * and `FOR KEY SHARE` conflicts with `FOR UPDATE` and with nothing weaker — so
 * the weaker mode would let two writes to one purchase order run side by side.
 * The same rule src/lifecycle/delete.js states for check-then-delete.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {(client: object, purchaseOrder: object) => Promise<void>} fn
 * @param {{ finance?: boolean }} [options]
 */
export const withPurchaseOrderTxn = async (pool, id, fn, { finance = false } = {}) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, status FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const purchaseOrder = rows[0]
    if (!purchaseOrder) {
      throw httpError(404, `Purchase order ${id} not found.`)
    }
    await fn(client, purchaseOrder)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getPurchaseOrder(pool, id, { finance })
}

// ---------------------------------------------------------------------------
// The allocation rule (invariant 3 in the header)
// ---------------------------------------------------------------------------

// Lock one purchase-order line and read the two numbers the rule is over. The
// lock is the whole mechanism: without it two concurrent allocations each read
// the same "already allocated" figure and both pass a check that the pair of
// them breaks.
const lockLine = async (client, lineId) => {
  const { rows } = await client.query(
    `SELECT id, purchase_order_id, qty_ordered, is_sample
       FROM purchase_order_lines
      WHERE id = $1
      FOR UPDATE`,
    [lineId]
  )
  if (!rows[0]) {
    throw httpError(404, `Purchase-order line ${lineId} not found.`)
  }
  return { ...rows[0], qty_ordered: Number(rows[0].qty_ordered) }
}

// Only LIVE allocations count. A released one (its purchase order was cancelled)
// has handed its claim back to the next derivation and must not go on holding
// capacity against a line it no longer covers.
const liveAllocatedQty = async (client, lineId) => {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(qty), 0) AS qty
       FROM purchase_order_line_allocations
      WHERE purchase_order_line_id = $1 AND released_at IS NULL`,
    [lineId]
  )
  return Number(rows[0].qty)
}

/**
 * THE only path that writes an allocation. Both the derivation and the manual
 * allocate route go through it, so the `SUM(qty) <= qty_ordered` rule has one
 * enforcement rather than two that can drift.
 *
 * `<=`, not `=`: the unallocated remainder is a deliberate stock buy — buying a
 * full roll to cover a 25 m order is how this trade works.
 *
 * @param {object} client an open transaction
 * @param {number} lineId
 * @param {{ orderLineId: number, qty: number }} allocation
 */
export const insertAllocation = async (client, lineId, { orderLineId, qty }) => {
  const line = await lockLine(client, lineId)
  // A sample line is never demand bought against a sales order (C18). The
  // derivation cannot reach one — its lines come from open sales demand and a
  // sample is added by hand — so the manual allocate route is the only caller
  // this refuses, and it is refused HERE because this is the one path that
  // writes an allocation.
  if (line.is_sample) {
    throw httpError(
      422,
      'This is a sample line — a hanger or cutting bought for the library, not ' +
        'stock bought against a sales order — so it cannot cover sales demand.'
    )
  }
  const allocated = await liveAllocatedQty(client, lineId)
  if (round2(allocated + qty) > line.qty_ordered) {
    throw httpError(
      422,
      `This line orders ${line.qty_ordered} and ${allocated} is already allocated, ` +
        `so ${qty} more would over-commit it. Increase the ordered quantity first.`
    )
  }
  try {
    const { rows } = await client.query(
      `INSERT INTO purchase_order_line_allocations (purchase_order_line_id, order_line_id, qty)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [lineId, orderLineId, qty]
    )
    return rows[0].id
  } catch (error) {
    if (error?.code === '23505' && error.constraint === OPEN_ALLOCATION_UNIQUE) {
      // Re-thrown as-is so the derivation can name the covering purchase order;
      // the direct caller gets the same fact through `describeExistingCover`.
      throw error
    }
    if (error?.code === '23503') {
      throw httpError(422, `Order line ${orderLineId} does not exist.`)
    }
    throw error
  }
}

// Which purchase order already covers one of these sales-order lines. Answered
// by a query rather than by parsing `error.detail`, because the detail string is
// a pg display format and not an interface.
const describeExistingCover = async (db, orderLineIds) => {
  const { rows } = await db.query(
    `SELECT po.po_number, o.order_number
       FROM purchase_order_line_allocations a
       JOIN purchase_order_lines l ON l.id = a.purchase_order_line_id
       JOIN purchase_orders po ON po.id = l.purchase_order_id
       JOIN order_lines ol ON ol.id = a.order_line_id
       JOIN orders o ON o.id = ol.order_id
      WHERE a.order_line_id = ANY($1::int[]) AND a.released_at IS NULL
      ORDER BY a.id
      LIMIT 1`,
    [orderLineIds]
  )
  const hit = rows[0]
  return httpError(
    409,
    hit
      ? `${hit.order_number} is already covered by purchase order ${hit.po_number}. ` +
          'Someone raised these while you were looking at them — re-run the plan to ' +
          'see what is left.'
      : 'One of these sales-order lines is already on a purchase order. Re-run the ' +
          'plan to see what is left.'
  )
}

// ---------------------------------------------------------------------------
// The derivation
// ---------------------------------------------------------------------------

// The candidate predicate. `RESERVING_KINDS` and `HELD_STATUSES` are IMPORTED —
// a card checkout is excluded by construction (it is not a reserving kind: it
// arrived paid with stock already decremented, so it is not demand to buy
// against), and shipped/completed/cancelled/refunded have already been settled.
// A quote still at `quote_requested` IS a candidate: the office may raise the
// purchase order before quoting, whatever the stock says.
//
// The `NOT EXISTS` is what makes the DRY RUN honest. It is NOT the anti-double-
// order guard: it reads rows a concurrent transaction is about to write, which
// is exactly the window the partial unique index closes.
const CANDIDATE_SQL = `SELECT ol.id AS order_line_id,
            ol.order_id,
            o.order_number,
            ol.qty,
            ol.colourway_id,
            c.sku,
            p.name AS product_name,
            b.id AS brand_id,
            b.name AS brand_name,
            b.slug AS brand_slug,
            b.supplier_id,
            s.name AS supplier_name,
            s.currency,
            s.agent,
            s.incoterm,
            s.po_email
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
       JOIN colourways c ON c.id = ol.colourway_id
       JOIN products p ON p.id = c.product_id
       JOIN brands b ON b.id = p.brand_id
       LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE o.kind = ANY($1::text[])
        AND o.status = ANY($2::text[])
        AND o.archived_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM purchase_order_line_allocations a
               WHERE a.order_line_id = ol.id AND a.released_at IS NULL)`

/**
 * The dry run (FR-134). Reads the open demand, groups it by brand, and returns
 * exactly what `generatePurchaseOrders` would write — same function, so the
 * screen and the act cannot disagree about what was grouped.
 *
 * `orderIds` narrows the run to named sales orders — the order page's "Create
 * purchase order" — beside or instead of `brandIds`.
 *
 * @param {{ query: Function }} db
 * @param {{ brandIds?: number[]|null, orderIds?: number[]|null }} [options]
 */
export const planPurchaseOrdersFromOrders = async (
  db,
  { brandIds = null, orderIds = null } = {}
) => {
  const params = [[...RESERVING_KINDS], [...HELD_STATUSES]]
  let filter = ''
  if (Array.isArray(brandIds) && brandIds.length > 0) {
    params.push(brandIds)
    filter += ` AND b.id = ANY($${params.length}::int[])`
  }
  if (Array.isArray(orderIds) && orderIds.length > 0) {
    params.push(orderIds)
    filter += ` AND o.id = ANY($${params.length}::int[])`
  }
  const { rows } = await db.query(
    `${CANDIDATE_SQL}${filter} ORDER BY b.name, c.sku, ol.id`,
    params
  )
  return planPurchaseOrders(rows)
}

const insertPurchaseOrderHeader = async (client, group, user) => {
  const { rows } = await client.query(
    `INSERT INTO purchase_orders
       (po_number, brand_id, supplier_id, supplier_name, currency, agent, incoterm,
        po_email, created_by, expected_at, notes)
     VALUES (${PO_NUMBER}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      group.brand_id,
      group.supplier_id,
      group.supplier_name,
      group.currency,
      group.agent,
      group.incoterm,
      group.po_email,
      user?.id ?? null,
      group.expected_at ?? null,
      group.notes ?? null,
    ]
  )
  return rows[0].id
}

const insertLine = async (client, purchaseOrderId, line) => {
  const { rows } = await client.query(
    `INSERT INTO purchase_order_lines
       (purchase_order_id, colourway_id, qty_ordered, unit_price, is_sample,
        sample_barcode, supplier_code, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      purchaseOrderId,
      line.colourway_id,
      line.qty_ordered,
      // NULL, never 0. Nothing in this schema can derive a purchase price for a
      // colourway, and `Number(null)` is 0 — a zero purchase price reads as free.
      line.unit_price ?? null,
      // The derivation's planner produces no `is_sample` at all, which is what
      // keeps a derived line a goods line BY CONSTRUCTION: a sample is added by
      // hand to a purchase order, never derived from demand.
      line.is_sample === true,
      line.sample_barcode ?? null,
      line.supplier_code ?? null,
      line.notes ?? null,
    ]
  )
  return rows[0].id
}

// The two-column CHECK's friendly answer. A 23514 is a rejected value, not a
// server fault, so a direct caller must not meet it as a 500 — the same mapping
// src/samples/admin-samples.js makes for samples_unit_cost_check.
const rethrowSampleBarcodeCheck = (error) => {
  if (
    error?.code === '23514' &&
    error.constraint === 'purchase_order_lines_sample_barcode_check'
  ) {
    throw httpError(
      422,
      'A sample barcode only belongs on a sample line. Mark the line as a sample, ' +
        'or clear the barcode.'
    )
  }
}

/**
 * Turn the day's open demand into purchase orders (FR-134).
 *
 * ONE transaction over the whole run: either the derivation happened or it did
 * not. A per-group transaction would leave a partial run behind after a
 * collision, and the office would have to work out which houses were already
 * ordered from by reading the ledger.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brandIds?: number[]|null, orderIds?: number[]|null, user?: object|null, finance?: boolean }} [options]
 * @returns {Promise<{ purchase_orders: object[], blocked: ReadonlyArray<object>, candidate_lines: number }>}
 */
export const generatePurchaseOrders = async (
  pool,
  { brandIds = null, orderIds = null, user = null, finance = false } = {}
) => {
  const plan = await planPurchaseOrdersFromOrders(pool, { brandIds, orderIds })

  // A brand named EXPLICITLY by the caller and carrying no supplier is a 422
  // naming it (FR-133): the caller asked for that house and there is no house to
  // address. An unfiltered run reports `blocked` and creates the rest instead —
  // most houses are unlinked today, and refusing the whole run because of them
  // would make the derivation unusable while the backfill catches up.
  if (Array.isArray(brandIds) && brandIds.length > 0 && plan.blocked.length > 0) {
    throw httpError(422, plan.blocked.map((entry) => entry.message).join(' '))
  }

  if (plan.groups.length === 0) {
    return { purchase_orders: [], blocked: plan.blocked, candidate_lines: plan.candidate_lines }
  }

  const orderLineIds = plan.groups.flatMap((group) =>
    group.lines.flatMap((line) => line.allocations.map((allocation) => allocation.order_line_id))
  )

  const client = await pool.connect()
  const created = []
  try {
    await client.query('BEGIN')
    for (const group of plan.groups) {
      const purchaseOrderId = await insertPurchaseOrderHeader(client, group, user)
      for (const line of group.lines) {
        const lineId = await insertLine(client, purchaseOrderId, line)
        for (const allocation of line.allocations) {
          await insertAllocation(client, lineId, {
            orderLineId: allocation.order_line_id,
            qty: allocation.qty,
          })
        }
      }
      created.push(purchaseOrderId)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    if (error?.code === '23505' && error.constraint === OPEN_ALLOCATION_UNIQUE) {
      throw await describeExistingCover(pool, orderLineIds)
    }
    throw error
  } finally {
    client.release()
  }

  const purchaseOrders = []
  for (const id of created) {
    purchaseOrders.push(await getPurchaseOrder(pool, id, { finance }))
  }
  return { purchase_orders: purchaseOrders, blocked: plan.blocked, candidate_lines: plan.candidate_lines }
}

/**
 * Move the sales orders a run raised purchase orders for onto `back_order`
 * (24 Sep 2026: the order page's "Create purchase order"). Only an order the
 * machine lets move is moved; one that cannot — a paid order, one already on
 * back order — keeps its status and is reported in `notMoved`, because the
 * purchase order itself was still right to raise. Runs after the generate
 * committed: the purchase orders stand whether or not an order moves.
 *
 * @param {import('pg').Pool} pool
 * @param {object[]} purchaseOrders the generate's `purchase_orders`
 * @param {{ actor: { kind: string, userId?: number|null } }} options
 * @returns {Promise<{ moved: object[], notMoved: Array<{ order_number: string, status: string }> }>}
 */
export const backOrderRaisedOrders = async (pool, purchaseOrders, { actor }) => {
  const orderIds = [
    ...new Set(
      purchaseOrders.flatMap((po) =>
        (po.lines ?? []).flatMap((line) => (line.allocations ?? []).map((a) => a.order_id))
      )
    ),
  ]
  const moved = []
  const notMoved = []
  for (const orderId of orderIds) {
    const { rows } = await pool.query(`SELECT order_number, status FROM orders WHERE id = $1`, [
      orderId,
    ])
    const order = rows[0]
    if (!order) continue
    if (!canTransition(order.status, 'back_order')) {
      notMoved.push({ order_number: order.order_number, status: order.status })
      continue
    }
    try {
      moved.push(await setOrderStatus(pool, orderId, 'back_order', { actor }))
    } catch (error) {
      // Somebody moved it between the read and the transaction: report it as
      // it now stands rather than fail a run whose purchase orders exist.
      if (error?.statusCode !== 409) throw error
      notMoved.push({ order_number: order.order_number, status: order.status })
    }
  }
  return { moved, notMoved }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// The supplier, derived. This is the whole of invariant one and it is the ONLY
// place either write path gets a supplier id from. A house may have several
// suppliers (migration 1791638400000): the caller may NAME one, but only one
// that invoices the house — `supplierForBrand` refuses any other with a 422 —
// and naming none means the main supplier.
const resolveBrandSupplier = async (db, brandId, supplierId = null) => {
  const { rows } = await db.query('SELECT id, name FROM brands WHERE id = $1', [brandId])
  const brand = rows[0]
  if (!brand) {
    throw httpError(422, `House ${brandId} does not exist.`)
  }
  const supplier = await supplierForBrand(db, brandId, supplierId)
  if (!supplier) {
    throw httpError(
      422,
      `"${brand.name}" has no supplier linked, so there is no house to address a ` +
        'purchase order to. Link one on the house record first.'
    )
  }
  return {
    id: brand.id,
    name: brand.name,
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    currency: supplier.currency,
    agent: supplier.agent,
    incoterm: supplier.incoterm,
    po_email: supplier.po_email,
  }
}

/**
 * Raise a purchase order by hand — a stock buy, or an order placed for a reason
 * no sales order records. `supplier_id` is optional and must be one of the
 * house's suppliers; absent means the house's main supplier.
 *
 * @param {import('pg').Pool} pool
 * @param {{ brand_id: number, supplier_id?: number|null, lines: Array<object>, expected_at?: string|null, notes?: string|null }} input
 * @param {{ user?: object|null, finance?: boolean }} [ctx]
 */
export const createPurchaseOrder = async (
  pool,
  input,
  { user = null, finance = false } = {}
) => {
  const brand = await resolveBrandSupplier(pool, input.brand_id, input.supplier_id ?? null)
  const client = await pool.connect()
  let purchaseOrderId
  try {
    await client.query('BEGIN')
    purchaseOrderId = await insertPurchaseOrderHeader(
      client,
      {
        brand_id: brand.id,
        supplier_id: brand.supplier_id,
        supplier_name: brand.supplier_name,
        currency: brand.currency,
        agent: brand.agent,
        incoterm: brand.incoterm,
        po_email: brand.po_email,
        expected_at: input.expected_at ?? null,
        notes: input.notes ?? null,
      },
      user
    )
    for (const line of input.lines) {
      await insertLine(client, purchaseOrderId, line)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    rethrowSampleBarcodeCheck(error)
    if (error?.code === '23503') {
      throw httpError(422, 'One of those colourways does not exist.')
    }
    throw error
  } finally {
    client.release()
  }
  return getPurchaseOrder(pool, purchaseOrderId, { finance })
}

// The header fields staff may correct. `supplier_id`, `brand_id`, `po_number`
// and `status` are all absent, and each for its own reason: the first two are
// derived, the third is the sequence's, and the fourth moves through the verb
// routes so the state and its stamp are written together.
//
// The four SNAPSHOT fields ARE editable, deliberately — the same argument
// `users.email` carries. A wrong PO address means the order reaches nobody, a
// wrong Incoterm means the freight is billed on the wrong basis, and a purchase
// order nobody can correct is one the office re-keys somewhere else. Correcting
// the snapshot is not the same act as re-pointing the brand at a new supplier,
// which still cannot rewrite this document.
export const PURCHASE_ORDER_UPDATE_COLUMNS = Object.freeze([
  'expected_at',
  'notes',
  'po_email',
  'agent',
  'incoterm',
  'currency',
])

// What a line PATCH may write. `colourway_id` is absent: a line naming the wrong
// design is a different line, and editing it would silently re-point every
// allocation and receipt already hanging off it. `is_sample` and
// `sample_barcode` ARE here — a goods line keyed without its sample tick is the
// ordinary mistake, and correcting the paper must not mean re-keying the line —
// with the one guard below: a line already covering sales demand cannot become
// a sample, because a sample line never allocates demand.
const LINE_UPDATE_COLUMNS = Object.freeze([
  'qty_ordered',
  'unit_price',
  'is_sample',
  'sample_barcode',
  'supplier_code',
  'notes',
])

const applyLinePatch = async (client, purchaseOrderId, edit) => {
  const line = await lockLine(client, edit.id)
  if (line.purchase_order_id !== purchaseOrderId) {
    throw httpError(422, `Line ${edit.id} is not on purchase order ${purchaseOrderId}.`)
  }
  // Lowering `qty_ordered` is the other way `SUM(allocations.qty) <= qty_ordered`
  // can be broken, and it is the easy one to miss: the allocations are untouched
  // and the line quietly stops covering them. Same lock, same rule.
  if (edit.qty_ordered !== undefined) {
    const allocated = await liveAllocatedQty(client, edit.id)
    if (allocated > edit.qty_ordered) {
      throw httpError(
        422,
        `${allocated} is already allocated to sales orders from this line, so it ` +
          `cannot be reduced to ${edit.qty_ordered}.`
      )
    }
  }
  // The invariant "a sample line has no sales-order allocation" has a second
  // door: flipping a GOODS line that already covers demand. The allocations
  // would sit untouched on a line the rest of the system may no longer allocate
  // against or count as demand — the same silent break the qty_ordered guard
  // above closes, under the same lock.
  if (edit.is_sample === true && line.is_sample !== true) {
    const allocated = await liveAllocatedQty(client, edit.id)
    if (allocated > 0) {
      throw httpError(
        422,
        `${allocated} is allocated to sales orders from this line, so it cannot ` +
          'become a sample line. A sample never covers sales demand.'
      )
    }
  }
  const { sets, params } = buildUpdate(edit, LINE_UPDATE_COLUMNS)
  try {
    await client.query(
      `UPDATE purchase_order_lines SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length + 1}`,
      [...params, edit.id]
    )
  } catch (error) {
    rethrowSampleBarcodeCheck(error)
    throw error
  }
}

/**
 * Patch a purchase order's header and/or its line quantities and prices.
 *
 * Refused on a cancelled order: that document is closed and its demand has gone
 * back to the order desk, so editing it would describe an order nobody placed.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{ lines?: Array<object> }} patch
 * @param {{ finance?: boolean }} [options]
 */
export const updatePurchaseOrder = (pool, id, patch, { finance = false } = {}) =>
  withPurchaseOrderTxn(
    pool,
    id,
    async (client, purchaseOrder) => {
      requireStatus(purchaseOrder, ['draft', 'sent', 'paid', 'closed'], 'edit')

      const headerColumns = PURCHASE_ORDER_UPDATE_COLUMNS.filter((column) =>
        Object.hasOwn(patch, column)
      )
      if (headerColumns.length > 0) {
        const { sets, params } = buildUpdate(patch, PURCHASE_ORDER_UPDATE_COLUMNS)
        await client.query(
          `UPDATE purchase_orders SET ${sets.join(', ')}, updated_at = now()
            WHERE id = $${params.length + 1}`,
          [...params, id]
        )
      }

      for (const edit of patch.lines ?? []) {
        await applyLinePatch(client, id, edit)
      }
    },
    { finance }
  )

// One move writes the state AND the stamp that dates it; either alone is a row
// that contradicts itself. The stamp column is a code literal out of the frozen
// `STATUS_STAMPS` map, never user input.
const moveStatus = async (client, id, target) => {
  const stamp = STATUS_STAMPS[target]
  await client.query(
    `UPDATE purchase_orders SET status = $2, ${stamp} = now(), updated_at = now()
      WHERE id = $1`,
    [id, target]
  )
}

/**
 * The house has been paid — by hand, or mirrored from the Xero bill (the sync
 * calls this when Xero answers PAID). Refused as a 409 where the machine does
 * not allow it, so a draft cannot be "paid" and a paid order is not re-paid.
 */
export const payPurchaseOrder = (pool, id, { finance = false } = {}) =>
  withPurchaseOrderTxn(
    pool,
    id,
    async (client, purchaseOrder) => {
      requireTransition(purchaseOrder, 'paid')
      await moveStatus(client, id, 'paid')
    },
    { finance }
  )

/** Mark a draft as sent to the house. */
export const sendPurchaseOrder = (pool, id, { finance = false } = {}) =>
  withPurchaseOrderTxn(
    pool,
    id,
    async (client, purchaseOrder) => {
      requireTransition(purchaseOrder, 'sent')
      await moveStatus(client, id, 'sent')
    },
    { finance }
  )

/**
 * Close a sent purchase order — including SHORT, which is the whole reason this
 * is a decision rather than arithmetic. The allocations are NOT released: the
 * goods that did arrive were bought against those sales orders, and handing the
 * demand back would have the next derivation buy it a second time.
 */
export const closePurchaseOrder = (pool, id, { finance = false } = {}) =>
  withPurchaseOrderTxn(
    pool,
    id,
    async (client, purchaseOrder) => {
      requireTransition(purchaseOrder, 'closed')
      await moveStatus(client, id, 'closed')
    },
    { finance }
  )

/**
 * Cancel a purchase order and RELEASE its allocations back to the order desk.
 *
 * The release is a stamp, not a delete: the allocation row is the record that
 * this sales-order line was once on this purchase order, and destroying it would
 * leave the cancellation looking like it never covered anything. Stamping
 * `released_at` drops the row out of `purchase_order_line_allocations_open_unique`,
 * which is precisely why that index has to be partial — otherwise a line
 * cancelled by mistake could never be ordered from anybody again.
 */
export const cancelPurchaseOrder = (pool, id, { finance = false } = {}) =>
  withPurchaseOrderTxn(
    pool,
    id,
    async (client, purchaseOrder) => {
      requireTransition(purchaseOrder, 'cancelled')
      await client.query(
        `UPDATE purchase_order_line_allocations a
            SET released_at = now()
           FROM purchase_order_lines l
          WHERE l.id = a.purchase_order_line_id
            AND l.purchase_order_id = $1
            AND a.released_at IS NULL`,
        [id]
      )
      await moveStatus(client, id, 'cancelled')
    },
    { finance }
  )

/**
 * Allocate part of a purchase-order line to a sales-order line by hand — the
 * case the derivation cannot cover, where the office buys stock first and a
 * client asks for it afterwards.
 *
 * @param {import('pg').Pool} pool
 * @param {number} lineId
 * @param {{ order_line_id: number, qty: number }} input
 * @param {{ finance?: boolean }} [options]
 */
export const allocatePurchaseOrderLine = async (
  pool,
  lineId,
  input,
  { finance = false } = {}
) => {
  const { rows } = await pool.query(
    `SELECT purchase_order_id FROM purchase_order_lines WHERE id = $1`,
    [lineId]
  )
  if (!rows[0]) {
    throw httpError(404, `Purchase-order line ${lineId} not found.`)
  }
  const purchaseOrderId = rows[0].purchase_order_id

  return withPurchaseOrderTxn(
    pool,
    purchaseOrderId,
    async (client, purchaseOrder) => {
      requireStatus(purchaseOrder, ['draft', 'sent', 'paid'], 'allocate against')
      try {
        await insertAllocation(client, lineId, {
          orderLineId: input.order_line_id,
          qty: input.qty,
        })
      } catch (error) {
        if (error?.code === '23505' && error.constraint === OPEN_ALLOCATION_UNIQUE) {
          // The transaction is doomed either way, so ask on the POOL rather than
          // on the aborted client.
          throw await describeExistingCover(pool, [input.order_line_id])
        }
        throw error
      }
    },
    { finance }
  )
}
