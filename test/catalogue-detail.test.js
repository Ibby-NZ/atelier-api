import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { sampleTradeApplication } from './helpers/trade-application-fixture.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'det-test'
const TEST_DOMAIN = 'det-test.example.com'
const PASSWORD = 'correct horse battery'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`

const get = (app, url, cookie) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// One domestic brand + collection, one fabric product with a trade price, and
// three colourways exercising the availability math (stocked, fully reserved,
// no inventory row). Also a hidden product to prove the 404 path.
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story, website_url, image_url)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.', 'https://det-test-house.example.com',
             'https://det-test-house.example.com/house.jpg')
     RETURNING id`,
    ['Det Test House', `${PREFIX}-house`]
  )
  const brandId = brands[0].id

  await pool.query(
    `INSERT INTO collections (brand_id, name, slug)
     VALUES ($1, 'Det Collection', $2)`,
    [brandId, `${PREFIX}-collection`]
  )

  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, application, width, composition,
        price_band, retail_price_cents, trade_price_cents, currency,
        show_on_website, hi_res_asset_url, size, description)
     VALUES
       ($1, 'Det Fabric', $2, 'fabric', 'Drapery', '140cm', '100% Linen',
        'NZ$120 / m', NULL, 18776, 'NZD', true, 'https://cdn.example/hi.jpg',
        '70 x 140 cm', 'Pre-washed, long-staple cotton.'),
       ($1, 'Det Hidden', $3, 'fabric', 'Drapery', '140cm', '100% Linen',
        'NZ$120 / m', NULL, 18776, 'NZD', false, NULL, NULL, NULL)
     RETURNING id, slug`,
    [brandId, `${PREFIX}-fabric`, `${PREFIX}-hidden`]
  )
  const fabricId = products.find((p) => p.slug === `${PREFIX}-fabric`).id

  const { rows: colourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku, image_url)
     VALUES
       ($1, 'Stocked', $2, NULL),
       ($1, 'Reserved', $3, NULL),
       ($1, 'NoInventory', $4, NULL)
     RETURNING id, name`,
    [fabricId, `${PREFIX}-SKU-A`, `${PREFIX}-SKU-B`, `${PREFIX}-SKU-C`]
  )
  const idByName = new Map(colourways.map((c) => [c.name, c.id]))

  // Stocked: 60 available, 10 reserved -> in stock. Reserved: 12/12 -> out.
  // NoInventory: no row at all -> out.
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 60, 10, 'metres'), ($2, 12, 12, 'metres')`,
    [idByName.get('Stocked'), idByName.get('Reserved')]
  )
}

const cleanup = async (pool) => {
  // Applications first: deleting the user would SET NULL user_id, orphaning them.
  await pool.query(
    `DELETE FROM trade_applications
      WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`%@${TEST_DOMAIN}`]
  )
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

