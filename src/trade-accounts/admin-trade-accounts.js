// Back-office management of the login → D365 customer link.
//
// WHERE THIS IS CALLED FROM. Nothing yet — the intended client is the CRM's
// Users → Applicants screen, next to the approve checkbox, and that screen lives
// in another repo and has not been built. Until it is, staff create links
// through the AdminJS panel, where `trade_accounts` and `trade_account_users`
// are registered as editable resources for exactly that reason
// (src/admin/resources.js). These routes are the real interface; the panel is
// the stopgap.
//
// LINKING IS A HUMAN ACT AND THERE IS NO AUTOMATIC PATH. An email match looks
// like it would do the job and does not: 171 contact emails are shared by 2-4
// contacts, 385 are free-mail domains, and end to end only about half of them
// resolve to exactly one account. Auto-linking would eventually put one
// designer's invoices in front of another. So `suggestTradeAccounts` RANKS
// candidates for a person to choose from, and only `linkTradeAccount` — called
// with a GUID a human picked — creates the grant.
//
// The link is created against the D365 account GUID, and the account's name is
// SNAPSHOTTED at that moment because the transaction exports carry the customer
// as a display name, not a key. If that name is shared with another account the
// row is flagged `name_is_ambiguous` and the client-facing reads serve nothing
// (viewer.js) — the flag is computed once, here, rather than re-derived on every
// read.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100
export const MAX_SUGGESTIONS = 10

const ACCOUNT_COLUMNS = `ta.id,
        ta.legacy_account_guid,
        ta.legacy_customer_name,
        ta.name_is_ambiguous,
        ta.account_manager_name,
        ta.account_manager_email,
        ta.account_manager_phone,
        ta.linked_by_user_id,
        ta.created_at,
        ta.updated_at`

// Staff-editable fields. The identity columns (guid, snapshotted name, the
// ambiguity flag) are deliberately absent: re-pointing a link at a different
// company is unlink-then-link, which leaves an audit trail, not a PATCH.
const UPDATE_COLUMNS = Object.freeze([
  'account_manager_name',
  'account_manager_email',
  'account_manager_phone',
])

const toTradeAccount = (row, users = []) => ({
  id: row.id,
  legacy_account_guid: row.legacy_account_guid,
  company_name: row.legacy_customer_name,
  name_is_ambiguous: row.name_is_ambiguous,
  account_manager: {
    name: row.account_manager_name ?? null,
    email: row.account_manager_email ?? null,
    phone: row.account_manager_phone ?? null,
  },
  linked_by_user_id: row.linked_by_user_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  users,
})

// The logins granted access to a company, batch-loaded for a page of accounts.
const loadUsersByAccountId = async (db, accountIds) => {
  if (accountIds.length === 0) {
    return new Map()
  }
  const { rows } = await db.query(
    `SELECT tau.trade_account_id,
            u.id,
            u.email,
            u.name,
            u.role,
            u.trade_approved
       FROM trade_account_users tau
       JOIN users u ON u.id = tau.user_id
      WHERE tau.trade_account_id = ANY($1::int[])
      ORDER BY u.id`,
    [accountIds]
  )
  const byAccount = new Map()
  for (const row of rows) {
    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      trade_approved: row.trade_approved,
    }
    const existing = byAccount.get(row.trade_account_id)
    if (existing) {
      existing.push(user)
    } else {
      byAccount.set(row.trade_account_id, [user])
    }
  }
  return byAccount
}

/**
 * Linked trade accounts, newest first. `q` matches the snapshotted company name.
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, page?: number, limit?: number }} [options]
 */
