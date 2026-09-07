// Seed back-office staff logins so the CRM (which now authenticates against the
// API) has real accounts to sign in with. The Dynamics export carries the staff
// as sales-order/customer "Owner" names but no passwords, so we create each with
// a shared TEMP password they change on first login.
//
// Idempotent: upsert on email, updating name/role but NEVER the password — so a
// re-run can't clobber a password a staff member has already changed.
//
// The conflict target is EMAIL, so a changed address in the roster would INSERT
// a second account and leave the old login answering beside the new one. A
// roster entry therefore names the address it replaced (`previously`), and the
// seed RENAMES that live row before the upsert — the person keeps their password
// and every order / sales-rep reference. The move to atelier.co.nz shipped as a
// roster change with the rename left as a manual UPDATE, and the UPDATE never
// ran: the CRM tiles carried the new addresses while the database only knew the
// old ones. `npm run seed:staff` is the whole fix now.
//
// Roles map the demo's director/finance/user onto the API's backoffice/director:
// the two principals are directors; the rest are backoffice (director inherits
// backoffice, so directors keep full access). Trade/customer accounts are for the
// storefront, never seeded here.

import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'
import { hashPassword } from '../auth/passwords.js'
import { PUBLIC_USER_COLUMNS } from '../auth/user-columns.js'

// Exported for the test suite — the roster and password must keep mirroring
// the CRM's Login screen (atelier-crm src/screens/Login.jsx).
export const TEMP_PASSWORD = process.env.STAFF_TEMP_PASSWORD ?? 'AtelierTemp2026!'

export const STAFF = [
  { email: 'elizabethd@atelier.co.nz', previously: 'liz@ateliertextiles.co.nz', name: 'Liz', role: 'director' },
  { email: 'jenettec@atelier.co.nz', previously: 'jenette@ateliertextiles.co.nz', name: 'Jenette', role: 'director' },
  { email: 'charlottes@atelier.co.nz', previously: 'charlotte@ateliertextiles.co.nz', name: 'Charlotte', role: 'backoffice' },
  { email: 'rebeccaf@atelier.co.nz', previously: 'rebecca@ateliertextiles.co.nz', name: 'Rebecca', role: 'backoffice' },
  { email: 'showroom@ateliertextiles.co.nz', name: 'Showroom', role: 'backoffice' },
  { email: 'sales@atelier.co.nz', name: 'Sales', role: 'backoffice' },
]

// Moves the live row from the address the roster replaced to the current one.
// If the current address already exists (a seed re-run beat the rename), the
// old row is archived instead so only one login answers — it is not deleted,
// because orders may reference it. Returns what happened, for the CLI report.
const renameStaff = async (pool, person) => {
  if (!person.previously) return null
  const email = person.email.toLowerCase()
  const previously = person.previously.toLowerCase()
  const renamed = await pool.query(
    `UPDATE users SET email = $1
     WHERE email = $2 AND NOT EXISTS (SELECT 1 FROM users WHERE email = $1)`,
    [email, previously]
  )
  if (renamed.rowCount > 0) return 'renamed'
  const archived = await pool.query(
    'UPDATE users SET archived_at = now() WHERE email = $1 AND archived_at IS NULL',
    [previously]
  )
  return archived.rowCount > 0 ? 'archived_old' : null
}

export const seedStaff = async (pool) => {
  const passwordHash = await hashPassword(TEMP_PASSWORD)
  const results = []
  for (const person of STAFF) {
    const moved = await renameStaff(pool, person)
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role
       RETURNING ${PUBLIC_USER_COLUMNS}, (xmax = 0) AS inserted`,
      [person.email.toLowerCase(), passwordHash, person.name, person.role]
    )
    results.push({ ...rows[0], moved, previously: person.previously ?? null })
  }
  return results
}

const describeResult = (r) => {
  if (r.moved === 'renamed') return `renamed  ${r.previously} -> ${r.email}  (${r.role})`
  if (r.moved === 'archived_old') return `updated  ${r.email}  (${r.role}); archived duplicate ${r.previously}`
  return `${r.inserted ? 'created' : 'updated'}  ${r.email}  (${r.role})`
}

const main = async () => {
  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  try {
    const rows = await seedStaff(pool)
    for (const r of rows) console.log(`  ${describeResult(r)}`)
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

// Run when invoked directly (node src/seed/seed-staff.js), not when imported by
// tests. `file://${process.argv[1]}` is the wrong spelling: import.meta.url is
// percent-encoded and argv[1] is not, so one space in the checkout path makes
// this false and `npm run seed:staff` exits 0 having seeded nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
