// The one-row home of the Xero connection (migration 1789412800000).
//
// Everything here targets id = 1 — the CHECK in the migration makes a second
// row impossible, so "the connection" is a read of one row, not a query with
// an ORDER BY hiding a policy.
//
// THE ROW IS REWRITTEN UNDER FOR UPDATE WHENEVER A REFRESH TOKEN IS SPENT.
// Xero's refresh tokens are single-use: refreshing returns a NEW refresh
// token and kills the old one. Two workers refreshing concurrently with the
// same stored token means the loser's response is a dead token and the row
// ends up holding it — the connection bricks until a director reconnects.
// `withConnectionLock` serialises that read-refresh-write cycle; service.js
// is the only caller and re-checks expiry INSIDE the lock, so the second
// worker in the queue finds a fresh token and skips its own refresh.

const ROW_ID = 1

/** Ensure the singleton row exists so later UPDATEs always have a target. */
const ensureRow = async (db) => {
  await db.query(
    `INSERT INTO xero_connection (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
    [ROW_ID]
  )
}

export const loadConnection = async (db) => {
  const { rows } = await db.query(
    `SELECT grant_type, token_set, tenant_id, org_name, pending_state
       FROM xero_connection WHERE id = $1`,
    [ROW_ID]
  )
  return rows[0] ?? null
}

export const saveTokenSet = async (db, { grantType, tokenSet, tenantId, orgName }) => {
  await ensureRow(db)
  await db.query(
    `UPDATE xero_connection
        SET grant_type = $2,
            token_set = $3,
            tenant_id = COALESCE($4, tenant_id),
            org_name = COALESCE($5, org_name),
            pending_state = NULL,
            updated_at = now()
      WHERE id = $1`,
    // jsonb params must be stringified — pg maps raw objects to record types.
    [ROW_ID, grantType, JSON.stringify(tokenSet), tenantId ?? null, orgName ?? null]
  )
}

export const clearConnection = async (db) => {
  await db.query(
    `UPDATE xero_connection
        SET grant_type = NULL, token_set = NULL, tenant_id = NULL,
            org_name = NULL, pending_state = NULL, updated_at = now()
      WHERE id = $1`,
    [ROW_ID]
  )
}

/** Remember the OAuth `state` nonce a Connect click minted. */
export const savePendingState = async (db, state) => {
  await ensureRow(db)
  await db.query(
    `UPDATE xero_connection SET pending_state = $2, updated_at = now() WHERE id = $1`,
    [ROW_ID, state]
  )
}

/**
 * Read AND clear the pending state in one statement — the nonce is single
 * use, so the read is the spend. Returns the state that was stored (null when
 * none was pending, which callers treat as "this callback matches nothing").
 */
export const takePendingState = async (db) => {
  // RETURNING sees the row AFTER the update (already NULL), so the old value
  // rides in through a locked self-select instead.
  const { rows } = await db.query(
    `UPDATE xero_connection x
        SET pending_state = NULL, updated_at = now()
       FROM (SELECT pending_state FROM xero_connection WHERE id = $1 FOR UPDATE) old
      WHERE x.id = $1
      RETURNING old.pending_state AS taken`,
    [ROW_ID]
  )
  return rows[0]?.taken ?? null
}

/**
 * Run `fn(client, connection)` with the connection row locked FOR UPDATE in a
 * transaction. `connection` is the row as `fn` must trust it (re-read inside
 * the lock). Whatever `fn` returns is returned after COMMIT; any throw rolls
 * back and re-throws.
 */
export const withConnectionLock = async (pool, fn) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await ensureRow(client)
    const { rows } = await client.query(
      `SELECT grant_type, token_set, tenant_id, org_name
         FROM xero_connection WHERE id = $1 FOR UPDATE`,
      [ROW_ID]
    )
    const result = await fn(client, rows[0] ?? null)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
