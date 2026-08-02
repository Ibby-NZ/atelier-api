import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { seedStaff, STAFF, TEMP_PASSWORD } from '../src/seed/seed-staff.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'

const STAFF_EMAILS = STAFF.map((s) => s.email)

const deleteStaffUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [STAFF_EMAILS])

describe('seed:staff', () => {
  let pool
  let app

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
    await deleteStaffUsers(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await deleteStaffUsers(pool)
    await app.close()
    await pool.end()
  })

  it('creates every staff account with its back-office role', async () => {
    const results = await seedStaff(pool)
    expect(results).toHaveLength(STAFF.length)
    expect(results.every((r) => r.inserted)).toBe(true)
    // password_hash must never leak through PUBLIC_USER_COLUMNS.
    expect(results.every((r) => r.password_hash === undefined)).toBe(true)

    const byEmail = Object.fromEntries(results.map((r) => [r.email, r]))
    expect(byEmail['liz@ateliertextiles.co.nz'].role).toBe('director')
    expect(byEmail['jenette@ateliertextiles.co.nz'].role).toBe('director')
    expect(byEmail['charlotte@ateliertextiles.co.nz'].role).toBe('backoffice')
    expect(byEmail['rebecca@ateliertextiles.co.nz'].role).toBe('backoffice')
    expect(byEmail['showroom@ateliertextiles.co.nz'].role).toBe('backoffice')
  })

  it('lets a seeded director log in with the temp password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'liz@ateliertextiles.co.nz', password: TEMP_PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.user.role).toBe('director')
    expect(body.user.password_hash).toBeUndefined()
  })

  it('re-run refreshes name/role but never a changed password', async () => {
    // Simulate a password changed after first sign-in, and a drifted role.
    const changedHash = 'argon2-placeholder-changed-after-first-login'
    await pool.query(
      "UPDATE users SET password_hash = $1, role = 'customer' WHERE email = $2",
      [changedHash, 'charlotte@ateliertextiles.co.nz']
    )

    const results = await seedStaff(pool)
    expect(results.every((r) => !r.inserted)).toBe(true)

    const { rows } = await pool.query(
      'SELECT password_hash, role FROM users WHERE email = $1',
      ['charlotte@ateliertextiles.co.nz']
    )
    // Role is re-asserted by the upsert; the changed password survives.
    expect(rows[0].role).toBe('backoffice')
    expect(rows[0].password_hash).toBe(changedHash)

    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int AS n FROM users WHERE email = ANY($1::text[])',
      [STAFF_EMAILS]
    )
    expect(countRows[0].n).toBe(STAFF.length)
  })
})
