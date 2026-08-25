/**
 * Which purchase orders one supplier invoice covers (W14-US-002).
 *
 * `purchase_order_id` IS UNIQUE, AND THAT IS THE WHOLE TABLE. A purchase order
 * appears on EXACTLY ONE invoice. Without the constraint, a re-attach after a
 * correction leaves two rows claiming the same purchase order, every downstream
 * report double-counts that spend, and NOTHING IN THE DATA SAYS WHICH ROW WAS
 * THE MISTAKE — the two are indistinguishable, both plausible, and the error is
 * discovered as a wrong total months later with no way back to the keystroke
 * that caused it. Attaching a second time is a caught 23505 answered **409
 * naming the invoice that already holds it**, found by a QUERY rather than by
 * parsing `error.detail` (that string is a pg display format, not an interface —
 * the same rule `describeExistingCover` follows in W13).
 *
 * IT IS A PLAIN UNIQUE, NOT THE PARTIAL ONE `purchase_order_line_allocations`
 * CARRIES, and the difference is deliberate. There, cancelling a purchase order
 * RELEASES its claim so the demand can be bought again, so the row survives as
 * history and drops out of the index. Here there is no such second life: a
 * purchase order detached from an invoice was put on the wrong invoice, full
 * stop, and the correction is to attach it to the right one. A `detached_at`
 * stamp would force this index to be partial, which is precisely the shape that
 * lets two live rows exist for one purchase order the moment a predicate is got
 * wrong. So DETACH IS A HARD DELETE OF THE ROW and the act is explicit rather
 * than recorded (FR-159): `DELETE /admin/supplier-invoices/:id/allocations/:poId`
 * is a route of its own, not a side effect of an edit, so nobody detaches by
 * accident. Trade-off stated plainly: this table cannot answer "which invoice
 * was this purchase order on before?".
 *
 * `amount` IS WHAT THIS INVOICE CHARGES FOR THIS PURCHASE ORDER, and it is
 * NULLABLE — the `purchase_order_lines.unit_price` posture, for the same reason
 * and with the same trap. A supplier's consolidated invoice frequently does not
 * break its total down per purchase order at all (it may not even quote
 * Atelier's purchase-order numbers — FR-158), so "attached, but nobody has said
 * how much of the total is this one" is a REAL and common state. NULL is that;
 * 0 is "charged at nil, and we know it"; and `Number(null)` is 0 in JS, so every
 * read goes through `value == null ? null : Number(value)` or an unstated amount
 * silently reads as a free purchase order. `>= 0`, not `> 0`.
 *
 * **`SUM(amount)` IS NOT CONSTRAINED AGAINST `supplier_invoices.total_amount`,
 * AND NO CHECK MAY EVER BE ADDED.** The unreconciled difference IS the product —
 * the screen exists to show it — so a constraint would refuse the half-done
 * state the feature is for. It could not be expressed anyway: a CHECK sees one
 * row and this is an aggregate over a set. `unallocated_amount` is derived at
 * read time in `src/purchasing/supplier-invoices.js` and stored nowhere.
 *
 * BOTH FKs ARE RESTRICT, and neither is a formality:
 *   - `supplier_invoice_id` — deleting an invoice while purchase orders are
 *     attached is refused (FR-159). The registry's `supplier_invoice` entry
 *     probes this so the refusal counts them and offers detaching as the way
 *     out; the FK is the backstop for the lost race.
 *   - `purchase_order_id` — a purchase order that has been INVOICED is a
 *     financial record on someone's ledger, and the W13 delete gains a third
 *     blocker beside its receipts and its sales-order allocations.
 *
 * There is no CASCADE anywhere here on purpose: every edge out of this table
 * points at something the office would have to be asked about first.
 *
 * THE SUPPLIER AGREEMENT IS NOT IN THIS SCHEMA. An invoice's supplier must
 * equal every allocated purchase order's supplier, and expressing that in SQL
 * needs `supplier_invoices` and `purchase_orders` both to carry a composite
 * `(id, supplier_id)` unique key and this table to carry `supplier_id` and two
 * chained composite foreign keys — three columns and two constraints to say one
 * sentence, and a denormalised supplier that then has its own way of being
 * wrong. It is a 422 in the module NAMING THE PURCHASE ORDER instead, which is
 * also the only form of it a person can act on.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('supplier_invoice_allocations', {
    id: 'id',
    supplier_invoice_id: {
      type: 'integer',
      notNull: true,
      references: 'supplier_invoices',
      onDelete: 'RESTRICT',
    },
    // THE invariant. See the header: plain unique, never partial.
    purchase_order_id: {
      type: 'integer',
      notNull: true,
      unique: true,
      references: 'purchase_orders',
      onDelete: 'RESTRICT',
    },
    // Nullable on purpose, four decimals on purpose, `>= 0` on purpose.
    amount: {
      type: 'numeric(12,4)',
      check: 'amount IS NULL OR amount >= 0',
    },
    notes: { type: 'text' },
    // Who attached it and when. Attaching is a commercial act — it is what says
    // this spend is on this bill — so it is attributed like the invoice itself.
    allocated_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // The read: which purchase orders are on this invoice. The reverse direction
  // is already covered by the unique constraint on `purchase_order_id`.
  pgm.createIndex('supplier_invoice_allocations', 'supplier_invoice_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('supplier_invoice_allocations')
}
