import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { updateInventory } from '../src/inventory/admin-inventory.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'inv-test'
const DOMAIN = 'inv-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// Two colourways under one house so `q` search and per-row edits can be told
// apart. Velvet starts with a live reservation; Linen is untouched stock.
const SKU = {
  velvet: `${PREFIX}-VELVET-RUBY`,
  linen: `${PREFIX}-LINEN-SKY`,
}

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Inv Test House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  const { rows: velvet } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Inv Velvet', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brandId, `${PREFIX}-velvet`]
  )
  const { rows: velvetCw } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Ruby', $2) RETURNING id`,
    [velvet[0].id, SKU.velvet]
  )
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 60, 5, 'metres')`,
    [velvetCw[0].id]
  )

  const { rows: linen } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Inv Linen', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brandId, `${PREFIX}-linen`]
  )
  const { rows: linenCw } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Sky', $2) RETURNING id`,
    [linen[0].id, SKU.linen]
  )
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 20, 0, 'metres')`,
    [linenCw[0].id]
  )
}

// Delete any orders that reference the fixtures BEFORE the brands, because
// order_lines.colourway_id is ON DELETE RESTRICT (commerce records survive a
// catalogue cleanup). Brands then cascade to products -> colourways -> inventory.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM orders
      WHERE id IN (
        SELECT ol.order_id FROM order_lines ol
          JOIN colourways c ON c.id = ol.colourway_id
         WHERE c.sku LIKE $1
      )`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

const colourwayIdFor = async (pool, sku) => {
  const { rows } = await pool.query(`SELECT id FROM colourways WHERE sku = $1`, [sku])
  return rows[0]?.id
}

const inventoryFor = async (pool, sku) => {
  const { rows } = await pool.query(
    `SELECT i.qty_available, i.qty_reserved
       FROM inventory i JOIN colourways c ON c.id = i.colourway_id
      WHERE c.sku = $1`,
    [sku]
  )
  return {
    available: Number(rows[0].qty_available),
    reserved: Number(rows[0].qty_reserved),
  }
}

describe('back-office stock management', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

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
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanupFixtures(pool)
    await deleteUsers(pool)

    // Register the two users ONCE and keep them: register shares a rate-limit
    // bucket (10 / 15 min / IP) that re-registering every test would exhaust.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await inject('GET', '/admin/inventory', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await inject('GET', '/admin/inventory', customerCookie)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('GET /admin/inventory', () => {
    it('lists inventory rows with numeric quantities and identifiers', async () => {
      const response = await inject('GET', '/admin/inventory', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const rows = response.json().inventory
      const velvet = rows.find((r) => r.sku === SKU.velvet)
      expect(velvet).toMatchObject({
        product_name: 'Inv Velvet',
        colourway_name: 'Ruby',
        brand_name: 'Inv Test House',
        unit: 'metres',
      })
      // pg numeric strings are coerced to numbers before they leave the module.
      expect(velvet.qty_available).toBe(60)
      expect(velvet.qty_reserved).toBe(5)
      expect(typeof velvet.qty_available).toBe('number')
      expect(rows.some((r) => r.sku === SKU.linen)).toBe(true)
    })

    it('narrows the list with a q search over sku / product / colourway', async () => {
      const byProduct = await inject('GET', '/admin/inventory?q=Velvet', backofficeCookie)
      const productRows = byProduct.json().inventory
      expect(productRows).toHaveLength(1)
      expect(productRows[0].sku).toBe(SKU.velvet)

      // Colourway name matches too.
      const bySwatch = await inject('GET', '/admin/inventory?q=Sky', backofficeCookie)
      const swatchRows = bySwatch.json().inventory
      expect(swatchRows).toHaveLength(1)
      expect(swatchRows[0].sku).toBe(SKU.linen)
    })
  })

  describe('PATCH /admin/inventory/:colourwayId', () => {
    it('sets qty_available (receiving stock)', async () => {
      const cwId = await colourwayIdFor(pool, SKU.velvet)
      const response = await inject(
        'PATCH',
        `/admin/inventory/${cwId}`,
        backofficeCookie,
        { qty_available: 80 }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().inventory.qty_available).toBe(80)
      // Reserved untouched by an available-only edit.
      expect(await inventoryFor(pool, SKU.velvet)).toEqual({ available: 80, reserved: 5 })
    })

    it('sets qty_reserved (manual override) without touching available', async () => {
      const cwId = await colourwayIdFor(pool, SKU.velvet)
      const response = await inject(
        'PATCH',
        `/admin/inventory/${cwId}`,
        backofficeCookie,
        { qty_reserved: 12 }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().inventory.qty_reserved).toBe(12)
      // reserved > available is allowed (short backorders reserve more than on hand).
      expect(await inventoryFor(pool, SKU.velvet)).toEqual({ available: 60, reserved: 12 })
    })

    it('rejects a negative quantity with 422 at the module gate', async () => {
      // The route schema caps qty at >= 0 (a negative body is a 400 there), so the
      // module's belt-and-suspenders 422 is exercised by calling it directly.
      const cwId = await colourwayIdFor(pool, SKU.velvet)
      await expect(
        updateInventory(pool, cwId, { qty_available: -5 })
      ).rejects.toMatchObject({ statusCode: 422 })
    })

    it('returns 404 for a colourway with no inventory row', async () => {
      const response = await inject(
        'PATCH',
        '/admin/inventory/99999999',
        backofficeCookie,
        { qty_available: 10 }
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /admin/inventory/:colourwayId/adjust', () => {
    it('adjusts qty_available up and down by a signed delta', async () => {
      const cwId = await colourwayIdFor(pool, SKU.velvet)

      const up = await inject('POST', `/admin/inventory/${cwId}/adjust`, backofficeCookie, {
        delta: 15,
      })
      expect(up.statusCode).toBe(200)
      expect(up.json().inventory.qty_available).toBe(75)

      const down = await inject(
        'POST',
        `/admin/inventory/${cwId}/adjust`,
        backofficeCookie,
        { delta: -10 }
      )
      expect(down.statusCode).toBe(200)
      expect(down.json().inventory.qty_available).toBe(65)
      // Adjust only moves available; the reservation is left alone.
      expect(await inventoryFor(pool, SKU.velvet)).toEqual({ available: 65, reserved: 5 })
    })

    it('rejects an adjustment that would drive stock below zero with 422', async () => {
      const cwId = await colourwayIdFor(pool, SKU.velvet)
      const response = await inject(
        'POST',
        `/admin/inventory/${cwId}/adjust`,
        backofficeCookie,
        { delta: -1000 }
      )
      expect(response.statusCode).toBe(422)
      // Stock untouched by the rejected adjustment.
      expect((await inventoryFor(pool, SKU.velvet)).available).toBe(60)
    })

    it('returns 404 when adjusting a colourway with no inventory row', async () => {
      const response = await inject(
        'POST',
        '/admin/inventory/99999999/adjust',
        backofficeCookie,
        { delta: 5 }
      )
      expect(response.statusCode).toBe(404)
    })
  })
})
