import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  deleteOrExplain,
  replyDelete,
  constraintBlockers,
  lockSql,
} from '../src/lifecycle/delete.js'
import { LIFECYCLE_ENTITIES, requireEntity } from '../src/lifecycle/registry.js'

// The shared delete mechanism (W1-US-001). Two halves:
//
//   - Against the real database: a delete that would destroy commercial history
//     is refused and destroys nothing. Most of the FK edges out of these tables
//     are CASCADE or SET NULL, so "the database will stop us" is false — these
//     tests are the proof that the probes are what stops us.
//   - Against a stub pool: the statement ORDER (lock -> guard -> probe -> delete)
//     and the `FOR UPDATE` lock mode, which no amount of black-box behaviour can
//     demonstrate, plus the 23503 backstop, whose real-world trigger is a race.

const PREFIX = 'lc-test'
const DOMAIN = 'lc-test.example.com'

const seedBrand = async (pool, slug = `${PREFIX}-house`) => {
  const { rows } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: the house rule for every catalogue fixture.
     VALUES ('Lifecycle House', $1, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    [slug]
  )
  return rows[0].id
}

const seedProduct = async (pool, brandId, slug = `${PREFIX}-fabric`, collectionId = null) => {
  const { rows } = await pool.query(
    `INSERT INTO products (brand_id, collection_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, $2, 'Lifecycle Fabric', $3, 'fabric', 'NZD', true)
     RETURNING id`,
    [brandId, collectionId, slug]
  )
  return rows[0].id
}

const seedColourway = async (pool, productId, sku = `${PREFIX}-SKU`) => {
  const { rows } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Default', $2) RETURNING id`,
    [productId, sku]
  )
  return rows[0].id
}

const seedInventory = (pool, colourwayId, available, reserved) =>
  pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, $2, $3, 'metres')`,
    [colourwayId, available, reserved]
  )

const seedUser = async (pool, local, role = 'customer') => {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, role)
     VALUES ($1, 'not-a-real-hash', 'Lifecycle Tester', $2) RETURNING id`,
    [`${local}@${DOMAIN}`, role]
  )
  return rows[0].id
}

const cleanup = async (pool) => {
  await pool.query(`DELETE FROM orders WHERE order_number LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM contact_enquiries WHERE email LIKE $1`, [`%@${DOMAIN}`])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`])
  // samples.colourway_id is RESTRICT, so like orders they must go before the
  // brand cascade or the cleanup itself 23503s.
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM shipping_rates WHERE zone LIKE $1`, [`${PREFIX}-%`])
}

