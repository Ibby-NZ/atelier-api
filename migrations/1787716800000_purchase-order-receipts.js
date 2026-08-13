/**
 * Goods received against a purchase-order line (W13-US-003).
 *
 * THIS TABLE IS APPEND-ONLY AND THE LEDGER IS THE ANSWER. There is no
 * `qty_received` column on `purchase_order_lines` and there must never be one:
 * received quantity is `COALESCE(SUM(r.qty), 0)` and a purchase order's receipt
 * state — `none | part | full | over` — is derived from it beside `qty_ordered`
 * at read time. A stored counter and an append-only ledger disagree the first
 * time somebody corrects a receipt, and nothing in the data says which of the
 * two was the lie.
 *
 * A RECEIPT IS NEVER EDITED AND NEVER DELETED; A MISTAKE IS REVERSED BY A
 * NEGATIVE ROW. Hence `CHECK (qty <> 0)` and NOT `CHECK (qty > 0)`. The ledger
 * then reads as what happened, in order — "42 arrived, then −2 because two rolls
 * went back" — where an edit leaves a corrected number nobody can date and a
 * delete leaves an absence nobody can explain. Zero is excluded because a
 * receipt of nothing is not an event; it is a row somebody meant to fill in.
 *
 * The protection is ABSENCE: `purchase_order_receipt` gets **no entry in
 * `src/lifecycle/registry.js`**, and `requireEntity` throws a plain Error for an
 * unknown name, so no DELETE route can be registered against this table even by
 * accident. That is the same protection `order_lines` and `webhook_events`
 * already rely on, and it is deliberately stronger than a guard that returns a
 * refusal — there is nothing to argue with.
 *
 * OVER-RECEIPT IS LEGITIMATE AND IS NEVER CLAMPED. Suppliers over-ship rolls;
 * a receipt of 42 against an order of 40 is a fact about what is standing in the
 * warehouse. There is no CHECK tying the sum to `qty_ordered` (an aggregate
 * cannot be a CHECK anyway) and there is no clamp in the module. The read model
 * reports `over` and the office deals with the house.
 *
 * **NOTHING HERE WRITES AN INVENTORY QUANTITY.** `moveReservation` in
 * `src/orders/admin-orders.js` is the sole writer of `inventory.qty_reserved`
 * and `qty_available`, and a second writer breaks the reservation arithmetic
 * SILENTLY rather than loudly — the reserved figure simply stops meaning what
 * every other reader assumes. Receipting feeding stock is a separate and
 * deliberate decision, not an oversight in this migration; `test/purchasing.test.js`
 * asserts by source scan and by statement scan that no purchasing code path
 * names `inventory` in a SQL position.
 *
 * `consignment_ref` IS WHY THIS TABLE CAN CARRY FREIGHT LATER (FR-144). A
 * shipment is what a freight invoice is actually against — one container holding
 * lines from several purchase orders — so the reference is recorded on the
 * receipt, where the physical arrival is, rather than on the purchase order,
 * where it would be a lie the moment a house split a delivery. Free text and
 * nullable: it is whatever the house wrote on the paperwork, and plenty of
 * deliveries arrive with nothing on them.
 *
 * `purchase_order_line_id` IS RESTRICT. A line that has been received against is
 * a record of goods that physically arrived, and neither a line edit nor a
 * purchase-order delete may destroy it — the delete's cascade to the lines dies
 * on this edge, which the `purchase_order` registry probe reports as a counted
 * 409 before anything is touched.
 *
 * NO `archived_at` AND NO `updated_at`, for the same reason `sample_loans` has
 * neither: an append-only movement is not a row a list may offer to remove, and
 * a row that is never updated has nothing to stamp.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('purchase_order_receipts', {
    id: 'id',
    purchase_order_line_id: {
      type: 'integer',
      notNull: true,
      references: 'purchase_order_lines',
      onDelete: 'RESTRICT',
    },
    // SIGNED, and never zero. A negative row is how a mistake is reversed.
    qty: { type: 'numeric(12,2)', notNull: true, check: 'qty <> 0' },
    // When the goods arrived. Its own column rather than created_at, so a
    // delivery keyed in on Monday can carry Friday's date — the same posture as
    // sample_loans.out_at.
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // The shipment this arrival belongs to (FR-144). Free text, nullable.
    consignment_ref: { type: 'text' },
    // Who booked it in. SET NULL: the movement outlives the account.
    received_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // The derivation: every receipt for a line, and the SUM behind every received
  // and outstanding figure in the read model.
  pgm.createIndex('purchase_order_receipts', 'purchase_order_line_id')

  // "What arrived in this consignment", across purchase orders — the query a
  // freight cost will later be apportioned over. Partial, because most rows
  // carry no reference and indexing those buys nothing.
  pgm.createIndex('purchase_order_receipts', 'consignment_ref', {
    name: 'purchase_order_receipts_consignment_idx',
    where: 'consignment_ref IS NOT NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('purchase_order_receipts')
}
