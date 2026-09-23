/**
 * The addresses the office adds to a sales order so they hear about its status
 * changes (23 Sep 2026) — the CRM's Emails section on the order page.
 *
 * `orders.notify_emails` — extra recipients of the status letters (confirmed,
 * paid, shipped, cancelled), ON TOP of the client and the order's sales rep,
 * who are always included and are never stored here: they are read off the
 * order's own `user_id`/`guest_email` and `sales_rep_user_id`, so a rep who is
 * re-assigned takes the letters with them rather than leaving a stale copy in
 * this list.
 *
 * NOT NULL DEFAULT '{}' rather than nullable: "nobody extra" has one spelling,
 * and every existing order reads as exactly that. Rules for what a value may be
 * (shape, count, one spelling per address) live in
 * src/orders/notify-emails.js, not in a CHECK — the same argument as the
 * template-name vocabulary: a rule that moves with a deploy should not have to
 * be migrated in lockstep.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('orders', {
    notify_emails: { type: 'text[]', notNull: true, default: pgm.func("'{}'::text[]") },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['notify_emails'])
}
