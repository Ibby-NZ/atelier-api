/**
 * The import log — who imported which price list, when, and how the file
 * accounted for itself.
 *
 * This exists because the office is taking the price-list import over. Today
 * the only way a supplier's rates reach the ledger is `npm run import:pricing`
 * on a developer's laptop, so "who changed this and when" has one answer and
 * everybody knows it. Once Liz can drop a file into the CRM herself, the answer
 * stops being obvious, and a rate ledger nobody can attribute is a rate ledger
 * nobody trusts.
 *
 * ONE ROW PER APPLIED IMPORT, NEVER PER ATTEMPT. A file with any row error is
 * refused whole and writes nothing (the `applyProductSheet` posture), so a row
 * here is always an import that landed. A refused upload is answered with its
 * errors and leaves no trace — recording attempts would turn the history screen
 * into a list of typos.
 *
 * WHAT IT DELIBERATELY DOES NOT STORE:
 *
 *   - The rate changes themselves. Those are already in
 *     `price_list_item_price_history` with `source = 'import'`, and a
 *     denormalised count here would be a second statement of the same fact,
 *     free to disagree. `created_at` is `now()` inside the import's own
 *     transaction and so is every history row's `changed_at`, which is what
 *     makes the join exact rather than a time window:
 *       SELECT * FROM price_list_item_price_history h
 *        WHERE h.source = 'import' AND h.changed_at = <import>.created_at
 *
 *   - The supplier. A v3 file names a supplier per ROW and may legitimately
 *     carry several, so one column would have to lie or become an array nobody
 *     has asked to filter on. The filename is how the office identifies a drop
 *     ("BOUSSAC FABRIC PL 2026.xlsx") and it is recorded verbatim.
 *
 * `filename` is the same string that lands in `price_list_items.source_file`,
 * so the row a rate came from and the import that carried it name the same file.
 *
 * `imported_by_user_id` is `ON DELETE SET NULL`, the `trade_applications.user_id`
 * rule: the import is a business record and outlives the account that ran it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('price_list_imports', {
    id: 'id',
    imported_by_user_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    // The file's own name, as the office knows it. Also what every row of this
    // import carries in `price_list_items.source_file`.
    filename: { type: 'text', notNull: true },
    // Which header row the file declared — the converter's verdict, the same
    // value `price_list_items.template_version` records. No CHECK, for the
    // reason that column has none: the accepted set is the code registry in
    // scripts/lib/price-template.js, and pinning it here makes every new
    // template a migration.
    template_version: { type: 'text', notNull: true },

    // The four counts that account for the file. They balance exactly:
    //   rows_read = rows_imported + rows_skipped + rows_duplicate
    // (a row that FAILED is not in any of them, because a file with a failed
    // row is never applied). The same "rows in = rows out + skips" invariant
    // the colour converter and the product sheet both report on.
    rows_read: { type: 'integer', notNull: true },
    rows_imported: { type: 'integer', notNull: true },
    // Unpriced rows — a wholesale rate of 0 is "price on application", which is
    // a legitimate row to leave out and never an error.
    rows_skipped: { type: 'integer', notNull: true },
    // Exact repeats of an earlier row, dropped keep-first. A supplier who
    // reprints a code identically is not making two statements.
    rows_duplicate: { type: 'integer', notNull: true },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // The history screen is "newest first", and nothing else reads this table.
  pgm.createIndex('price_list_imports', 'created_at')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('price_list_imports')
}
