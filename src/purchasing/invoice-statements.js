// The statement that asks a house for ONE consolidated invoice covering several
// purchase orders.
//
// THE PROBLEM. W13 groups purchase orders by BRAND and one supplier sells
// several houses, so there are always more purchase orders than invoices
// (`supplier-invoices.js` states this at length). The office's side of that is
// a letter: "these six orders are outstanding with you — please bill them
// together, quoting our numbers". Until now that letter was typed by hand,
// which is how a purchase order already invoiced ends up on it.
//
// IT IS A LETTER, NOT A DOCUMENT OF RECORD, and nothing here writes an invoice.
// A supplier invoice is the HOUSE's paper: its number, its date and its total
// are facts only the house can state, and inventing a row for a bill that has
// not arrived would put a figure in the ledger that no paper supports. What is
// recorded is that the office asked — one entry in `supplier_contact_log`,
// which is what the supplier list's "Last contact" column reads.
//
// EVERY REFUSAL IS THE ONE THE ATTACH ALREADY GIVES, in the same words:
//   - a purchase order raised for another house      → 422 naming it
//   - one a bill already covers                      → 409 naming that bill
//   - a cancelled one                                → 422 naming it
// A letter that asks a house to bill an order it has already billed is the
// mistake this route exists to prevent, so the checks run BEFORE the send and
// the whole statement is refused rather than quietly narrowed — a letter that
// went out missing an order the staffer ticked is worse than one that did not
// go at all, because nothing on screen says so.
//
// THE LETTER CARRIES COSTS AND IS NOT FINANCE-MASKED, for the reason
// `notifyPurchaseOrderSent` already gives: the house quoted those prices, and
// masking them from the party that set them protects nobody. It is composed by
// the server and addressed to the house and the one configured back-office
// address, so it is never rendered to the staffer who triggered it — and the
// RESPONSE that comes back to the screen carries no money at all, which is why
// this module needs no finance flag.

import { loadInvoiceStateByPurchaseOrderId } from './supplier-invoices.js'
import { createContactLogEntry } from '../suppliers/supplier-contacts.js'
import { notifyConsolidatedInvoiceRequest } from '../email/purchasing-notifications.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * How many purchase orders one statement may name. A cycle is two to four
 * weeks of buying from one house, so the ceiling is generous; what it stops is
 * a request that renders the whole ledger into one letter.
 */
export const MAX_STATEMENT_PURCHASE_ORDERS = 100

// Duplicates are the screen's to make and not an error — a tick list can send
// the same id twice — but a letter that names one order twice reads as two
// orders, so they collapse here.
const uniqueIds = (ids) => [...new Set(ids)]

/**
 * The purchase orders a statement is being asked for, with the costed total
 * beside each. `unpriced_lines` travels with it: a cost over a partly-priced
 * order reads as the cost of the whole thing while describing part of it, so
 * the letter says "not priced" instead of a figure (the rule
 * `listUnbilledPurchaseOrders` states one grain up).
 */
const loadPurchaseOrders = async (pool, ids) => {
  const { rows } = await pool.query(
    `SELECT po.id,
            po.po_number,
            po.supplier_id,
            po.supplier_name,
            po.brand_id,
            b.name AS brand_name,
            po.currency,
            po.status,
            po.created_at,
            po.expected_at,
            cost.ordered_cost,
            COALESCE(cost.unpriced_lines, 0) AS unpriced_lines
       FROM purchase_orders po
       JOIN brands b ON b.id = po.brand_id
       LEFT JOIN LATERAL (
         SELECT SUM(round(l.qty_ordered * l.unit_price, 2)) AS ordered_cost,
                count(*) FILTER (WHERE l.unit_price IS NULL)::int AS unpriced_lines
           FROM purchase_order_lines l
          WHERE l.purchase_order_id = po.id
       ) cost ON true
      WHERE po.id = ANY($1::int[])
      ORDER BY po.created_at, po.id`,
    [ids]
  )
  return rows
}

const loadSupplier = async (pool, supplierId) => {
  const { rows } = await pool.query(
    `SELECT id, name, po_email, currency FROM suppliers WHERE id = $1`,
    [supplierId]
  )
  return rows[0] ?? null
}

/**
 * Every reason this statement must not go out, checked before anything is
 * sent. Throws the first one it finds, naming the purchase order — the same
 * posture `attachPurchaseOrder` takes, and for the same reason: an id is not
 * something the person on the screen can act on.
 */
