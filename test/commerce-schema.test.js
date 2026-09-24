import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'

const COMMERCE_TABLES = ['users', 'orders', 'order_lines', 'shipping_rates']

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

describe('users/orders/shipping schema migration', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('creates all four commerce tables', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [COMMERCE_TABLES]
    )
    expect(rows.map((row) => row.table_name).sort()).toEqual([...COMMERCE_TABLES].sort())
  })

  it('is a no-op when migrations run again', async () => {
    const config = loadConfig()
    const applied = await runMigrations(config.databaseUrl)
    expect(applied).toEqual([])
  })

  it('rejects an order status outside the allowed lifecycle', async () => {
    await expect(
      pool.query(
        `INSERT INTO orders (order_number, kind, status)
         VALUES ('CHK-0001', 'checkout', 'declined')`
      )
    ).rejects.toThrow(/orders_status_check/)
  })

  it('rejects a role outside customer/trade/backoffice/director', async () => {
    await expect(
      pool.query(
        `INSERT INTO users (email, password_hash, role)
         VALUES ('bad-role@example.com', 'x', 'admin')`
      )
    ).rejects.toThrow(/users_role_check/)
  })
})
