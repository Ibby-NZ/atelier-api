// Reserves & cuttings — the live replacement for the D365 `fulmar_reserve` and
// cutting entities (the "In Progress Reserves" report the office runs today).
//
// TWO TABLES, NOT ONE, because the office asked for the shape out loud: "enter
// them like a sales order — accounts first, then enter the reserve/cutting in
// each line so we don't have to create a new form all the time." A DOCKET
// (`reserve_requests`) is one visit to the form for one account; a LINE
// (`reserve_lines`) is one design in one colour. The old system was one form
// per line, and 100 cuttings for a new collection meant 100 forms.
//
// Decisions a later reader will want stated:
//
//   - **This is a live table, not a mapping of `legacy_reserves`.** The staging
//     tables are re-imported wholesale (`importLegacyEntity` upserts every
//     mapped column to EXCLUDED), so lifecycle state written there is destroyed
//     by the next `npm run import:legacy`. The legacy rows stay where they are;
//     this table starts empty and grows from the CRM.
//   - **Nothing here touches `inventory.qty_reserved`.** A reserve in this
//     system is a request to the HOUSE to hold uncut stock at their end — it is
//     not a claim on Atelier's own shelves. The order state machine stays the
//     sole writer of that column, as the samples and purchasing migrations
//     already promise.
//   - **The product is a snapshot plus an optional pointer.** `product_name`,
//     `range_name`, `supplier` and `product_code` are copied off the price list
//     at entry time (the D365 form did the same on save), and
//     `price_list_item_id` keeps the pointer while the rate row lives. SET NULL,
//     not RESTRICT: a price re-import may retire the row, and a reserve must
//     outlive the price list that named it. The supplier-facing report reads
//     the SNAPSHOT, so it cannot change under an open reserve.
//   - **One colour per line, `multiplier` for identical copies.** The De Le
//     Cuona sheet carried "cols 05 + 06" in a single cell and the overflow in a
//     comment; the fix is structural. `multiplier` is the "×10 / ×20" the
//     office asked for — identical cuttings for ONE account collapse to one
//     line. Different accounts stay different dockets, because they want every
//     request connected to its account.
//   - **`customer_reference` is its own column** — it was squeezed into the
//     comment before, which is exactly where the office said it must stop being.
//   - **Status is per LINE, with a stamp per transition** (the sample-orders
//     pattern): requested → confirmed → arrived → dispatched, cancelled from
//     the open states. `requested → arrived` is legal — goods turn up that
//     nobody marked confirmed. The CHECK holds the VOCABULARY only; the
//     transitions live in src/reserves/reserve-line-states.js, which the CRM
//     mirrors.
//   - **`cfa` is the D365 field the houses reply to** ("cutting for approval"):
//     not_required / required / ordered / received / approved. Nullable — it
//     only means anything on a reserve line — and stored as its own state, not
//     folded into `status`, because a reserve can be confirmed while its CFA is
//     still in the post.
//   - **`reserved_until` is a DATE, not a timestamptz.** The house quotes "held
//     until the 27th"; the D365 export carried times only because Excel serials
//     do. A zone-less calendar date is the truthful grain.
//   - **`source_line_id` links a cutting generated from a reserve** (the wish
//     that made the two old systems one form). SET NULL: deleting a drafting
//     mistake must not take the cutting it spawned with it.
//   - **No `archived_at`.** `cancelled` is the removal that keeps the record,
//     and the lifecycle registry says `archivable: false` to match. A docket
//     disappears by its lines all closing, not by a second flag.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('reserve_requests', {
    id: 'id',
    // The account it is for. `user_id` when a platform account was picked;
    // `account_name` always — a snapshot, because most of the client base is
    // still Dynamics-side and nothing live references the staging tables.
    user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    account_name: { type: 'text', notNull: true },
    contact_name: { type: 'text' },
    // The staff member who raised it — the report's Owner column. A snapshot
    // (like `account_name`) so the paperwork survives staff-account changes.
    owner_name: { type: 'text' },
    created_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createIndex('reserve_requests', 'user_id')

  pgm.createTable('reserve_lines', {
    id: 'id',
    request_id: {
      type: 'integer',
      notNull: true,
      references: 'reserve_requests',
      onDelete: 'CASCADE',
    },
    kind: { type: 'text', notNull: true },
    status: { type: 'text', notNull: true, default: 'requested' },
    // The product, as entered: snapshot columns plus the optional pointer back
    // to the price-list row that filled them.
    product_name: { type: 'text', notNull: true },
    range_name: { type: 'text' },
    supplier: { type: 'text' },
    product_code: { type: 'text' },
    price_list_item_id: {
      type: 'integer',
      references: 'price_list_items',
      onDelete: 'SET NULL',
    },
    colour: { type: 'text' },
    // Metres for a reserve; blank is legal (the old report has blank
    // quantities and they were real requests). A cutting usually counts in
    // `multiplier` alone.
    qty: { type: 'numeric(12,2)' },
    multiplier: { type: 'integer', notNull: true, default: 1 },
    customer_reference: { type: 'text' },
    // The house's reference, free text — "TBA", "R/ 26735", "ATE017 – 0020223509"
    // are all real values in the current book.
    reserve_number: { type: 'text' },
    reserved_until: { type: 'date' },
    cfa: { type: 'text' },
    comment: { type: 'text' },
    source_line_id: {
      type: 'integer',
      references: 'reserve_lines',
      onDelete: 'SET NULL',
    },
    // One stamp per transition, requested included (a create can back-date it).
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    confirmed_at: { type: 'timestamptz' },
    arrived_at: { type: 'timestamptz' },
    dispatched_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.addConstraint('reserve_lines', 'reserve_lines_kind_check', {
    check: "kind IN ('reserve', 'cutting')",
  })
  pgm.addConstraint('reserve_lines', 'reserve_lines_status_check', {
    check: "status IN ('requested', 'confirmed', 'arrived', 'dispatched', 'cancelled')",
  })
  pgm.addConstraint('reserve_lines', 'reserve_lines_cfa_check', {
    check: "cfa IS NULL OR cfa IN ('not_required', 'required', 'ordered', 'received', 'approved')",
  })
  pgm.addConstraint('reserve_lines', 'reserve_lines_qty_check', {
    check: 'qty IS NULL OR qty > 0',
  })
  pgm.addConstraint('reserve_lines', 'reserve_lines_multiplier_check', {
    check: 'multiplier >= 1',
  })

  pgm.createIndex('reserve_lines', 'request_id')
  pgm.createIndex('reserve_lines', 'status')
  pgm.createIndex('reserve_lines', 'kind')
  // The supplier report and its facet list group on the snapshot column.
  pgm.createIndex('reserve_lines', 'supplier')
  // The chase list: open lines whose hold date has passed.
  pgm.createIndex('reserve_lines', 'reserved_until')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('reserve_lines')
  pgm.dropTable('reserve_requests')
}
