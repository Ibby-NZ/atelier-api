// Back-office users / clients admin.
//
// Staff manage customer and trade accounts from the storefront admin UI: they
// list and search accounts, approve trade applications, adjust roles, and
// soft-archive accounts that should drop out of the working lists. Handlers
// stay thin — the rules live here, mirroring the catalogue/order admin modules.
//
// Two things shape this module:
//   - password_hash must NEVER be selected into a response. Reads extend the
//     single-source-of-truth PUBLIC_USER_COLUMNS (which already excludes it)
//     rather than hand-listing columns, so a future column rename can't silently
//     reintroduce the hash.
//   - "Delete" is a soft archive (nullable `archived_at`): commerce and
//     accounting records reference users, so a hard delete would SET NULL across
//     a client's order history. Archiving hides the row from the default list
//     while keeping it fully intact and restorable.

import { PUBLIC_USER_COLUMNS } from '../auth/user-columns.js'
import { buildUpdate } from '../catalogue/admin-brands.js'
import { hashPassword } from '../auth/passwords.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

const PG_UNIQUE_VIOLATION = '23505'

// Reads add the two admin-only columns on top of the public set. created_at and
// archived_at are staff context (when the account was made, whether it's been
// archived); customers never see them, but the back office lists on them.
const USER_READ_COLUMNS = `${PUBLIC_USER_COLUMNS}, created_at, archived_at`

// Only these columns are ever writable via updateUser. email/password_hash are
// managed by the auth endpoints, not the admin panel; created_at/archived_at are
// system-owned (archive() is the only path that touches archived_at).
const USER_UPDATE_COLUMNS = Object.freeze(['role', 'trade_approved', 'name'])

// Escape the LIKE wildcards so a search for "a_b" matches a literal underscore
// rather than any single character. Pairs with the ESCAPE '\' clause in the SQL.
const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

const toUser = (row) =>
  Object.freeze({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    trade_approved: row.trade_approved,
    created_at: row.created_at,
    archived_at: row.archived_at,
  })

/**
 * List accounts newest first, optionally filtered by role and/or a free-text
 * term. Archived accounts are excluded unless `includeArchived` is set, so the
 * default admin list only shows live clients.
 *
 * @param {import('pg').Pool} pool
 * @param {{ role?: string, q?: string, includeArchived?: boolean }} [options]
 * @returns {Promise<object[]>}
 */
export const listUsers = async (pool, { role, q, includeArchived = false } = {}) => {
  const clauses = []
  const params = []

  // Hide archived accounts by default (they stay reachable via includeArchived).
  if (!includeArchived) {
    clauses.push('archived_at IS NULL')
  }

  if (role) {
    params.push(role)
    clauses.push(`role = $${params.length}`)
  }

  // A blank/whitespace term is ignored, not treated as "match nothing".
  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    clauses.push(`(email ILIKE $${i} ESCAPE '\\' OR name ILIKE $${i} ESCAPE '\\')`)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const { rows } = await pool.query(
    `SELECT ${USER_READ_COLUMNS} FROM users ${where} ORDER BY created_at DESC, id DESC`,
    params
  )
  return rows.map(toUser)
}

/**
 * Create an account from the back office (a staff login, or a customer/trade
 * account the office sets up on someone's behalf). The password is hashed with
 * the same argon2id path as self-serve register; a duplicate email is a 409.
 *
 * @param {import('pg').Pool} pool
 * @param {{ email: string, name?: string, role: string, password: string }} input
 * @returns {Promise<object>}
 */
export const createUser = async (pool, { email, name, role, password }) => {
  const passwordHash = await hashPassword(password)
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${USER_READ_COLUMNS}`,
      [email.toLowerCase(), passwordHash, name ?? null, role]
    )
    return toUser(rows[0])
  } catch (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw httpError(409, 'An account with that email already exists.')
    }
    throw error
  }
}

/**
 * A single account by id, or null when it doesn't exist.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getUser = async (pool, id) => {
  const { rows } = await pool.query(
    `SELECT ${USER_READ_COLUMNS} FROM users WHERE id = $1`,
    [id]
  )
  return rows[0] ? toUser(rows[0]) : null
}

/**
 * Patch an account's role / trade_approved / name from a whitelisted body.
 * buildUpdate only ever writes the listed columns and always binds values as
 * placeholders. 404 when the id is unknown.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateUser = async (pool, id, input) => {
  const { sets, params } = buildUpdate(input, USER_UPDATE_COLUMNS)
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')}
      WHERE id = $${params.length + 1}
      RETURNING ${USER_READ_COLUMNS}`,
    [...params, id]
  )
  if (rows.length === 0) {
    throw httpError(404, `User ${id} not found.`)
  }
  return toUser(rows[0])
}

/**
 * Archive (`archived === true`) or restore (`false`) an account by stamping /
 * clearing `archived_at`. Returns the fresh row, or null when the id is unknown
 * (the route turns that into a 404). `archived` is a trusted boolean argument —
 * never user input — so switching the SQL fragment on it is safe.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived
 * @returns {Promise<object|null>}
 */
export const setUserArchived = async (pool, id, archived) => {
  const archivedExpr = archived ? 'now()' : 'NULL'
  const { rows } = await pool.query(
    `UPDATE users SET archived_at = ${archivedExpr}
      WHERE id = $1
      RETURNING ${USER_READ_COLUMNS}`,
    [id]
  )
  return rows[0] ? toUser(rows[0]) : null
}
