/**
 * The company details a trade account carries once it is a LIVE record rather
 * than a link onto a Dynamics row.
 *
 * `trade_accounts` was born as the join between a portal login and a D365
 * account: its only company facts were the guid and a snapshotted name, and
 * everything else was read off `legacy_accounts`. The cutover merge
 * (`merge:legacy`) makes it the client roster itself — every D365 client
 * lands here — so the facts the office reads on a client (account number,
 * type, who to ring, where they are, terms) move onto the row. All nullable:
 * an account raised by hand carries what the office typed and no more.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('trade_accounts', {
    account_number: { type: 'text' },
    customer_type: { type: 'text' },
    primary_contact_name: { type: 'text' },
    email: { type: 'text' },
    phone: { type: 'text' },
    address: { type: 'text' },
    city: { type: 'text' },
    country: { type: 'text' },
    payment_terms: { type: 'text' },
    xero_contact_id: { type: 'text' },
    archived_at: { type: 'timestamptz' },
  })
  pgm.createIndex('trade_accounts', 'account_number')
}

export const down = (pgm) => {
  pgm.dropIndex('trade_accounts', 'account_number')
  pgm.dropColumns('trade_accounts', [
    'account_number', 'customer_type', 'primary_contact_name', 'email', 'phone',
    'address', 'city', 'country', 'payment_terms', 'xero_contact_id', 'archived_at',
  ])
}
