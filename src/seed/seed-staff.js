// Seed back-office staff logins so the CRM (which now authenticates against the
// API) has real accounts to sign in with. The Dynamics export carries the staff
// as sales-order/customer "Owner" names but no passwords, so we create each with
// a shared TEMP password they change on first login.
//
// Idempotent: upsert on email, updating name/role but NEVER the password — so a
// re-run can't clobber a password a staff member has already changed.
//
// Roles map the demo's director/finance/user onto the API's backoffice/director:
// the two principals are directors; the rest are backoffice (director inherits
// backoffice, so directors keep full access). Trade/customer accounts are for the
// storefront, never seeded here.

import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { hashPassword } from '../auth/passwords.js'
import { PUBLIC_USER_COLUMNS } from '../auth/user-columns.js'

// Exported for the test suite — the roster and password must keep mirroring
// the CRM's Login screen (atelier-crm src/screens/Login.jsx).
export const TEMP_PASSWORD = process.env.STAFF_TEMP_PASSWORD ?? 'AtelierTemp2026!'

export const STAFF = [
  { email: 'liz@ateliertextiles.co.nz', name: 'Liz', role: 'director' },
  { email: 'jenette@ateliertextiles.co.nz', name: 'Jenette', role: 'director' },
  { email: 'charlotte@ateliertextiles.co.nz', name: 'Charlotte', role: 'backoffice' },
  { email: 'rebecca@ateliertextiles.co.nz', name: 'Rebecca', role: 'backoffice' },
  { email: 'showroom@ateliertextiles.co.nz', name: 'Showroom', role: 'backoffice' },
]

export const seedStaff = async (pool) => {
  const passwordHash = await hashPassword(TEMP_PASSWORD)
  const results = []
  for (const person of STAFF) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING ${PUBLIC_USER_COLUMNS}, (xmax = 0) AS inserted`,
      [person.email.toLowerCase(), passwordHash, person.name, person.role]
    )
    results.push(rows[0])
  }
  return results
}

const main = async () => {
  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  try {
    const rows = await seedStaff(pool)
    for (const r of rows) {
      console.log(`  ${r.inserted ? 'created' : 'updated'}  ${r.email}  (${r.role})`)
    }
    console.log(
      `Staff seed complete — ${rows.length} accounts. Temp password: ${TEMP_PASSWORD} (change on first login).`
    )
  } catch (error) {
    console.error(`atelier-api staff seed failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

// Run when invoked directly (node src/seed/seed-staff.js), not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
