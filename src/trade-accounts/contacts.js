// The contacts roster: every person the office knows, across every company and
// none. `trade_account_contacts` was born as one company's contact book (the
// per-account routes in admin-trade-accounts.js still serve it that way); the
// cutover merge made it the whole address book, and a contact may stand
// unattached. This module is the cross-company view and the writes that move a
// contact between companies.
//
// `company` on every row is what a reader wants to see: the account's name
// where the contact is filed, else the text D365 gave it. Filing under an
// account clears the text — the account IS the company then — and unfiling
// keeps whatever the caller sends as `company_name`.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const CONTACT_COLUMNS = Object.freeze(['name', 'role', 'email', 'phone', 'note', 'company_name'])

const foldBlank = (value) => {
  if (value == null) return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

const escapeLike = (term) => term.replace(/[\\%_]/g, (char) => `\\${char}`)

const PROJECTION = `c.id, c.trade_account_id, c.name, c.role, c.email, c.phone, c.note,
        c.legacy_guid, c.created_at, c.updated_at,
        COALESCE(ta.legacy_customer_name, c.company_name) AS company,
        c.company_name, ta.account_number`

const toContact = (row) => ({
  id: row.id,
  trade_account_id: row.trade_account_id,
  name: row.name,
  role: row.role,
  email: row.email,
  phone: row.phone,
  note: row.note,
  company: row.company ?? null,
  company_name: row.company_name ?? null,
  account_number: row.account_number ?? null,
  legacy_guid: row.legacy_guid ?? null,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

/**
 * @param {import('pg').Pool} pool
 * @param {{ q?: string|null, filed?: boolean|null, tradeAccountId?: number|null, page?: number, limit?: number }} opts
 *   `filed` true = under an account, false = unattached, null = both.
 */
export const listContacts = async (
  pool,
  { q = null, filed = null, tradeAccountId = null, page = 1, limit = DEFAULT_LIMIT } = {}
) => {
  const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT)
  const safePage = Math.max(page, 1)
  const term = typeof q === 'string' && q.trim() !== '' ? `%${escapeLike(q.trim())}%` : null
  const { rows } = await pool.query(
    `SELECT ${PROJECTION}, COUNT(*) OVER () AS total_count
       FROM trade_account_contacts c
       LEFT JOIN trade_accounts ta ON ta.id = c.trade_account_id
      WHERE ($1::text IS NULL
             OR c.name ILIKE $1 ESCAPE '\\'
             OR c.email ILIKE $1 ESCAPE '\\'
             OR c.phone ILIKE $1 ESCAPE '\\'
             OR c.role ILIKE $1 ESCAPE '\\'
             OR COALESCE(ta.legacy_customer_name, c.company_name) ILIKE $1 ESCAPE '\\')
        AND ($2::boolean IS NULL OR (c.trade_account_id IS NOT NULL) = $2)
        AND ($3::int IS NULL OR c.trade_account_id = $3)
      ORDER BY c.name ASC, c.id ASC
      LIMIT $4 OFFSET $5`,
    [term, filed, tradeAccountId, safeLimit, (safePage - 1) * safeLimit]
  )
  return {
    contacts: rows.map(toContact),
    meta: { total: rows.length > 0 ? Number(rows[0].total_count) : 0, page: safePage, limit: safeLimit },
  }
}

export const getContact = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${PROJECTION} FROM trade_account_contacts c
       LEFT JOIN trade_accounts ta ON ta.id = c.trade_account_id
      WHERE c.id = $1`,
    [id]
  )
  return rows[0] ? toContact(rows[0]) : null
}

// A filed contact's company is its account, so the text is cleared; an
// unattached one keeps what was sent.
const companyTextFor = (input, tradeAccountId) =>
  tradeAccountId != null ? null : foldBlank(input.company_name)

const accountExists = async (pool, id) => {
  if (id == null) return true
  const { rowCount } = await pool.query('SELECT 1 FROM trade_accounts WHERE id = $1', [id])
  return rowCount > 0
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ name: string, trade_account_id?: number|null, company_name?: string|null,
 *           role?: string|null, email?: string|null, phone?: string|null, note?: string|null }} input
 */
export const createContact = async (pool, input) => {
  const name = foldBlank(input.name)
  if (!name) throw httpError(400, 'A contact needs a name.')
  const tradeAccountId = input.trade_account_id ?? null
  if (!(await accountExists(pool, tradeAccountId))) {
    throw httpError(422, `Trade account ${tradeAccountId} does not exist.`)
  }
  const { rows } = await pool.query(
    `INSERT INTO trade_account_contacts (trade_account_id, company_name, name, role, email, phone, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      tradeAccountId, companyTextFor(input, tradeAccountId), name,
      foldBlank(input.role), foldBlank(input.email), foldBlank(input.phone), foldBlank(input.note),
    ]
  )
  return getContact(pool, rows[0].id)
}

/**
 * Any subset of the columns plus `trade_account_id` (null unfiles). Returns
 * null for an unknown contact.
 */
export const updateContact = async (pool, id, input) => {
  const sets = []
  const params = [id]
  const push = (column, value) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (Object.hasOwn(input, 'name') && foldBlank(input.name) == null) {
    throw httpError(400, 'A contact needs a name.')
  }
  const refiling = Object.hasOwn(input, 'trade_account_id')
  if (refiling) {
    const tradeAccountId = input.trade_account_id ?? null
    if (!(await accountExists(pool, tradeAccountId))) {
      throw httpError(422, `Trade account ${tradeAccountId} does not exist.`)
    }
    push('trade_account_id', tradeAccountId)
    push('company_name', companyTextFor(input, tradeAccountId))
  }
  for (const column of CONTACT_COLUMNS) {
    if (column === 'company_name' && refiling) continue
    if (Object.hasOwn(input, column)) push(column, foldBlank(input[column]))
  }
  if (sets.length === 0) throw httpError(400, 'No updatable fields provided.')
  const { rowCount } = await pool.query(
    `UPDATE trade_account_contacts SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
    params
  )
  return rowCount === 0 ? null : getContact(pool, id)
}

export const deleteContact = async (pool, id) => {
  const { rowCount } = await pool.query('DELETE FROM trade_account_contacts WHERE id = $1', [id])
  return rowCount > 0
}
