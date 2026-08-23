/**
 * Xero integration foundations (C4).
 *
 * Atelier already RUNS on Xero — invoicing happens there today, by hand, and
 * the D365 staging mirror carries the old system's linkage
 * (legacy_accounts.xero_contact_id, legacy_sales_invoices.xero_invoice_id).
 * This migration gives the LIVE tables their own linkage plus somewhere to
 * keep the OAuth connection, so the platform can push invoices instead of
 * staff re-keying them.
 *
 * `xero_connection` IS A SINGLE ROW, ANCHORED AT id = 1 BY A CHECK. There is
 * exactly one Xero organisation; a second row could only be a second tenant
 * silently receiving half the invoices. Every reader/writer targets id = 1
 * (`src/xero/connection-store.js`), and the CHECK makes an accidental INSERT
 * of a second connection a constraint error rather than a split brain.
 *
 * `token_set` IS jsonb, NOT COLUMNS. Its shape is Xero's, not ours
 * (access_token / refresh_token / expires_at), and Xero ROTATES the refresh
 * token on every use — the row is rewritten whole under a FOR UPDATE lock
 * (see the store) so two workers can never both spend the same single-use
 * refresh token. Secrets-in-DB note: the token grants what the Xero app's
 * scopes grant and nothing else; the client secret itself stays in the
 * environment and is never written here.
 *
 * `pending_state` is the OAuth `state` nonce between "a director clicked
 * Connect" and the callback landing. It lives on the same row because the
 * connection is the thing being negotiated; TEXT and nullable, cleared the
 * moment it is checked (single use, like the refresh token).
 *
 * `users.xero_contact_id` — the live counterpart of
 * legacy_accounts.xero_contact_id: which Xero Contact this login invoices
 * as. TEXT, not uuid: it is Xero's identifier, opaque to us, and a uuid
 * type would make us the validator of somebody else's key. Nullable —
 * unlinked simply means "the next invoice push will match-or-create".
 *
 * `orders.xero_invoice_id` sits beside the existing xero_invoice_ref (the
 * HUMAN number staff have always typed, e.g. INV-0231, which the confirm
 * flow and the order_confirmed email already use). The id is the API
 * identifier the push stores so a second push can 409 instead of minting a
 * duplicate invoice; the ref stays the display/reconciliation number, now
 * filled automatically by the push. Two columns because they answer
 * different questions and only one of them existed before Xero did.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('xero_connection', {
    id: { type: 'integer', primaryKey: true, default: 1, check: 'id = 1' },
    // 'authorization_code' or 'client_credentials' — recorded so a saved
    // token set is never interpreted under the other grant's rules after an
    // env change. The config is the intent; this is what actually happened.
    grant_type: { type: 'text' },
    token_set: { type: 'jsonb' },
    tenant_id: { type: 'text' },
    org_name: { type: 'text' },
    pending_state: { type: 'text' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.addColumns('users', {
    xero_contact_id: { type: 'text' },
  })

  pgm.addColumns('orders', {
    xero_invoice_id: { type: 'text' },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropColumns('orders', ['xero_invoice_id'])
  pgm.dropColumns('users', ['xero_contact_id'])
  pgm.dropTable('xero_connection')
}
