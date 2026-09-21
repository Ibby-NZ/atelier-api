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
        ta.updated_at,
        ta.account_number,
        ta.customer_type,
        ta.primary_contact_name,
        ta.email,
        ta.phone,
        ta.address,
        ta.city,
        ta.country,
        ta.payment_terms,
        ta.xero_contact_id,
        ta.archived_at,
        (SELECT COUNT(*)::int FROM trade_account_contacts tac WHERE tac.trade_account_id = ta.id) AS contact_count,
        (SELECT tap.id FROM trade_applications tap WHERE tap.trade_account_id = ta.id
          ORDER BY tap.created_at DESC, tap.id DESC LIMIT 1) AS trade_application_id`

// Staff-editable fields. The identity columns (guid, snapshotted name, the
// ambiguity flag) are deliberately absent: re-pointing a link at a different
// company is unlink-then-link, which leaves an audit trail, not a PATCH — and
// the snapshotted name is what the client portal matches invoice history on
// (viewer.js), so renaming it would silently empty a client's history.
export const MANAGER_COLUMNS = Object.freeze([
  'account_manager_name',
  'account_manager_email',
  'account_manager_phone',
])
// The company details the cutover merge carried over — the client's terms and
// identity, where the account manager block is who at Atelier looks after
// them. Backoffice edits both (the director gate went in Sept 2026).
export const DETAIL_COLUMNS = Object.freeze([
  'account_number', 'customer_type', 'primary_contact_name', 'email', 'phone',
  'address', 'city', 'country', 'payment_terms', 'xero_contact_id',
])
const UPDATE_COLUMNS = Object.freeze([...MANAGER_COLUMNS, ...DETAIL_COLUMNS])

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
  // The company details the cutover merge carried over from D365 (see
  // migrations/1790947200000_trade-account-details.js); null on a row raised
  // by hand.
  account_number: row.account_number ?? null,
  customer_type: row.customer_type ?? null,
  primary_contact_name: row.primary_contact_name ?? null,
  email: row.email ?? null,
  phone: row.phone ?? null,
  address: row.address ?? null,
  city: row.city ?? null,
  country: row.country ?? null,
  payment_terms: row.payment_terms ?? null,
  xero_contact_id: row.xero_contact_id ?? null,
  archived_at: row.archived_at ?? null,
  contact_count: row.contact_count ?? 0,
  // The trade application that raised this company, when one did (the
  // storefront form; migration 1791379200000). The CRM reviews it on the row.
  trade_application_id: row.trade_application_id ?? null,
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
            u.phone,
            u.role,
            u.trade_approved,
            u.archived_at,
            u.created_at
       FROM trade_account_users tau
       JOIN users u ON u.id = tau.user_id
      WHERE tau.trade_account_id = ANY($1::int[])
      ORDER BY u.id`,
    [accountIds]
  )
  const byAccount = new Map()
  for (const row of rows) {
    // The whole editable shape: the CRM's Accounts screen edits a login in
    // place (Sept 2026), so it needs phone and the archived flag, not a
    // name-and-role summary.
    const user = {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone ?? null,
      role: row.role,
      trade_approved: row.trade_approved,
      archived_at: row.archived_at ?? null,
      created_at: row.created_at,
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

// An account awaiting review: a live trade login on it that nobody has
// approved. This is the trade-application queue, expressed on the roster —
// approving flips `users.trade_approved` and the row simply stops matching.
const PENDING_LOGIN_EXISTS = `EXISTS (
  SELECT 1 FROM trade_account_users pu
    JOIN users u ON u.id = pu.user_id
   WHERE pu.trade_account_id = ta.id
     AND u.role = 'trade' AND NOT u.trade_approved AND u.archived_at IS NULL)`

/**
 * The client roster, A–Z. `q` matches the company name, account number, primary
 * contact, email or phone — or a LOGIN's email, so an order's "open the client"
 * link lands on the company; `customer_type` narrows to Trade / Retail;
 * `include_archived` keeps the rows the merge or the office closed; `pending`
 * narrows to the accounts with an unapproved trade login (the review queue).
 *
 * @param {import('pg').Pool} pool
 * @param {{ q?: string, customerType?: string, includeArchived?: boolean,
 *   pending?: boolean, page?: number, limit?: number }} [options]
 */
export const listTradeAccounts = async (
  pool,
  {
    q = null,
    customerType = null,
    includeArchived = false,
    pending = false,
    page = DEFAULT_PAGE,
    limit = DEFAULT_LIMIT,
  } = {}
) => {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const safePage = Math.max(page, 1)
  const term = typeof q === 'string' && q.trim() !== '' ? `%${escapeLike(q.trim())}%` : null
  const type = typeof customerType === 'string' && customerType.trim() !== '' ? customerType.trim() : null
  const { rows } = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS},
            count(*) OVER () AS total_count
       FROM trade_accounts ta
      WHERE ($1::text IS NULL
             OR ta.legacy_customer_name ILIKE $1 ESCAPE '\\'
             OR ta.account_number ILIKE $1 ESCAPE '\\'
             OR ta.primary_contact_name ILIKE $1 ESCAPE '\\'
             OR ta.email ILIKE $1 ESCAPE '\\'
             OR ta.phone ILIKE $1 ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM trade_account_users qu JOIN users qq ON qq.id = qu.user_id
                         WHERE qu.trade_account_id = ta.id AND qq.email ILIKE $1 ESCAPE '\\'))
        AND ($2::text IS NULL OR ta.customer_type = $2)
        AND (ta.archived_at IS NULL OR $3)
        AND (NOT $4 OR ${PENDING_LOGIN_EXISTS})
      ORDER BY ta.legacy_customer_name ASC, ta.id ASC
      LIMIT $5 OFFSET $6`,
    [term, type, includeArchived, pending, safeLimit, (safePage - 1) * safeLimit]
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
    // do-not-contact / GDPR columns the staged row also carries. A person the
    // cutover merge already landed on the book (`legacy_guid`) is left out, so
    // the list is what is still only in Dynamics, not a copy of the book.
    pool.query(
      `SELECT c.full_name, c.job_title, c.email, c.mobile_phone, c.business_phone
         FROM legacy_contacts c
        WHERE lower(btrim(c.company_name)) = lower(btrim($1))
          AND NOT EXISTS (SELECT 1 FROM trade_account_contacts t WHERE t.legacy_guid = c.guid)
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
            'That login is already linked to another client account. Unlink it there first.'
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

/** A typed cell: trimmed, and blank means "nothing said", never a stored ''. */
const trimmedOrNull = (value) => {
  const text = value == null ? '' : String(value).trim()
  return text === '' ? null : text
}

/**
 * Raise a client the business won today — a company with no Dynamics account
 * behind it, and so no GUID (nullable since
 * migrations/1791206400000_client-raised-by-hand.js; NULLs are distinct to the
 * UNIQUE constraint, so any number of them coexist).
 *
 * This is the roster's own create, and it exists because the roster became the
 * client list at cutover: every path before it demanded a D365 GUID, which a
 * new client by definition does not have. The order desk is the caller — a
 * client rings up who is in no export, and keying the order should not mean
 * leaving the order to go and make a client somewhere else.
 *
 * The company NAME is all that is required; everything else is what the office
 * happened to take down. No duplicate-name check: account names are famously
 * not unique in this corpus (866 rows, 865 distinct names), so a 409 on one
 * would refuse legitimate clients — the caller searches first, which is what
 * the form is built around.
 *
 * `linked_by_user_id` carries who raised it, the same audit trail a real link
 * writes. `name_is_ambiguous` keeps its default: it describes a collision with
 * a D365 name, and with no GUID the viewer CTE resolves nothing for this row
 * regardless — a hand-raised client is served no legacy history, which is
 * correct, since none of it is theirs.
 *
 * @param {import('pg').Pool} pool
 * @param {{ company_name: string, created_by_user_id?: number|null }} input
 *   plus any of DETAIL_COLUMNS (account number, contact, email, phone,
 *   address, city, country, terms).
 * @returns {Promise<object>} the fresh account, in getTradeAccount's shape
 */
export const createTradeAccount = async (pool, input = {}) => {
  const name = trimmedOrNull(input.company_name)
  if (!name) {
    throw httpError(422, 'A client needs a company name.')
  }
  const columns = ['legacy_customer_name', 'linked_by_user_id']
  const params = [name, input.created_by_user_id ?? null]
  for (const column of DETAIL_COLUMNS) {
    if (Object.hasOwn(input, column)) {
      const value = trimmedOrNull(input[column])
      params.push(column === 'email' && value ? value.toLowerCase() : value)
      columns.push(column)
    }
  }
  const { rows } = await pool.query(
    `INSERT INTO trade_accounts (${columns.join(', ')})
     VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    params
  )
  return getTradeAccount(pool, rows[0].id)
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
 * Edit the account manager and the company details.
 *
 * `company_name` is accepted ONLY on a row with no Dynamics GUID: on a linked
 * row the name is the snapshot the client portal matches invoice history on
 * (viewer.js), so renaming it would silently empty that history — 422 names
 * the reason. A hand-raised or application-raised company has no history to
 * lose, and a typo in its name is exactly what the office needs to fix.
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
      const value = input[column] == null ? null : String(input[column]).trim()
      params.push(value === '' ? null : column === 'email' ? value.toLowerCase() : value)
      sets.push(`${column} = $${params.length}`)
    }
  }
  if (Object.hasOwn(input, 'company_name')) {
    const name = trimmedOrNull(input.company_name)
    if (!name) {
      throw httpError(422, 'A client needs a company name.')
    }
    const { rows } = await pool.query(
      `SELECT legacy_account_guid FROM trade_accounts WHERE id = $1`,
      [id]
    )
    if (!rows[0]) return null
    if (rows[0].legacy_account_guid) {
      throw httpError(
        422,
        'This company came over from Dynamics; its name is what its invoice history is matched on, so it cannot be renamed here.'
      )
    }
    params.push(name)
    sets.push(`legacy_customer_name = $${params.length}`)
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