export const listTradeAccounts = async (
  pool,
  { q = null, page = DEFAULT_PAGE, limit = DEFAULT_LIMIT } = {}
) => {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const safePage = Math.max(page, 1)
  const term = typeof q === 'string' && q.trim() !== '' ? `%${escapeLike(q.trim())}%` : null
  const { rows } = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS},
            count(*) OVER () AS total_count
       FROM trade_accounts ta
      WHERE ($1::text IS NULL OR ta.legacy_customer_name ILIKE $1 ESCAPE '\\')
      ORDER BY ta.created_at DESC, ta.id DESC
      LIMIT $2 OFFSET $3`,
    [term, safeLimit, (safePage - 1) * safeLimit]
  )
  const usersByAccount = await loadUsersByAccountId(pool, rows.map((row) => row.id))
  return {
    trade_accounts: rows.map((row) => toTradeAccount(row, usersByAccount.get(row.id) ?? [])),
    meta: {
      total: rows.length > 0 ? Number(rows[0].total_count) : 0,
      page: safePage,
      limit: safeLimit,
    },
  }
}

/**
 * One trade account, with its logins and how much D365 history the snapshotted
 * name actually reaches.
 *
 * The coverage counts are the point of the screen: a link that resolves to zero
 * invoices and zero cuttings is almost certainly the wrong account, and this is
 * the only place a human can see that before the client does. Both counts run
 * against the `lower(btrim(...))` indexes added with the tables.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 */
export const getTradeAccount = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS},
            (SELECT count(*) FROM legacy_sales_invoices i
              WHERE lower(btrim(i.customer)) = lower(btrim(ta.legacy_customer_name)))
              AS invoice_count,
            (SELECT count(*) FROM legacy_cuttings k
              WHERE lower(btrim(k.customer)) = lower(btrim(ta.legacy_customer_name)))
              AS sample_count
       FROM trade_accounts ta
      WHERE ta.id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) {
    return null
  }
  const [usersByAccount, { rows: contactRows }, { rows: peopleRows }] = await Promise.all([
    loadUsersByAccountId(pool, [row.id]),
    pool.query(
      `SELECT id, name, role, email, phone, note, created_at, updated_at
         FROM trade_account_contacts
        WHERE trade_account_id = $1
        ORDER BY name ASC, id ASC`,
      [row.id]
    ),
    // The Dynamics people behind this company, READ-ONLY, matched the same way
    // the coverage counts are (the exports carry the company as a display name,
    // not a key — so a shared name unions same-named companies; staff-facing,
    // and the ambiguity flag already warns about exactly that). The projection
    // is a WHITELIST: names and reachability only — never the credit /
    // do-not-contact / GDPR columns the staged row also carries.
    pool.query(
      `SELECT c.full_name, c.job_title, c.email, c.mobile_phone, c.business_phone
         FROM legacy_contacts c
        WHERE lower(btrim(c.company_name)) = lower(btrim($1))
        ORDER BY c.full_name ASC`,
      [row.legacy_customer_name]
    ),
  ])
  return {
    ...toTradeAccount(row, usersByAccount.get(row.id) ?? []),
    contacts: contactRows.map((contact) => Object.freeze({ ...contact })),
    d365_people: peopleRows.map((person) => Object.freeze({ ...person })),
    coverage: {
      invoices: Number(row.invoice_count),
      samples: Number(row.sample_count),
    },
  }
}

/**
 * Grant a login access to a D365 customer's history — or, with no `userId`,
 * create the company row BARE so its contact book can exist before any login
 * does. The GUID is unique, so a later real link upserts onto the same row and
 * contacts survive it; a bare row grants nobody portal access, because the
 * viewer CTE keys off the grant and fails closed.
 *
 * One transaction: resolve the account (422 if the GUID is not a staged D365
 * account), work out whether its name is shared, upsert the trade_accounts row,
 * then insert the grant (skipped entirely when bare). Re-linking the same pair
 * is a no-op rather than a 409 — the operation is "this person belongs to this
 * company", which is either true or it is not.
 *
 * @param {import('pg').Pool} pool
 * @param {{ legacyAccountGuid: string, userId?: number|null, linkedByUserId?: number|null }} input
 */
export const linkTradeAccount = async (
  pool,
  { legacyAccountGuid, userId = null, linkedByUserId = null }
) => {
  const tradeAccountId = await withLinkTxn(pool, { legacyAccountGuid, userId, linkedByUserId })
  // Read back on the pool, outside the transaction: getTradeAccount runs the
  // coverage counts, and holding the write transaction open across them would
  // keep a row lock for no reason.
  return getTradeAccount(pool, tradeAccountId)
}

const withLinkTxn = async (pool, { legacyAccountGuid, userId, linkedByUserId }) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: accountRows } = await client.query(
      `SELECT a.guid,
              a.name,
              (SELECT count(*) FROM legacy_accounts dup
                WHERE lower(btrim(dup.name)) = lower(btrim(a.name))) AS name_count
         FROM legacy_accounts a
        WHERE a.guid = $1`,
      [legacyAccountGuid]
    )
    const account = accountRows[0]
    if (!account) {
      throw httpError(422, 'No Dynamics account with that id has been imported.')
    }
    if (!account.name || account.name.trim() === '') {
      // Without a name there is no key into the transaction tables, so the link
      // could never serve anything. Refuse it rather than create a dead grant.
      throw httpError(422, 'That Dynamics account has no name, so its history cannot be matched.')
    }

    // A bare create carries no user at all — the company row exists for its
    // contact book, and the grant half simply does not happen.
    if (userId !== null) {
      const { rows: userRows } = await client.query(
        `SELECT id, role FROM users WHERE id = $1`,
        [userId]
      )
      const user = userRows[0]
      if (!user) {
        throw httpError(422, 'No user with that id.')
      }
      if (user.role !== 'trade') {
        // A customer or staff login has no portal to see this in, and granting
        // one would put a client's financial history behind an account that was
        // never reviewed as a trade application.
        throw httpError(422, 'Only a trade account can be linked to a Dynamics customer.')
      }
    }

    const { rows: accountUpsert } = await client.query(
      `INSERT INTO trade_accounts
            (legacy_account_guid, legacy_customer_name, name_is_ambiguous, linked_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (legacy_account_guid) DO UPDATE
          SET legacy_customer_name = EXCLUDED.legacy_customer_name,
              name_is_ambiguous = EXCLUDED.name_is_ambiguous,
              updated_at = now()
       RETURNING id`,
      [account.guid, account.name, Number(account.name_count) > 1, linkedByUserId]
    )

    const tradeAccountId = accountUpsert[0].id
    // UNIQUE (user_id) means a login already attached to ANOTHER company raises
    // 23505 on a constraint that is not the composite PK — that is a real
    // conflict a human has to resolve, not something to swallow.
    if (userId !== null) {
      try {
        await client.query(
          `INSERT INTO trade_account_users (trade_account_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (trade_account_id, user_id) DO NOTHING`,
          [tradeAccountId, userId]
        )
      } catch (error) {
        if (error?.code === '23505') {
          throw httpError(
            409,
            'That login is already linked to a different Dynamics customer. Unlink it first.'
          )
        }
        throw error
      }
    }

    await client.query('COMMIT')
    return tradeAccountId
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * The trade account behind a mirror GUID — the bridge the CRM's ClientAccount
 * screen (keyed by D365 GUID) crosses to reach the contact book. Null when no
 * company row exists yet; the route's 404 is the screen's "enable contacts"
 * branch.
 *
 * @param {import('pg').Pool} pool
 * @param {string} guid
 */
export const getTradeAccountByGuid = async (pool, guid) => {
  const { rows } = await pool.query(
    `SELECT id FROM trade_accounts WHERE legacy_account_guid = $1`,
    [guid]
  )
  return rows[0] ? getTradeAccount(pool, rows[0].id) : null
}

// ---------------------------------------------------------------------------
// The contact book (trade_account_contacts). Staff-kept people at the client
// company — NOT logins, and never served to clients (viewer.js and
// client-legacy.js write their own SQL and know nothing of this table).
//
// Every write folds '' to null (the applyOrderHeader rule: a stored '' is an
// absence every IS NULL read misses), scopes child rows in the WRITING
// statement, and answers with the fresh account via getTradeAccount — the
// unlinkTradeAccountUser pattern, so the CRM redraws off one shape.
// ---------------------------------------------------------------------------

const CONTACT_COLUMNS = Object.freeze(['name', 'role', 'email', 'phone', 'note'])

const foldBlank = (value) => {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} accountId
 * @param {{ name: string, role?: string|null, email?: string|null,
 *           phone?: string|null, note?: string|null }} input
 * @returns {Promise<object|null>} the fresh account, or null for an unknown one
 */
export const createTradeAccountContact = async (pool, accountId, input) => {
  const name = foldBlank(input.name)
  if (!name) {
    throw httpError(400, 'A contact needs a name.')
  }
  try {
    await pool.query(
      `INSERT INTO trade_account_contacts (trade_account_id, name, role, email, phone, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        accountId,
        name,
        foldBlank(input.role),
        foldBlank(input.email),
        foldBlank(input.phone),
        foldBlank(input.note),
      ]
    )
  } catch (error) {
    // The unknown company is the FK's 23503 — the id came from the URL, so it
    // is a 404, and a pre-read would race.
    if (error?.code === '23503') return null
    throw error
  }
  return getTradeAccount(pool, accountId)
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} accountId
 * @param {number} contactId
 * @param {object} input
 * @returns {Promise<object|null>} the fresh account, or null when the contact
 *   is missing or belongs to another company (the scoped WHERE decides)
 */
