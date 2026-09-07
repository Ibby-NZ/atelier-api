// Password reset tokens — the self-service "forgot password" flow, and what the
// back office sends instead of reading a temp password out over the phone.
//
// ONE row per account, keyed on user_id: a fresh request replaces the previous
// link rather than accumulating beside it, so the newest email is the only one
// that works and a stale one in an old inbox is dead the moment a new one is
// asked for. The token itself is never stored — only its SHA-256 — so a read of
// this table cannot be turned into a sign-in; the raw value exists solely in the
// email that carried it. `expires_at` is what bounds that email's life (one hour
// at the time of writing, decided in src/auth/password-reset.js), and consuming
// a token DELETES the row, which is what makes the link single-use without a
// `used_at` column to remember to check.
//
// ON DELETE CASCADE: a hard-deleted account takes its pending link with it;
// an archived one keeps the row but the consume query excludes archived
// accounts, the same rule every other auth path applies.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('password_reset_tokens', {
    user_id: {
      type: 'integer',
      primaryKey: true,
      references: 'users',
      onDelete: 'CASCADE',
    },
    token_hash: { type: 'text', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('password_reset_tokens')
}
