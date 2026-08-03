// Trade account applications.
//
// The storefront trade form mirrors atelier.co.nz/trade-account-application/:
// alongside the login credentials it collects the business, contact, trading
// and consent details the back office needs to open a trade account. Submitting
// creates the users row (role='trade', unapproved — same as before) AND stores
// the form here, in one transaction, so the CRM's Applicants tab can review the
// whole application instead of a bare approve checkbox.
//
// Approval state is deliberately NOT stored on this table: users.trade_approved
// stays the single source of truth (flipped via PATCH /admin/users/:id), so the
// admin reads join users for it rather than keeping a copy that could desync.
//
// Validation mirrors the order-request split: the Fastify schema is structural
// (types, max lengths -> 400) and these checks add the field-level 422s the
// storefront renders inline, with paths like `application.business_name`.

import { PUBLIC_USER_COLUMNS } from '../auth/user-columns.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

const PG_UNIQUE_VIOLATION = '23505'
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export const BUSINESS_TYPES = Object.freeze([
  'limited_liability_company',
  'sole_trader',
  'partnership',
])

// Required free-text fields, in form order, with the message shown when blank.
const REQUIRED_TEXT_FIELDS = Object.freeze([
  ['business_name', 'Business name is required.'],
  ['postal_address', 'Postal address is required.'],
  ['delivery_address', 'Delivery address is required.'],
  ['landline_phone', 'A landline phone number is required.'],
  ['mobile_phone', 'A mobile phone number is required.'],
  ['accounts_contact_name', 'Accounts contact name is required.'],
  ['accounts_contact_person', 'Accounts contact person is required.'],
  ['design_contact_name', 'Design contact name is required.'],
  ['design_contact_phone', 'Design contact phone number is required.'],
  ['design_qualifications', 'Design qualifications are required.'],
  ['nzbn', 'An NZBN is required.'],
  ['registered_office_address', 'The registered office address is required.'],
  ['directors_names_addresses', 'Director/proprietor names and addresses are required.'],
  ['directors_dates_of_birth', 'Director/proprietor dates of birth are required.'],
  ['trade_reference', 'A trade reference is required.'],
  ['customer_full_name', 'The full business and contact name is required.'],
  ['signatory_name', 'The signatory name is required.'],
  ['signatory_position', 'The signatory position/title is required.'],
  ['signature', 'A signature is required.'],
])

const REQUIRED_EMAIL_FIELDS = Object.freeze([
  ['accounts_email', 'A valid accounts email address is required.'],
  ['design_contact_email', 'A valid design contact email is required.'],
  ['primary_contact_email', 'A valid primary contact email is required.'],
])

// Yes/no questions on the form: absent is not the same as "No", so the client
// must send an explicit boolean.
const REQUIRED_BOOLEAN_FIELDS = Object.freeze([
  ['mailchimp_opt_in', 'Please choose whether to receive notifications.'],
  ['cash_account_acceptable', 'Please answer whether a cash account is acceptable.'],
])

const isBlank = (value) =>
  typeof value !== 'string' || value.trim().length === 0

/**
 * Field-level validation returning 422 messages (schema violations are 400).
 * Paths are prefixed `application.` to match the request body shape.
 *
 * @param {object} application
 * @returns {Array<{ field: string, message: string }>} empty when valid
 */
export const validateTradeApplication = (application) => {
  const errors = []
  const push = (field, message) =>
    errors.push({ field: `application.${field}`, message })

  for (const [field, message] of REQUIRED_TEXT_FIELDS) {
    if (isBlank(application[field])) push(field, message)
  }
  for (const [field, message] of REQUIRED_EMAIL_FIELDS) {
    if (isBlank(application[field]) || !EMAIL_RE.test(application[field].trim())) {
      push(field, message)
    }
  }
  for (const [field, message] of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof application[field] !== 'boolean') push(field, message)
  }
  if (!BUSINESS_TYPES.includes(application.business_type)) {
    push('business_type', 'Please choose the type of business.')
  }
  if (application.terms_accepted !== true) {
    push('terms_accepted', 'You must accept the Terms of Trade.')
  }

  return errors
}

// Trim to null so a blank optional field never stores an empty string.
const trimToNull = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

