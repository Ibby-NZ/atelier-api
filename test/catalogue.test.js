import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
// Distinct slug prefix so fixtures never collide with seeded catalogue rows
// and cleanup is precise.
const PREFIX = 'cat-test'

const get = (app, url) => app.inject({ method: 'GET', url })

// Fixture brands + products created directly so the test does not depend on
// seed row counts. Two brands: one domestic (priced), one international (hidden).
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, currency, is_international, trade_only)
     -- trade_only false: these fixtures model the PUBLIC storefront, and the
     -- column defaults to closed (see catalogue/visibility.js).
     VALUES
       ($1, $2, 'NZD', false, false),
       ($3, $4, 'NZD', true, false)
     RETURNING id, is_international`,
    [
      'Cat Test Domestic',
      `${PREFIX}-domestic`,
      'Cat Test International',
      `${PREFIX}-international`,
    ]
  )
  const domestic = brands.find((b) => !b.is_international).id
  const international = brands.find((b) => b.is_international).id

  // Domestic priced finished good; domestic fabric with no retail price;
  // international fabric (price always hidden).
  await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, application, width, composition, price_band, retail_price_cents, currency, show_on_website)
     VALUES
       ($1, 'Cushion A',  $2, 'finished_good', 'Homeware',   NULL,    NULL,           NULL,          12900, 'NZD', true),
       ($1, 'Linen Bolt', $3, 'fabric',        'Drapery',    '140cm', '100% Linen',   'NZ$120 / m',  NULL,  'NZD', true),
       ($4, 'Velvet Bolt',$5, 'fabric',        'Upholstery', '130cm', '100% Cotton',  'NZ$480 / m',  NULL,  'NZD', true),
       ($1, 'Hidden One', $6, 'finished_good', 'Homeware',   NULL,    NULL,           NULL,          9900,  'NZD', false)`,
    [
      domestic,
      `${PREFIX}-cushion-a`,
      `${PREFIX}-linen-bolt`,
      international,
      `${PREFIX}-velvet-bolt`,
      `${PREFIX}-hidden`,
    ]
  )
}

const cleanup = (pool) =>
  pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

describe('GET /catalogue/products', () => {
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
    await cleanup(pool)
    await seedFixtures(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  const fetchFixtureBrand = (products, brandSlug) =>
    products.filter((p) => p.brand.slug === brandSlug)

  it('returns only website-visible products (hidden ones excluded)', async () => {
    const response = await get(app, '/catalogue/products?limit=100')
    expect(response.statusCode).toBe(200)
    const { products } = response.json()
    const slugs = products.map((p) => p.slug)
    expect(slugs).toContain(`${PREFIX}-cushion-a`)
    expect(slugs).not.toContain(`${PREFIX}-hidden`)
  })

  it('paginates with meta', async () => {
    const response = await get(app, '/catalogue/products?limit=1&page=1')
    const body = response.json()
    expect(body.products).toHaveLength(1)
    expect(body.meta.limit).toBe(1)
    expect(body.meta.page).toBe(1)
    expect(body.meta.total).toBeGreaterThanOrEqual(3)
  })

  it('filters by product_type', async () => {
    const response = await get(
      app,
      `/catalogue/products?product_type=fabric&brand=${PREFIX}-domestic&limit=100`
    )
    const { products } = response.json()
    expect(products).toHaveLength(1)
    expect(products[0].slug).toBe(`${PREFIX}-linen-bolt`)
    expect(products[0].product_type).toBe('fabric')
  })

  it('filters by brand slug', async () => {
    const response = await get(
      app,
      `/catalogue/products?brand=${PREFIX}-international&limit=100`
    )
    const { products } = response.json()
    expect(products).toHaveLength(1)
    expect(products[0].slug).toBe(`${PREFIX}-velvet-bolt`)
  })

  it('filters by application', async () => {
    const response = await get(
      app,
      `/catalogue/products?application=Drapery&brand=${PREFIX}-domestic&limit=100`
    )
    const { products } = response.json()
    expect(products.map((p) => p.slug)).toEqual([`${PREFIX}-linen-bolt`])
  })

  it('shows retail_price_cents for a domestic product when set', async () => {
    const response = await get(
      app,
      `/catalogue/products?brand=${PREFIX}-domestic&product_type=finished_good&limit=100`
    )
    const [product] = fetchFixtureBrand(response.json().products, `${PREFIX}-domestic`)
    expect(product.price_hidden).toBe(false)
    expect(product.retail_price_cents).toBe(12900)
  })

  it('omits price and sets price_hidden for international brands', async () => {
    const response = await get(
      app,
      `/catalogue/products?brand=${PREFIX}-international&limit=100`
    )
    const [product] = response.json().products
    expect(product.price_hidden).toBe(true)
    expect(product).not.toHaveProperty('retail_price_cents')
  })

  it('never exposes a trade price field to anonymous callers', async () => {
    const response = await get(app, '/catalogue/products?limit=100')
    const { products } = response.json()
    for (const product of products) {
      expect(product).not.toHaveProperty('trade_price_cents')
      expect(product).not.toHaveProperty('trade_price')
    }
  })

  it('rejects an invalid product_type with 400', async () => {
    const response = await get(app, '/catalogue/products?product_type=bogus')
    expect(response.statusCode).toBe(400)
  })
})
