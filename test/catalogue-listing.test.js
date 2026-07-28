import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { CARD_SWATCH_LIMIT } from '../src/catalogue/products.js'

// Merchandising fields on GET /catalogue/products: imagery, availability, the
// card colourway strip, free-text search, sort, and trade pricing behind the
// same approved-trade gate the detail endpoint uses.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'list-test'
const TEST_DOMAIN = 'list-test.example.com'
const PASSWORD = 'correct horse battery'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`

const get = (app, url, cookie) =>
  app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Only the fixture rows, so assertions never depend on the seeded catalogue.
const only = (body) =>
  body.products.filter((product) => product.slug.startsWith(PREFIX))

const bySlug = (body, slug) =>
  body.products.find((product) => product.slug === `${PREFIX}-${slug}`)

/*
 * Fixtures (all on one domestic house unless noted):
 *   throw     — finished good, priced 12900, 2 colourways, second one imaged,
 *               stocked. Composition mentions "Merino".
 *   bolt      — fabric, no retail price, trade price 18776, one colourway with
 *               no image but a hi-res product asset, fully reserved (out).
 *   sparse    — finished good, priced 4900, NO colourways at all.
 *   many      — finished good, priced 9900, 8 colourways (exceeds the card cap).
 *   imported  — fabric on an INTERNATIONAL house, retail price set but hidden.
 *   hidden    — show_on_website = false, must never appear.
 */
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international)
     VALUES ($1, $2, 'New Zealand', 'NZD', false),
            ($3, $4, 'France', 'EUR', true)
     RETURNING id, is_international`,
    [
      'List Test House',
      `${PREFIX}-house`,
      'List Test Maison',
      `${PREFIX}-maison`,
    ]
  )
  const domestic = brands.find((b) => !b.is_international).id
  const international = brands.find((b) => b.is_international).id

  const { rows: products } = await pool.query(
    `INSERT INTO products
       (brand_id, name, slug, product_type, application, width, composition,
        price_band, retail_price_cents, trade_price_cents, currency,
        show_on_website, hi_res_asset_url)
     VALUES
       ($1, 'Alpine Throw',  $2, 'finished_good', 'Homeware',   NULL,    '100% Merino',   NULL,         12900, NULL,  'NZD', true,  NULL),
       ($1, 'Bolt of Linen', $3, 'fabric',        'Drapery',    '140cm', '100% Linen',    'NZ$120 / m', NULL,  18776, 'NZD', true,  'https://cdn.example/hi-res.jpg'),
       ($1, 'Sparse Cushion',$4, 'finished_good', 'Homeware',   NULL,    '100% Cotton',   NULL,         4900,  NULL,  'NZD', true,  NULL),
       ($1, 'Many Ways',     $5, 'finished_good', 'Homeware',   NULL,    '100% Wool',     NULL,         9900,  NULL,  'NZD', true,  NULL),
       ($6, 'Imported Silk', $7, 'fabric',        'Upholstery', '130cm', '100% Silk',     'NZ$480 / m', 99900, 44400, 'NZD', true,  NULL),
       ($1, 'Hidden Thing',  $8, 'finished_good', 'Homeware',   NULL,    '100% Merino',   NULL,         1900,  NULL,  'NZD', false, NULL)
     RETURNING id, slug`,
    [
      domestic,
      `${PREFIX}-throw`,
      `${PREFIX}-bolt`,
      `${PREFIX}-sparse`,
      `${PREFIX}-many`,
      international,
      `${PREFIX}-imported`,
      `${PREFIX}-hidden`,
    ]
  )
  const idBySlug = new Map(products.map((p) => [p.slug, p.id]))

  // Throw: "Ash" has no image, "Bracken" does. Alphabetical order puts Ash
  // first, so the card image must come from Bracken (first NON-NULL image).
  const { rows: throwColourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku, image_url, hex_tones)
     VALUES ($1, 'Ash',     $2, NULL,                          $4),
            ($1, 'Bracken', $3, 'https://cdn.example/bracken.jpg', $5)
     RETURNING id, name`,
    [
      idBySlug.get(`${PREFIX}-throw`),
      `${PREFIX}-THROW-ASH`,
      `${PREFIX}-THROW-BRK`,
      JSON.stringify(['#cccccc']),
      JSON.stringify(['#7a5c3e', '#3d2f22']),
    ]
  )
  const throwAsh = throwColourways.find((c) => c.name === 'Ash').id

  const { rows: boltColourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Natural', $2)
     RETURNING id`,
    [idBySlug.get(`${PREFIX}-bolt`), `${PREFIX}-BOLT-NAT`]
  )

  const { rows: manyColourways } = await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     SELECT $1, 'Way ' || n, $2 || n
       FROM generate_series(1, 8) AS n
     RETURNING id`,
    [idBySlug.get(`${PREFIX}-many`), `${PREFIX}-MANY-`]
  )

  await pool.query(
    `INSERT INTO colourways (product_id, name, sku)
     VALUES ($1, 'Ivoire', $2)`,
    [idBySlug.get(`${PREFIX}-imported`), `${PREFIX}-IMP-IVO`]
  )

  // Throw "Ash" stocked -> product in stock. Bolt fully reserved -> out of
  // stock. "Many" has colourways but no inventory rows at all -> out of stock.
  await pool.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, 20, 5, 'units'), ($2, 30, 30, 'metres')`,
    [throwAsh, boltColourways[0].id]
  )
  expect(manyColourways).toHaveLength(8)
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

