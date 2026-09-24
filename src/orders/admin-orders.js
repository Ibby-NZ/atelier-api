// Back-office order management (US-014, FR-7).
//
// Staff review, edit, and drive website orders through their lifecycle. The
// interesting state lives in the reservation: an order-request reserves stock
// (qty_reserved) the moment it is placed (US-012). This module holds that
// reservation through quoting, invoicing and payment, then either converts it
// to a real decrement (shipped) or releases it (cancelled, refunded unshipped).
//
// Lifecycle (24 Sep 2026): quote_requested → quote_sent → quote_accepted |
// quote_rejected → back_order | processing → pending_payment → paid → shipped →
// completed, with cancelled and refunded as the dead ends. The legal moves are
// `ALLOWED_TRANSITIONS` in ./order-states.js and every one of them runs through
// `setOrderStatus` below — one function, one audit row per move — so a move the
// machine does not list is a 409 whoever asks. Checkout orders
// (kind='checkout') arrive already paid with inventory decremented and hold no
// reservation, so their inventory is never touched here.

import { setArchived } from '../lifecycle/archive.js'
// The staff segment is the rep vocabulary — one frozen list, never retyped.
import { USER_SEGMENTS } from '../users/admin-users.js'
// Which kinds hold a reservation lives in a leaf module: src/lifecycle/registry.js
// needs the same predicate for the delete guard and cannot import this file
// (archive.js -> registry.js -> here would be a cycle).
import {
  ORDER_STATUSES,
  DELIVERY_EDIT_STATUSES,
  LINE_EDIT_STATUSES,
  PRICED_ENTRY_STATUSES,
  holdsReservation,
  requireTransition,
  reservationState,
  reserves,
  unpricedLineCount,
} from './order-states.js'
// The same packing the storefront's request flow writes, so `orders.notes` reads
// identically however the order was raised.
import { buildNotes, addressOrNull } from './order-request.js'
// One shape of human order number for every channel — `SO` here.
import { orderNumber } from './order-number.js'
// The discount tiers and the director-only override gate (Rebecca-R2) — pure,
// like order-states.js, so the CRM can mirror the tiers and the gate tests
// without a database.
import { checkDiscountWrite } from './discounts.js'
// The free-text search layer: pure, and the only place a filter value becomes
// SQL. See src/orders/order-filters.js for why it is not src/reports/filters.js.
import { buildOrderFilters } from './order-filters.js'
// Who hears about a status change: the Emails list is stored one spelling per
// address, by the same rule the notifier dedupes with at send time.
import { uniqueEmails } from './notify-emails.js'

