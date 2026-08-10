/**
 * Samples: the physical register — where every showroom sample is, and whose
 * shelf it is standing on.
 *
 * Until now the office tracked samples in three CRM screens that persist
 * nothing (localStorage) and in `legacy_cuttings`, a read-only D365 staging
 * table. Neither is a register: the demo screens lose everything on
 * clear-site-data, and `importLegacyEntity` upserts every mapped column to
 * EXCLUDED, so any state written onto a `legacy_*` row is destroyed by the next
 * `npm run import:legacy`. THAT is why these tables live outside the `legacy_*`
 * namespace — the same reason `trade_accounts` does.
 *
 * NOTHING IS COPIED OUT OF `legacy_cuttings.comments`. 1,757 of its 1,886 rows
 * carry one and they are the back office's scratchpad: staff names, handling
 * instructions and, in current rows, third parties' names, emails, phones and
 * home addresses. `samples.notes` is staff-typed here and nowhere else.
 *
 * SAMPLES ARE NOT STOCK. A sample is a physical object on a shelf, not a
 * sellable quantity: no column here mirrors an inventory figure, and no sample
 * code path may read or write one. The order state machine's reservation
 * arithmetic is the only owner of those numbers, and it fails silently rather
 * than loudly when a second writer appears.
 *
 * WHY `barcode` IS THE KEY, NOT NULL AND UNIQUE. The scanner is the point of the
 * register: `GET /admin/samples/by-barcode/:barcode` has to give one
 * deterministic answer, 200 or 404, never a filtered list. A nullable barcode
 * would make the unique index tolerate any number of unlabelled samples and turn
 * that lookup into a guess. A duplicate is refused by the database
 * (23505 on `samples_barcode_key` → 409), never by a pre-check that races.
 *
 * WHY THE THREE FK POLICIES DIFFER.
 * - `colourway_id` is RESTRICT and NULLABLE. Restricted, because a sample is
 *   physical evidence that the design exists and deleting the catalogue row
 *   underneath it would leave a labelled object nobody can identify. Nullable,
 *   because plenty of samples on the shelves predate the catalogue or come from
 *   a house Atelier does not stock — `label` is what identifies those.
 * - `supplier_id` is SET NULL: who sent the sample is history, and it must
 *   survive the supplier record being tidied away.
 * - `showroom_id` is SET NULL: closing a showroom does not destroy the samples
 *   that were standing in it; they simply have no home until someone re-homes
 *   them.
 *
 * `status` is CHECK-constrained rather than left free text because the whole
 * register is read through it, and `archived_at` sits beside it deliberately:
 * `retired` is a statement about the physical object (worn out, sent back),
 * archiving is the reversible removal of the ROW that every live CRM list
 * offers. They are different questions and the screens ask both.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // A showroom is a place samples are stocked — Atelier's own and the stockists
  // it supplies. Names are unique so a duplicate is refused by the database.
  pgm.createTable('showrooms', {
    id: 'id',
    name: { type: 'text', notNull: true, unique: true },
    address: { type: 'text' },
    city: { type: 'text' },
    contact_name: { type: 'text' },
    contact_email: { type: 'text' },
    contact_phone: { type: 'text' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })

  // Same posture as every other archivable table: the common read filters on
  // archived_at IS NULL, so index only the live rows.
  pgm.createIndex('showrooms', 'archived_at', {
    name: 'showrooms_archived_at_live_idx',
    where: 'archived_at IS NULL',
  })

  pgm.createTable('samples', {
    id: 'id',
    // See the header: the scanner's key, so one barcode is one sample.
    barcode: { type: 'text', notNull: true, unique: true },
    // What is written on the tag. The only identity a sample carrying no
    // catalogue link has, so the register stays readable without one.
    label: { type: 'text' },
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
    showroom_id: {
      type: 'integer',
      references: 'showrooms',
      onDelete: 'SET NULL',
    },
    // Free text, deliberately: nobody has ratified a vocabulary for what a
    // sample IS (hanger, cutting, book, memo), and a guessed CHECK would refuse
    // the office's own word for it the first time they typed it.
    sample_type: { type: 'text' },
    // Where the object physically sits — a shelf, a bay, a drawer.
    location: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: 'in_library',
      check: "status IN ('in_library', 'out', 'missing', 'retired')",
    },
    // Staff-typed. Never populated from `legacy_cuttings.comments` — see header.
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })

  pgm.createIndex('samples', 'colourway_id')
  pgm.createIndex('samples', 'supplier_id')
  pgm.createIndex('samples', 'showroom_id')
  // The register's headline filter — every list is "what is out" or "what is on
  // the shelf".
  pgm.createIndex('samples', 'status')
  pgm.createIndex('samples', 'archived_at', {
    name: 'samples_archived_at_live_idx',
    where: 'archived_at IS NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('samples')
  pgm.dropTable('showrooms')
}
