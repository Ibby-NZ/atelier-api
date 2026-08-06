import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { setArchived } from '../src/lifecycle/archive.js'
import { deleteOrExplain } from '../src/lifecycle/delete.js'
import { LIFECYCLE_ENTITIES } from '../src/lifecycle/registry.js'

// The shared archive write (W1-US-002). The eight callers' own behaviour is
// already covered by test/admin-archive.test.js, test/admin-users.test.js,
// test/admin-price-lists.test.js and test/contact.test.js — those passing
// untouched is the proof this was a move rather than a rewrite. What is new here
// is the helper's own contract and the registry rules it depends on.

const PREFIX = 'lc-arch-test'

describe('setArchived', () => {
  let pool
  let brandId

  const cleanup = () =>
    pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

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
    await cleanup()
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only)
       VALUES ('Archive House', $1, 'New Zealand', 'NZD', false, false) RETURNING id`,
      [`${PREFIX}-house`]
    )
    brandId = rows[0].id
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  const archivedAt = async () => {
    const { rows } = await pool.query('SELECT archived_at FROM brands WHERE id = $1', [brandId])
    return rows[0].archived_at
  }

  it('stamps and clears archived_at, projecting what the caller asked for', async () => {
    const stamped = await setArchived(pool, 'brand', brandId, true, {
      returning: 'id, name, archived_at',
    })
    expect(stamped.name).toBe('Archive House')
    expect(stamped.archived_at).toBeTruthy()
    expect(await archivedAt()).toBeTruthy()

    const cleared = await setArchived(pool, 'brand', brandId, false, {
      returning: 'id, archived_at',
    })
    expect(cleared.archived_at).toBeNull()
    expect(await archivedAt()).toBeNull()
  })

  it('returns null for an unknown id, leaving the 404 to the caller', async () => {
    expect(await setArchived(pool, 'brand', 2147483000, true)).toBeNull()
  })

  it('accepts an open client, so a caller can join it to its own transaction', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await setArchived(client, 'brand', brandId, true)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    // Rolled back with the caller's transaction: the write was inside it.
    expect(await archivedAt()).toBeNull()
  })

  it('refuses an entity whose table has no archived_at column', async () => {
    // A wiring mistake, not a request outcome — so it throws rather than
    // answering a status. Both of these are registry entries with archivable:false.
    expect(LIFECYCLE_ENTITIES.inventory.archivable).toBe(false)
    expect(LIFECYCLE_ENTITIES.shipping_rate.archivable).toBe(false)
    await expect(setArchived(pool, 'inventory', 1, true)).rejects.toThrow(
      /"inventory" is not archivable/
    )
  })

  it('refuses an unknown entity name', async () => {
    await expect(setArchived(pool, 'legacy_accounts', 1, true)).rejects.toThrow(
      /Unknown lifecycle entity/
    )
  })
})

describe('never-hard-deletable entities', () => {
  it('an order is archivable but can never reach deleteOrExplain', async () => {
    expect(LIFECYCLE_ENTITIES.order.archivable).toBe(true)
    expect(LIFECYCLE_ENTITIES.order.deletable).toBe(false)

    // CASCADE would take the lines, the delete would not release qty_reserved,
    // and the row carries xero_invoice_ref / stripe_session_id. No pool is
    // touched: the refusal happens before anything connects.
    await expect(deleteOrExplain(null, 'order', 1)).rejects.toThrow(
      /"order" is never hard-deletable/
    )
  })

  it('every other registry entry is deletable', () => {
    const blocked = Object.entries(LIFECYCLE_ENTITIES)
      .filter(([, entity]) => entity.deletable === false)
      .map(([name]) => name)
    expect(blocked).toEqual(['order'])
  })
})
