// The receipt ledger: goods booked in against a purchase-order line.
//
// APPEND-ONLY, AND THE MODULE HAS NO UPDATE AND NO DELETE. That is not an
// omission to fill in later — a receipt is a statement about a physical arrival,
// and the way to say "that was wrong" is another statement, not a rewrite of the
// first. `CHECK (qty <> 0)` in `1787716800000_purchase-order-receipts.js` is
// what makes a reversal expressible: a mistaken 42 is corrected by a -42, and
// the ledger then reads as what happened, in order. An edit leaves a number
// nobody can date; a delete leaves an absence nobody can explain.
//
// `purchase_order_receipt` IS DELIBERATELY ABSENT FROM
// `src/lifecycle/registry.js`, and the absence IS the protection:
// `requireEntity` throws a plain Error for an unknown name, so a DELETE route
// cannot be registered against this table even by accident. Nothing to argue
// with beats a guard that returns a refusal.
//
// **NOTHING HERE WRITES AN INVENTORY QUANTITY.** `moveReservation` in
// `src/orders/admin-orders.js` is the sole writer of `inventory.qty_reserved`
// and `qty_available`. A second writer does not break loudly — it breaks
// SILENTLY, by making the reserved figure stop meaning what every other reader
// assumes, and W13, W19 and W20 can each do it independently. Receipting
// feeding stock is a separate, deliberate decision that has not been taken.
// `test/purchasing.test.js` asserts it twice: a source scan over this whole
// domain for `inventory` in a SQL position, and a statement scan over a
// recording stub pool.
//
// OVER-RECEIPT IS NEVER CLAMPED. There is no comparison against `qty_ordered`
// anywhere in this file. Suppliers over-ship rolls; 42 against an order of 40 is
// a fact about the warehouse, and the read model reports `over` so the office
// can take it up with the house.
//
// This module does NOT import `admin-purchase-orders.js`. The dependency runs
// one way — that module loads receipts for its read model — so the route, not
// this file, re-reads the purchase order after a receipt lands.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Written out twice rather than derived from each other by string surgery: two
// short literals are readable at 3am, a `.replaceAll('r.', '')` is not.
const RECEIPT_COLUMNS = `id, purchase_order_line_id, qty, received_at,
              consignment_ref, received_by, notes, created_at`
const RECEIPT_COLUMNS_R = `r.id, r.purchase_order_line_id, r.qty, r.received_at,
              r.consignment_ref, r.received_by, r.notes, r.created_at`

// pg hands numeric back as a string. `qty` is NOT NULL so a plain Number() is
// safe here; every NULLABLE numeric in this domain uses the
// `value == null ? null : Number(value)` form instead.
const toReceipt = (row) =>
  Object.freeze({
    id: row.id,
    purchase_order_line_id: row.purchase_order_line_id,
    qty: Number(row.qty),
    received_at: row.received_at,
    consignment_ref: row.consignment_ref,
    received_by: row.received_by,
    received_by_name: row.received_by_name ?? null,
    notes: row.notes,
    created_at: row.created_at,
  })

/**
 * Every receipt for a set of purchase-order lines, in one query, grouped by
 * line — the batch-load posture `loadLinesByOrderId` already takes, so a
 * purchase order with twelve lines costs one round trip rather than twelve.
 *
 * Ordered by `received_at` then `id`, so a reversal always reads after the row
 * it reverses even when both were keyed on the same day.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {number[]} lineIds
 * @returns {Promise<Map<number, object[]>>}
 */