export const updateTradeAccountContact = async (pool, accountId, contactId, input) => {
  const sets = []
  const params = []
  for (const column of CONTACT_COLUMNS) {
    if (Object.hasOwn(input, column)) {
      params.push(foldBlank(input[column]))
      sets.push(`${column} = $${params.length}`)
    }
  }
  if (sets.length === 0) {
    throw httpError(400, 'No updatable fields provided.')
  }
  if (Object.hasOwn(input, 'name') && foldBlank(input.name) == null) {
    throw httpError(400, 'A contact needs a name.')
  }
  const { rowCount } = await pool.query(
    `UPDATE trade_account_contacts
        SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length + 1} AND trade_account_id = $${params.length + 2}`,
    [...params, contactId, accountId]
  )
  return rowCount === 0 ? null : getTradeAccount(pool, accountId)
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} accountId
 * @param {number} contactId
 * @returns {Promise<object|null>}
 */
export const deleteTradeAccountContact = async (pool, accountId, contactId) => {
  const { rowCount } = await pool.query(
    `DELETE FROM trade_account_contacts WHERE id = $1 AND trade_account_id = $2`,
    [contactId, accountId]
  )
  return rowCount === 0 ? null : getTradeAccount(pool, accountId)
}

/**
 * Revoke one login's access. The trade_accounts row survives — it carries the
 * account-manager details and the audit trail, and the company still exists.
 *
 * @param {import('pg').Pool} pool
 * @param {{ id: number, userId: number }} input
 * @returns {Promise<object|null>}  the account, or null when it does not exist
 */
