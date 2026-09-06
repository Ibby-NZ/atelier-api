// Supplier contact people + the contact log (read models and writes).
//
// Two tables, one module, both back-office only like everything supplier-side:
//   - `supplier_contacts` — the PEOPLE at a house. Several per supplier is the
//     common case (a sales contact and an accounts contact), which is why they
//     are rows and not columns.
//   - `supplier_contact_log` — APPEND-ONLY history of staff↔supplier contact.
//     There is no update or delete here on purpose: the log answers "when were
//     we last in touch and who spoke to them", and an editable history answers
//     nothing. (Same posture as sample_loans; add a scoped DELETE if the office
//     ever asks.)
//
// Every write that addresses a child row scopes it in the WRITING statement
// (`AND supplier_id = $n`) — the supplier-terms posture — so a contact id under
// another supplier 404s through this path rather than being reachable.
//
// The unknown-supplier case is the database's 23503 on the FK, mapped to a 404:
// the id came from the URL, and a pre-check would race the way the module
// header of admin-suppliers.js describes for duplicates.

import { buildUpdate } from '../catalogue/admin-brands.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// Boundary copy of `supplier_contact_log_method_check`. The database owns the
// vocabulary; test/suppliers-contacts.test.js compares this to the live CHECK
// so one side cannot widen without the other.
export const CONTACT_METHODS = Object.freeze(['call', 'email', 'visit', 'showroom'])

// Columns a contact PATCH may ever write, as buildUpdate requires.
const CONTACT_UPDATE_COLUMNS = Object.freeze(['name', 'role', 'email', 'phone', 'note'])

const CONTACT_COLUMNS = 'id, supplier_id, name, role, email, phone, note, created_at, updated_at'

const toContact = (row) =>
  Object.freeze({
    id: row.id,
    supplier_id: row.supplier_id,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })

// pg serialises `date` columns to a Date at midnight; the API speaks
// YYYY-MM-DD, so both date columns go through ::text in every projection
// below rather than being re-formatted (and re-timezoned) in JS.
const LOG_COLUMNS = `id, supplier_id, contacted_on::text AS contacted_on, staff_user_id,
  staff_name, method, note, follow_up_on::text AS follow_up_on, created_at`

const toLogEntry = (row) =>
  Object.freeze({
    id: row.id,
    supplier_id: row.supplier_id,
    contacted_on: row.contacted_on,
    staff_user_id: row.staff_user_id,
    staff_name: row.staff_name,
    method: row.method,
    note: row.note,
    follow_up_on: row.follow_up_on,
    created_at: row.created_at,
  })

// 23503 on the supplier FK = the URL named a supplier that does not exist.
// 22007/22008 = a value that passed the YYYY-MM-DD shape check but is not a
// real calendar date ('2026-02-31') — the schema regex cannot know that, the
// database does, and it must come back a 422 rather than a 500.
const rethrowMapped = (error, supplierId) => {
  if (error?.code === '23503') {
    throw httpError(404, `Supplier ${supplierId} not found.`)
  }
  if (error?.code === '22007' || error?.code === '22008') {
    throw httpError(422, 'That is not a real calendar date.')
  }
  throw error
}

/**
 * All contact people for one supplier, alphabetical. A house holds a handful of
 * people, so this list is deliberately unpaginated.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @returns {Promise<object[]>}
 */
