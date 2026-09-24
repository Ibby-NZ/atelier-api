/**
 * The trade application review flow (24 Sep 2026).
 *
 * `users.trade_first_approved_at` — the approver (Liz) approved this trade
 * login; the accounts desk (Jenette) gives the final approval, which is the
 * `trade_approved` flip that actually unlocks trade pricing. A login with this
 * set and `trade_approved` false is waiting on the accounts desk. Cleared
 * whenever `trade_approved` goes false, so a revoked or re-promoted login is
 * reviewed from the start again.
 *
 * `trade_applications.declined_at` / `decline_reason` — the reason the
 * approver gave when she declined the application, which is also what the
 * applicant is emailed. A record of the letter, not the account's state: the
 * login's archive is still the "no" (users.archived_at), and restoring it does
 * not clear this.
 *
 * `trade_accounts.account_owner_id` — the staff login who owns the client,
 * picked from a list in the CRM, and the account manager the client portal
 * shows (falling back to the old account-manager text columns while nobody is
 * picked). SET NULL so removing a staff login leaves the client unowned rather
 * than refusing the delete.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('users', {
    trade_first_approved_at: { type: 'timestamptz' },
  })
  pgm.addColumns('trade_applications', {
    declined_at: { type: 'timestamptz' },
    decline_reason: { type: 'text' },
  })
  pgm.addColumn('trade_accounts', {
    account_owner_id: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
  })
  pgm.createIndex('trade_accounts', 'account_owner_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('trade_accounts', 'account_owner_id')
  pgm.dropColumn('trade_accounts', 'account_owner_id')
  pgm.dropColumns('trade_applications', ['declined_at', 'decline_reason'])
  pgm.dropColumn('users', 'trade_first_approved_at')
}