describe('deleteOrExplain against the database', () => {
  let pool

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
    await cleanup(pool)
  })

  beforeEach(() => cleanup(pool))

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  const countRows = async (sql, params) => {
    const { rows } = await pool.query(sql, params)
    return Number(rows[0].count)
  }

  it('deletes a row nothing points at', async () => {
    const brandId = await seedBrand(pool)

    const result = await deleteOrExplain(pool, 'brand', brandId)

    expect(result).toEqual({ deleted: true, entity: 'brand', id: brandId })
    expect(await countRows('SELECT count(*) FROM brands WHERE id = $1', [brandId])).toBe(0)
  })

  it('refuses a house with a catalogue behind it and destroys nothing', async () => {
    // Both edges out of brands are ON DELETE CASCADE: without the probes this
    // delete succeeds and silently takes the collection, product, colourway and
    // inventory with it.
    const brandId = await seedBrand(pool)
    const { rows: collections } = await pool.query(
      `INSERT INTO collections (brand_id, name, slug) VALUES ($1, 'Spring', $2) RETURNING id`,
      [brandId, `${PREFIX}-spring`]
    )
    const productId = await seedProduct(pool, brandId, `${PREFIX}-fabric`, collections[0].id)
    const colourwayId = await seedColourway(pool, productId)
    await seedInventory(pool, colourwayId, 40, 0)

    const result = await deleteOrExplain(pool, 'brand', brandId)

    expect(result.deleted).toBe(false)
    expect(result.status).toBe(409)
    expect(result.error).toBe('Conflict')
    expect(result.archivable).toBe(true)
    expect(result.blockers).toEqual([
      { relation: 'products', label: 'products', count: 1, capped: false },
      { relation: 'collections', label: 'collections', count: 1, capped: false },
    ])
    expect(result.message).toMatch(/Archive it instead/)

    // Nothing was destroyed — the whole point.
    expect(await countRows('SELECT count(*) FROM brands WHERE id = $1', [brandId])).toBe(1)
    expect(await countRows('SELECT count(*) FROM products WHERE id = $1', [productId])).toBe(1)
    expect(
      await countRows('SELECT count(*) FROM inventory WHERE colourway_id = $1', [colourwayId])
    ).toBe(1)
  })

  it('refuses a product and a colourway that samples were cut from, naming the samples', async () => {
    // samples.colourway_id is RESTRICT, so without the probes the delete died
    // mid-cascade on a bare 23503 and the refusal read "related records"
    // instead of naming what blocks it. The product probe goes through the
    // colourway join; the colourway probe is direct — the order_lines shape.
    const brandId = await seedBrand(pool)
    const productId = await seedProduct(pool, brandId)
    const colourwayId = await seedColourway(pool, productId)
    await pool.query(`INSERT INTO samples (barcode, colourway_id) VALUES ($1, $2)`, [
      `${PREFIX}-BARCODE-1`,
      colourwayId,
    ])

    const viaColourway = await deleteOrExplain(pool, 'colourway', colourwayId)
    expect(viaColourway.deleted).toBe(false)
    expect(viaColourway.status).toBe(409)
    expect(viaColourway.blockers).toEqual([
      { relation: 'samples', label: 'samples', count: 1, capped: false },
    ])

    const viaProduct = await deleteOrExplain(pool, 'product', productId)
    expect(viaProduct.deleted).toBe(false)
    expect(viaProduct.status).toBe(409)
    expect(viaProduct.blockers).toEqual([
      { relation: 'samples', label: 'samples', count: 1, capped: false },
    ])

    // Nothing was destroyed on either path.
    expect(await countRows('SELECT count(*) FROM samples WHERE colourway_id = $1', [colourwayId])).toBe(1)
    expect(await countRows('SELECT count(*) FROM colourways WHERE id = $1', [colourwayId])).toBe(1)
  })

  it('refuses a collection that still holds products, which the SET NULL FK would silently uncollect', async () => {
    const brandId = await seedBrand(pool)
    const { rows: collections } = await pool.query(
      `INSERT INTO collections (brand_id, name, slug) VALUES ($1, 'Spring', $2) RETURNING id`,
      [brandId, `${PREFIX}-spring`]
    )
    const collectionId = collections[0].id
    const productId = await seedProduct(pool, brandId, `${PREFIX}-fabric`, collectionId)

    const result = await deleteOrExplain(pool, 'collection', collectionId)

    expect(result.status).toBe(409)
    expect(result.blockers).toEqual([
      { relation: 'products', label: 'products', count: 1, capped: false },
    ])
    // The product kept its collection: no invisible SET NULL happened.
    const { rows } = await pool.query('SELECT collection_id FROM products WHERE id = $1', [
      productId,
    ])
    expect(rows[0].collection_id).toBe(collectionId)
  })

  it('counts archived rows too — archiving a product does not unblock its house', async () => {
    const brandId = await seedBrand(pool)
    const productId = await seedProduct(pool, brandId)
    await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [productId])

    const result = await deleteOrExplain(pool, 'brand', brandId)

    expect(result.status).toBe(409)
    expect(result.blockers).toEqual([
      { relation: 'products', label: 'products', count: 1, capped: false },
    ])
  })

  it('caps a probe at 100 and says so rather than counting the whole table', async () => {
    const brandId = await seedBrand(pool)
    await pool.query(
      `INSERT INTO collections (brand_id, name, slug)
       SELECT $1, 'Bulk ' || g, $2 || g FROM generate_series(1, 150) AS g`,
      [brandId, `${PREFIX}-bulk-`]
    )

    const result = await deleteOrExplain(pool, 'brand', brandId)

    expect(result.blockers).toEqual([
      { relation: 'collections', label: 'collections', count: 100, capped: true },
    ])
    expect(result.message).toMatch(/100\+ collections/)
  })

  it('blocks a colourway that carries order lines and one that still holds stock', async () => {
    const brandId = await seedBrand(pool)
    const productId = await seedProduct(pool, brandId)
    const colourwayId = await seedColourway(pool, productId)
    await seedInventory(pool, colourwayId, 12, 0)
    const { rows: orders } = await pool.query(
      `INSERT INTO orders (order_number, kind, status) VALUES ($1, 'order_request', 'requested')
       RETURNING id`,
      [`${PREFIX}-ORD`]
    )
    await pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
       VALUES ($1, $2, 3, 0)`,
      [orders[0].id, colourwayId]
    )

    const result = await deleteOrExplain(pool, 'colourway', colourwayId)

    expect(result.status).toBe(409)
    expect(result.blockers.map((b) => b.relation)).toEqual(['order_lines', 'inventory'])
    expect(await countRows('SELECT count(*) FROM colourways WHERE id = $1', [colourwayId])).toBe(1)

    // The product above it is blocked by the same history, reached through the
    // colourway — the grandchild the CASCADE would have taken.
    const viaProduct = await deleteOrExplain(pool, 'product', productId)
    expect(viaProduct.status).toBe(409)
    expect(viaProduct.blockers.map((b) => b.relation)).toEqual(['order_lines', 'inventory'])
  })

  it('answers 404 for an id that is not there', async () => {
    const result = await deleteOrExplain(pool, 'brand', 2147483000)

    expect(result.deleted).toBe(false)
    expect(result.status).toBe(404)
    expect(result.error).toBe('Not Found')
    expect(result.blockers).toEqual([])
  })

  it('runs a guard before the probes: reserved stock is a 409 with no archive offered', async () => {
    const brandId = await seedBrand(pool)
    const productId = await seedProduct(pool, brandId)
    const colourwayId = await seedColourway(pool, productId)
    await seedInventory(pool, colourwayId, 40, 6)

    const held = await deleteOrExplain(pool, 'inventory', colourwayId)
    expect(held.status).toBe(409)
    expect(held.archivable).toBe(false) // inventory has no archived_at column
    expect(held.message).toMatch(/6 reserved/)
    expect(
      await countRows('SELECT count(*) FROM inventory WHERE colourway_id = $1', [colourwayId])
    ).toBe(1)

    await pool.query('UPDATE inventory SET qty_reserved = 0 WHERE colourway_id = $1', [
      colourwayId,
    ])
    const freed = await deleteOrExplain(pool, 'inventory', colourwayId)
    expect(freed.deleted).toBe(true)
  })

  it('refuses a self-delete with 403, and deletes someone else', async () => {
    const directorId = await seedUser(pool, 'director', 'director')
    const otherId = await seedUser(pool, 'other')

    const self = await deleteOrExplain(pool, 'user', directorId, {
      user: { id: directorId, role: 'director' },
    })
    expect(self.status).toBe(403)
    expect(self.error).toBe('Forbidden')
    expect(self.blockers).toEqual([])

    const other = await deleteOrExplain(pool, 'user', otherId, {
      user: { id: directorId, role: 'director' },
    })
    expect(other.deleted).toBe(true)
  })

  it('blocks an account whose orders and enquiries would be SET NULL into anonymity', async () => {
    const userId = await seedUser(pool, 'shopper')
    await pool.query(
      `INSERT INTO orders (user_id, order_number, kind, status)
       VALUES ($1, $2, 'checkout', 'paid')`,
      [userId, `${PREFIX}-WEB`]
    )
    await pool.query(
      `INSERT INTO contact_enquiries (name, email, message, user_id)
       VALUES ('Shopper', $1, 'Hello', $2)`,
      [`shopper@${DOMAIN}`, userId]
    )

    const result = await deleteOrExplain(pool, 'user', userId, { user: { id: 0 } })

    expect(result.status).toBe(409)
    expect(result.blockers.map((b) => b.relation)).toEqual(['orders', 'contact_enquiries'])
    const { rows } = await pool.query('SELECT user_id FROM orders WHERE order_number = $1', [
      `${PREFIX}-WEB`,
    ])
    expect(rows[0].user_id).toBe(userId)
  })

  it('keeps the last shipping tier for a zone, and lets the others go', async () => {
    const { rows } = await pool.query(
      `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
       VALUES ($1, 0, 1500), ($1, 20, 3000) RETURNING id`,
      [`${PREFIX}-north`]
    )
    const [first, second] = rows.map((row) => row.id)

    expect((await deleteOrExplain(pool, 'shipping_rate', second)).deleted).toBe(true)

    const last = await deleteOrExplain(pool, 'shipping_rate', first)
    expect(last.status).toBe(409)
    expect(last.archivable).toBe(false)
    expect(last.message).toMatch(/stops checkout/)
  })

  it('deletes an entity that declares no probes and no guard', async () => {
    const { rows } = await pool.query(
      `INSERT INTO contact_enquiries (name, email, message) VALUES ('Ann', $1, 'Hi') RETURNING id`,
      [`ann@${DOMAIN}`]
    )

    expect((await deleteOrExplain(pool, 'contact_enquiry', rows[0].id)).deleted).toBe(true)
  })
})

// A pool stub records the exact statements the module issues. This is the only
// way to assert the lock mode and the ordering, and the only deterministic way to
// reach the 23503 backstop (whose real trigger is a concurrent insert).
const stubPool = ({ locked = [{ id: 1 }], probeRows = [], failDelete = null } = {}) => {
  const log = []
  const client = {
    query: async (sql) => {
      const text = String(sql)
      log.push(text)
      if (text.includes('FOR UPDATE')) return { rows: locked }
      if (text.includes('count(*)')) return { rows: probeRows }
      if (text.startsWith('DELETE FROM') && failDelete) throw failDelete
      return { rows: [] }
    },
    release: () => log.push('RELEASE'),
  }
  return { log, connect: async () => client }
}

describe('deleteOrExplain transaction shape', () => {
  it('locks FOR UPDATE — never FOR NO KEY UPDATE — then probes, then deletes', async () => {
    const pool = stubPool()

    const result = await deleteOrExplain(pool, 'brand', 7)

    expect(result.deleted).toBe(true)
    const steps = pool.log
    expect(steps[0]).toBe('BEGIN')
    expect(steps[1]).toContain('FROM brands WHERE id = $1 FOR UPDATE')
    // FOR KEY SHARE (taken by anything inserting a child row) conflicts with
    // FOR UPDATE and with nothing weaker. This assertion is the invariant.
    expect(steps[1]).not.toContain('FOR NO KEY UPDATE')
    expect(steps[2]).toContain('count(*)')
    expect(steps[3]).toBe('DELETE FROM brands WHERE id = $1')
    expect(steps[4]).toBe('COMMIT')
    expect(steps.at(-1)).toBe('RELEASE')
  })

  it('probes in one round trip however many relations an entity declares', async () => {
    const pool = stubPool()
    await deleteOrExplain(pool, 'user', 3)

    const probes = pool.log.filter((sql) => sql.includes('count(*)'))
    expect(probes).toHaveLength(1)
    expect(probes[0].match(/UNION ALL/g)).toHaveLength(
      LIFECYCLE_ENTITIES.user.probes.length - 1
    )
    expect(probes[0].match(/LIMIT 101/g)).toHaveLength(LIFECYCLE_ENTITIES.user.probes.length)
  })

  it('rolls back and issues no DELETE when a probe reports a dependant', async () => {
    const pool = stubPool({ probeRows: [{ relation: 'products', hits: 4 }] })

    const result = await deleteOrExplain(pool, 'brand', 7)

    expect(result.status).toBe(409)
    expect(result.blockers).toEqual([
      { relation: 'products', label: 'products', count: 4, capped: false },
    ])
    expect(pool.log).toContain('ROLLBACK')
    expect(pool.log.some((sql) => sql.startsWith('DELETE FROM'))).toBe(false)
  })

  it('rolls back on a 404 without probing', async () => {
    const pool = stubPool({ locked: [] })

    expect((await deleteOrExplain(pool, 'brand', 7)).status).toBe(404)
    expect(pool.log.some((sql) => sql.includes('count(*)'))).toBe(false)
    expect(pool.log).toContain('ROLLBACK')
  })

  it('maps a 23503 raised by the DELETE onto the same 409 shape', async () => {
    const violation = Object.assign(new Error('update or delete violates foreign key'), {
      code: '23503',
      constraint: 'order_lines_colourway_id_fkey',
    })
    const pool = stubPool({ failDelete: violation })

    const result = await deleteOrExplain(pool, 'colourway', 7)

    expect(result.status).toBe(409)
    expect(result.blockers).toEqual([
      { relation: 'order_lines', label: 'order lines', count: 1, capped: true },
    ])
    expect(pool.log).toContain('ROLLBACK')
  })

  it('rethrows anything that is not a foreign-key violation', async () => {
    const pool = stubPool({ failDelete: Object.assign(new Error('boom'), { code: '42P01' }) })

    await expect(deleteOrExplain(pool, 'brand', 7)).rejects.toThrow('boom')
    expect(pool.log).toContain('ROLLBACK')
  })
})

describe('lifecycle helpers', () => {
  it('lockSql takes the strongest row lock', () => {
    expect(lockSql(LIFECYCLE_ENTITIES.inventory)).toBe(
      'SELECT colourway_id FROM inventory WHERE colourway_id = $1 FOR UPDATE'
    )
  })

  it('constraintBlockers degrades an unrecognised constraint without changing the status', () => {
    const known = constraintBlockers({ code: '23503', constraint: 'order_lines_colourway_id_fkey' })
    expect(known[0].relation).toBe('order_lines')

    const unknown = constraintBlockers({ code: '23503', constraint: 'something_new_fkey' })
    expect(unknown[0]).toEqual({
      relation: 'related_records',
      label: 'related records',
      count: 1,
      capped: true,
    })

    expect(constraintBlockers({ code: '23505' })).toBeNull()
    expect(constraintBlockers(undefined)).toBeNull()
  })

  it('requireEntity throws for an unknown name rather than answering 404', () => {
    // A 404 would let a caller that wired :entity from the URL probe which names
    // exist. This is a wiring mistake, so it is a 500.
    expect(() => requireEntity('orders')).toThrow(/Unknown lifecycle entity "orders"/)
  })

  it('replyDelete sends 200 with an envelope on success', () => {
    const sent = {}
    const reply = {
      code(status) {
        sent.status = status
        return this
      },
      send(payload) {
        sent.payload = payload
        return this
      },
    }

    replyDelete(reply, { deleted: true, entity: 'brand', id: 9 })
    expect(sent).toEqual({ status: 200, payload: { deleted: { entity: 'brand', id: 9 } } })
  })

  it('replyDelete keeps Fastify’s error envelope and adds blockers + archivable', () => {
    const sent = {}
    const reply = {
      code(status) {
        sent.status = status
        return this
      },
      send(payload) {
        sent.payload = payload
        return this
      },
    }
    const blockers = [{ relation: 'products', label: 'products', count: 2, capped: false }]

    replyDelete(reply, {
      deleted: false,
      status: 409,
      error: 'Conflict',
      message: 'Cannot delete this house: 2 products still reference it.',
      blockers,
      archivable: true,
    })

    expect(sent.status).toBe(409)
    expect(sent.payload).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Cannot delete this house: 2 products still reference it.',
      blockers,
      archivable: true,
    })
  })
})
