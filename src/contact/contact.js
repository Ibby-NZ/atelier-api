// Contact enquiries (storefront contact form).
//
// The live atelier.co.nz has a working contact form; ours was static text. A
// submission is both stored here (so nothing is lost) and emailed to the back
// office by the route. Business rules live here; the route stays thin.
//
// Validation mirrors the order-request split: the Fastify schema is structural
// (required fields, max lengths -> 400 on gross violations) and these checks
// add the field-level 422s the storefront renders inline — a valid email and
// non-whitespace name/message.

import { setArchived } from '../lifecycle/archive.js'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// Columns returned to the back-office inbox — the whole row is safe to expose
// to staff (no secrets), so this is the single SELECT list for reads.
const ENQUIRY_COLUMNS =
  'id, name, email, phone, subject, message, source, user_id, created_at, archived_at'

const isBlank = (value) =>
  typeof value !== 'string' || value.trim().length === 0

/**
 * Field-level validation returning 422 messages (schema violations are 400).
 *
 * @param {{ name?: string, email?: string, message?: string }} body
 * @returns {Array<{ field: string, message: string }>} empty when valid
 */
export const validateContactInput = (body) => {
  const errors = []

  if (isBlank(body.name)) {
    errors.push({ field: 'name', message: 'Please tell us your name.' })
  }
  if (isBlank(body.email)) {
    errors.push({ field: 'email', message: 'A valid email is required.' })
  } else if (!EMAIL_RE.test(body.email)) {
    errors.push({ field: 'email', message: 'A valid email is required.' })
  }
  if (isBlank(body.message)) {
    errors.push({ field: 'message', message: 'Please include a message.' })
  }

  return errors
}

// Trim to null so blank optional fields never store empty strings.
const trimToNull = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * Persist an enquiry. Returns the stored row (used for the back-office email).
 *
 * @param {{ query: Function }} db  pool or open client
 * @param {{ name: string, email: string, phone?: string, subject?: string,
 *           message: string, source?: string, userId?: number|null }} input
 */
export const createEnquiry = async (db, input) => {
  const { rows } = await db.query(
    `INSERT INTO contact_enquiries (name, email, phone, subject, message, source, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ENQUIRY_COLUMNS}`,
    [
      input.name.trim(),
      input.email.trim().toLowerCase(),
      trimToNull(input.phone),
      trimToNull(input.subject),
      input.message.trim(),
      input.source ?? 'contact_form',
      input.userId ?? null,
    ]
  )
  return rows[0]
}

/**
 * Back-office inbox: newest first. Archived enquiries are hidden unless
 * includeArchived is set (the "Archived" filter in the admin island).
 *
 * @param {{ query: Function }} db
 * @param {{ includeArchived?: boolean }} [options]
 */
export const listEnquiries = async (db, { includeArchived = false } = {}) => {
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL'
  const { rows } = await db.query(
    `SELECT ${ENQUIRY_COLUMNS}
       FROM contact_enquiries
       ${where}
      ORDER BY created_at DESC, id DESC`
  )
  return rows
}

/**
 * Archive (soft-delete) or restore an enquiry. Returns the updated row, or null
 * when no enquiry has that id.
 *
 * @param {{ query: Function }} db
 * @param {number} id
 * @param {boolean} archived  true -> archive (set now()), false -> restore (null)
 */
export const setEnquiryArchived = (db, id, archived) =>
  setArchived(db, 'contact_enquiry', id, archived, { returning: ENQUIRY_COLUMNS })