const refuseUnsendable = (supplier, requestedIds, rows, invoiceState) => {
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of requestedIds) {
    const row = byId.get(id)
    if (!row) {
      throw httpError(422, `Purchase order ${id} does not exist.`)
    }
    if (row.supplier_id !== supplier.id) {
      throw httpError(
        422,
        `${row.po_number} was raised for ${row.supplier_name ?? 'another house'}, not ` +
          `${supplier.name}. A statement names one house's orders only.`
      )
    }
    if (row.status === 'cancelled') {
      throw httpError(
        422,
        `${row.po_number} is cancelled — a house will not bill for an order Atelier withdrew.`
      )
    }
    const invoice = invoiceState.get(id)
    if (invoice) {
      throw httpError(
        409,
        `${row.po_number} is already covered by invoice ${invoice.invoice_number}. ` +
          'Take it off the statement, or detach it from that bill first.'
      )
    }
  }
  if (!supplier.po_email) {
    throw httpError(
      422,
      `There is no purchase-order address on file for ${supplier.name}, so there is ` +
        'nowhere to send the statement. Add one on the supplier record.'
    )
  }
}

/** One line per order, in the letter: ours, theirs, when, and what we costed it at. */
const formatStatementLine = (row) => {
  const cost =
    row.unpriced_lines > 0
      ? 'not priced'
      : `${Number(row.ordered_cost ?? 0).toFixed(2)}${row.currency ? ` ${row.currency}` : ''}`
  const raised = String(row.created_at?.toISOString?.() ?? row.created_at ?? '').slice(0, 10)
  return `  ${row.po_number} — ${row.brand_name}${raised ? ` — raised ${raised}` : ''} — ${cost}`
}

/**
 * The costed total across the statement, or null where ANY order on it is
 * unpriced. Same rule as one purchase order's own total: a sum that silently
 * skips the unpriced ones states a figure the office cannot stand behind, and
 * the house would reconcile against it.
 */
const statementTotal = (rows) => {
  if (rows.some((row) => row.unpriced_lines > 0)) return null
  const total = rows.reduce((sum, row) => sum + Number(row.ordered_cost ?? 0), 0)
  return Math.round(total * 100) / 100
}

/**
 * Ask one house for a single invoice covering the purchase orders named.
 *
 * The mailer is REQUIRED here, unlike on the purchase-order moves. There, the
 * letter hangs off a status change that stands on its own and a null mailer is
 * a no-op; here the letter IS the act, so an unconfigured relay is a 503 that
 * says so rather than a 200 over nothing sent.
 *
 * @param {import('pg').Pool} pool
 * @param {import('../email/mailer.js').Mailer|null} mailer
 * @param {{ supplierId: number, purchaseOrderIds: number[], user: object }} input
 * @returns {Promise<{ statement: object }>}
 */
export const requestConsolidatedInvoice = async (pool, mailer, input) => {
  const { supplierId, purchaseOrderIds, user } = input
  const ids = uniqueIds(purchaseOrderIds)

  const supplier = await loadSupplier(pool, supplierId)
  if (!supplier) {
    throw httpError(404, `Supplier ${supplierId} not found.`)
  }

  const rows = await loadPurchaseOrders(pool, ids)
  const invoiceState = await loadInvoiceStateByPurchaseOrderId(pool, ids, false)
  refuseUnsendable(supplier, ids, rows, invoiceState)

  if (!mailer) {
    throw httpError(
      503,
      'Email is not configured on this server, so the statement cannot be sent.'
    )
  }

  const currency = rows.find((row) => row.currency)?.currency ?? supplier.currency ?? null

  await notifyConsolidatedInvoiceRequest(mailer, {
    supplier_name: supplier.name,
    po_email: supplier.po_email,
    lines_text: rows.map(formatStatementLine).join('\n'),
    purchase_order_count: rows.length,
    currency,
    total: statementTotal(rows),
    staff_name: user?.name ?? user?.email ?? null,
    notes: input.notes ?? null,
  })

  // The office asked a house something, which is exactly what the contact log
  // is for — and it is what the supplier list's "Last contact" column reads, so
  // a house chased for its bill stops looking like one nobody has spoken to.
  // `user` is the SESSION, never the body: who chased a house is not something
  // the caller gets to state.
  const contact_log_entry = await createContactLogEntry(
    pool,
    supplier.id,
    {
      method: 'email',
      note: `Asked for one consolidated invoice covering ${rows.length} purchase order${
        rows.length === 1 ? '' : 's'
      }: ${rows.map((row) => row.po_number).join(', ')}.`,
    },
    user
  )

  return {
    statement: {
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      sent_to: supplier.po_email,
      // No money on the way back: the letter quotes what Atelier costed each
      // order at, but this payload is read by whichever staffer pressed the
      // button and that reader may have no finance grant. How many orders went
      // on the letter is the only figure a screen needs.
      purchase_order_count: rows.length,
      purchase_orders: rows.map((row) => ({
        id: row.id,
        po_number: row.po_number,
        brand_name: row.brand_name,
        status: row.status,
      })),
      contact_log_entry,
    },
  }
}
