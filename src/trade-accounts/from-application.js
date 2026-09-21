// The client account a trade application asks for.
//
// A submitted form names a business and two people at it — the accounts
// contact and the design contact. Until Sept 2026 the submission created only
// the LOGIN and the paper record, so the business was on no roster until the
// office re-typed it into `trade_accounts` by hand. Now it lands here on the
// day: the company row (customer_type Trade, unapproved until the login is),
// its two named people in the contact book, and the login granted to it. The
// CRM reviews the application on the account row itself.
//
// Runs INSIDE submitTradeApplication's transaction, on its client, so a failed
// insert leaves no company without a form and no form without a company.

/**
 * Shape the form's business block into the company row's columns. The
 * form has no city/country split — the postal address is one text block —
 * so those stay null for the office to fill.
 */
export const accountFromApplication = (a) => ({
  company_name: a.business_name.trim(),
  customer_type: 'Trade',
  primary_contact_name: a.customer_full_name.trim(),
  email: a.primary_contact_email.trim().toLowerCase(),
  phone: a.mobile_phone.trim(),
  address: a.postal_address.trim(),
})

/** The two named people on the form, as contact-book rows. */
export const contactsFromApplication = (a) => [
  {
    name: a.accounts_contact_person.trim(),
    role: 'Accounts',
    email: a.accounts_email.trim().toLowerCase(),
    phone: a.landline_phone.trim(),
    note: `Accounts contact: ${a.accounts_contact_name.trim()}`,
  },
  {
    name: a.design_contact_name.trim(),
    role: 'Design',
    email: a.design_contact_email.trim().toLowerCase(),
    phone: a.design_contact_phone.trim(),
    note: null,
  },
]

/**
 * Raise the company, file its people and grant the login. Returns the new
 * trade_accounts id.
 *
 * @param {import('pg').PoolClient} db a client inside an open transaction
 * @param {{ userId: number, application: object }} input
 * @returns {Promise<number>}
 */
export const raiseAccountFromApplication = async (db, { userId, application }) => {
  const account = accountFromApplication(application)
  const { rows } = await db.query(
    `INSERT INTO trade_accounts
       (legacy_customer_name, customer_type, primary_contact_name, email, phone, address, linked_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      account.company_name,
      account.customer_type,
      account.primary_contact_name,
      account.email,
      account.phone,
      account.address,
      userId,
    ]
  )
  const accountId = rows[0].id
  await db.query(
    `INSERT INTO trade_account_users (trade_account_id, user_id) VALUES ($1, $2)`,
    [accountId, userId]
  )
  for (const contact of contactsFromApplication(application)) {
    await db.query(
      `INSERT INTO trade_account_contacts (trade_account_id, name, role, email, phone, note)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [accountId, contact.name, contact.role, contact.email, contact.phone, contact.note]
    )
  }
  return accountId
}
