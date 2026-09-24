// The trade application review flow (24 Sep 2026), after the form is in:
//
//   application -> Liz is asked to approve it (notifyTradeApplicationReceived)
//   Liz decline -> the login is archived, the reason is kept on the form and
//                  the applicant is emailed it       (declineTradeLogin)
//   Liz approve -> users.trade_first_approved_at, and Jenette is asked for the
//                  final approval  (firstApproveTradeLogin + notifyTradeAccountToReview)
//   Jenette     -> PATCH /admin/users/:id { trade_approved: true }, refused
//                  until Liz has approved; the client gets the acceptance
//                  letter and the company is matched-or-created in Xero
//                  (linkCompanyToXero)
//   cancel      -> the company AND its logins are archived, and so is its
//                  Xero contact                       (setTradeAccountArchived)
//
// Each step belongs to ONE person, named by config (TRADE_APPROVER_EMAIL,
// TRADE_ACCOUNTS_EMAIL): the address a step's letter goes to is the only login
// allowed to take it (`mayReview`). Unset means any back-office login.
//
// The Xero half never fails the request that triggered it — the same posture
// as mark-paid's payment: the platform's decision stands, and the answer says
// in words what Xero did or why it did not.

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * May this signed-in staff login take the step that belongs to `reviewerEmail`?
 * Yes when no reviewer is configured; otherwise only that person.
 *
 * @param {{ email: string }} user
 * @param {string|null} reviewerEmail
 */
export const mayReview = (user, reviewerEmail) =>
  !reviewerEmail || user.email.trim().toLowerCase() === reviewerEmail.trim().toLowerCase()

/** The company a login is filed under, or null (trade_account_users is 1:1 on user). */
export const companyForLogin = async (db, userId) => {
  const { rows } = await db.query(
    `SELECT ta.id, ta.legacy_customer_name AS company_name
       FROM trade_accounts ta
       JOIN trade_account_users tau ON tau.trade_account_id = ta.id
      WHERE tau.user_id = $1`,
    [userId]
  )
  return rows[0] ?? null
}

const xeroReason = (error) => error?.message || 'Xero did not answer.'

/**
 * Match-or-create the company's Xero contact. Never throws.
 *
 * @returns {Promise<{ linked: true, xero_contact_id: string } | { linked: false, reason: string }>}
 */
export const linkCompanyToXero = async (xero, accountId) => {
  if (!xero) return { linked: false, reason: 'Xero is not set up on this server.' }
  try {
    const contactId = await xero.ensureTradeAccountContact(accountId)
    return contactId
      ? { linked: true, xero_contact_id: contactId }
      : { linked: false, reason: 'That account no longer exists.' }
  } catch (error) {
    return { linked: false, reason: xeroReason(error) }
  }
}

/**
 * Archive or reactivate a company's Xero contact. Null when there is no
 * contact to touch; never throws.
 *
 * @returns {Promise<null | { updated: true } | { updated: false, reason: string }>}
 */
export const setCompanyXeroArchived = async (xero, contactId, archived) => {
  if (!contactId) return null
  if (!xero) return { updated: false, reason: 'Xero is not set up on this server.' }
  try {
    await xero.setContactStatus(contactId, archived ? 'ARCHIVED' : 'ACTIVE')
    return { updated: true }
  } catch (error) {
    return { updated: false, reason: xeroReason(error) }
  }
}

/**
 * The approver's approval of a trade login awaiting review: stamp
 * `trade_first_approved_at`. It grants nothing — the login still cannot sign
 * in — it is what the final approval (the `trade_approved` flip) waits for.
 * Refuses anything but a live unapproved trade login, and a second stamp.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<true|null>} null for an unknown login
 */
export const firstApproveTradeLogin = async (pool, userId) => {
  const { rows } = await pool.query(
    `SELECT role, trade_approved, archived_at, trade_first_approved_at FROM users WHERE id = $1`,
    [userId]
  )
  const login = rows[0]
  if (!login) return null
  if (login.role !== 'trade' || login.trade_approved || login.archived_at) {
    throw httpError(422, 'Only a trade login awaiting review can be approved.')
  }
  // The WHERE re-checks the state, so two clicks racing stamp it once.
  const { rowCount } = await pool.query(
    `UPDATE users SET trade_first_approved_at = now()
      WHERE id = $1 AND trade_first_approved_at IS NULL AND NOT trade_approved AND archived_at IS NULL`,
    [userId]
  )
  if (rowCount === 0) {
    throw httpError(422, 'This application is already approved and waiting on the final approval.')
  }
  return true
}

/**
 * Decline a trade login awaiting review (at either step): archive it (the only durable "no" a
 * users row carries — it can no longer sign in, and Restore undoes it) and
 * keep the reason on its latest application, in one transaction. Refuses
 * anything that is not a live, unapproved trade login.
 *
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @param {string} reason already trimmed, non-empty
 * @returns {Promise<{ businessName: string|null } | null>} null for an unknown login
 */
export const declineTradeLogin = async (pool, userId, reason) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT role, trade_approved, archived_at FROM users WHERE id = $1 FOR UPDATE`,
      [userId]
    )
    const login = rows[0]
    if (!login) {
      await client.query('ROLLBACK')
      return null
    }
    if (login.role !== 'trade' || login.trade_approved || login.archived_at) {
      throw httpError(422, 'Only a trade login awaiting review can be declined.')
    }
    // A restored login starts the review again, so the approver's stamp goes.
    await client.query(
      `UPDATE users SET archived_at = now(), trade_first_approved_at = NULL WHERE id = $1`,
      [userId]
    )
    const { rows: forms } = await client.query(
      `UPDATE trade_applications
          SET declined_at = now(), decline_reason = $2
        WHERE id = (SELECT id FROM trade_applications WHERE user_id = $1
                     ORDER BY created_at DESC, id DESC LIMIT 1)
        RETURNING business_name`,
      [userId, reason]
    )
    await client.query('COMMIT')
    return { businessName: forms[0]?.business_name ?? null }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Cancel (`archived`) or restore a client company. Archiving also archives
 * every live client login filed under it, in the same transaction, so nobody
 * at a cancelled client can sign in or see trade pricing a moment longer.
 * Restore brings the company back only: its logins are restored one by one
 * from the account page, because some may have been archived for their own
 * reasons before the cancellation.
 *
 * @param {import('pg').Pool} pool
 * @param {number} id
 * @param {boolean} archived trusted code argument, never user input
 * @returns {Promise<{ xeroContactId: string|null } | null>} null for an unknown id
 */
export const setTradeAccountArchived = async (pool, id, archived) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE trade_accounts
          SET archived_at = ${archived ? 'COALESCE(archived_at, now())' : 'NULL'}, updated_at = now()
        WHERE id = $1
        RETURNING xero_contact_id`,
      [id]
    )
    if (!rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (archived) {
      // Client logins only: a staff row filed here by mistake is not the
      // office's to lock out by cancelling a client.
      await client.query(
        `UPDATE users SET archived_at = now()
          WHERE archived_at IS NULL
            AND role IN ('customer', 'trade')
            AND id IN (SELECT user_id FROM trade_account_users WHERE trade_account_id = $1)`,
        [id]
      )
    }
    await client.query('COMMIT')
    return { xeroContactId: rows[0].xero_contact_id ?? null }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