// Paging for the order desk, in the shape src/pricing/admin-price-lists.js
// established. MAX_LIMIT is spent as the route schema's `maximum`, so an
// over-large limit is a 400 rather than a page size nobody asked for.
export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The vocabulary lives in the leaf module now (the CRM and the registry read
// it there); re-exported for the route schemas and reports that import it
// from here.
export { ORDER_STATUSES }

// Which price list the order was written off. Stated on the order, never
// derived from the account: the storefront's trade-vs-retail rule
// (`canSeeTradePricing`) says what a shopper is QUOTED, and the office
// routinely charges the other one — trade terms for a walk-in job, retail for
// a one-off to a trade client. The route schema spends this as its `enum`, so
// the vocabulary and the CHECK cannot drift.
export const PRICE_TYPES = Object.freeze(['trade', 'retail'])

const requireStatus = (order, allowed, action) => {
  const set = Array.isArray(allowed) ? allowed : [allowed]
  if (!set.includes(order.status)) {
    throw httpError(
      409,
      `Cannot ${action} an order in status "${order.status}".`
    )
  }
}

// The account's own name/email, so a screen can say who an order is for. An
// order attributed to a login carries only `user_id`; without this the CRM had
// nothing to render but "Account #4". LEFT JOIN because a guest order has no
// account, and `orders.user_id` is SET NULL when one is deleted.
const ORDER_FROM = `orders o
       LEFT JOIN users u ON u.id = o.user_id
       LEFT JOIN users rep ON rep.id = o.sales_rep_user_id`

const ORDER_COLUMNS = `o.id,
        o.user_id,
        o.guest_email,
        u.name AS client_name,
        u.email AS client_email,
        o.order_number,
        o.kind,
        o.status,
        o.subtotal_cents,
        o.shipping_cents,
        o.gst_cents,
        o.total_cents,
        o.price_type,
        o.discount_pct,
        o.discount_reason,
        o.discount_applied_by,
        o.shipping_zone,
        o.xero_invoice_ref,
        o.xero_invoice_id,
        o.xero_invoice_status,
        o.shipping_address,
        o.contact_phone,
        o.client_reference,
        o.customer_po_number,
        o.tracking_url,
        o.sales_rep_user_id,
        rep.name AS sales_rep_name,
        CASE WHEN rep.archived_at IS NULL THEN rep.email END AS sales_rep_email,
        o.notify_emails,
        o.notes,
        o.archived_at,
        o.created_at`

// Load every line for a set of orders (one query, no N+1) with a snapshot of the
// colourway's inventory so staff see current stock alongside each line.
const loadLinesByOrderId = async (db, orderIds) => {
  if (orderIds.length === 0) {
    return new Map()
  }
  const { rows } = await db.query(
    `SELECT ol.order_id,
            ol.id,
            ol.qty,
            ol.unit_price_cents,
            ol.cut_requirements,
            ol.colourway_id,
            c.sku,
            c.name AS colourway_name,
            p.id AS product_id,
            p.slug AS product_slug,
            p.name AS product_name,
            p.composition,
            p.width,
            p.size,
            p.description,
            i.qty_available,
            i.qty_reserved,
            i.unit,
            po.id AS purchase_order_id,
            po.po_number,
            po.status AS purchase_order_status
       FROM order_lines ol
       JOIN colourways c ON c.id = ol.colourway_id
       JOIN products p ON p.id = c.product_id
       LEFT JOIN inventory i ON i.colourway_id = ol.colourway_id
       -- The purchase order raised for this line, if any. At most one live
       -- allocation per line (purchase_order_line_allocations_open_unique), so
       -- the join never duplicates a line.
       LEFT JOIN purchase_order_line_allocations a
              ON a.order_line_id = ol.id AND a.released_at IS NULL
       LEFT JOIN purchase_order_lines pol ON pol.id = a.purchase_order_line_id
       LEFT JOIN purchase_orders po ON po.id = pol.purchase_order_id
      WHERE ol.order_id = ANY($1::int[])
      ORDER BY ol.id`,
    [orderIds]
  )
  const byOrder = new Map()
  for (const row of rows) {
    const existing = byOrder.get(row.order_id)
    if (existing) {
      existing.push(row)
    } else {
      byOrder.set(row.order_id, [row])
    }
  }
  return byOrder
}

/**
 * Refuse a priced move while any line is still at $0.00 (422, naming the count
 * — the CRM shows API messages verbatim). Reads the lines inside the order's own
 * transaction: `withOrderTxn` selects only `id, kind, status`.
 *
 * Applied on ENTERING `PRICED_ENTRY_STATUSES` (a quote going out, an invoice,
 * money received), not on shipping: money is frozen from `paid` on, so once
 * `paid` refuses an unpriced order, an unpriced paid order cannot exist. The
 * Xero push applies the same predicate (`src/xero/service.js`). No director
 * override — an unpriced order is priced first, not invoiced at nil.
 */
const requirePriced = async (client, id, phrase) => {
  const lines = (await loadLinesByOrderId(client, [id])).get(id) ?? []
  const count = unpricedLineCount(lines)
  if (count > 0) {
    throw httpError(
      422,
      `Price every line before you ${phrase} — ${count} line${count === 1 ? ' is' : 's are'} still at $0.00.`
    )
  }
}

const toLine = (row, state) => ({
  id: row.id,
  sku: row.sku,
  product_name: row.product_name,
  // Where the line came from, so the CRM can open the catalogue record behind
  // a SKU instead of retyping it into a search (Userback 8367841).
  colourway_name: row.colourway_name,
  product_id: row.product_id,
  product_slug: row.product_slug,
  qty: row.qty,
  // 'metres' | 'units' from the inventory row; null for a colourway that has
  // never been stocked, exactly like `inventory` below. The customer shape
  // does not carry it — its lines have `product_type`, which decides the unit.
  unit: row.unit ?? null,
  // What the cloth is, as the catalogue states it: the packing slip prints
  // these under the design the way the D365 slip printed Contents and Width.
  // Null wherever the product record has not been filled in.
  composition: row.composition ?? null,
  width: row.width ?? null,
  size: row.size ?? null,
  description: row.description ?? null,
  unit_price_cents: row.unit_price_cents,
  cut_requirements: row.cut_requirements,
  colourway_id: row.colourway_id,
  inventory:
    row.qty_available === null
      ? null
      : { qty_available: row.qty_available, qty_reserved: row.qty_reserved },
  // How much of inventory.qty_reserved this line is responsible for right now.
  reserved_qty: state === 'held' && row.qty_available !== null ? row.qty : '0',
  // The purchase order raised for this line (its live allocation), so the CRM
  // can link the order desk to the paper that will fill it. Null when none.
  purchase_order:
    row.purchase_order_id === null || row.purchase_order_id === undefined
      ? null
      : { id: row.purchase_order_id, po_number: row.po_number, status: row.purchase_order_status },
})

// Every status move an order has made, newest first (one query for the whole
// set, grouped — the lines loader's posture). `actor_name` rides the join so a
// staffer who later leaves still displays; the client and the Xero pull have
// no user row to name.
const loadEventsByOrderId = async (db, orderIds) => {
  if (orderIds.length === 0) {
    return new Map()
  }
  const { rows } = await db.query(
    `SELECT e.id,
            e.order_id,
            e.from_status,
            e.to_status,
            e.actor_kind,
            e.actor_user_id,
            u.name AS actor_name,
            e.note,
            e.created_at
       FROM order_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.order_id = ANY($1::int[])
      ORDER BY e.created_at DESC, e.id DESC`,
    [orderIds]
  )
  const byOrder = new Map()
  for (const { order_id: orderId, ...event } of rows) {
    byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), event])
  }
  return byOrder
}

// Why the client turned the quote down — the note on the latest answer, when
// that answer was a rejection. A re-quote the client then accepted clears it;
// a rejected quote the office went on to cancel keeps it, which is the context
// the order page wants. Events arrive newest first.
const quoteRejectionReason = (events) => {
  const answer = events.find((event) =>
    ['quote_accepted', 'quote_rejected'].includes(event.to_status)
  )
  return answer?.to_status === 'quote_rejected' ? (answer.note ?? null) : null
}