// Insert column order; values() must stay in lockstep.
const APPLICATION_INSERT_COLUMNS = Object.freeze([
  'user_id',
  'business_name',
  'registered_name',
  'postal_address',
  'delivery_address',
  'landline_phone',
  'mobile_phone',
  'accounts_contact_name',
  'accounts_contact_person',
  'accounts_email',
  'design_contact_name',
  'design_contact_email',
  'design_contact_phone',
  'design_qualifications',
  'mailchimp_opt_in',
  'primary_contact_email',
  'wants_showroom_visit',
  'wants_account_manager',
  'nzbn',
  'business_type',
  'registered_office_address',
  'directors_names_addresses',
  'directors_dates_of_birth',
  'cash_account_acceptable',
  'trade_reference',
  'terms_accepted',
  'customer_full_name',
  'signatory_name',
  'signatory_position',
  'signature',
])

const applicationValues = (userId, a) => [
  userId,
  a.business_name.trim(),
  trimToNull(a.registered_name),
  a.postal_address.trim(),
  a.delivery_address.trim(),
  a.landline_phone.trim(),
  a.mobile_phone.trim(),
  a.accounts_contact_name.trim(),
  a.accounts_contact_person.trim(),
  a.accounts_email.trim().toLowerCase(),
  a.design_contact_name.trim(),
  a.design_contact_email.trim().toLowerCase(),
  a.design_contact_phone.trim(),
  a.design_qualifications.trim(),
  a.mailchimp_opt_in,
  a.primary_contact_email.trim().toLowerCase(),
  a.wants_showroom_visit === true,
  a.wants_account_manager === true,
  a.nzbn.trim(),
  a.business_type,
  a.registered_office_address.trim(),
  a.directors_names_addresses.trim(),
  a.directors_dates_of_birth.trim(),
  a.cash_account_acceptable,
  a.trade_reference.trim(),
  a.terms_accepted,
  a.customer_full_name.trim(),
  a.signatory_name.trim(),
  a.signatory_position.trim(),
  a.signature.trim(),
]

const APPLICATION_READ_COLUMNS = ['id', ...APPLICATION_INSERT_COLUMNS, 'created_at']
  .map((column) => `ta.${column}`)
  .join(', ')

/**
 * Create the trade account AND store the application in one transaction: a
 * duplicate email (409) leaves no orphan application, and a failed insert
 * leaves no account without a form. Returns the public user row for the 201.
 *
 * @param {import('pg').Pool} pool
 * @param {{ email: string, passwordHash: string, name?: string|null, application: object }} input
 * @returns {Promise<object>} public user row
 */
export const submitTradeApplication = async (pool, { email, passwordHash, name, application }) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, 'trade')
       RETURNING ${PUBLIC_USER_COLUMNS}`,
      [email.toLowerCase(), passwordHash, name ?? null]
    )
    const user = rows[0]

    const placeholders = APPLICATION_INSERT_COLUMNS.map((_, i) => `$${i + 1}`)
    await client.query(
      `INSERT INTO trade_applications (${APPLICATION_INSERT_COLUMNS.join(', ')})
       VALUES (${placeholders.join(', ')})`,
      applicationValues(user.id, application)
    )

    await client.query('COMMIT')
    return user
  } catch (error) {
    await client.query('ROLLBACK')
    if (error.code === PG_UNIQUE_VIOLATION) {
      throw httpError(409, 'An account with that email already exists.')
    }
    throw error
  } finally {
    client.release()
  }
}

// The applicant's live account state rides along so the CRM can show pending vs
// approved (and spot an archived account) without a second request.
const toTradeApplication = (row) => {
  const { user_id: userId } = row
  const application = { id: row.id, user_id: userId }
  for (const column of APPLICATION_INSERT_COLUMNS.slice(1)) {
    application[column] = row[column]
  }
  application.created_at = row.created_at
  application.user =
    userId == null
      ? null
      : Object.freeze({
          id: userId,
          email: row.user_email,
          name: row.user_name,
          trade_approved: row.user_trade_approved,
          archived_at: row.user_archived_at,
        })
  return Object.freeze(application)
}

const APPLICATION_SELECT = `
  SELECT ${APPLICATION_READ_COLUMNS},
         u.email AS user_email,
         u.name AS user_name,
         u.trade_approved AS user_trade_approved,
         u.archived_at AS user_archived_at
    FROM trade_applications ta
    LEFT JOIN users u ON u.id = ta.user_id`

/**
 * All applications, newest first, each with the applicant's account state.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<object[]>}
 */
export const listTradeApplications = async (pool) => {
  const { rows } = await pool.query(
    `${APPLICATION_SELECT} ORDER BY ta.created_at DESC, ta.id DESC`
  )
  return rows.map(toTradeApplication)
}

/**
 * A single application by id, or null when it doesn't exist.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export const getTradeApplication = async (pool, id) => {
  const { rows } = await pool.query(`${APPLICATION_SELECT} WHERE ta.id = $1`, [id])
  return rows[0] ? toTradeApplication(rows[0]) : null
}
