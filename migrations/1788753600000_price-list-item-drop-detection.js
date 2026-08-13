/**
 * Drop detection — what an import SAW, so staff can decide what a supplier has
 * stopped selling.
 *
 * The re-runnable-import invariant is untouched: `(supplier, category, code)`
 * still upserts and rows absent from a later file are STILL KEPT. Keeping them
 * is what preserves the history the price-history tables just started building;
 * these three columns only record coverage so that absence becomes visible
 * instead of silent.
 *
 * SCOPE IS `(supplier, category)`, WHICH IS WHY THERE IS NO PER-FILE KEY.
 * Filenames carry the year ("BOUSSAC FABRIC PL 2026.csv") and change annually,
 * so a file-to-file comparison has no stable key at all. Per SUPPLIER is wrong
 * the other way: a house that sends only its wallpaper list in March would mark
 * its entire fabric range discontinued.
 *
 * `discontinued_at` IS NOT `archived_at`, and both columns live here. Archived
 * means staff took the row out of their working list; discontinued means the
 * SUPPLIER stopped selling it. A discontinued item blocks nothing and hides
 * nothing — it is information.
 *
 * DETECTION IS NEVER AUTOMATIC. An import writes `last_seen_*` and clears
 * `discontinued_at` for every row it names; nothing is ever flagged by an import
 * run. `POST /admin/price-list-items/mark-discontinued` is an explicit staff act
 * and states its coverage before it acts.
 *
 * The index is what makes the DERIVED "suspect" state cheap: suspect is
 * `last_seen_in_import < max(last_seen_in_import) over the (supplier, category)`,
 * and the existing `(supplier, category, code)` unique index cannot answer that
 * max without a heap fetch per row. With this one it is an index-only backward
 * scan.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('price_list_items', {
    // When an import last named this row. NULL means no import ever has — a
    // hand-keyed item, or a row that predates this migration. Both are
    // "unknown", never "dropped", which is why the mark route compares against
    // the group's own latest import rather than against a wall-clock date.
    last_seen_in_import: { type: 'timestamptz' },
    // Which drop named it. The row's own `source_file` is where its DATA came
    // from and is overwritten by every upsert; this is the same value, kept as
    // the answer to "which file was the last to list this code".
    last_seen_source_file: { type: 'text' },
    // Stored state, set only by the explicit staff act. An import CLEARS it for
    // any row the file names: a supplier re-listing a code is the strongest
    // possible statement that it is not discontinued.
    discontinued_at: { type: 'timestamptz' },
  })

  pgm.createIndex('price_list_items', ['supplier', 'category', 'last_seen_in_import'])
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('price_list_items', ['supplier', 'category', 'last_seen_in_import'])
  pgm.dropColumns('price_list_items', [
    'last_seen_in_import',
    'last_seen_source_file',
    'discontinued_at',
  ])
}