const toOrder = (row, lineRows, events = []) => {
  const state = reservationState(row.kind, row.status)
  return {
    id: row.id,
    user_id: row.user_id,
    guest_email: row.guest_email,
    client_name: row.client_name ?? null,
    client_email: row.client_email ?? null,
    order_number: row.order_number,
    kind: row.kind,
    status: row.status,
    subtotal_cents: row.subtotal_cents,
    shipping_cents: row.shipping_cents,
    gst_cents: row.gst_cents,
    total_cents: row.total_cents,
    // Which price list the order was written off (trade / retail). The office's
    // own statement, editable while the order is still priceable.
    price_type: row.price_type,
    // The manual pricing override (Rebecca-R2), ADMIN shape only: the customer
    // toOrder (order-history.js) stays without it, because the totals already
    // reflect the discount and who authorised it is the office's business.
    // pg numeric arrives as a string ('7.50') — the CRM coerces, like qty.
    discount_pct: row.discount_pct,
    discount_reason: row.discount_reason ?? null,
    discount_applied_by: row.discount_applied_by ?? null,
    shipping_zone: row.shipping_zone,
    xero_invoice_ref: row.xero_invoice_ref,
    // Set by the Xero invoice push (C4) — its presence is the duplicate gate,
    // so a pushed order can never be pushed twice.
    xero_invoice_id: row.xero_invoice_id ?? null,
    // Xero's own word for the invoice (DRAFT/AUTHORISED/PAID/VOIDED…) as of
    // the last pull; null until one has run. VOIDED/DELETED re-open the push.
    xero_invoice_status: row.xero_invoice_status ?? null,
    // Card checkouts carry the delivery details Stripe collected; request-kind
    // orders have none until the back office adds them.
    shipping_address: row.shipping_address ?? null,
    contact_phone: row.contact_phone ?? null,
    // Staff-asserted attribution (A6 groundwork). The name rides the join, not
    // a CRM-side lookup, so a rep who later leaves still displays.
    sales_rep_user_id: row.sales_rep_user_id ?? null,
    sales_rep_name: row.sales_rep_name ?? null,
    // Where the rep's copy of each status letter goes. Null with nobody
    // assigned, AND null for a rep whose login is archived: a person who has
    // left must not keep receiving a client's orders, so the CRM's Emails
    // section says the rep is not emailed rather than naming a dead inbox.
    sales_rep_email: row.sales_rep_email ?? null,
    // The extra addresses the office added to this order in the CRM's Emails
    // section; every status letter goes to each of them as well as to the
    // client and the rep (src/email/notifications.js notifyOrderTransition).
    notify_emails: row.notify_emails ?? [],
    // The client's OWN two numbers (FR-115). `customer_po_number` is the PO the
    // CLIENT issued to us — never one of our purchase orders (W13).
    client_reference: row.client_reference ?? null,
    customer_po_number: row.customer_po_number ?? null,
    // The courier link the office typed at `ship`, so the CRM can show the same
    // link the client was emailed rather than a number nobody kept.
    tracking_url: row.tracking_url ?? null,
    notes: row.notes,
    archived_at: row.archived_at ?? null,
    created_at: row.created_at,
    reservation_state: state,
    lines: (lineRows ?? []).map((line) => toLine(line, state)),
    // The audit trail (order_events), newest first: who moved it, from what,
    // to what, and any note — a rejected quote's reason is one of these.
    events,
    quote_rejection_reason: quoteRejectionReason(events),
  }
}

/**
 * One page of orders, newest first, each with lines and reservation state, plus
 * the `total` the whole filtered population holds (FR-118 — no admin list
 * returns the table).
 *
 * `filters` is the output of `parseOrderFilters` (free text, client, date range,
 * reference, PO number); `status` and `includeArchived` stay here because they
 * are enum/boolean gates the route schema already validates, not free text.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   status?: string,
 *   includeArchived?: boolean,
 *   filters?: object,
 *   page?: number,
 *   limit?: number,
 * }} [options]
 * @returns {Promise<{ orders: object[], total: number }>}
 */
export const listAdminOrders = async (
  pool,
  { status, kind, includeArchived = false, filters = {}, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const params = []
  const clauses = []
  // One status or a set of them — the route schema admits both shapes, and a
  // set binds as ANY so "the open book" (three statuses) is one query.
  const statuses = Array.isArray(status) ? status : status ? [status] : []
  if (statuses.length > 0) {
    params.push(statuses)
    clauses.push(`o.status = ANY($${params.length}::text[])`)
  }
  // The channel an order arrived through — `checkout` is the website, `manual`
  // is one the office keyed. An enum, so it sits beside `status` rather than
  // going through buildOrderFilters, which exists for free text.
  //
  // Without this the CRM's Source filter can only narrow the page it already
  // fetched, and would print a server total above a narrowed table.
  if (kind) {
    params.push(kind)
    clauses.push(`o.kind = $${params.length}`)
  }
  if (!includeArchived) {
    clauses.push('o.archived_at IS NULL')
  }
  // The search filters bind AFTER the ones above, which is why they are handed
  // the params array rather than starting their own numbering.
  const search = buildOrderFilters(filters, { params })
  const allClauses = [...clauses, ...search.clauses]
  const where = allClauses.length ? `WHERE ${allClauses.join(' AND ')}` : ''

  // The count runs over the same FROM and the same WHERE — a total computed off
  // a different query is a total that disagrees with its own list. The users
  // join has to be in it too: `client` and `q` search that table.
  const countResult = await pool.query(
    `SELECT count(*)::int AS total FROM ${ORDER_FROM} ${where}`,
    search.params
  )

  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS}
       FROM ${ORDER_FROM}
       ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${search.params.length + 1} OFFSET $${search.params.length + 2}`,
    [...search.params, safeLimit, offset]
  )
  const ids = rows.map((row) => row.id)
  const [linesByOrderId, eventsByOrderId] = await Promise.all([
    loadLinesByOrderId(pool, ids),
    loadEventsByOrderId(pool, ids),
  ])
  return {
    orders: rows.map((row) =>
      toOrder(row, linesByOrderId.get(row.id), eventsByOrderId.get(row.id))
    ),
    total: countResult.rows[0].total,
  }
}

/**
 * A single order with lines and reservation state, or null when it doesn't
 * exist. Reads through `db` (pool or client) so it can reflect an open txn.
 */
export const getAdminOrder = async (db, id) => {
  const { rows } = await db.query(
    `SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  // In turn, not in parallel: `db` may be a single transaction client.
  const linesByOrderId = await loadLinesByOrderId(db, [id])
  const eventsByOrderId = await loadEventsByOrderId(db, [id])
  return toOrder(row, linesByOrderId.get(id), eventsByOrderId.get(id))
}

