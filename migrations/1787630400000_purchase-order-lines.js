/**
 * Purchase-order lines and what each one covers (W13-US-002).
 *
 * `unit_price` IS `numeric(12,4)` AND IT IS NULLABLE, and both halves are
 * deliberate.
 *
 * The type is `price_list_items.wholesale_rate`'s type exactly, because that
 * ledger is where a purchase price comes from — foreign, fractional,
 * unconverted. There is no cents column here and there must never be one (see
 * `1787544000000_purchase-orders.js`).
 *
 * The nullability is the harder half. **Nothing in this schema can derive a
 * purchase price for a colourway.** `price_list_items` is keyed
 * `(supplier, category, code)` and a supplier colour code has no path to a
 * colourway — the root CLAUDE.md states that as a rule: the corpus is evidence,
 * not a key. So a generated purchase order lands with no price on it, and the
 * only honest way to say that is NULL. `Number(null)` is 0 in JS, and a zero
 * purchase price reads as "the house is giving it to us", so every read of this
 * column goes through `value == null ? null : Number(value)` and every caller
 * must keep doing so. The CHECK is `unit_price IS NULL OR unit_price >= 0` —
 * `>=`, not `>` the way `price_list_items` does it, because a free replacement
 * roll is a real thing a house sends. **NULL and 0 are different facts:** NULL
 * is "nobody has priced this", 0 is "free, and we know it". Same rule
 * architecture.md states for `samples.unit_cost`.
 *
 * THE ALLOCATION CARRIES A QUANTITY, and that is the whole reason it is a table
 * rather than a column. One purchase-order line covering two sales orders is the
 * ORDINARY case — the office buys 40 m of a cloth because SO-411 wants 25 and
 * SO-418 wants 15. Without a quantity the line can say which orders it relates
 * to and nothing about how much of it is whose, and a short delivery of 30 m has
 * no basis on which to be split between them.
 *
 * `SUM(allocations.qty) <= purchase_order_lines.qty_ordered` — **`<=`, not
 * `=`**, because the unallocated remainder is a deliberate stock buy: buying a
 * full roll to cover a 25 m order is how this trade works. **It cannot be a
 * CHECK.** A CHECK sees one row and this rule is over a set, so it is enforced
 * in `src/purchasing/admin-purchase-orders.js` with the purchase-order line
 * locked `SELECT … FOR UPDATE` — which is what makes it hold under two
 * concurrent allocations, and is the same posture `withOrderTxn` already takes
 * on an order.
 *
 * A SALES-ORDER LINE MAY BE ORDERED EXACTLY ONCE, AND THE DATABASE IS WHAT SAYS
 * SO. `purchase_order_line_allocations_open_unique` is a PARTIAL unique index on
 * `order_line_id WHERE released_at IS NULL`. The derivation — "turn today's
 * confirmed orders into purchase orders" — is exactly what two staff run at once
 * at 5pm, and a read-then-insert pre-check reads rows the other transaction is
 * about to write. So the second run is a caught 23505 answered **409 naming the
 * purchase order that already covers the line**, the same posture as
 * `sample_loans_open_unique`. Application code cannot hold this and must not
 * pretend to.
 *
 * It is PARTIAL for the same reason the loan index is: cancelling a purchase
 * order stamps `released_at` on its allocations, which drops them out of the
 * index and puts that demand back on the pile for the next derivation. A plain
 * unique on `order_line_id` would mean an order line cancelled by mistake could
 * never be re-ordered from anybody, for all time. The allocation ROW survives —
 * it is the record that this line was once on that purchase order — which is why
 * the release is a stamp and not a delete.
 *
 * `order_line_id` IS `ON DELETE RESTRICT`, so the order delete gains a blocker:
 * an order that has already been ordered from a supplier is no longer a mis-key
 * anyone can delete. `src/lifecycle/registry.js`'s `order` entry declares the
 * probe and `CONSTRAINT_BLOCKERS` names the constraint, so a lost race says
 * "supplier allocations" rather than "related records".
 *
 * `colourway_id` IS RESTRICT for the same reason `order_lines.colourway_id` is:
 * a purchase order is a commercial record and must survive a catalogue tidy-up.
 * `purchase_order_id` is CASCADE — the lines are the document's own body, not
 * independent records, exactly as `order_lines.order_id` is.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('purchase_order_lines', {
    id: 'id',
    // The document owns its body.
    purchase_order_id: {
      type: 'integer',
      notNull: true,
      references: 'purchase_orders',
      onDelete: 'CASCADE',
    },
    // RESTRICT: commerce records survive catalogue cleanup, the same rule
    // order_lines.colourway_id carries.
    colourway_id: {
      type: 'integer',
      notNull: true,
      references: 'colourways',
      onDelete: 'RESTRICT',
    },
    // Metres or units, matching order_lines.qty's precision so a demand figure
    // copied from one to the other cannot lose a decimal.
    qty_ordered: {
      type: 'numeric(12,2)',
      notNull: true,
      check: 'qty_ordered > 0',
    },
    // See the header: nullable on purpose, four decimals on purpose, and >= 0
    // rather than > 0 on purpose.
    unit_price: {
      type: 'numeric(12,4)',
      check: 'unit_price IS NULL OR unit_price >= 0',
    },
    // The house's own code for the cloth, as it will appear on the paper sent to
    // them. Staff-typed and free text: no key joins a colourway to a supplier's
    // catalogue, which is exactly why this is typed rather than derived.
    supplier_code: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createIndex('purchase_order_lines', 'purchase_order_id')
  pgm.createIndex('purchase_order_lines', 'colourway_id')

  pgm.createTable('purchase_order_line_allocations', {
    id: 'id',
    purchase_order_line_id: {
      type: 'integer',
      notNull: true,
      references: 'purchase_order_lines',
      onDelete: 'CASCADE',
    },
    // RESTRICT: the fourth blocker on the order delete. See the header.
    order_line_id: {
      type: 'integer',
      notNull: true,
      references: 'order_lines',
      onDelete: 'RESTRICT',
    },
    // How much of the purchase-order line is for THIS sales-order line.
    qty: { type: 'numeric(12,2)', notNull: true, check: 'qty > 0' },
    // NULL is the whole of "this allocation is live" — the partial index's
    // predicate. Stamped when the purchase order is cancelled, so the demand
    // returns to the next derivation without the record being destroyed.
    released_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // THE invariant, held by the database: one live allocation per sales-order
  // line. The second concurrent derivation is a 23505 here, mapped to a 409.
  pgm.createIndex('purchase_order_line_allocations', 'order_line_id', {
    name: 'purchase_order_line_allocations_open_unique',
    unique: true,
    where: 'released_at IS NULL',
  })

  // The read: what does this purchase-order line cover.
  pgm.createIndex('purchase_order_line_allocations', 'purchase_order_line_id')
  // The reverse read, and what makes the order-delete probe cheap. Not covered
  // by the partial unique index above, which skips released rows.
  pgm.createIndex('purchase_order_line_allocations', 'order_line_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('purchase_order_line_allocations')
  pgm.dropTable('purchase_order_lines')
}
