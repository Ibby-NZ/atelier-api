/**
 * Contact people on a trade company (Zomia is Jenny, Viv, Haike…).
 *
 * `trade_account_users` is the LOGIN grant — a person who can sign in to the
 * portal. The client's ask is different: a staff-kept contact BOOK, several
 * named people per company, none of whom needs a password. That is this table.
 *
 * WHY IT HANGS OFF `trade_accounts` AND NOT `legacy_accounts`: the import
 * upserts every mapped column to EXCLUDED, so anything staff wrote onto a
 * legacy row dies on the next `npm run import:legacy` — the exact argument
 * that created `trade_accounts` in the first place (see that migration's
 * header). No `legacy_` prefix either: test/samples-schema.test.js counts
 * `legacy_%` tables as the import's own.
 *
 * CASCADE: a contact is address-book data about the company record, not a
 * business record that must survive it.
 *
 * A6 note: nothing here touches sales attribution. These are the CLIENT's
 * people; the legacy owner/salesperson columns stay untouched and unmapped.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('trade_account_contacts', {
    id: 'id',
    trade_account_id: {
      type: 'integer',
      notNull: true,
      references: 'trade_accounts',
      onDelete: 'CASCADE',
    },
    name: { type: 'text', notNull: true },
    // Free text — "Design lead", "Accounts" — the trade doesn't share a
    // vocabulary, so there is nothing to CHECK.
    role: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    note: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('trade_account_contacts', 'trade_account_id')
}

export const down = (pgm) => {
  pgm.dropTable('trade_account_contacts')
}
