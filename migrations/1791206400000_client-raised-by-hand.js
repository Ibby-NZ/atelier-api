/**
 * A client company may exist without a Dynamics account behind it.
 *
 * `trade_accounts` was born as the link from a portal login onto a D365
 * account, so its GUID was the identity and could not be null. The cutover
 * merge made the table the client ROSTER itself — 860 companies, the ones the
 * office actually trades with — and a roster has to be able to take a client
 * the business won TODAY, who is in no export and never will be. Until now
 * there was no way to raise one: every create path demanded a GUID.
 *
 * NULL rather than a fabricated UUID, because the column says "the D365
 * account this company is" and a made-up one would be a lie every reader
 * believes: the Archive link would open an empty record, the merge's upsert
 * key would collide the day that client really does appear in an export, and
 * `VIEWER_CTE` joins `legacy_accounts` on it to serve a client their own
 * invoice history — which for a hand-raised client is correctly nothing, and
 * with a fabricated GUID would be nothing with no way to tell why.
 *
 * The UNIQUE constraint stays as it is: Postgres treats NULLs as distinct, so
 * any number of hand-raised clients coexist while two rows can still never
 * claim the same D365 account.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.alterColumn('trade_accounts', 'legacy_account_guid', { notNull: false })
}

export const down = (pgm) => {
  // The rows that only exist because of this migration cannot be given a GUID,
  // so going back drops them — the same posture as the standalone contacts.
  pgm.sql('DELETE FROM trade_accounts WHERE legacy_account_guid IS NULL')
  pgm.alterColumn('trade_accounts', 'legacy_account_guid', { notNull: true })
}
