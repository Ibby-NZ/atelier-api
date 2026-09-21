/**
 * The keys `npm run merge:legacy` lands its rows on.
 *
 * The merge promotes Dynamics staging rows into the live tables in preparation
 * for going live, and it has to be re-runnable until the day it is run for
 * real: the staging import refreshes until cutover, so the merge will be run
 * against a fresher corpus more than once. Every table it writes therefore
 * needs a column that says "this row came from THAT D365 record", or a second
 * run doubles the contacts and the dockets.
 *
 * `trade_accounts` already carries one (`legacy_account_guid`, unique) and the
 * catalogue keys on the colourway SKU, so only the two tables with no natural
 * key gain one here. Nullable: rows the office keys by hand carry no guid.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.addColumns('trade_account_contacts', { legacy_guid: { type: 'uuid' } })
  pgm.addConstraint('trade_account_contacts', 'trade_account_contacts_legacy_guid_key', {
    unique: ['legacy_guid'],
  })
  pgm.addColumns('reserve_lines', { legacy_guid: { type: 'uuid' } })
  pgm.addConstraint('reserve_lines', 'reserve_lines_legacy_guid_key', { unique: ['legacy_guid'] })
}

export const down = (pgm) => {
  pgm.dropConstraint('reserve_lines', 'reserve_lines_legacy_guid_key')
  pgm.dropColumns('reserve_lines', ['legacy_guid'])
  pgm.dropConstraint('trade_account_contacts', 'trade_account_contacts_legacy_guid_key')
  pgm.dropColumns('trade_account_contacts', ['legacy_guid'])
}
