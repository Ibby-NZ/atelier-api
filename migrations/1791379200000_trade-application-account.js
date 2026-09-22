/**
 * A trade application raises the client account it asks for (Sept 2026).
 *
 * The form used to create a LOGIN (`users`, role trade, unapproved) and the
 * paper record (`trade_applications`) and nothing else, so an applicant was
 * listed nowhere on the client roster until somebody re-typed the business
 * into `trade_accounts` by hand. Now `submitTradeApplication` also raises the
 * company row, files the form's two named people into its contact book and
 * grants the login — the CRM's Accounts screen reviews the application on the
 * account itself, so the Applicants queue is gone.
 *
 * This column is the back-link from the form to that company row. SET NULL,
 * like `user_id`: the form is a business record and survives the account.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumn('trade_applications', {
    trade_account_id: {
      type: 'integer',
      references: 'trade_accounts',
      onDelete: 'SET NULL',
    },
  })
  pgm.createIndex('trade_applications', 'trade_account_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropIndex('trade_applications', 'trade_account_id')
  pgm.dropColumn('trade_applications', 'trade_account_id')
}
