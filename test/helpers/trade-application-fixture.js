// A complete, valid trade-application form body (the atelier.co.nz
// trade-account-application fields). Tests that only need a trade *account*
// spread this in; the trade-applications suite overrides fields to probe
// validation.
export const sampleTradeApplication = (overrides = {}) => ({
  business_name: 'Studio Interiors Ltd',
  registered_name: 'Studio Interiors (2019) Ltd',
  postal_address: 'PO Box 100, Auckland 1010',
  delivery_address: '5 Ponsonby Road, Auckland 1011',
  landline_phone: '09 555 0100',
  mobile_phone: '021 555 0100',
  accounts_contact_name: 'Studio Interiors Accounts',
  accounts_contact_person: 'Pat Ledger',
  accounts_email: 'accounts@studio-interiors.example.com',
  design_contact_name: 'Alex Designer',
  design_contact_email: 'alex@studio-interiors.example.com',
  design_contact_phone: '021 555 0101',
  design_qualifications: 'NZ Diploma in Interior Design',
  mailchimp_opt_in: true,
  primary_contact_email: 'hello@studio-interiors.example.com',
  wants_showroom_visit: true,
  wants_account_manager: false,
  nzbn: '9429000000000',
  business_type: 'limited_liability_company',
  registered_office_address: '5 Ponsonby Road, Auckland 1011',
  directors_names_addresses: 'Alex Designer, 12 Home Street, Auckland',
  directors_dates_of_birth: '01/02/1980',
  cash_account_acceptable: true,
  trade_reference: 'Fabric House / Sam Vendor / 09 555 0200',
  terms_accepted: true,
  customer_full_name: 'Studio Interiors Ltd — Alex Designer',
  signatory_name: 'Alex Designer',
  signatory_position: 'Director',
  signature: 'Alex Designer',
  ...overrides,
})

/**
 * Remove what a test's trade applications left behind, for every user whose
 * email matches `emailLike` — the company each form raised (its contacts and
 * login grant cascade) and the form itself. Call BEFORE deleting the users:
 * both FKs are SET NULL, so deleting users first orphans the rows for ever.
 *
 * @param {import('pg').Pool} pool
 * @param {string} emailLike a SQL LIKE pattern, e.g. `%@test.example.com`
 */
export const cleanupTradeApplications = async (pool, emailLike) => {
  await pool.query(
    `DELETE FROM trade_accounts WHERE id IN
       (SELECT trade_account_id FROM trade_applications
         WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1))`,
    [emailLike]
  )
  await pool.query(
    `DELETE FROM trade_applications
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [emailLike]
  )
}