describe('GET /catalogue/products — merchandising fields', () => {
  let pool
  let app
  const cookies = {}

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

    const signUp = async (url, local) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload: { email: testEmail(local), password: PASSWORD, name: local },
      })
      expect(response.statusCode).toBe(201)
      cookies[local] = sessionCookieFrom(response)
    }
    await signUp('/auth/register', 'customer')
    await signUp('/auth/trade-application', 'trader')
    await signUp('/auth/trade-application', 'pending')
    await pool.query('UPDATE users SET trade_approved = true WHERE email = $1', [
      testEmail('trader'),
    ])
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  describe('imagery', () => {
    it('uses the first colourway image that is actually set', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'throw').image_url).toBe('https://cdn.example/bracken.jpg')
    })

    it("falls back to the product's hi-res asset when no colourway is imaged", async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'bolt').image_url).toBe('https://cdn.example/hi-res.jpg')
    })

    it('is null when neither exists, rather than absent', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'sparse').image_url).toBeNull()
    })
  })

  describe('availability', () => {
    it('is in stock when any colourway has uncommitted quantity', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'throw').in_stock).toBe(true)
    })

    it('is out of stock when every colourway is fully reserved', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'bolt').in_stock).toBe(false)
    })

    it('is out of stock when colourways have no inventory row at all', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'many').in_stock).toBe(false)
    })

    it('is out of stock when the product has no colourways at all', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      const sparse = bySlug(body, 'sparse')
      expect(sparse.in_stock).toBe(false)
      expect(sparse.colourway_count).toBe(0)
      expect(sparse.colourways).toEqual([])
    })
  })

  describe('colourway strip', () => {
    it('carries name, sku and hex tones in alphabetical order', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      const product = bySlug(body, 'throw')
      expect(product.colourway_count).toBe(2)
      expect(product.colourways.map((c) => c.name)).toEqual(['Ash', 'Bracken'])
      expect(product.colourways[1]).toEqual({
        name: 'Bracken',
        sku: `${PREFIX}-THROW-BRK`,
        hex_tones: ['#7a5c3e', '#3d2f22'],
      })
    })

    it('caps the strip but still reports the true colourway count', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      const product = bySlug(body, 'many')
      expect(product.colourway_count).toBe(8)
      expect(product.colourways).toHaveLength(CARD_SWATCH_LIMIT)
    })
  })

  describe('search (q)', () => {
    it('matches the product name, case-insensitively', async () => {
      const body = (await get(app, `/catalogue/products?limit=100&q=alpine`)).json()
      expect(only(body).map((p) => p.slug)).toEqual([`${PREFIX}-throw`])
    })

    it('matches the house name', async () => {
      const body = (await get(app, `/catalogue/products?limit=100&q=Maison`)).json()
      expect(only(body).map((p) => p.slug)).toEqual([`${PREFIX}-imported`])
    })

    it('matches composition', async () => {
      const body = (await get(app, `/catalogue/products?limit=100&q=merino`)).json()
      // Hidden Thing is also 100% Merino but is not on the website.
      expect(only(body).map((p) => p.slug)).toEqual([`${PREFIX}-throw`])
    })

    it('matches a colourway name or SKU', async () => {
      const byName = (await get(app, `/catalogue/products?limit=100&q=bracken`)).json()
      expect(only(byName).map((p) => p.slug)).toEqual([`${PREFIX}-throw`])

      const bySku = (await get(app, `/catalogue/products?limit=100&q=BOLT-NAT`)).json()
      expect(only(bySku).map((p) => p.slug)).toEqual([`${PREFIX}-bolt`])
    })

    it('narrows the meta total, not just the page', async () => {
      const all = (await get(app, '/catalogue/products?limit=100')).json()
      const some = (await get(app, `/catalogue/products?limit=100&q=alpine`)).json()
      expect(some.meta.total).toBeLessThan(all.meta.total)
      expect(some.meta.total).toBe(some.products.length)
    })

    it('treats LIKE wildcards as literal characters', async () => {
      // "100%" must not behave like "100" followed by match-anything.
      const literal = (await get(app, '/catalogue/products?limit=100&q=100%25 Silk')).json()
      expect(only(literal).map((p) => p.slug)).toEqual([`${PREFIX}-imported`])

      const underscore = (await get(app, '/catalogue/products?limit=100&q=_')).json()
      expect(only(underscore)).toEqual([])
    })

    it('combines with the exact-match filters', async () => {
      const body = (
        await get(app, `/catalogue/products?limit=100&q=100%25&product_type=fabric`)
      ).json()
      expect(only(body).map((p) => p.slug).sort()).toEqual(
        [`${PREFIX}-bolt`, `${PREFIX}-imported`].sort()
      )
    })

    it('ignores a blank search rather than matching nothing', async () => {
      const all = (await get(app, '/catalogue/products?limit=100')).json()
      const blank = (await get(app, '/catalogue/products?limit=100&q=%20')).json()
      expect(blank.meta.total).toBe(all.meta.total)
    })
  })

  describe('sort', () => {
    it('defaults to name and reports it in meta', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(body.meta.sort).toBe('name')
      const names = body.products.map((p) => p.name)
      expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names)
    })

    it('orders by visible price ascending with unpriced products last', async () => {
      const body = (
        await get(app, `/catalogue/products?limit=100&sort=price_asc&brand=${PREFIX}-house`)
      ).json()
      expect(body.products.map((p) => p.slug)).toEqual([
        `${PREFIX}-sparse`, // 4900
        `${PREFIX}-many`, // 9900
        `${PREFIX}-throw`, // 12900
        `${PREFIX}-bolt`, // no retail price -> last
      ])
    })

    it('orders by visible price descending', async () => {
      const body = (
        await get(app, `/catalogue/products?limit=100&sort=price_desc&brand=${PREFIX}-house`)
      ).json()
      expect(body.products.map((p) => p.slug).slice(0, 3)).toEqual([
        `${PREFIX}-throw`,
        `${PREFIX}-many`,
        `${PREFIX}-sparse`,
      ])
    })

    it('never orders on a price the shopper cannot see', async () => {
      // The imported fabric's retail price (99900) is the highest of the whole
      // fixture set, but it is hidden — so it must sort as unpriced, not first.
      const body = (await get(app, '/catalogue/products?limit=100&sort=price_desc')).json()
      const slugs = only(body).map((p) => p.slug)
      expect(slugs.indexOf(`${PREFIX}-imported`)).toBeGreaterThan(
        slugs.indexOf(`${PREFIX}-throw`)
      )
    })

    it('rejects an unknown sort key with 400', async () => {
      const response = await get(app, '/catalogue/products?sort=cheapest')
      expect(response.statusCode).toBe(400)
    })
  })

  describe('trade pricing', () => {
    it('is absent for anonymous shoppers', async () => {
      const body = (await get(app, '/catalogue/products?limit=100')).json()
      expect(bySlug(body, 'bolt')).not.toHaveProperty('trade_price_cents')
    })

    it('is absent for a plain customer', async () => {
      const body = (await get(app, '/catalogue/products?limit=100', cookies.customer)).json()
      expect(bySlug(body, 'bolt')).not.toHaveProperty('trade_price_cents')
    })

    it('is absent for an unapproved trade applicant', async () => {
      const body = (await get(app, '/catalogue/products?limit=100', cookies.pending)).json()
      expect(bySlug(body, 'bolt')).not.toHaveProperty('trade_price_cents')
    })

    it('is present for an approved trade user', async () => {
      const body = (await get(app, '/catalogue/products?limit=100', cookies.trader)).json()
      expect(bySlug(body, 'bolt').trade_price_cents).toBe(18776)
    })

    it('still hides the retail price of an international house from trade users', async () => {
      const body = (await get(app, '/catalogue/products?limit=100', cookies.trader)).json()
      const imported = bySlug(body, 'imported')
      expect(imported.price_hidden).toBe(true)
      expect(imported).not.toHaveProperty('retail_price_cents')
      expect(imported.trade_price_cents).toBe(44400)
    })
  })

  it('never lists a product that is off the website', async () => {
    const body = (await get(app, '/catalogue/products?limit=100&q=hidden')).json()
    expect(only(body)).toEqual([])
  })
})
