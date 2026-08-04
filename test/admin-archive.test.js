import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

// Soft-archive behaviour across the catalogue + orders: archiving hides a row
// from the public storefront and the default admin lists but keeps it, and
// restore brings it back. Orders that still hold a reservation can't be archived.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'arch-test'
const DOMAIN = 'arch-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// One website-visible brand → product → colourway (+ inventory) fixture.
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Arch House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  const { rows: products } = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Arch Fabric', $2, 'fabric', 'NZD', true)
     RETURNING id`,
    [brandId, `${PREFIX}-fabric`]
  )
  const productId = products[0].id

  const { rows: colourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Default', $2) RETURNING id`,
    [productId, `${PREFIX}-SKU`]
  )
  const colourwayId = colourways[0].id
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 40, 0, 'metres')`,
    [colourwayId]
  )
  return { brandId, productId, colourwayId }
}

const cleanup = async (pool) => {
  await pool.query(
    `DELETE FROM orders WHERE order_number LIKE $1`,
    [`${PREFIX}-%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

describe('soft archive / restore', () => {
  let pool
  let app
  let backofficeCookie
  let ids

  const inject = (method, url, cookie) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {} })

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

    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])
  })

  beforeEach(async () => {
    await cleanup(pool)
    ids = await seedFixtures(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  const publicHasProduct = async () => {
    const { products } = (await inject('GET', '/catalogue/products?limit=100', null)).json()
    return products.some((p) => p.slug === `${PREFIX}-fabric`)
  }

  it('archives a brand: gone from public + default admin list, restored back', async () => {
    expect(await publicHasProduct()).toBe(true)

    const archived = await inject(
      'POST',
      `/admin/brands/${ids.brandId}/archive`,
      backofficeCookie
    )
    expect(archived.statusCode).toBe(200)
    expect(archived.json().brand.archived_at).toBeTruthy()

    // Public brands + products drop the archived house.
    const brands = (await inject('GET', '/catalogue/brands', null)).json().brands
    expect(brands.some((b) => b.slug === `${PREFIX}-house`)).toBe(false)
    expect(await publicHasProduct()).toBe(false)

    // Default admin brand list hides it; include_archived shows it.
    const adminList = (await inject('GET', '/admin/brands', backofficeCookie)).json().brands
    expect(adminList.some((b) => b.id === ids.brandId)).toBe(false)
    const withArchived = (
      await inject('GET', '/admin/brands?include_archived=true', backofficeCookie)
    ).json().brands
    expect(withArchived.some((b) => b.id === ids.brandId)).toBe(true)

    const restored = await inject(
      'POST',
      `/admin/brands/${ids.brandId}/restore`,
      backofficeCookie
    )
    expect(restored.statusCode).toBe(200)
    expect(restored.json().brand.archived_at).toBeNull()
    // Products need re-publishing? No — the brand only was archived, product
    // stayed show_on_website=true, so it returns immediately.
    expect(await publicHasProduct()).toBe(true)
  })

  it('archives a product: unpublished + hidden from public, restore leaves it unpublished', async () => {
    const archived = await inject(
      'POST',
      `/admin/products/${ids.productId}/archive`,
      backofficeCookie
    )
    expect(archived.statusCode).toBe(200)
    expect(archived.json().product.archived_at).toBeTruthy()
    expect(archived.json().product.show_on_website).toBe(false)
    expect(await publicHasProduct()).toBe(false)

    const restored = await inject(
      'POST',
      `/admin/products/${ids.productId}/restore`,
      backofficeCookie
    )
    expect(restored.statusCode).toBe(200)
    // archived flag cleared, but staff must re-enable the website flag.
    expect(restored.json().product.archived_at).toBeNull()
    expect(restored.json().product.show_on_website).toBe(false)
    expect(await publicHasProduct()).toBe(false)
  })

  it('archives a colourway: gone from the public product detail', async () => {
    const before = (
      await inject('GET', `/catalogue/products/${PREFIX}-fabric`, null)
    ).json().product
    expect(before.colourways).toHaveLength(1)

    await inject('POST', `/admin/colourways/${ids.colourwayId}/archive`, backofficeCookie)

    const after = (
      await inject('GET', `/catalogue/products/${PREFIX}-fabric`, null)
    ).json().product
    expect(after.colourways).toHaveLength(0)
  })

  it('refuses to archive a reserving order until it is terminal, then allows it', async () => {
    // A live order-request (still holding a reservation).
    const { rows: live } = await pool.query(
      `INSERT INTO orders (order_number, kind, status)
       VALUES ($1, 'order_request', 'requested') RETURNING id`,
      [`${PREFIX}-LIVE`]
    )
    const liveId = live[0].id
    const blocked = await inject('POST', `/admin/orders/${liveId}/archive`, backofficeCookie)
    expect(blocked.statusCode).toBe(409)

    // A declined (terminal) order archives fine.
    const { rows: dead } = await pool.query(
      `INSERT INTO orders (order_number, kind, status)
       VALUES ($1, 'order_request', 'declined') RETURNING id`,
      [`${PREFIX}-DEAD`]
    )
    const deadId = dead[0].id
    const ok = await inject('POST', `/admin/orders/${deadId}/archive`, backofficeCookie)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().order.archived_at).toBeTruthy()

    // Archived order drops from the default queue but shows with include_archived.
    const queue = (await inject('GET', '/admin/orders', backofficeCookie)).json().orders
    expect(queue.some((o) => o.id === deadId)).toBe(false)
    const all = (
      await inject('GET', '/admin/orders?include_archived=true', backofficeCookie)
    ).json().orders
    expect(all.some((o) => o.id === deadId)).toBe(true)

    // A checkout order (non-reserving) can be archived in any state.
    const { rows: co } = await pool.query(
      `INSERT INTO orders (order_number, kind, status)
       VALUES ($1, 'checkout', 'paid') RETURNING id`,
      [`${PREFIX}-CO`]
    )
    const coArchive = await inject('POST', `/admin/orders/${co[0].id}/archive`, backofficeCookie)
    expect(coArchive.statusCode).toBe(200)
  })
})