export const unlinkTradeAccountUser = async (pool, { id, userId }) => {
  const { rowCount } = await pool.query(
    `DELETE FROM trade_account_users WHERE trade_account_id = $1 AND user_id = $2`,
    [id, userId]
  )
  if (rowCount === 0) {
    // Either the account or the grant is gone. getTradeAccount decides which,
    // so the route can 404 the account and no-op the rest.
    return getTradeAccount(pool, id)
  }
  return getTradeAccount(pool, id)
}

/**
 * Edit the client-visible account manager.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 */
export const updateTradeAccount = async (pool, id, input) => {
  const sets = []
  const params = [id]
  for (const column of UPDATE_COLUMNS) {
    if (Object.hasOwn(input, column)) {
      params.push(input[column])
      sets.push(`${column} = $${params.length}`)
    }
  }
  if (sets.length === 0) {
    throw httpError(400, 'No updatable fields provided.')
  }
  const { rows } = await pool.query(
    `UPDATE trade_accounts
        SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $1
      RETURNING id`,
    params
  )
  return rows[0] ? getTradeAccount(pool, id) : null
}

// ILIKE metacharacters in a staff-typed search term are literal, not wildcards.
const escapeLike = (term) => term.replace(/[\\%_]/g, (char) => `\\${char}`)

/**
 * Ranked D365 accounts a login might belong to, for a human to choose from.
 *
 * Ranking, best first: an exact match on the account's own email, then a name
 * containing the search term. `already_linked` and `name_is_ambiguous` are
 * returned so the screen can warn before the click rather than after — an
 * ambiguous name produces a link that will serve nothing.
 *
 * @param {import('pg').Pool} pool
 * @param {{ email?: string|null, q?: string|null }} input
 */
export const suggestTradeAccounts = async (pool, { email = null, q = null } = {}) => {
  const normalizedEmail = typeof email === 'string' && email.trim() !== ''
    ? email.trim().toLowerCase()
    : null
  const term = typeof q === 'string' && q.trim() !== '' ? `%${escapeLike(q.trim())}%` : null
  if (!normalizedEmail && !term) {
    return { suggestions: [] }
  }
  const { rows } = await pool.query(
    `SELECT a.guid,
            a.name,
            a.atelier_account_number,
            a.email,
            a.main_phone,
            a.address1_city,
            (SELECT count(*) FROM legacy_accounts dup
              WHERE lower(btrim(dup.name)) = lower(btrim(a.name))) > 1 AS name_is_ambiguous,
            EXISTS (SELECT 1 FROM trade_accounts ta WHERE ta.legacy_account_guid = a.guid)
              AS already_linked,
            CASE
              WHEN $1::text IS NOT NULL AND lower(btrim(a.email)) = $1 THEN 0
              WHEN $2::text IS NOT NULL AND a.name ILIKE $2 ESCAPE '\\' THEN 1
              ELSE 2
            END AS rank
       FROM legacy_accounts a
      WHERE ($1::text IS NOT NULL AND lower(btrim(a.email)) = $1)
         OR ($2::text IS NOT NULL AND a.name ILIKE $2 ESCAPE '\\')
      ORDER BY rank, a.name
      LIMIT $3`,
    [normalizedEmail, term, MAX_SUGGESTIONS]
  )
  return {
    suggestions: rows.map((row) => ({
      legacy_account_guid: row.guid,
      name: row.name,
      account_number: row.atelier_account_number,
      email: row.email,
      phone: row.main_phone,
      city: row.address1_city,
      name_is_ambiguous: row.name_is_ambiguous,
      already_linked: row.already_linked,
      matched_on: row.rank === 0 ? 'email' : 'name',
    })),
  }
}