// Lock the order row, run a mutation inside one transaction, and return the
// fresh order. 404 when the order id is unknown.
const withOrderTxn = async (pool, id, fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, kind, status FROM orders WHERE id = $1 FOR UPDATE`,
      [id]
    )
    const order = rows[0]
    if (!order) {
      throw httpError(404, `Order ${id} not found.`)
    }
    await fn(client, order)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getAdminOrder(pool, id)
}

// An order's demand PER COLOURWAY, not per line.
//
// **Two lines may name the same colourway** — two cuts of one cloth with
// different cut requirements is an ordinary order — and `UPDATE … FROM
// order_lines` would then be wrong in a way that is silent and permanent:
// Postgres updates a target row ONCE however many rows of the FROM relation
// match it, choosing one arbitrarily. So two 5-metre lines on one colourway
// reserve 10 and release 5, stranding 5 metres for good.
//
// Aggregating first is what makes the release the exact inverse of the
// reservation. Every whole-order inventory move goes through this.
const ORDER_DEMAND = `SELECT colourway_id, SUM(qty) AS qty
                        FROM order_lines
                       WHERE order_id = $1
                       GROUP BY colourway_id`

// Move a colourway's held reservation by `delta` (signed). Reserving kinds only;
// a colourway with no inventory row (a short backorder, or a design that has
// never been stocked) reserved nothing, so the UPDATE simply matches no rows.
const moveReservation = async (client, kind, colourwayId, delta) => {
  if (!reserves(kind) || delta === 0) return
  await client.query(
    `UPDATE inventory SET qty_reserved = qty_reserved + $1 WHERE colourway_id = $2`,
    [delta, colourwayId]
  )
}

// Lock a colourway by id inside the transaction so concurrent edits to the same
// SKU serialise their read-then-reserve. `FOR UPDATE OF c` because the inventory
// row is the nullable side of the LEFT JOIN and cannot be locked directly — the
// same rule (and the same reason) as resolveLine in order-request.js.
//
// No visibility gate here, unlike the storefront's resolveLine: staff key orders
// against unlisted designs and trade-only houses as a matter of course, and the
// backoffice guard is what stands in for the catalogue gate.
const lockColourway = async (client, colourwayId) => {
  const { rows } = await client.query(
    `SELECT c.id, i.colourway_id AS stocked
       FROM colourways c
       LEFT JOIN inventory i ON i.colourway_id = c.id
      WHERE c.id = $1
      FOR UPDATE OF c`,
    [colourwayId]
  )
  const row = rows[0]
  if (!row) {
    throw httpError(422, `Colourway ${colourwayId} does not exist.`)
  }
  return { colourwayId: row.id, hasInventory: row.stocked !== null }
}

// Recompute the money from the lines — THE one place a total is computed, so
// every path (line edit, added line, removal, a discount change) agrees by
// construction. `qty` is numeric(12,2), so the product is numeric too — ROUND
// then cast, once, over the whole order rather than per line (rounding each
// line would multiply the error by the line count).
//
// The discount (Rebecca-R2) is an INPUT to this recompute, never a second
// spelling of the total: `subtotal_cents` stays the un-discounted figure, the
// discount is taken once over it (same rounding argument as the lines), and
// `shipping_cents` rides on top exactly as it was — the discount is off the
// goods, and nothing here prices freight. Mirrored by `discountedTotalCents`
// in ./discounts.js; the DB suite asserts the two agree.
const recomputeOrderMoney = (client, id) =>
  client.query(
    `UPDATE orders o
        SET subtotal_cents = t.sum,
            total_cents = ROUND(t.sum * (1 - o.discount_pct / 100))::int + o.shipping_cents
       FROM (SELECT COALESCE(ROUND(SUM(qty * unit_price_cents)), 0)::int AS sum
               FROM order_lines
              WHERE order_id = $1) t
      WHERE o.id = $1`,
    [id]
  )

// Write a discount change (Rebecca-R2). The pct and its reason travel as a
// PAIR: whenever the patch carries `discount_pct`, the reason is set from the
// same patch — absent folds to null, so a stale justification can never
// outlive the percentage it justified — and `discount_applied_by` is stamped
// from the SESSION, never from the body, because who authorised an override is
// exactly the fact the body must not be able to state. The tier/role/reason
// gate is `checkDiscountWrite` (./discounts.js): standard tiers for anyone the
// route guard admitted, anything else director-only with a reason (403/422).
//
// The caller runs `recomputeOrderMoney` after this — the discount changes the
// total, and the total is only ever computed in that one place.
const applyDiscount = async (client, id, patch, actor) => {
  if (!Object.hasOwn(patch, 'discount_pct')) return
  const reason =
    typeof patch.discount_reason === 'string' && patch.discount_reason.trim() !== ''
      ? patch.discount_reason
      : null
  checkDiscountWrite({ pct: patch.discount_pct, reason, role: actor?.role })
  await client.query(
    `UPDATE orders
        SET discount_pct = $2, discount_reason = $3, discount_applied_by = $4
      WHERE id = $1`,
    [id, patch.discount_pct, reason, actor.id]
  )
}

// The header fields staff may correct while an order is still being priced.
// Frozen code literals fed to a dynamic SET clause — column names are never user
// input, values are always placeholders (the buildUpdate posture).
//
// `client_reference` and `customer_po_number` are the client's own two numbers
// (US-006, FR-127). They are editable rather than create-only because a PO
// number is almost never known when the order is raised — it arrives in a later
// email, and an order nobody can attach it to is one the client's accounts
// payable will not pay. `customer_po_number` is THEIRS, not one of our purchase
// orders (W13).
const ORDER_HEADER_COLUMNS = Object.freeze([
  'notes',
  'price_type',
  'guest_email',
  'contact_phone',
  'client_reference',
  'customer_po_number',
  'sales_rep_user_id',
  'notify_emails',
])

// The columns that are ANNOTATIONS rather than commercial terms. Neither
// moves money, stock or a reservation, so neither is gated on the order still
// being editable — a client's PO number almost never arrives before the order
// is raised, and on a paid order it is precisely the thing the office is trying
// to record. Everything else in ORDER_HEADER_COLUMNS stays behind the status
// guard, because changing where an order ships after it shipped is a different
// question that nobody has asked for.
// `sales_rep_user_id` joins them for the same reason: attribution moves no
// money, stock or reservation, and back-filling WHO sold a shipped order is
// exactly what the office wants to record after the fact.
// `notify_emails` (who else hears about a status change) likewise moves no
// money, stock or reservation, and "copy their accounts desk in" arrives at any
// point in an order's life — most usefully before it ships.
const ANNOTATION_COLUMNS = Object.freeze([
  'client_reference',
  'customer_po_number',
  'sales_rep_user_id',
  'notify_emails',
])

/** True when a patch touches nothing but those annotations. */
const isAnnotationOnly = (patch) => {
  const keys = Object.keys(patch)
  return keys.length > 0 && keys.every((key) => ANNOTATION_COLUMNS.includes(key))
}

// `notes` ALONE is the third thing the office writes down after the fact — the
// courier they used, the phone call about a delivery, what the client asked for
// on the doorstep — and the order it belongs on is usually one that has already
// been paid or shipped. A guard that refuses it there is a guard that sends the
// note to a spreadsheet instead.
//
// It rides alone deliberately, rather than joining ANNOTATION_COLUMNS: `notes`
// is also the header field an ordinary edit carries alongside lines and money,
// and a body that says anything else keeps the status guard exactly as it was.
// One key, one meaning.
const isNotesOnly = (patch) => {
  const keys = Object.keys(patch)
  return keys.length === 1 && keys[0] === 'notes'
}

// Where the cloth goes can change until it has gone. A client paying up front
// and then asking for delivery to the upholsterer, or to site rather than the
// office, is ordinary — and the packing slip is printed from this address, so an
// order the office could not correct after payment shipped to the wrong place.
// Like notes, it rides ALONE: a body that also touches lines, money or any other
// header field is an ordinary edit and keeps the LINE_EDIT_STATUSES guard.
// DELIVERY_EDIT_STATUSES (./order-states.js) is every held status: shipped and
// later are excluded because the address is then the record of where the order
// went; cancelled, because nothing is going anywhere.

const isDeliveryOnly = (patch) => {
  const keys = Object.keys(patch)
  return keys.length === 1 && keys[0] === 'shipping_address'
}

// The same trimmer the storefront's request and the manual create store
// through, so an edited address has the shape the other paths write. `null`
// clears it (collected from the showroom). An address that names neither a
// street nor a town is refused rather than silently stored as none: on those
// paths an empty form means "no address", but here somebody pressed Save on a
// delivery they meant to record.
const applyShippingAddress = async (client, id, patch) => {
  if (!Object.hasOwn(patch, 'shipping_address')) return
  const address = addressOrNull(patch.shipping_address)
  if (patch.shipping_address !== null && address === null) {
    throw httpError(
      422,
      'A delivery address needs a street or a town/city. Clear every field to remove it instead.'
    )
  }
  await client.query(`UPDATE orders SET shipping_address = $2 WHERE id = $1`, [
    id,
    address ? JSON.stringify(address) : null,
  ])
}

// A rep must be a STAFF login (USER_SEGMENTS.staff) or null. Checked here —
// once, for both write paths — so a bad id is a 422 naming the problem rather
// than an FK 23503 surfacing as a 500, and a customer can never appear as the
// seller of record.
const assertSalesRep = async (client, userId) => {
  if (userId == null) return
  const { rows } = await client.query(`SELECT role FROM users WHERE id = $1`, [userId])
  if (!rows[0] || !USER_SEGMENTS.staff.includes(rows[0].role)) {
    throw httpError(422, 'A sales rep must be a staff login (back office or director).')
  }
}

const applyOrderHeader = async (client, id, patch) => {
  const sets = []
  const params = [id]
  for (const column of ORDER_HEADER_COLUMNS) {
    // hasOwn, not a truthiness test: an explicit null clears the column and an
    // absent key must leave it alone.
    if (!Object.hasOwn(patch, column)) continue
    // A cleared field clears to NULL, never to '' (FR-127). The CRM's inputs
    // send back an empty string when a person deletes what they typed, and a
    // stored '' is an absence that every `IS NULL` read misses and every search
    // matches — two spellings of "nothing" is one too many.
    params.push(patch[column] === '' ? null : patch[column])
    sets.push(`${column} = $${params.length}`)
  }
  if (sets.length === 0) return
  await client.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $1`, params)
}

/**
 * Edit an order: line quantities and prices, added lines, removed lines, and the
 * contact/notes header — keeping the held reservation and the money in step.
 *
 * Only allowed while the order still holds its reservation and nobody has paid
 * it (LINE_EDIT_STATUSES); later states have converted or released the
 * reservation, and their money is settled. The exceptions are the
 * ANNOTATION_COLUMNS and a patch carrying nothing but `notes`: neither moves
 * money, stock or a reservation, and both are written after the fact by
 * definition. A patch carrying nothing but `shipping_address` is the third,
 * open until the order ships (DELIVERY_EDIT_STATUSES).
 *
 * This is what turns a storefront request (every line priced at 0 by
 * `createOrderRequest`) into a sales order the office can invoice.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {{
 *   lines?: Array<{ id: number, qty?: number, unit_price_cents?: number, cut_requirements?: string|null }>,
 *   add_lines?: Array<{ colourway_id: number, qty: number, unit_price_cents: number, cut_requirements?: string|null }>,
 *   remove_line_ids?: number[],
 *   notes?: string|null,
 *   guest_email?: string|null,
 *   contact_phone?: string|null,
 *   client_reference?: string|null,
 *   customer_po_number?: string|null,
 *   price_type?: 'trade'|'retail',
 *   discount_pct?: number,
 *   discount_reason?: string|null,
 *   notify_emails?: string[],
 *   shipping_address?: object|null,
 * }} patch
 * @param {{ id: number, role: string }} [actor] request.user — the discount
 *   gate reads the role and the audit column records the id
 */
export const editOrderLines = (pool, id, patch, actor) =>
  withOrderTxn(pool, id, async (client, order) => {
    // A delivery change touches nothing else, so it skips the line checks and
    // the money recompute below: on a paid card checkout the total is what
    // Stripe charged, and a new address must not re-derive it.
    if (isDeliveryOnly(patch)) {
      requireStatus(order, DELIVERY_EDIT_STATUSES, 'change the delivery details of')
      await applyShippingAddress(client, id, patch)
      return
    }
    if (!isAnnotationOnly(patch) && !isNotesOnly(patch)) {
      requireStatus(order, LINE_EDIT_STATUSES, 'edit')
    }

    const edits = patch.lines ?? []
    const adds = patch.add_lines ?? []
    const removeIds = patch.remove_line_ids ?? []

    const { rows: lines } = await client.query(
      `SELECT id, colourway_id, qty FROM order_lines WHERE order_id = $1`,
      [id]
    )
    const byId = new Map(lines.map((line) => [line.id, line]))

    // An order with no lines is not an order. Cancelling it is what the office
    // means by "get rid of this" — that releases the reservation and leaves a
    // record, where an empty order would keep its number and say nothing.
    if (lines.length - removeIds.length + adds.length <= 0) {
      throw httpError(
        422,
        'An order cannot be left with no lines. Cancel it instead.'
      )
    }

    // Removals first: they free reservation that a re-add in the same request
    // may want back.
    for (const lineId of removeIds) {
      const line = byId.get(lineId)
      if (!line) {
        throw httpError(422, `Order line ${lineId} is not on order ${id}.`)
      }
      await moveReservation(client, order.kind, line.colourway_id, -Number(line.qty))
      byId.delete(lineId)
    }
    if (removeIds.length > 0) {
      await client.query(`DELETE FROM order_lines WHERE id = ANY($1::int[])`, [
        removeIds,
      ])
    }

    for (const edit of edits) {
      const line = byId.get(edit.id)
      if (!line) {
        throw httpError(422, `Order line ${edit.id} is not on order ${id}.`)
      }
      const sets = []
      const params = [edit.id]
      if (edit.qty !== undefined) {
        params.push(edit.qty)
        sets.push(`qty = $${params.length}`)
      }
      if (edit.unit_price_cents !== undefined) {
        params.push(edit.unit_price_cents)
        sets.push(`unit_price_cents = $${params.length}`)
      }
      if (Object.hasOwn(edit, 'cut_requirements')) {
        params.push(edit.cut_requirements)
        sets.push(`cut_requirements = $${params.length}`)
      }
      if (sets.length > 0) {
        await client.query(
          `UPDATE order_lines SET ${sets.join(', ')} WHERE id = $1`,
          params
        )
      }
      if (edit.qty !== undefined) {
        await moveReservation(
          client,
          order.kind,
          line.colourway_id,
          edit.qty - Number(line.qty)
        )
      }
    }

    for (const add of adds) {
      const { colourwayId, hasInventory } = await lockColourway(client, add.colourway_id)
      await client.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents, cut_requirements)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, colourwayId, add.qty, add.unit_price_cents, add.cut_requirements ?? null]
      )
      if (hasInventory) {
        await moveReservation(client, order.kind, colourwayId, add.qty)
      }
    }

    // Validate the rep before the header write, inside the same transaction —
    // both write paths (here and createManualOrder) route through this check.
    if (Object.hasOwn(patch, 'sales_rep_user_id')) {
      await assertSalesRep(client, patch.sales_rep_user_id)
    }
    // The Emails list REPLACES what was there (the CRM sends the whole list on
    // every add and remove) and is stored one spelling per address. The route
    // schema has already refused a malformed address or too many.
    const header = Object.hasOwn(patch, 'notify_emails')
      ? { ...patch, notify_emails: uniqueEmails(patch.notify_emails) }
      : patch
    await applyOrderHeader(client, id, header)
    await applyShippingAddress(client, id, patch)
    // The discount before the recompute, so the total the transaction commits
    // already reflects it. A discount is a commercial term, not an annotation:
    // it changes the invoice amount, so it sits behind the status guard above
    // exactly like a price edit does.
    await applyDiscount(client, id, patch, actor)
    await recomputeOrderMoney(client, id)
  })

/**
 * Create a sales order the back office keyed itself (a phone call, a walk-in, a
 * bespoke enquiry, or a storefront request that turned into a bigger job).
 *
 * `createOrderRequest` cannot serve this: it is keyed on SKU rather than
 * colourway id, prices every line at 0, and applies the storefront's trade
 * visibility gate. This one takes prices, addresses colourways directly (the CRM
 * picks them out of the catalogue search) and trusts the backoffice guard.
 *
 * Attribution is either an account (`user_id`) or a walk-in's contact details;
 * the contact is packed into `notes` in the same shape `createOrderRequest`
 * writes, so one CRM renderer reads both.
 *
 * `shipping_address` is optional and stored through the request path's own
 * `addressOrNull`, so an order keyed by the office and one submitted from the
 * storefront put the same shape in the same column — the CRM's Delivery block
 * and the packing slip read both without knowing which path wrote it. The
 * order desk does not type it: the CRM sends what the client's own record
 * holds, and an order for a client with no address on file simply has none.
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   user_id?: number|null,
 *   contact?: { name?: string, email?: string, phone?: string },
 *   lines: Array<{ colourway_id: number, qty: number, unit_price_cents: number, cut_requirements?: string|null }>,
 *   notes?: string|null,
 *   shipping_address?: object|null,
 *   discount_pct?: number,
 *   discount_reason?: string|null,
 * }} input
 * @param {{ id: number, role: string }} [actor] request.user — see editOrderLines
 * @returns {Promise<object>} the created order
 */
export const createManualOrder = async (pool, input, actor) => {
  const contact = input.contact ?? {}
  const userId = input.user_id ?? null
  // An order nobody can be billed for is not a sales order. One of the two forms
  // of attribution has to be present; which one is the office's choice.
  if (userId === null && !contact.name && !contact.email) {
    throw httpError(
      422,
      'A sales order needs a client: either an account (user_id) or contact details.'
    )
  }

  // A discount keyed at creation runs the same gate a PATCH does (Rebecca-R2):
  // standard tiers for any back-office user, anything else director-only with a
  // reason. Checked before the transaction opens — a refused order should cost
  // no BEGIN. Absent means 0, the column default, with nobody stamped as having
  // applied anything.
  const hasDiscount = Object.hasOwn(input, 'discount_pct')
  const discountReason =
    typeof input.discount_reason === 'string' && input.discount_reason.trim() !== ''
      ? input.discount_reason
      : null
  if (hasDiscount) {
    checkDiscountWrite({ pct: input.discount_pct, reason: discountReason, role: actor?.role })
  }

  const client = await pool.connect()
  let orderId
  try {
    await client.query('BEGIN')

    if (userId !== null) {
      const { rows } = await client.query(`SELECT id FROM users WHERE id = $1`, [
        userId,
      ])
      if (!rows[0]) {
        throw httpError(422, `User ${userId} does not exist.`)
      }
    }

    await assertSalesRep(client, input.sales_rep_user_id ?? null)

    // Resolve every line before writing anything, so an unknown colourway
    // refuses the whole order rather than leaving half of one behind.
    const resolved = []
    for (const line of input.lines) {
      const { colourwayId, hasInventory } = await lockColourway(client, line.colourway_id)
      resolved.push({
        colourwayId,
        hasInventory,
        qty: line.qty,
        unitPriceCents: line.unit_price_cents,
        cutRequirements: line.cut_requirements ?? null,
      })
    }

    const notes = [buildNotes(contact), input.notes ?? null]
      .filter(Boolean)
      .join('\n')
    const address = addressOrNull(input.shipping_address)

    const { rows } = await client.query(
      `INSERT INTO orders (user_id, guest_email, order_number, kind, status, notes,
                           discount_pct, discount_reason, discount_applied_by,
                           sales_rep_user_id, price_type, shipping_address)
       VALUES ($1, $2, $3, 'manual', 'quote_requested', $4, $5, $6, $7, $8, COALESCE($9, 'retail'), $10)
       RETURNING id`,
      [
        userId,
        // A guest email only when there is no account: the account's own address
        // is the one to write to, and duplicating it here would go stale.
        userId === null ? (contact.email ?? null) : null,
        orderNumber('SO'),
        notes === '' ? null : notes,
        hasDiscount ? input.discount_pct : 0,
        discountReason,
        // From the session, never the body — who authorised a discount is the
        // one fact the caller must not be able to state.
        hasDiscount ? (actor?.id ?? null) : null,
        input.sales_rep_user_id ?? null,
        // Absent means the column default: an order keyed with nothing said
        // about its basis is a retail one until the office says otherwise.
        input.price_type ?? null,
        // Where the cloth is going, through the request path's own trimmer: an
        // address that names neither a street nor a city is the ABSENCE of one,
        // and a `{}` in the column would print an empty Ship-to block on the
        // packing slip. jsonb, so it goes in as text.
        address ? JSON.stringify(address) : null,
      ]
    )
    orderId = rows[0].id

    for (const line of resolved) {
      await client.query(
        `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents, cut_requirements)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, line.colourwayId, line.qty, line.unitPriceCents, line.cutRequirements]
      )
      if (line.hasInventory) {
        await moveReservation(client, 'manual', line.colourwayId, line.qty)
      }
    }

    await recomputeOrderMoney(client, orderId)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getAdminOrder(pool, orderId)
}