export const loadReceiptsByLineId = async (db, lineIds) => {
  if (!Array.isArray(lineIds) || lineIds.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT ${RECEIPT_COLUMNS_R}, u.name AS received_by_name
       FROM purchase_order_receipts r
       LEFT JOIN users u ON u.id = r.received_by
      WHERE r.purchase_order_line_id = ANY($1::int[])
      ORDER BY r.received_at, r.id`,
    [lineIds]
  )
  const byLine = new Map()
  for (const row of rows) {
    const existing = byLine.get(row.purchase_order_line_id)
    if (existing) existing.push(toReceipt(row))
    else byLine.set(row.purchase_order_line_id, [toReceipt(row)])
  }
  return byLine
}

/**
 * Book goods in against one purchase-order line.
 *
 * Returns `{ receipt, purchase_order_id }` rather than the whole purchase
 * order: the route re-reads through `getPurchaseOrder` so a receipt hands the
 * CRM exactly the shape a plain read does, and keeping that call in the route
 * is what stops this module and `admin-purchase-orders.js` importing each other.
 *
 * The only status refused is `cancelled`. A cancelled purchase order is one the
 * office says never happened, and its allocations have been released back to the
 * next derivation, so booking goods against it would credit demand that is
 * already spoken for elsewhere. `draft` is deliberately allowed — plenty of
 * orders are placed by phone and written up afterwards, and refusing the arrival
 * because the paperwork is behind makes the register argue with the person
 * holding the rolls.
 *
 * @param {import('pg').Pool} pool
 * @param {number} lineId
 * @param {{ qty: number, received_at?: string, consignment_ref?: string|null, notes?: string|null }} input
 * @param {{ user?: { id: number } }} [ctx]
 * @returns {Promise<{ receipt: object, purchase_order_id: number }>}
 */
export const createReceipt = async (pool, lineId, input, { user = null } = {}) => {
  const { rows: lineRows } = await pool.query(
    `SELECT l.id, l.purchase_order_id, po.status
       FROM purchase_order_lines l
       JOIN purchase_orders po ON po.id = l.purchase_order_id
      WHERE l.id = $1`,
    [lineId]
  )
  const line = lineRows[0]
  if (!line) {
    throw httpError(404, `Purchase-order line ${lineId} not found.`)
  }
  if (line.status === 'cancelled') {
    throw httpError(
      409,
      'This purchase order is cancelled, so its demand has been released back to ' +
        'the order desk. Raise a new purchase order for goods that have arrived.'
    )
  }

  // The CHECK is the enforcement (`qty <> 0`); this is the friendly answer, so a
  // rejected value never surfaces as a 500 to a direct caller. There is
  // deliberately no upper bound — over-receipt is legitimate.
  if (typeof input.qty !== 'number' || !Number.isFinite(input.qty) || input.qty === 0) {
    throw httpError(
      422,
      'A receipt quantity must be a non-zero number. Reverse a mistake with a ' +
        'negative quantity rather than editing or deleting the original row.'
    )
  }

  try {
    // COALESCE rather than a bare placeholder: the column is NOT NULL with a
    // `now()` default, and binding an explicit null would violate the NOT NULL
    // instead of taking the default. `received_at` is its own column so a
    // delivery keyed in on Monday can still carry Friday's date.
    const { rows } = await pool.query(
      `INSERT INTO purchase_order_receipts
         (purchase_order_line_id, qty, received_at, consignment_ref, received_by, notes)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5, $6)
       RETURNING ${RECEIPT_COLUMNS}`,
      [
        lineId,
        input.qty,
        input.received_at ?? null,
        input.consignment_ref ?? null,
        user?.id ?? null,
        input.notes ?? null,
      ]
    )
    return Object.freeze({
      receipt: toReceipt(rows[0]),
      purchase_order_id: line.purchase_order_id,
    })
  } catch (error) {
    // The route's `received_at` pattern can only police the SHAPE (Fastify's
    // bundled Ajv carries no `format` keywords), so `2026-02-31` reaches pg as a
    // 22007/22008. A rejected value must never surface as a 500 — the same
    // mapping src/samples/admin-samples.js makes.
    if (error?.code === '22007' || error?.code === '22008') {
      throw httpError(422, `"${input.received_at}" is not a real date and time.`)
    }
    throw error
  }
}