describe('product detail and brand endpoints', () => {
  let pool
  let app
  const cookies = {}

  const signUp = async (url, local) => {
    const response = await app.inject({
      method: 'POST',
      url,
      payload: {
        email: testEmail(local),
        password: PASSWORD,
        name: local,
        ...(url === '/auth/trade-application'
          ? { application: sampleTradeApplication() }
          : {}),
      },
    })
    expect(response.statusCode).toBe(201)
    if (response.headers['set-cookie']) {
      cookies[local] = sessionCookieFrom(response)
    }
    return response.json().user
  }

  const logIn = async (local) => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: testEmail(local), password: PASSWORD },
    })
    expect(response.statusCode).toBe(200)
    cookies[local] = sessionCookieFrom(response)
  }

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
    await seedFixtures(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await signUp('/auth/register', 'customer')
    // A trade application no longer starts a session and a pending account
    // cannot log in, so approve first, then take the session.
    await signUp('/auth/trade-application', 'trader')
    await pool.query('UPDATE users SET trade_approved = true WHERE email = $1', [
      testEmail('trader'),
    ])
    await logIn('trader')
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  describe('GET /catalogue/products/:slug', () => {
    it('returns the product with hi_res_asset_url and colourways', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-fabric`)
      expect(response.statusCode).toBe(200)
      const { product } = response.json()
      expect(product.slug).toBe(`${PREFIX}-fabric`)
      expect(product.hi_res_asset_url).toBe('https://cdn.example/hi.jpg')
      expect(product.brand.slug).toBe(`${PREFIX}-house`)
      expect(product.colourways).toHaveLength(3)
      // The size is what tells a bath sheet from a face cloth, and the detail
      // read is the only one that carries the prose — a card has no room for it.
      expect(product.size).toBe('70 x 140 cm')
      expect(product.description).toBe('Pre-washed, long-staple cotton.')
    })

    it('computes in_stock as qty_available minus qty_reserved > 0', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-fabric`)
      const stock = Object.fromEntries(
        response.json().product.colourways.map((c) => [c.name, c.in_stock])
      )
      expect(stock.Stocked).toBe(true) // 60 - 10 > 0
      expect(stock.Reserved).toBe(false) // 12 - 12 = 0
      expect(stock.NoInventory).toBe(false) // no inventory row
    })

    it('404s for an unknown slug', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-nope`)
      expect(response.statusCode).toBe(404)
    })

    it('404s for a product hidden from the website', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-hidden`)
      expect(response.statusCode).toBe(404)
    })

    it('never exposes trade_price_cents to an anonymous caller', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-fabric`)
      expect(response.json().product).not.toHaveProperty('trade_price_cents')
    })

    it('never exposes trade_price_cents to a plain customer', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-fabric`, cookies.customer)
      expect(response.json().product).not.toHaveProperty('trade_price_cents')
    })

    it('exposes trade_price_cents to an approved trade user', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-fabric`, cookies.trader)
      expect(response.statusCode).toBe(200)
      expect(response.json().product.trade_price_cents).toBe(18776)
    })

    it('withholds trade_price_cents from an unapproved trade user', async () => {
      // Same account, approval revoked: the session resolves to nobody now
      // (a pending trade account cannot authenticate), so no trade pricing.
      await pool.query('UPDATE users SET trade_approved = false WHERE email = $1', [
        testEmail('trader'),
      ])
      const response = await get(app, `/catalogue/products/${PREFIX}-fabric`, cookies.trader)
      expect(response.json().product).not.toHaveProperty('trade_price_cents')
      await pool.query('UPDATE users SET trade_approved = true WHERE email = $1', [
        testEmail('trader'),
      ])
    })
  })

  describe('GET /catalogue/brands', () => {
    it('lists brands including the fixture brand', async () => {
      const response = await get(app, '/catalogue/brands')
      expect(response.statusCode).toBe(200)
      const slugs = response.json().brands.map((b) => b.slug)
      expect(slugs).toContain(`${PREFIX}-house`)
    })
  })

  describe('GET /catalogue/brands/:slug', () => {
    it('returns a brand with its collections', async () => {
      const response = await get(app, `/catalogue/brands/${PREFIX}-house`)
      expect(response.statusCode).toBe(200)
      const { brand } = response.json()
      expect(brand.name).toBe('Det Test House')
      expect(brand.collections.map((c) => c.slug)).toContain(`${PREFIX}-collection`)
    })

    it('exposes the house website URL', async () => {
      const response = await get(app, `/catalogue/brands/${PREFIX}-house`)
      expect(response.json().brand.website_url).toBe('https://det-test-house.example.com')

      const list = await get(app, '/catalogue/brands')
      const listed = list.json().brands.find((b) => b.slug === `${PREFIX}-house`)
      expect(listed.website_url).toBe('https://det-test-house.example.com')
    })

    // The storefront's house tiles are a photograph with the maison's mark over
    // it and no caption, so the picture IS the tile — a brand read that dropped
    // the office's own upload would fall through to a collection or product
    // shot and quietly show the wrong room.
    it('exposes the house image URL on the detail and the list', async () => {
      const response = await get(app, `/catalogue/brands/${PREFIX}-house`)
      expect(response.json().brand.image_url).toBe('https://det-test-house.example.com/house.jpg')

      const list = await get(app, '/catalogue/brands')
      const listed = list.json().brands.find((b) => b.slug === `${PREFIX}-house`)
      expect(listed.image_url).toBe('https://det-test-house.example.com/house.jpg')
    })

    it('404s for an unknown brand slug', async () => {
      const response = await get(app, `/catalogue/brands/${PREFIX}-nobrand`)
      expect(response.statusCode).toBe(404)
    })
  })
})