// The words `requirePriced` finishes its sentence with, per priced target.
const PRICED_PHRASES = Object.freeze({
  quote_sent: 'send the quote',
  pending_payment: 'invoice this order',
  paid: 'mark this order paid',
})

// The stock side of a move is keyed on the TRANSITION, not on the status: what
// matters is whether the order still held its reservation when it left `from`.
//   → shipped              convert: the reservation becomes a real decrement
//   → cancelled | refunded release: the reservation is handed back
// A refund after shipping holds nothing (the stock already left), so it touches
// no inventory — `holdsReservation` answers that, as it does for the delete.
// Both statements aggregate per colourway first (ORDER_DEMAND, above).
const settleReservation = async (client, order, to) => {
  if (!holdsReservation(order)) return
  if (to === 'shipped') {
    await client.query(
      `UPDATE inventory i
          SET qty_reserved = i.qty_reserved - demand.qty,
              qty_available = i.qty_available - demand.qty
         FROM (${ORDER_DEMAND}) AS demand
        WHERE i.colourway_id = demand.colourway_id`,
      [order.id]
    )
  } else if (to === 'cancelled' || to === 'refunded') {
    await client.query(
      `UPDATE inventory i
          SET qty_reserved = i.qty_reserved - demand.qty
         FROM (${ORDER_DEMAND}) AS demand
        WHERE i.colourway_id = demand.colourway_id`,
      [order.id]
    )
  }
}

