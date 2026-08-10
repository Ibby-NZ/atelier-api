/**
 * Sample orders: a showroom asks for sample material, and the office tracks it
 * from the request to the day it stands on the shelf.
 *
 * This is the SECOND lifecycle in the samples domain and it is independent of
 * the first. `sample_loans` records a sample Atelier already owns leaving the
 * library and coming back; a sample order records material that does not exist
 * here yet being requested from a house. Nothing joins them: an order that is
 * `received` may or may not ever become a barcoded row in `samples`, and that
 * decision is the office's, not this schema's.
 *
 * OUTSIDE THE `legacy_*` NAMESPACE, like the rest of the domain.
 * `importLegacyEntity` upserts every mapped column to EXCLUDED, so lifecycle
 * state written onto a staging row is destroyed by the next
 * `npm run import:legacy`.
 *
 * SAMPLES ARE NOT STOCK, and an order for them is not a purchase order. No
 * column here mirrors an inventory figure and no sample route may write one —
 * the order state machine in `src/orders/` owns the reservation arithmetic and
 * a second writer breaks it silently rather than loudly. There is deliberately
 * no quantity column either: the row is one requested item, nothing derives a
 * figure from it, and a count on a samples table is the first thing a later
 * reader would mistake for stock.
 *
 * EACH TRANSITION HAS ITS OWN TIMESTAMP COLUMN, and that is the point of the
 * table. `status` alone answers "where is it now"; the six columns answer "when
 * did it move", which is the question a showroom chasing a house actually asks
 * ("ordered three weeks ago, still not shipped"). One `status_changed_at` would
 * be overwritten by the next move and lose every earlier one. `requested_at` is
 * NOT NULL because every order was requested; the other five are NULL until the
 * move happens, and a NULL is therefore readable as "has not reached that state"
 * without consulting `status`.
 *
 * WHAT THE SCHEMA DOES NOT ENFORCE. The legal transitions
 * (`requested → ordered → in_transit → received → displayed`, and `cancelled`
 * from anywhere short of terminal) are US-007's `ALLOWED_TRANSITIONS`, not a
 * CHECK: a CHECK sees one row at a time and cannot see which state the row is
 * moving FROM, so it can express the vocabulary but never the machine. The
 * vocabulary is checked here, where it belongs — `status` is what every list
 * filters on and free text would make the CRM's tabs a guess.
 *
 * WHY THE THREE FK POLICIES DIFFER.
 * - `showroom_id` is NOT NULL and RESTRICT. A sample order exists to send
 *   material somewhere; one with no destination is unroutable, so it may not be
 *   created without a showroom and the showroom may not be deleted out from
 *   under it. SET NULL — the policy `samples.showroom_id` takes — would be
 *   wrong here for exactly that reason: a sample with no home is still a sample
 *   on a shelf, an order with no home is a request nobody can fulfil.
 * - `colourway_id` is RESTRICT and NULLABLE, mirroring `samples`. Restricted
 *   because the order is evidence the design was asked for; nullable because
 *   plenty of requests name material the catalogue does not hold yet (that is
 *   often WHY it is being ordered), and `label` is what identifies those.
 * - `supplier_id` is SET NULL: who it was ordered from is history, and it must
 *   survive the supplier record being tidied away.
 *
 * `archived_at` sits beside `status` as it does on `samples`, and for the same
 * reason: `cancelled` and `displayed` are statements about the ORDER, while
 * archiving is the reversible removal of the ROW that every live CRM list
 * offers. US-007 refuses a hard delete of anything past `requested`/`cancelled`,
 * so archiving is the only way a finished order leaves the screen.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('sample_orders', {
    id: 'id',
    // NOT NULL and RESTRICT: see the header. An order with no destination is a
    // request nobody can fulfil.
    showroom_id: {
      type: 'integer',
      notNull: true,
      references: 'showrooms',
      onDelete: 'RESTRICT',
    },
    colourway_id: {
      type: 'integer',
      references: 'colourways',
      onDelete: 'RESTRICT',
    },
    supplier_id: {
      type: 'integer',
      references: 'suppliers',
      onDelete: 'SET NULL',
    },
    // What was asked for, in the office's own words. The only identity an order
    // carrying no catalogue link has.
    label: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'requested',
      check:
        "status IN ('requested', 'ordered', 'in_transit', 'received', 'displayed', 'cancelled')",
    },
    // The six transition stamps. Defaulted rather than derived from created_at
    // so an order recorded after the fact can carry the day it was raised — the
    // same posture as `sample_loans.out_at`.
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ordered_at: { type: 'timestamptz' },
    in_transit_at: { type: 'timestamptz' },
    received_at: { type: 'timestamptz' },
    displayed_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
    // Staff-typed, like samples.notes. Never populated from legacy staging.
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })

  // "What is this showroom waiting on" is the screen's first question.
  pgm.createIndex('sample_orders', 'showroom_id')
  pgm.createIndex('sample_orders', 'colourway_id')
  pgm.createIndex('sample_orders', 'supplier_id')
  // Every list is a status tab.
  pgm.createIndex('sample_orders', 'status')
  pgm.createIndex('sample_orders', 'archived_at', {
    name: 'sample_orders_archived_at_live_idx',
    where: 'archived_at IS NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('sample_orders')
}
