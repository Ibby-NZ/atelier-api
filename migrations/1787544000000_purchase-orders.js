/**
 * Purchase orders — the header (W13-US-001).
 *
 * A purchase order is a DOCUMENT ADDRESSED TO A HOUSE AT A MOMENT. That sentence
 * is what every column choice below falls out of.
 *
 * NO INTEGER-CENTS COLUMN EXISTS ANYWHERE IN PURCHASING, here or on the lines.
 * Cents is the storefront's money type — `orders.total_cents`,
 * `order_lines.unit_price_cents` — and it is right there, because a storefront
 * sale is NZD, whole, and already converted. A purchase is none of those: it is
 * quoted in the supplier's own currency, it is fractional (`price_list_items`
 * carries four decimal places for exactly this reason), and nobody has converted
 * it. `purchase_order_lines.unit_price` is `numeric(12,4)` — the same type as
 * `price_list_items.wholesale_rate`, which is where the number comes from. A
 * cents column beside it turns €48.0000 into 48 cents and nothing in the schema
 * objects.
 *
 * `supplier_id` IS DERIVED FROM `brands.supplier_id` AT CREATE AND IS NEVER
 * ACCEPTED FROM A CLIENT. There is no CHECK that could catch a client-chosen
 * supplier: every supplier id is a valid supplier id, so a wrong one produces a
 * perfectly well-formed row and the first anyone hears of it is the wrong house
 * shipping the goods. The rule therefore lives in `src/purchasing/`, and it is
 * why `brand_id` is NOT NULL here: the brand is the input the supplier is
 * derived FROM, not a decoration. A brand whose `supplier_id` is NULL is a 422
 * naming the brand, and that fires on most houses today — `backfill:suppliers`
 * has linked a minority of them.
 *
 * SUPPLIER, CURRENCY, AGENT, INCOTERM AND PO EMAIL ARE SNAPSHOTS. Re-pointing a
 * brand at a new distributor next year must not rewrite who last year's orders
 * were addressed to, and joining `suppliers` at read time does exactly that.
 * Same argument as `sample_loans.holder_name` and for the same reason: the link
 * is current state, the document is history. `supplier_id` stays beside them as
 * the link a report rolls up on; the snapshot is what the paper said.
 *
 * `status` HOLDS ONLY WHAT A PERSON DID — `draft | sent | closed | cancelled`.
 * It is not a receipt state and must never become one. **`closed` is not
 * `full`:** a purchase order closed short because the house discontinued the
 * balance is a decision somebody made, and a derived "fully received" stored
 * beside it gives two answers to one question. Received, outstanding and the
 * per-line backorder balance are computed from `purchase_order_receipts` at read
 * time, always. The vocabulary is the CHECK's; the transitions live in
 * `src/purchasing/po-states.js`, because a CHECK sees one row and cannot see
 * which state a row is moving FROM.
 *
 * THERE IS NO `archived_at`, DELIBERATELY, and the lifecycle registry entry says
 * `archivable: false` to match (`test/lifecycle-registry.test.js` asserts the
 * two agree). Every other live table here carries one because a finished row
 * still has to leave a CRM list — but `cancelled` and `closed` already do that
 * job for a purchase order, and they say WHY, which `archived_at` cannot. A
 * second vocabulary for "take it off my screen" is how two lists start
 * disagreeing about what is open.
 *
 * THE NUMBER COMES FROM A SEQUENCE, NEVER `max(po_number) + 1`. A max-plus-one
 * reads the whole table, serialises every insert behind that read, and races
 * anyway — two staff generating at 5pm mint the same number. A sequence is
 * non-blocking and non-transactional, which is precisely what makes it correct
 * and what makes GAPS INEVITABLE: a rolled-back transaction burns its number and
 * never gives it back. **A gap in a purchase-order number is not a missing
 * purchase order**, and that sentence belongs in the office's own documentation
 * rather than in a support ticket a year from now. The sequence also DOES NOT
 * RESET PER YEAR — a per-year reset needs a year in the key to stay unique, and
 * `PO-000412` appearing twice in the ledger is worse than a number that keeps
 * climbing.
 *
 * Format `PO-` + six zero-padded digits, starting at 1000 — the
 * `samples_barcode_seq` posture (`1787371200000_sample-barcode-sequence.js`),
 * including where it is spelled: `src/purchasing/admin-purchase-orders.js` mints
 * it inside the INSERT, not a column DEFAULT, so there is one copy of the format
 * and not two to drift apart. Fixed width makes lexical order chronological
 * order, which is what the default list sorts on.
 *
 * WHY BOTH FKs ARE RESTRICT. A house or a supplier that has been ordered from is
 * a live commercial relationship and a purchase order addressed to it is the
 * evidence; SET NULL would leave a document addressed to nobody, and CASCADE
 * would destroy the order along with the catalogue row. Both edges get a probe
 * in `src/lifecycle/registry.js` so the refusal counts them rather than dying on
 * a bare 23503.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createSequence('purchase_orders_number_seq', { start: 1000 })

  pgm.createTable('purchase_orders', {
    id: 'id',
    // Minted from the sequence above by the module that inserts the row.
    po_number: { type: 'text', notNull: true, unique: true },
    // The grouping key. NOT NULL because it is the input `supplier_id` is
    // DERIVED from — a purchase order with no brand has no supplier to address.
    brand_id: {
      type: 'integer',
      notNull: true,
      references: 'brands',
      onDelete: 'RESTRICT',
    },
    // Derived from brands.supplier_id at create; never accepted from a client.
    supplier_id: {
      type: 'integer',
      notNull: true,
      references: 'suppliers',
      onDelete: 'RESTRICT',
    },
    // The snapshot: what the document said, on the day. Never joined for.
    supplier_name: { type: 'text', notNull: true },
    // Nullable exactly as `suppliers.currency` is: blank means "no invoice on
    // file yet", and the country is the wrong answer to guess with.
    currency: { type: 'text' },
    agent: { type: 'text' },
    incoterm: { type: 'text' },
    po_email: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'draft',
      check: "status IN ('draft', 'sent', 'closed', 'cancelled')",
    },
    // One stamp per move, the `sample_orders` posture: `status` answers "where
    // is it now" and the stamps answer "when did it move", which is what an
    // office chasing a house actually asks. A NULL reads as "has not been
    // there" with no CASE over the status.
    sent_at: { type: 'timestamptz' },
    closed_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
    // The house's quoted lead time, typed by staff. Nullable: most houses quote
    // nothing at order time, and an invented date makes every order late.
    expected_at: { type: 'timestamptz' },
    // Who raised it. SET NULL — the document outlives the account.
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // The list filters (FR-145): supplier, brand, status and a date range.
  pgm.createIndex('purchase_orders', 'supplier_id')
  pgm.createIndex('purchase_orders', 'brand_id')
  pgm.createIndex('purchase_orders', 'status')
  pgm.createIndex('purchase_orders', 'created_at')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('purchase_orders')
  pgm.dropSequence('purchase_orders_number_seq')
}
