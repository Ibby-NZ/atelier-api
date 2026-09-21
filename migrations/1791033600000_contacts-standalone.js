/**
 * A contact may exist without a company.
 *
 * `trade_account_contacts` was a client company's contact book, so every row
 * needed a company. The cutover merge lands EVERY Dynamics contact, and 1,288
 * of the 2,662 name no client company (553 name none at all; the rest name a
 * supplier, a courier, a firm that never became a client). They are people the
 * office knows and still rings, so they land here — unattached, carrying the
 * company name D365 gave them as text until someone files them.
 *
 * `company_name` is that text: read only when `trade_account_id` is null, and
 * cleared when a contact is filed under an account (the account IS the company
 * then). The CASCADE on the FK becomes SET NULL for the same reason — deleting
 * a company should orphan its people, not erase them.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.alterColumn('trade_account_contacts', 'trade_account_id', { notNull: false })
  pgm.dropConstraint('trade_account_contacts', 'trade_account_contacts_trade_account_id_fkey')
  pgm.addConstraint('trade_account_contacts', 'trade_account_contacts_trade_account_id_fkey', {
    foreignKeys: {
      columns: 'trade_account_id',
      references: 'trade_accounts(id)',
      onDelete: 'SET NULL',
    },
  })
  pgm.addColumns('trade_account_contacts', { company_name: { type: 'text' } })
  pgm.createIndex('trade_account_contacts', 'name')
}

export const down = (pgm) => {
  pgm.dropIndex('trade_account_contacts', 'name')
  pgm.dropColumns('trade_account_contacts', ['company_name'])
  pgm.sql('DELETE FROM trade_account_contacts WHERE trade_account_id IS NULL')
  pgm.dropConstraint('trade_account_contacts', 'trade_account_contacts_trade_account_id_fkey')
  pgm.addConstraint('trade_account_contacts', 'trade_account_contacts_trade_account_id_fkey', {
    foreignKeys: {
      columns: 'trade_account_id',
      references: 'trade_accounts(id)',
      onDelete: 'CASCADE',
    },
  })
  pgm.alterColumn('trade_account_contacts', 'trade_account_id', { notNull: true })
}
