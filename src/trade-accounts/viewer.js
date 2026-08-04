// Who the signed-in trade client IS, as a company.
//
// Every client-facing portal read is scoped by this and nothing else. The rule
// this module exists to enforce: THE SCOPING KEY IS NEVER A FUNCTION ARGUMENT.
// A helper taking `{ legacyCustomerName }` is a helper a future route can bind
// from a query parameter, and the first person to do that hands one client
// another client's invoices. So the key is derived inside the SQL from the
// authenticated user id, exactly as `/orders/mine` scopes on `user_id = $1`.
//
// `VIEWER_CTE` is that derivation, exported for the read models to inline as the
// first CTE of their own statement. It resolves to AT MOST ONE ROW
// (trade_account_users has UNIQUE (user_id)) and to NO ROWS when:
//   - the user has no link at all (a trade account nobody has linked yet), or
//   - the linked company's name collided with another D365 account
//     (`name_is_ambiguous`), or
//   - the snapshotted name is blank.
// Joining against it therefore FAILS CLOSED: an unlinked or ambiguous viewer
// sees an empty list, never `= ''` matching every legacy row with an empty
// customer field.

/**
 * The viewer CTE body. Inline as `WITH viewer AS (${VIEWER_CTE}) …` and bind the
 * authenticated user id as `$1`; the reads then `JOIN viewer v ON …`.
 *
 * Exposes `customer_name` (the snapshot to match on) and `trade_account_id`.
 *
 * THE COLLISION CHECK IS LIVE, NOT THE STORED FLAG. `trade_accounts.name_is_ambiguous`
 * is computed once at link time, and `npm run import:legacy` re-runs until
 * cutover — upserting `legacy_accounts.name` and inserting new accounts — so the
 * flag can be falsified after the fact in two ways this join closes:
 *   - a NEW D365 account appears with the same name as an already-linked
 *     company. Its invoices export under that display name and would join
 *     straight onto the existing viewer, while the stored flag still says false.
 *   - a linked account is RENAMED and its old name is later taken by an
 *     unrelated company. The snapshot still holds the old name, so the viewer
 *     would match the other company's rows entirely — and here the collision
 *     count is legitimately 1, so recomputing the flag would not catch it
 *     either. Requiring the snapshot to still equal the LINKED GUID's current
 *     name is what does.
 * Both predicates use the `lower(btrim(...))` indexes the migration adds. The
 * stored flag stays as the CRM's warning; this is the enforcement.
 */
export const VIEWER_CTE = `SELECT ta.id AS trade_account_id,
            ta.legacy_customer_name AS customer_name
       FROM trade_account_users tau
       JOIN trade_accounts ta ON ta.id = tau.trade_account_id
       JOIN legacy_accounts la ON la.guid = ta.legacy_account_guid
      WHERE tau.user_id = $1
        AND ta.name_is_ambiguous = false
        AND btrim(ta.legacy_customer_name) <> ''
        AND lower(btrim(la.name)) = lower(btrim(ta.legacy_customer_name))
        AND NOT EXISTS (
              SELECT 1 FROM legacy_accounts dup
               WHERE lower(btrim(dup.name)) = lower(btrim(ta.legacy_customer_name))
                 AND dup.guid <> ta.legacy_account_guid
            )`

/** The predicate every scoped read uses to match a legacy row to the viewer. */
export const VIEWER_MATCH = `lower(btrim(v.customer_name))`

const ACCOUNT_MANAGER_COLUMNS = `ta.account_manager_name,
        ta.account_manager_email,
        ta.account_manager_phone`

/**
 * The signed-in user's trade account, or null when they have no link.
 *
 * Unlike VIEWER_CTE this deliberately DOES return an ambiguous link, flagged —
 * the portal has to tell the client "we are still setting your account up"
 * rather than showing empty panels with no explanation, and the CRM has to see
 * that the link needs a human. The scoped reads still refuse to serve it.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<object|null>}
 */
export const loadViewerTradeAccount = async (pool, userId) => {
  // `resolves` recomputes the SAME conditions VIEWER_CTE enforces, so the
  // dashboard's "linked" can never claim a client will be served history that
  // the reads then refuse. Deriving it from the stored flag alone let the two
  // drift apart after an import.
  const { rows } = await pool.query(
    `SELECT ta.id,
            ta.legacy_account_guid,
            ta.legacy_customer_name,
            ta.name_is_ambiguous,
            EXISTS (SELECT 1 FROM (${VIEWER_CTE}) v WHERE v.trade_account_id = ta.id)
              AS resolves,
            ${ACCOUNT_MANAGER_COLUMNS}
       FROM trade_account_users tau
       JOIN trade_accounts ta ON ta.id = tau.trade_account_id
      WHERE tau.user_id = $1`,
    [userId]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    id: row.id,
    // The GUID is Atelier's internal handle on the D365 record. It is NOT sent
    // to the client — see toClientTradeAccount.
    legacy_account_guid: row.legacy_account_guid,
    company_name: row.legacy_customer_name,
    name_is_ambiguous: row.name_is_ambiguous,
    resolves: row.resolves,
    account_manager: toAccountManager(row),
  }
}

// Null rather than an object of nulls: "no account manager on file" is a state
// the storefront branches on (it shows the generic showroom block instead), and
// `{ name: null, … }` would read as one that exists with no name.
const toAccountManager = (row) => {
  if (!row.account_manager_name && !row.account_manager_email && !row.account_manager_phone) {
    return null
  }
  return {
    name: row.account_manager_name ?? null,
    email: row.account_manager_email ?? null,
    phone: row.account_manager_phone ?? null,
  }
}

/**
 * The client-safe projection of a trade account.
 *
 * Drops `legacy_account_guid` — a D365 record id is an internal handle, it
 * appears in staff screens and screenshots, and nothing in the portal needs it
 * (every scoped read derives its own key from the session). `linked` is the flag
 * the portal branches on, and it is `resolves` — the LIVE outcome of the same
 * conditions the reads apply — not the stored ambiguity flag, so it is true
 * exactly when history will actually be served.
 *
 * @param {object|null} account  from loadViewerTradeAccount
 */
export const toClientTradeAccount = (account) => {
  if (!account) {
    return { linked: false, company_name: null, account_manager: null }
  }
  return {
    linked: account.resolves === true,
    company_name: account.company_name,
    account_manager: account.account_manager,
  }
}
