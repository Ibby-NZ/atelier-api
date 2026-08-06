import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { updateUser, getUser } from '../src/users/admin-users.js'
import { DIRECTOR_BACKFILL_SQL } from '../migrations/1786680000000_reporting-finance-access.js'
import { PRODUCT_TYPES, ORDER_KINDS, ORDER_STATUSES } from '../src/reports/filters.js'

// Fixtures are prefix-namespaced and cleaned up by prefix, like every other suite
// here. These are plain INSERTs rather than /auth/register calls: register is
// rate-limited 10 per 15 min per IP and this file has no use for a session.
const PREFIX = 'w5-reporting-test'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertUser = (pool, { role, canViewFinance = false, tradeApproved = false }) =>
  pool
    .query(
      `INSERT INTO users (email, password_hash, name, role, trade_approved, can_view_finance)
       VALUES ($1, 'not-a-real-hash', $2, $3, $4, $5)
       RETURNING id`,
      [`${PREFIX}-${role}-${canViewFinance}@example.test`, `${PREFIX} ${role}`, role, tradeApproved, canViewFinance]
    )
    .then(({ rows }) => rows[0].id)

const financeFlagOf = (pool, id) =>
  pool
    .query('SELECT can_view_finance FROM users WHERE id = $1', [id])
    .then(({ rows }) => rows[0].can_view_finance)

const cleanup = (pool) => pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])

// The values a CHECK constraint accepts, read off its live definition — e.g.
// "CHECK ((kind = ANY (ARRAY['checkout'::text, ...])))".
const checkValues = (pool, constraint) =>
  pool
    .query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint]
    )
    .then(({ rows }) => {
      expect(rows).toHaveLength(1)
      return [...rows[0].def.matchAll(/'([^']+)'::text/g)].map((match) => match[1]).sort()
    })