/**
 * Move an order to `to` — THE one transition. The CRM's status dropdown, the
 * client's accept/reject, the purchase-order generator's back order and both
 * Xero directions all come through here, so every move is checked by the same
 * machine, settles stock the same way and leaves the same audit row.
 *
 * In one transaction: the machine (409 for a move `ALLOWED_TRANSITIONS` does not
 * list), the price gate on entering `PRICED_ENTRY_STATUSES` (422), the stock
 * side effect, the status write, and the `order_events` row. `trackingUrl` and
 * `xeroInvoiceRef` are written in the SAME statement as the status, so the order
 * handed to `notifyOrderTransition` already carries the link / reference its
 * letter quotes; absent, each keeps what the order already had.
 *
 * Returns the fresh admin order. Anything a caller needs beyond it (the quote
 * link a `quote_sent` letter carries) is issued after the transaction commits.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {string} to one of ORDER_STATUSES
 * @param {{
 *   actor: { kind: 'staff'|'customer'|'xero', userId?: number|null },
 *   note?: string|null,
 *   trackingUrl?: string|null,
 *   xeroInvoiceRef?: string|null,
 * }} options
 */
export const setOrderStatus = (
  pool,
  id,
  to,
  { actor, note = null, trackingUrl = null, xeroInvoiceRef = null }
) =>
  withOrderTxn(pool, id, async (client, order) => {
    requireTransition(order, to)
    if (PRICED_ENTRY_STATUSES.includes(to)) {
      await requirePriced(client, id, PRICED_PHRASES[to])
    }
    await settleReservation(client, order, to)
    await client.query(
      `UPDATE orders
          SET status = $2::text,
              tracking_url = COALESCE($3, tracking_url),
              xero_invoice_ref = COALESCE($4, xero_invoice_ref),
              quote_sent_at = CASE WHEN $2::text = 'quote_sent' THEN now() ELSE quote_sent_at END
        WHERE id = $1`,
      [id, to, trackingUrl || null, xeroInvoiceRef || null]
    )
    await client.query(
      `INSERT INTO order_events (order_id, from_status, to_status, actor_kind, actor_user_id, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        order.status,
        to,
        actor.kind,
        actor.userId ?? null,
        // A blank note is no note: '' would print an empty line in the trail.
        typeof note === 'string' && note.trim() !== '' ? note.trim() : null,
      ]
    )
  })

/**
 * Mark an order paid — the Xero pull's move (a payment recorded at the
 * accountant's desk). Kept as its own name because the Xero service imports it;
 * it is `setOrderStatus` and nothing else.
 */
export const markOrderPaid = (pool, id, actor = { kind: 'xero' }) =>
  setOrderStatus(pool, id, 'paid', { actor })

/**
 * Archive (soft-delete) or restore an order. Archiving only removes it from the
 * default queue; the record and its lines are kept. A reserving order is only
 * archivable once its reservation is settled (shipped, completed, cancelled,
 * refunded) — while it still holds one (HELD_STATUSES), hiding it would strand
 * that reserved stock forever. Cancel (or ship) it first. Restore has no such
 * rule.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 */
export const setOrderArchived = (pool, id, archived) =>
  withOrderTxn(pool, id, async (client, order) => {
    if (archived && holdsReservation(order)) {
      throw httpError(
        409,
        `Cannot archive an order in status "${order.status}" — it still holds stock. Cancel or ship it first.`
      )
    }
    // The transaction's client, not the pool: the guard above and this write
    // must be the same transaction, or a concurrent transition could slip in
    // between them.
    await setArchived(client, 'order', id, archived)
  })