export const listSupplierContacts = async (pool, supplierId) => {
  const { rows } = await pool.query(
    `SELECT ${CONTACT_COLUMNS} FROM supplier_contacts
      WHERE supplier_id = $1
      ORDER BY name ASC, id ASC`,
    [supplierId]
  )
  return rows.map(toContact)
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {{ name: string, role?: string|null, email?: string|null,
 *           phone?: string|null, note?: string|null }} input
 * @returns {Promise<object>}
 */
export const createSupplierContact = async (pool, supplierId, input) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO supplier_contacts (supplier_id, name, role, email, phone, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${CONTACT_COLUMNS}`,
      [
        supplierId,
        input.name,
        input.role ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.note ?? null,
      ]
    )
    return toContact(rows[0])
  } catch (error) {
    return rethrowMapped(error, supplierId)
  }
}

/**
 * Patch one contact from the frozen whitelist, scoped to its supplier in the
 * writing statement. 404 whether the contact is missing or belongs elsewhere.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {number} contactId
 * @param {object} input
 * @returns {Promise<object>}
 */
export const updateSupplierContact = async (pool, supplierId, contactId, input) => {
  const { sets, params } = buildUpdate(input, CONTACT_UPDATE_COLUMNS)
  const { rows } = await pool.query(
    `UPDATE supplier_contacts SET ${sets.join(', ')}, updated_at = now()
      WHERE id = $${params.length + 1} AND supplier_id = $${params.length + 2}
      RETURNING ${CONTACT_COLUMNS}`,
    [...params, contactId, supplierId]
  )
  if (rows.length === 0) {
    throw httpError(404, `Supplier ${supplierId} has no contact ${contactId}.`)
  }
  return toContact(rows[0])
}

/**
 * Delete one contact, same scoping. Returns whether a row went — nothing
 * references a contact, so this is a plain 204/404 rather than the lifecycle
 * registry (the admin-email-templates posture).
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {number} contactId
 * @returns {Promise<boolean>}
 */
export const deleteSupplierContact = async (pool, supplierId, contactId) => {
  const { rowCount } = await pool.query(
    'DELETE FROM supplier_contacts WHERE id = $1 AND supplier_id = $2',
    [contactId, supplierId]
  )
  return rowCount > 0
}

/**
 * Paginated contact log, newest first. `contacted_on DESC, id DESC` is the ONE
 * ordering spelling — the supplier list's last-contact probe uses the same one,
 * so "the newest entry" cannot mean two different rows on two screens.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ entries: object[], total: number }>}
 */
export const listContactLog = async (pool, supplierId, { page, limit } = {}) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const [countResult, { rows }] = await Promise.all([
    pool.query('SELECT count(*)::int AS total FROM supplier_contact_log WHERE supplier_id = $1', [
      supplierId,
    ]),
    pool.query(
      `SELECT ${LOG_COLUMNS} FROM supplier_contact_log
        WHERE supplier_id = $1
        ORDER BY contacted_on DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [supplierId, safeLimit, offset]
    ),
  ])

  return { entries: rows.map(toLogEntry), total: countResult.rows[0].total }
}

/**
 * Append one log entry as the signed-in staff member. `staff_user_id` is the
 * FK (SET NULL when the account goes); `staff_name` is the snapshot that keeps
 * the entry legible after — `user.name` falls back to the email because
 * users.name is nullable.
 *
 * An omitted `contacted_on` falls to the column's CURRENT_DATE default, so the
 * common case ("just spoke to them") needs no date typed.
 *
 * @param {import('pg').Pool} pool
 * @param {number} supplierId
 * @param {{ method: string, contacted_on?: string, note?: string|null,
 *           follow_up_on?: string|null }} input
 * @param {{ id: number, name?: string|null, email: string }} user
 * @returns {Promise<object>}
 */
export const createContactLogEntry = async (pool, supplierId, input, user) => {
  const columns = ['supplier_id', 'staff_user_id', 'staff_name', 'method', 'note', 'follow_up_on']
  const values = [
    supplierId,
    user.id,
    user.name ?? user.email,
    input.method,
    input.note ?? null,
    input.follow_up_on ?? null,
  ]
  if (input.contacted_on !== undefined) {
    columns.push('contacted_on')
    values.push(input.contacted_on)
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO supplier_contact_log (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
       RETURNING ${LOG_COLUMNS}`,
      values
    )
    return toLogEntry(rows[0])
  } catch (error) {
    return rethrowMapped(error, supplierId)
  }
}
