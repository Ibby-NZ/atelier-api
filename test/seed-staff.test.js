import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { seedStaff, STAFF, TEMP_PASSWORD } from '../src/seed/seed-staff.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'

// Old addresses too: the rename tests plant rows under them.
const STAFF_EMAILS = STAFF.flatMap((s) => [s.email, s.previously].filter(Boolean))

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
    expect(byEmail['elizabethd@atelier.co.nz'].role).toBe('director')
    expect(byEmail['jenettec@atelier.co.nz'].role).toBe('director')
    expect(byEmail['charlottes@atelier.co.nz'].role).toBe('backoffice')
    expect(byEmail['rebeccaf@atelier.co.nz'].role).toBe('backoffice')
    expect(byEmail['showroom@ateliertextiles.co.nz'].role).toBe('backoffice')
    expect(byEmail['sales@atelier.co.nz'].role).toBe('backoffice')
  })

  it('lets a seeded director log in with the temp password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'elizabethd@atelier.co.nz', password: TEMP_PASSWORD },
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
      [changedHash, 'charlottes@atelier.co.nz']
    )

    const results = await seedStaff(pool)
    expect(results.every((r) => !r.inserted)).toBe(true)

    const { rows } = await pool.query(
      'SELECT password_hash, role FROM users WHERE email = $1',
      ['charlottes@atelier.co.nz']
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

  it('renames a live row still under the old address, keeping its password', async () => {
    await deleteStaffUsers(pool)
    // The state production was left in: the person exists under the address the
    // roster replaced, with a password of their own, and orders point at the row.
    const oldHash = 'argon2-placeholder-set-before-the-rename'
    const { rows: planted } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Jenette', 'director')
       RETURNING id`,
      ['jenette@ateliertextiles.co.nz', oldHash]
    )

    const results = await seedStaff(pool)
    const jenette = results.find((r) => r.email === 'jenettec@atelier.co.nz')
    expect(jenette.moved).toBe('renamed')
    expect(jenette.inserted).toBe(false)

    const { rows } = await pool.query(
      'SELECT id, password_hash, archived_at FROM users WHERE email = $1',
      ['jenettec@atelier.co.nz']
    )
    // Same row (references survive), same password, still active.
    expect(rows[0].id).toBe(planted[0].id)
    expect(rows[0].password_hash).toBe(oldHash)
    expect(rows[0].archived_at).toBeNull()
    const { rows: old } = await pool.query('SELECT 1 FROM users WHERE email = $1', [
      'jenette@ateliertextiles.co.nz',
    ])
    expect(old).toHaveLength(0)
  })

  it('archives the old address when the new one already exists', async () => {
    await deleteStaffUsers(pool)
    // A seed re-run that beat the rename: both rows exist, both answer a login.
    await seedStaff(pool)
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role) VALUES ($1, 'x', 'Liz', 'director')`,
      ['liz@ateliertextiles.co.nz']
    )

    const results = await seedStaff(pool)
    expect(results.find((r) => r.email === 'elizabethd@atelier.co.nz').moved).toBe('archived_old')

    const { rows } = await pool.query(
      'SELECT email, archived_at FROM users WHERE email = ANY($1::text[]) ORDER BY email',
      [['liz@ateliertextiles.co.nz', 'elizabethd@atelier.co.nz']]
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].email).toBe('elizabethd@atelier.co.nz')
    expect(rows[0].archived_at).toBeNull()
    expect(rows[1].archived_at).not.toBeNull()
  })

  it('is a no-op once every row carries its current address', async () => {
    const results = await seedStaff(pool)
    expect(results.every((r) => r.moved === null && !r.inserted)).toBe(true)
  })
})