describe('W5-US-002 — reporting index and finance access', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup(pool)
  })

  it('re-running the migrations is a no-op', async () => {
    const applied = await runMigrations(loadConfig().databaseUrl)
    expect(applied).toEqual([])
  })

  describe('the orders.created_at index', () => {
    it('exists, because the date range is every report’s primary scan', async () => {
      const { rows } = await pool.query(
        `SELECT indexdef FROM pg_indexes
          WHERE tablename = 'orders' AND indexname = 'orders_created_at_index'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].indexdef).toContain('btree (created_at)')
    })

    // The two indexes that were already there are the account and lifecycle
    // access paths; neither helps a range predicate. Asserted so a future
    // "tidy-up" that drops one of the three has to say which.
    it('sits alongside the user_id and status indexes rather than replacing them', async () => {
      const { rows } = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'orders' ORDER BY indexname`
      )
      const names = rows.map((row) => row.indexname)
      expect(names).toContain('orders_user_id_index')
      expect(names).toContain('orders_status_index')
      expect(names).toContain('orders_created_at_index')
    })
  })

  describe('users.can_view_finance', () => {
    // Finance visibility fails CLOSED: a nullable column would turn "nobody has
    // decided yet" into a value every reader has to interpret.
    it('is a boolean, NOT NULL, defaulting to false', async () => {
      const { rows } = await pool.query(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'can_view_finance'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      })
    })

    it('defaults a new account to no finance visibility', async () => {
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, 'not-a-real-hash', 'backoffice')
         RETURNING can_view_finance`,
        [`${PREFIX}-default@example.test`]
      )
      expect(rows[0].can_view_finance).toBe(false)
    })
  })

  describe('the director backfill', () => {
    // The migration's OWN exported statement, run against this suite's fixtures
    // — not a retyped copy that could drift from what actually ran.
    it('grants directors finance visibility and nobody else', async () => {
      const director = await insertUser(pool, { role: 'director' })
      const backoffice = await insertUser(pool, { role: 'backoffice' })
      const customer = await insertUser(pool, { role: 'customer' })

      await pool.query(DIRECTOR_BACKFILL_SQL)

      expect(await financeFlagOf(pool, director)).toBe(true)
      expect(await financeFlagOf(pool, backoffice)).toBe(false)
      expect(await financeFlagOf(pool, customer)).toBe(false)
    })

    it('is idempotent — a second run writes nothing', async () => {
      const director = await insertUser(pool, { role: 'director' })

      const first = await pool.query(DIRECTOR_BACKFILL_SQL)
      const second = await pool.query(DIRECTOR_BACKFILL_SQL)

      expect(first.rowCount).toBe(1)
      expect(second.rowCount).toBe(0)
      expect(await financeFlagOf(pool, director)).toBe(true)
    })
  })

  describe('the PATCH whitelist', () => {
    it('writes can_view_finance on a staff account', async () => {
      const id = await insertUser(pool, { role: 'backoffice' })

      const user = await updateUser(pool, id, { can_view_finance: true })

      expect(user.can_view_finance).toBe(true)
      expect(await financeFlagOf(pool, id)).toBe(true)
    })

    it('reads it back, so the office can see what it granted', async () => {
      const id = await insertUser(pool, { role: 'director', canViewFinance: true })

      expect(await getUser(pool, id)).toMatchObject({ can_view_finance: true })
    })

    // Same discipline as trade_approved: the flag only means anything on a staff
    // row, so a demotion revokes it rather than stranding a true nobody displays.
    it('clears it when the role moves off backoffice/director', async () => {
      const id = await insertUser(pool, { role: 'backoffice', canViewFinance: true })

      const user = await updateUser(pool, id, { role: 'customer' })

      expect(user.role).toBe('customer')
      expect(user.can_view_finance).toBe(false)
    })

    it('clears it on a move to trade as well as to customer', async () => {
      const id = await insertUser(pool, { role: 'director', canViewFinance: true })

      const user = await updateUser(pool, id, { role: 'trade' })

      expect(user.can_view_finance).toBe(false)
    })

    // The role is the stronger statement; the two together are a contradiction
    // rather than an instruction.
    it('makes an explicit can_view_finance: true lose against the same body’s role', async () => {
      const id = await insertUser(pool, { role: 'backoffice' })

      const user = await updateUser(pool, id, { role: 'customer', can_view_finance: true })

      expect(user.can_view_finance).toBe(false)
      expect(await financeFlagOf(pool, id)).toBe(false)
    })

    it('keeps it across a move between the two finance roles', async () => {
      const id = await insertUser(pool, { role: 'director', canViewFinance: true })

      const user = await updateUser(pool, id, { role: 'backoffice' })

      expect(user.role).toBe('backoffice')
      expect(user.can_view_finance).toBe(true)
    })

    it('leaves it alone when the body does not mention the role', async () => {
      const id = await insertUser(pool, { role: 'backoffice', canViewFinance: true })

      const user = await updateUser(pool, id, { name: `${PREFIX} renamed` })

      expect(user.can_view_finance).toBe(true)
    })
  })
})

// src/reports/filters.js is unit-tested purely in test/report-filters.test.js.
// The one thing that file CANNOT prove is that its enum copies still describe
// the database: a boundary copy exists so an unknown value is a 400 instead of a
// 500, and the cost of one is that the two can drift silently.
describe('W5-US-003 — the report filter vocabularies against the schema', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('accepts exactly the product types products_product_type_check allows', async () => {
    expect(await checkValues(pool, 'products_product_type_check')).toEqual([...PRODUCT_TYPES].sort())
  })

  it('accepts exactly the kinds orders_kind_check allows', async () => {
    expect(await checkValues(pool, 'orders_kind_check')).toEqual([...ORDER_KINDS].sort())
  })

  it('accepts exactly the statuses orders_status_check allows', async () => {
    expect(await checkValues(pool, 'orders_status_check')).toEqual([...ORDER_STATUSES].sort())
  })
})
