/**
 * Universal pricing template v2 — the columns the appended header cells land in,
 * plus the two class checks widened to what a supplier may actually send.
 *
 * v2 is a strict superset of the 14 v1 columns, in the same order, with
 * `Supplier`, `Brand`, `Pattern Match` and `Duty Percent` appended; only the
 * last three need storage (Supplier already has a column, it just stops coming
 * from the filename). Every column here is nullable except `template_version`,
 * because a v1 drop carries none of them and must keep importing forever.
 *
 * `brand_name` is TEXT and deliberately NOT a foreign key to `brands`. Supplier
 * spelling does not reliably match the 41 houses ("Colefax & Fowler" vs
 * "Colefax and Fowler"), and an FK would fail a whole 2,000-row import over one
 * naming difference. The join, when it exists, belongs in a lookup we control.
 *
 * `duty_percent` is the seam for the broker's duty table (A10), which is still
 * owed. It stays NULL until a real file carries a real number — the CRM's
 * /import wizard applies its 7% placeholder downstream and that placeholder must
 * never be baked into this ledger. Left unconstrained beyond its precision on
 * purpose: nobody has told us the legitimate range, and a guessed CHECK is the
 * same class of mistake as the class letter sets below.
 *
 * `template_version` records which header row a row came in through. It is NOT
 * read from the file — the header row IS the version (a version cell can be
 * misdeclared by deleting a column; a header mismatch fails loudly) — so this is
 * the converter's verdict, written down. Existing rows backfill to 'v1' via the
 * default. No CHECK: the accepted set lives in the code registry, and pinning it
 * here would make every new template a migration.
 *
 * The class checks widen to a single uppercase letter. Today's sets ('A'-'E' for
 * freight, and nothing at all for duty) encode a guess about a broker table
 * nobody has; the first 'F' from a supplier would reject the client's own file
 * as if it were a bug in ours. The letters stay raw and uninterpreted either
 * way — widening the check writes no value and implies no meaning.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('price_list_items', {
    brand_name: { type: 'text' },
    pattern_match: { type: 'text' },
    duty_percent: { type: 'numeric(6,3)' },
    template_version: { type: 'text', notNull: true, default: 'v1' },
  })

  // freight_class is a genuine WIDEN: every existing row already satisfied
  // IN ('A'..'E'), which is a subset of ^[A-Z]$, so re-adding it validates the
  // table and cannot fail.
  pgm.dropConstraint('price_list_items', 'price_list_items_freight_class_check')
  pgm.addConstraint('price_list_items', 'price_list_items_freight_class_check', {
    check: "freight_class ~ '^[A-Z]$'",
  })
  // duty_class is NOT a widen — it had no check at all, and until now
  // POST/PATCH /admin/price-list-items accepted 200 characters of free text
  // into it, which the CRM renders as a plain input. So a live database may
  // hold a staff-typed note ("Pending broker confirmation") that this pattern
  // rejects, and a validating constraint would abort the whole deploy on it.
  // NOT VALID enforces the shape on every INSERT and UPDATE from here on while
  // leaving the existing rows alone. Validate it in a later migration once the
  // column has been audited — the letters are stored raw and uninterpreted, so
  // nothing reads a legacy value in the meantime.
  pgm.sql(`
    ALTER TABLE price_list_items
      ADD CONSTRAINT price_list_items_duty_class_check
      CHECK (duty_class ~ '^[A-Z]$') NOT VALID
  `)
}

/**
 * Note: the down migration restores the narrow freight-class set, so it fails if
 * any row has landed a letter outside 'A'-'E' by then. That is the honest
 * behaviour — silently dropping those rows' data would be worse.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropConstraint('price_list_items', 'price_list_items_duty_class_check')
  pgm.dropConstraint('price_list_items', 'price_list_items_freight_class_check')
  pgm.addConstraint('price_list_items', 'price_list_items_freight_class_check', {
    check: "freight_class IN ('A','B','C','D','E')",
  })
  pgm.dropColumns('price_list_items', ['brand_name', 'pattern_match', 'duty_percent', 'template_version'])
}
