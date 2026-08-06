/**
 * Sample loans: who has the sample, since when, and when it is due back.
 *
 * A loan is APPEND-ONLY HISTORY. A sample goes out, comes back, goes out again;
 * each movement is its own row and none of them is ever rewritten to say a
 * different thing happened. That is why there is no `archived_at` here (every
 * other live table in this schema has one) — archiving is the reversible removal
 * of a row a CRM list offers, and a loan is not a row anybody may remove from
 * the record. `returned_at IS NULL` is the whole of "still out".
 *
 * ONE OPEN LOAN PER SAMPLE IS A PARTIAL UNIQUE INDEX, NOT APPLICATION CODE.
 * `sample_loans_open_unique` covers `sample_id WHERE returned_at IS NULL`, so
 * the database holds the invariant. The scanner is a concurrent device: two
 * staff scanning the same barcode out at once would otherwise open two loans,
 * and the register would name the wrong holder from then on — with nothing in
 * the data to say which of the two rows was the lie. A pre-check ("is it out
 * already?") cannot close that window; it reads a row another transaction is
 * about to write. So the second check-out is a caught 23505 on this index,
 * mapped to a 409, exactly as a duplicate barcode is (see US-006's
 * `withSampleTxn`). Closing a loan sets `returned_at`, which drops the row out
 * of the index and lets the next check-out succeed — the index has to be PARTIAL
 * for that reason, since a plain unique on `sample_id` would allow one loan per
 * sample for all time.
 *
 * WHY `sample_id` IS RESTRICT. History is a record, not an owned child. CASCADE
 * would let deleting a sample destroy every movement it was ever part of, which
 * is precisely the question the register exists to answer ("where did that
 * hanger go?"), and it would do it silently. The delete policy in
 * architecture.md says a sample with loans is a 409; RESTRICT is the backstop
 * underneath the probe that will report it.
 *
 * WHY `holder_name` IS A SNAPSHOT, AND NOT NULL. A borrower is often a trade
 * client, so `trade_account_id` links the loan to the company where one is
 * known — SET NULL, because that link is the CURRENT state of a business
 * relationship and the loan record must outlive it. But the link cannot be the
 * holder: `trade_accounts.legacy_customer_name` is itself re-snapshotted when
 * staff re-link an account, the grant between a login and a company is unlinked
 * by back-office staff as a matter of course, and plenty of borrowers are not
 * trade clients at all (an architect, a stylist, Atelier's own staff). So the
 * name written on the loan is the name that was given when the sample went out,
 * stored here, never joined for. Renaming or unlinking the account afterwards
 * leaves the history reading exactly as it read on the day.
 *
 * OVERDUE IS DERIVED, NEVER STORED. There is no `is_overdue` column and there
 * must not be one: it is `returned_at IS NULL AND due_back_at < now()`,
 * evaluated at read time, and a stored boolean is wrong from the first minute
 * nobody runs the job that would maintain it. `sample_loans_overdue_idx` is what
 * makes deriving it cheap.
 *
 * SAMPLES ARE NOT STOCK. Nothing here mirrors a stock figure and no loan writes
 * one: a sample leaving the library is not a sale, and the order state machine
 * is the only owner of the reservation arithmetic.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('sample_loans', {
    id: 'id',
    // RESTRICT: see the header. A sample carrying loans is refused, not emptied.
    sample_id: {
      type: 'integer',
      notNull: true,
      references: 'samples',
      onDelete: 'RESTRICT',
    },
    // The company, where the borrower is a linked trade client. Nullable
    // because most borrowers are not, and SET NULL because the link is current
    // state while the loan is history.
    trade_account_id: {
      type: 'integer',
      references: 'trade_accounts',
      onDelete: 'SET NULL',
    },
    // The snapshot. Whoever took it, as given at the counter. NOT NULL: a loan
    // that cannot say who has the sample answers nothing.
    holder_name: { type: 'text', notNull: true },
    // When it left. Defaulted rather than derived from created_at so a movement
    // recorded after the fact can still carry the day it happened.
    out_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Nullable: plenty of samples go out with no date agreed, and inventing one
    // would make them overdue on a deadline nobody set.
    due_back_at: { type: 'timestamptz' },
    // NULL is the whole of "still out" — the partial index's predicate.
    returned_at: { type: 'timestamptz' },
    // Staff-typed, like samples.notes. Never populated from legacy staging.
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // THE invariant: at most one open loan per sample, held by the database.
  pgm.createIndex('sample_loans', 'sample_id', {
    name: 'sample_loans_open_unique',
    unique: true,
    where: 'returned_at IS NULL',
  })

  // The history read: every movement of one sample, and the loan count each
  // register row carries.
  pgm.createIndex('sample_loans', 'sample_id')

  // "What has this client got out." Also what makes unlinking cheap to check.
  pgm.createIndex('sample_loans', 'trade_account_id')

  // Overdue is derived at read time; this is what makes that cheap. Partial on
  // the same predicate as the unique index, because an overdue loan is by
  // definition one that is still out.
  pgm.createIndex('sample_loans', 'due_back_at', {
    name: 'sample_loans_overdue_idx',
    where: 'returned_at IS NULL',
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('sample_loans')
}
