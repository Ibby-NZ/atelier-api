import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'admin-cat-test'
const DOMAIN = 'admin-cat-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// Fixture brands are named so the server-generated slug carries PREFIX; cleanup
// deletes by that slug prefix and cascades to collections/products/colourways.
const brandName = (suffix) => `Admin Cat Test ${suffix}`

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Brand fixtures only — the staff/customer users are registered once in beforeAll
// and kept, because register shares a rate-limit bucket (10 / 15 min / IP) that
// re-registering every test would exhaust.
const cleanupFixtures = (pool) =>
  pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

describe('back-office catalogue admin', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  // trade_only defaults to TRUE on create (a new house is closed until the
  // office opens it), but most of these fixtures are then checked against the
  // anonymous public catalogue — so the shared fixture opens the house and the
  // tests that care about the gate pass their own override.
  const createBrandFixture = async (suffix, overrides = {}) => {
    const response = await inject('POST', '/admin/brands', backofficeCookie, {
      name: brandName(suffix),
      currency: 'NZD',
      trade_only: false,
      ...overrides,
    })
    return response.json().brand
  }

  const createCollectionFixture = async (brandId, name) => {
    const response = await inject('POST', '/admin/collections', backofficeCookie, {
      brand_id: brandId,
      name,
    })
    return response.json().collection
  }

  const createProductFixture = async (brandId, overrides = {}) => {
    const response = await inject('POST', '/admin/products', backofficeCookie, {
      brand_id: brandId,
      name: 'Velvet One',
      product_type: 'fabric',
      currency: 'NZD',
      ...overrides,
    })
    return response.json().product
  }

  const createColourwayFixture = async (productId, overrides = {}) => {
    const response = await inject(
      'POST',
      `/admin/products/${productId}/colourways`,
      backofficeCookie,
      { name: 'Default', sku: `${PREFIX}-001`, ...overrides }
    )
    return response.json().colourway
  }

  // pg returns numeric columns as strings — callers coerce with Number().
  const inventoryForSku = async (sku) => {
    const { rows } = await pool.query(
      `SELECT i.qty_available, i.qty_reserved, i.unit
         FROM inventory i JOIN colourways c ON c.id = i.colourway_id
        WHERE c.sku = $1`,
      [sku]
    )
    return rows[0] ?? null
  }

  const colourwayCountFor = async (productId) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM colourways WHERE product_id = $1`,
      [productId]
    )
    return rows[0].count
  }

  const publicProductSlugs = async (brandSlug) => {
    const response = await inject('GET', `/catalogue/products?brand=${brandSlug}`, null)
    return response.json().products.map((product) => product.slug)
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
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    await cleanupFixtures(pool)
    await deleteUsers(pool)

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
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  describe('access control', () => {
    it('rejects an anonymous brand list with 401', async () => {
      const response = await inject('GET', '/admin/brands', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a customer brand list with 403', async () => {
      const response = await inject('GET', '/admin/brands', customerCookie)
      expect(response.statusCode).toBe(403)
    })

    // Body validation runs before the preHandler, so send a valid payload —
    // otherwise this would assert Ajv's 400 instead of the auth failure.
    it('rejects an anonymous brand create with 401', async () => {
      const response = await inject('POST', '/admin/brands', null, {
        name: brandName('Anon'),
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(401)
    })

    it('rejects a customer brand create with 403', async () => {
      const response = await inject('POST', '/admin/brands', customerCookie, {
        name: brandName('Shopper'),
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(403)
    })

    it('rejects an anonymous collection list with 401', async () => {
      const response = await inject('GET', '/admin/collections', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a customer collection list with 403', async () => {
      const response = await inject('GET', '/admin/collections', customerCookie)
      expect(response.statusCode).toBe(403)
    })

    it('rejects an anonymous product list with 401', async () => {
      const response = await inject('GET', '/admin/products', null)
      expect(response.statusCode).toBe(401)
    })

    it('rejects a customer product list with 403', async () => {
      const response = await inject('GET', '/admin/products', customerCookie)
      expect(response.statusCode).toBe(403)
    })

    it('rejects a customer product create with 403', async () => {
      const response = await inject('POST', '/admin/products', customerCookie, {
        brand_id: 1,
        name: 'Shopper Special',
        product_type: 'fabric',
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(403)
    })

    // The guard runs before the handler, so an unknown product id is still a 401.
    it('rejects an anonymous colourway create with 401', async () => {
      const response = await inject(
        'POST',
        '/admin/products/99999999/colourways',
        null,
        { name: 'Default', sku: `${PREFIX}-anon` }
      )
      expect(response.statusCode).toBe(401)
    })

    it('rejects a customer colourway patch with 403', async () => {
      const response = await inject(
        'PATCH',
        '/admin/colourways/99999999',
        customerCookie,
        { name: 'Nope' }
      )
      expect(response.statusCode).toBe(403)
    })
  })

  describe('POST /admin/brands', () => {
    it('creates a brand with a server-generated slug', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('House'),
        currency: 'NZD',
        country: 'New Zealand',
        story: 'A test house.',
      })
      expect(response.statusCode).toBe(201)
      const { brand } = response.json()
      expect(brand.id).toBeGreaterThan(0)
      expect(brand.slug).toBe(`${PREFIX}-house`)
      expect(brand.name).toBe(brandName('House'))
      expect(brand.currency).toBe('NZD')
      expect(brand.country).toBe('New Zealand')
      expect(brand.story).toBe('A test house.')
      // Defaults to a domestic brand unless the caller says otherwise.
      expect(brand.is_international).toBe(false)
    })

    it('rejects a duplicate brand name with 409', async () => {
      await createBrandFixture('House')
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('House'),
        currency: 'EUR',
      })
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/already exists/i)
    })

    it('strips diacritics when generating the slug', async () => {
      const brand = await createBrandFixture('Métaphores')
      expect(brand.slug).toBe(`${PREFIX}-metaphores`)
    })

    it('rejects a punctuation-only name with 422', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: '!!!',
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/letter or number/i)
    })

    it('rejects a whitespace-only name with 422', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: '   ',
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(422)
    })

    // Slugs are server-generated. Fastify's Ajv runs with removeAdditional: true,
    // so `additionalProperties: false` strips a client-supplied slug rather than
    // rejecting it — what matters is that it can never reach the database.
    it('ignores a client-supplied slug', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('Custom'),
        currency: 'NZD',
        slug: 'hand-picked',
      })
      expect(response.statusCode).toBe(201)
      expect(response.json().brand.slug).toBe(`${PREFIX}-custom`)
    })

    it('rejects a missing currency with 400', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('NoCurrency'),
      })
      expect(response.statusCode).toBe(400)
    })

    it('rejects a malformed currency with 400', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('BadCurrency'),
        currency: 'nzd',
      })
      expect(response.statusCode).toBe(400)
    })

    it('stores a website URL on create', async () => {
      const brand = await createBrandFixture('House', {
        website_url: 'https://www.pierrefrey.com',
      })
      expect(brand.website_url).toBe('https://www.pierrefrey.com')
    })

    // The value becomes a public storefront href, so only http(s) may be stored.
    it('rejects a schemeless website URL with 422', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('NoScheme'),
        currency: 'NZD',
        website_url: 'pierrefrey.com',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/full URL/i)
    })

    it('rejects a javascript: website URL with 422', async () => {
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('Sneaky'),
        currency: 'NZD',
        website_url: 'javascript:alert(1)',
      })
      expect(response.statusCode).toBe(422)
    })
  })

  describe('GET /admin/brands', () => {
    it('lists brands with their ids', async () => {
      const created = await createBrandFixture('House')
      const response = await inject('GET', '/admin/brands', backofficeCookie)
      expect(response.statusCode).toBe(200)
      const brand = response.json().brands.find((row) => row.id === created.id)
      expect(brand.slug).toBe(`${PREFIX}-house`)
      expect(brand.name).toBe(brandName('House'))
    })
  })

  describe('PATCH /admin/brands/:id', () => {
    it('updates a subset of fields and leaves the slug untouched', async () => {
      const created = await createBrandFixture('House', { story: 'Old story.' })
      const response = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { story: 'New story.', is_international: true }
      )
      expect(response.statusCode).toBe(200)
      const { brand } = response.json()
      expect(brand.story).toBe('New story.')
      expect(brand.is_international).toBe(true)
      expect(brand.name).toBe(brandName('House'))
      expect(brand.slug).toBe(`${PREFIX}-house`)
    })

    it('returns 404 for an unknown brand id', async () => {
      const response = await inject('PATCH', '/admin/brands/99999999', backofficeCookie, {
        story: 'Nobody home.',
      })
      expect(response.statusCode).toBe(404)
    })

    // The slug is stripped as an unknown property, leaving an empty patch that
    // minProperties rejects — so a rename attempt cannot slip through.
    it('rejects a slug change with 400', async () => {
      const created = await createBrandFixture('House')
      const response = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { slug: 'renamed' }
      )
      expect(response.statusCode).toBe(400)
    })

    it('rejects an empty patch with 400', async () => {
      const created = await createBrandFixture('House')
      const response = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(400)
    })

    it('rejects a non-numeric id with 400', async () => {
      const response = await inject('PATCH', '/admin/brands/not-a-number', backofficeCookie, {
        story: 'x',
      })
      expect(response.statusCode).toBe(400)
    })

    it('sets, clears and validates the website URL', async () => {
      const created = await createBrandFixture('House')

      const set = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        website_url: 'https://www.dedar.com',
      })
      expect(set.statusCode).toBe(200)
      expect(set.json().brand.website_url).toBe('https://www.dedar.com')

      // Explicit null clears the field (absent key would leave it alone).
      const clear = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        website_url: null,
      })
      expect(clear.statusCode).toBe(200)
      expect(clear.json().brand.website_url).toBeNull()

      const bad = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        website_url: 'not a url',
      })
      expect(bad.statusCode).toBe(422)
    })
  })

  describe('collections', () => {
    it('creates a collection under a brand', async () => {
      const brand = await createBrandFixture('House')
      const response = await inject('POST', '/admin/collections', backofficeCookie, {
        brand_id: brand.id,
        name: 'Spring Two Six',
      })
      expect(response.statusCode).toBe(201)
      const { collection } = response.json()
      expect(collection.id).toBeGreaterThan(0)
      expect(collection.brand_id).toBe(brand.id)
      expect(collection.brand_name).toBe(brandName('House'))
      expect(collection.name).toBe('Spring Two Six')
      expect(collection.slug).toBe('spring-two-six')
    })

    it('allows the same collection name under a different brand', async () => {
      const first = await createBrandFixture('House')
      const second = await createBrandFixture('Mill')
      await createCollectionFixture(first.id, 'Spring Two Six')
      const response = await inject('POST', '/admin/collections', backofficeCookie, {
        brand_id: second.id,
        name: 'Spring Two Six',
      })
      expect(response.statusCode).toBe(201)
    })

    it('rejects a duplicate collection name in the same brand with 409', async () => {
      const brand = await createBrandFixture('House')
      await createCollectionFixture(brand.id, 'Spring Two Six')
      const response = await inject('POST', '/admin/collections', backofficeCookie, {
        brand_id: brand.id,
        name: 'Spring Two Six',
      })
      expect(response.statusCode).toBe(409)
    })

    it('rejects an unknown brand_id with 422', async () => {
      const response = await inject('POST', '/admin/collections', backofficeCookie, {
        brand_id: 99999999,
        name: 'Orphan',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/does not exist/i)
    })

    it('lists collections for a brand with the brand name', async () => {
      const brand = await createBrandFixture('House')
      const other = await createBrandFixture('Mill')
      await createCollectionFixture(brand.id, 'Spring Two Six')
      await createCollectionFixture(other.id, 'Autumn Two Six')

      const response = await inject(
        'GET',
        `/admin/collections?brand_id=${brand.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const { collections } = response.json()
      expect(collections).toHaveLength(1)
      expect(collections[0].name).toBe('Spring Two Six')
      expect(collections[0].brand_name).toBe(brandName('House'))
    })

    it('stores and edits tile editorial (description + image), validating the image URL', async () => {
      const brand = await createBrandFixture('House')
      const created = await inject('POST', '/admin/collections', backofficeCookie, {
        brand_id: brand.id,
        name: 'Giverny',
        description: 'Archival prints, reissued.',
        image_url: 'https://cdn.example/giverny.jpg',
      })
      expect(created.statusCode).toBe(201)
      expect(created.json().collection).toMatchObject({
        description: 'Archival prints, reissued.',
        image_url: 'https://cdn.example/giverny.jpg',
      })
      const id = created.json().collection.id

      // Editorial-only patch: name is no longer required.
      const patched = await inject('PATCH', `/admin/collections/${id}`, backofficeCookie, {
        description: 'New season copy.',
        image_url: null,
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().collection).toMatchObject({
        name: 'Giverny',
        description: 'New season copy.',
        image_url: null,
      })

      // The image lands in a public <img src>, so the http(s)-only rule applies.
      const bad = await inject('PATCH', `/admin/collections/${id}`, backofficeCookie, {
        image_url: 'javascript:alert(1)',
      })
      expect(bad.statusCode).toBe(422)
      expect(bad.json().message).toMatch(/Image/)
    })

    it('rejects an empty collection patch with 400', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Giverny')
      const response = await inject(
        'PATCH',
        `/admin/collections/${collection.id}`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(400)
    })

    it('renames a collection without changing its slug', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      const response = await inject(
        'PATCH',
        `/admin/collections/${collection.id}`,
        backofficeCookie,
        { name: 'Spring/Summer Two Six' }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().collection.name).toBe('Spring/Summer Two Six')
      expect(response.json().collection.slug).toBe('spring-two-six')
    })

    it('returns 404 when patching an unknown collection', async () => {
      const response = await inject(
        'PATCH',
        '/admin/collections/99999999',
        backofficeCookie,
        { name: 'Ghost' }
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /admin/products', () => {
    // Fabric slugs are brand-prefixed (matching the seed), so two houses can both
    // sell an "Atlas" without colliding on the public URL.
    it('creates a fabric with a brand-prefixed slug', async () => {
      const brand = await createBrandFixture('House')
      const response = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brand.id,
        name: 'Velvet One',
        product_type: 'fabric',
        currency: 'NZD',
        composition: '100% linen',
        width: '140cm',
        trade_price_cents: 12500,
      })
      expect(response.statusCode).toBe(201)
      const { product } = response.json()
      expect(product.id).toBeGreaterThan(0)
      expect(product.slug).toBe(`${PREFIX}-house-velvet-one`)
      expect(product.brand_id).toBe(brand.id)
      expect(product.brand_name).toBe(brandName('House'))
      expect(product.product_type).toBe('fabric')
      expect(product.composition).toBe('100% linen')
      expect(product.trade_price_cents).toBe(12500)
      // Nothing is published until staff say so.
      expect(product.show_on_website).toBe(false)
      expect(product.colourways).toEqual([])
    })

    it('creates a finished good with a name-only slug', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id, {
        name: brandName('Cushion'),
        product_type: 'finished_good',
        retail_price_cents: 8900,
      })
      expect(product.slug).toBe(`${PREFIX}-cushion`)
      expect(product.retail_price_cents).toBe(8900)
    })

    it('rejects an unknown brand_id with 422', async () => {
      const response = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: 99999999,
        name: 'Orphan Cloth',
        product_type: 'fabric',
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/does not exist/i)
    })

    it('rejects a collection_id belonging to another brand with 422', async () => {
      const brand = await createBrandFixture('House')
      const other = await createBrandFixture('Mill')
      const collection = await createCollectionFixture(other.id, 'Spring Two Six')
      const response = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brand.id,
        name: 'Velvet One',
        product_type: 'fabric',
        currency: 'NZD',
        collection_id: collection.id,
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/does not belong/i)
    })

    it('accepts a collection_id from the same brand', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      const product = await createProductFixture(brand.id, {
        collection_id: collection.id,
      })
      expect(product.collection_id).toBe(collection.id)
      expect(product.collection_name).toBe('Spring Two Six')
    })

    it('rejects a duplicate product name for the same brand with 409', async () => {
      const brand = await createBrandFixture('House')
      await createProductFixture(brand.id)
      const response = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brand.id,
        name: 'Velvet One',
        product_type: 'fabric',
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(409)
    })

    it('rejects an unknown product_type with 400', async () => {
      const brand = await createBrandFixture('House')
      const response = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brand.id,
        name: 'Mystery',
        product_type: 'wallpaper',
        currency: 'NZD',
      })
      expect(response.statusCode).toBe(400)
    })

    it('rejects a negative price with 400', async () => {
      const brand = await createBrandFixture('House')
      const response = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brand.id,
        name: 'Cheap One',
        product_type: 'fabric',
        currency: 'NZD',
        retail_price_cents: -1,
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('GET /admin/products', () => {
    it('lists hidden products too, with a colourway count', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      await createColourwayFixture(product.id)

      const response = await inject(
        'GET',
        `/admin/products?brand_id=${brand.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const { products } = response.json()
      expect(products).toHaveLength(1)
      expect(products[0].id).toBe(product.id)
      expect(products[0].show_on_website).toBe(false)
      expect(products[0].brand_name).toBe(brandName('House'))
      // ::int cast in SQL — a bigint COUNT would arrive as a string.
      expect(products[0].colourway_count).toBe(1)
    })

    it('narrows the list to one brand', async () => {
      const brand = await createBrandFixture('House')
      const other = await createBrandFixture('Mill')
      await createProductFixture(brand.id)
      await createProductFixture(other.id, { name: 'Twill Two' })

      const response = await inject(
        'GET',
        `/admin/products?brand_id=${other.id}`,
        backofficeCookie
      )
      expect(response.json().products.map((row) => row.name)).toEqual(['Twill Two'])
    })
  })

  describe('GET /admin/products/:id', () => {
    it('returns colourways with their inventory snapshot', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      await createColourwayFixture(product.id, { hex_tones: ['#AABBCC'] })

      const response = await inject(
        'GET',
        `/admin/products/${product.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const detail = response.json().product
      expect(detail.colourways).toHaveLength(1)
      expect(detail.colourways[0].sku).toBe(`${PREFIX}-001`)
      expect(detail.colourways[0].hex_tones).toEqual(['#AABBCC'])
      expect(detail.colourways[0].inventory.unit).toBe('metres')
      expect(Number(detail.colourways[0].inventory.qty_available)).toBe(0)
    })

    it('returns 404 for an unknown product id', async () => {
      const response = await inject('GET', '/admin/products/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('PATCH /admin/products/:id', () => {
    it('publishes a product to the public catalogue', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      expect(await publicProductSlugs(brand.slug)).toEqual([])

      const response = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { show_on_website: true }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().product.show_on_website).toBe(true)
      expect(await publicProductSlugs(brand.slug)).toEqual([product.slug])
    })

    it('updates spec fields without touching the slug', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const response = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { name: 'Velvet Two', lead_time: '6 weeks', retail_price_cents: null }
      )
      expect(response.statusCode).toBe(200)
      const updated = response.json().product
      expect(updated.name).toBe('Velvet Two')
      expect(updated.lead_time).toBe('6 weeks')
      expect(updated.retail_price_cents).toBe(null)
      expect(updated.slug).toBe(product.slug)
    })

    it('clears the collection with an explicit null', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      const product = await createProductFixture(brand.id, {
        collection_id: collection.id,
      })
      const response = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { collection_id: null }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().product.collection_id).toBe(null)
    })

    it('rejects a collection_id from another brand with 422', async () => {
      const brand = await createBrandFixture('House')
      const other = await createBrandFixture('Mill')
      const collection = await createCollectionFixture(other.id, 'Spring Two Six')
      const product = await createProductFixture(brand.id)
      const response = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { collection_id: collection.id }
      )
      expect(response.statusCode).toBe(422)
    })

    // product_type is create-only: the inventory unit is derived from it.
    it('rejects a product_type change with 400', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const response = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { product_type: 'finished_good' }
      )
      expect(response.statusCode).toBe(400)
    })

    it('ignores product_type and brand_id sent alongside a real field', async () => {
      const brand = await createBrandFixture('House')
      const other = await createBrandFixture('Mill')
      const product = await createProductFixture(brand.id)
      const response = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { width: '150cm', product_type: 'finished_good', brand_id: other.id }
      )
      expect(response.statusCode).toBe(200)
      const updated = response.json().product
      expect(updated.width).toBe('150cm')
      expect(updated.product_type).toBe('fabric')
      expect(updated.brand_id).toBe(brand.id)
    })

    it('returns 404 for an unknown product id', async () => {
      const response = await inject(
        'PATCH',
        '/admin/products/99999999',
        backofficeCookie,
        { width: '150cm' }
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('POST /admin/products/:id/colourways', () => {
    it('creates the colourway and its inventory row in metres for a fabric', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)

      const response = await inject(
        'POST',
        `/admin/products/${product.id}/colourways`,
        backofficeCookie,
        { name: 'Ink', sku: `${PREFIX}-001`, image_url: 'https://cdn.test/ink.jpg' }
      )
      expect(response.statusCode).toBe(201)
      const { colourway } = response.json()
      expect(colourway.id).toBeGreaterThan(0)
      expect(colourway.product_id).toBe(product.id)
      expect(colourway.name).toBe('Ink')
      expect(colourway.sku).toBe(`${PREFIX}-001`)
      expect(colourway.image_url).toBe('https://cdn.test/ink.jpg')
      expect(colourway.inventory.unit).toBe('metres')

      const inventory = await inventoryForSku(`${PREFIX}-001`)
      expect(inventory.unit).toBe('metres')
      expect(Number(inventory.qty_available)).toBe(0)
      expect(Number(inventory.qty_reserved)).toBe(0)
    })

    it('creates the inventory row in units for a finished good', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id, {
        name: brandName('Cushion'),
        product_type: 'finished_good',
      })
      await createColourwayFixture(product.id, { sku: `${PREFIX}-002` })

      const inventory = await inventoryForSku(`${PREFIX}-002`)
      expect(inventory.unit).toBe('units')
      expect(Number(inventory.qty_available)).toBe(0)
    })

    it('round-trips hex tones', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id, {
        hex_tones: ['#AABBCC', '#112233'],
      })
      expect(colourway.hex_tones).toEqual(['#AABBCC', '#112233'])
    })

    it('defaults hex tones to null when omitted', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      expect(colourway.hex_tones).toBe(null)
    })

    it('rejects a malformed hex tone with 400', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const response = await inject(
        'POST',
        `/admin/products/${product.id}/colourways`,
        backofficeCookie,
        { name: 'Ink', sku: `${PREFIX}-003`, hex_tones: ['nope'] }
      )
      expect(response.statusCode).toBe(400)
    })

    // The colourway + inventory pair is one transaction: a rejected SKU must not
    // leave a colourway behind for the next attempt to trip over.
    it('rejects a duplicate sku with 409 and leaves no orphan colourway', async () => {
      const brand = await createBrandFixture('House')
      const first = await createProductFixture(brand.id)
      const second = await createProductFixture(brand.id, { name: 'Twill Two' })
      await createColourwayFixture(first.id, { sku: `${PREFIX}-dup` })

      const response = await inject(
        'POST',
        `/admin/products/${second.id}/colourways`,
        backofficeCookie,
        { name: 'Ink', sku: `${PREFIX}-dup` }
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/sku/i)
      expect(await colourwayCountFor(second.id)).toBe(0)
    })

    it('returns 404 for an unknown product', async () => {
      const response = await inject(
        'POST',
        '/admin/products/99999999/colourways',
        backofficeCookie,
        { name: 'Ink', sku: `${PREFIX}-ghost` }
      )
      expect(response.statusCode).toBe(404)
    })

    it('rejects a missing sku with 400', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const response = await inject(
        'POST',
        `/admin/products/${product.id}/colourways`,
        backofficeCookie,
        { name: 'Ink' }
      )
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PATCH /admin/colourways/:id', () => {
    // SKUs are editable: order lines reference colourway_id, not the SKU text.
    it('updates the name, sku and tones', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)

      const response = await inject(
        'PATCH',
        `/admin/colourways/${colourway.id}`,
        backofficeCookie,
        { name: 'Ink Blue', sku: `${PREFIX}-001-B`, hex_tones: ['#000011'] }
      )
      expect(response.statusCode).toBe(200)
      const updated = response.json().colourway
      expect(updated.name).toBe('Ink Blue')
      expect(updated.sku).toBe(`${PREFIX}-001-B`)
      expect(updated.hex_tones).toEqual(['#000011'])
      // The inventory row follows the colourway, not the SKU.
      expect(updated.inventory.unit).toBe('metres')
    })

    it('rejects a duplicate sku with 409', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const first = await createColourwayFixture(product.id, { sku: `${PREFIX}-001` })
      await createColourwayFixture(product.id, { name: 'Other', sku: `${PREFIX}-002` })

      const response = await inject(
        'PATCH',
        `/admin/colourways/${first.id}`,
        backofficeCookie,
        { sku: `${PREFIX}-002` }
      )
      expect(response.statusCode).toBe(409)
    })

    it('rejects an empty patch with 400', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      const response = await inject(
        'PATCH',
        `/admin/colourways/${colourway.id}`,
        backofficeCookie,
        {}
      )
      expect(response.statusCode).toBe(400)
    })

    it('returns 404 for an unknown colourway id', async () => {
      const response = await inject(
        'PATCH',
        '/admin/colourways/99999999',
        backofficeCookie,
        { name: 'Ghost' }
      )
      expect(response.statusCode).toBe(404)
    })
  })

  // Hard delete, wired to the lifecycle registry. The point of these tests is
  // the refusal: every child edge out of brands and collections is CASCADE or
  // SET NULL, so a bare `DELETE FROM brands` returns success while destroying
  // the catalogue under it. Probe semantics themselves are W1's
  // test/lifecycle-delete.test.js; what is asserted here is the HTTP contract
  // the CRM's delete dialog reads.
  describe('DELETE /admin/brands/:id', () => {
    const blockerFor = (body, relation) =>
      body.blockers.find((blocker) => blocker.relation === relation)

    const brandExists = async (id) => {
      const { rows } = await pool.query('SELECT 1 FROM brands WHERE id = $1', [id])
      return rows.length === 1
    }

    it('rejects an anonymous delete with 401', async () => {
      const brand = await createBrandFixture('Anon Delete')
      const response = await inject('DELETE', `/admin/brands/${brand.id}`, null)
      expect(response.statusCode).toBe(401)
      expect(await brandExists(brand.id)).toBe(true)
    })

    it('rejects a customer delete with 403', async () => {
      const brand = await createBrandFixture('Shopper Delete')
      const response = await inject('DELETE', `/admin/brands/${brand.id}`, customerCookie)
      expect(response.statusCode).toBe(403)
      expect(await brandExists(brand.id)).toBe(true)
    })

    it('deletes an unreferenced house and returns 200', async () => {
      const brand = await createBrandFixture('Empty House')

      const response = await inject('DELETE', `/admin/brands/${brand.id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'brand', id: brand.id } })
      expect(await brandExists(brand.id)).toBe(false)
    })

    // Both counts, in one refusal: staff need to know everything in the way, not
    // the first thing the server tripped over.
    it('refuses a house with products AND collections, naming both counts', async () => {
      const brand = await createBrandFixture('Stocked House')
      await createCollectionFixture(brand.id, 'Spring')
      await createProductFixture(brand.id)

      const response = await inject('DELETE', `/admin/brands/${brand.id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)

      const body = response.json()
      expect(blockerFor(body, 'products')).toMatchObject({
        label: 'products',
        count: 1,
        capped: false,
      })
      expect(blockerFor(body, 'collections')).toMatchObject({
        label: 'collections',
        count: 1,
        capped: false,
      })
      expect(body.message).toContain('1 products')
      expect(body.message).toContain('1 collections')
      // The dialog offers "Archive instead" on the strength of this flag.
      expect(body.archivable).toBe(true)
      // Nothing was destroyed: the whole point of probing before deleting.
      expect(await brandExists(brand.id)).toBe(true)
      const listed = await inject('GET', `/admin/products?brand_id=${brand.id}`, backofficeCookie)
      expect(listed.json().products).toHaveLength(1)
    })

    // The trap staff hit first: archiving the catalogue does not unblock the
    // house, because archiving is not deletion and a delete must never destroy
    // the archive.
    it('still refuses when the only product is archived', async () => {
      const brand = await createBrandFixture('Archived Stock')
      const product = await createProductFixture(brand.id)
      const archived = await inject(
        'POST',
        `/admin/products/${product.id}/archive`,
        backofficeCookie
      )
      expect(archived.statusCode).toBe(200)

      const response = await inject('DELETE', `/admin/brands/${brand.id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(blockerFor(response.json(), 'products').count).toBe(1)
    })

    it('returns 404 for an unknown house id', async () => {
      const response = await inject('DELETE', '/admin/brands/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
      expect(response.json().blockers).toEqual([])
    })
  })

  describe('DELETE /admin/collections/:id', () => {
    const collectionIdFor = async (productId) => {
      const { rows } = await pool.query('SELECT collection_id FROM products WHERE id = $1', [
        productId,
      ])
      return rows[0]?.collection_id ?? null
    }

    it('rejects a customer delete with 403', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Autumn')
      const response = await inject(
        'DELETE',
        `/admin/collections/${collection.id}`,
        customerCookie
      )
      expect(response.statusCode).toBe(403)
    })

    it('deletes an empty collection and leaves its house alone', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Autumn')

      const response = await inject(
        'DELETE',
        `/admin/collections/${collection.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        deleted: { entity: 'collection', id: collection.id },
      })

      const remaining = await inject(
        'GET',
        `/admin/collections?brand_id=${brand.id}`,
        backofficeCookie
      )
      expect(remaining.json().collections).toEqual([])
      const houses = await inject('GET', '/admin/brands', backofficeCookie)
      expect(houses.json().brands.map((row) => row.id)).toContain(brand.id)
    })

    // products.collection_id is SET NULL, so the database raises nothing here:
    // without the probe this delete would succeed and silently uncollect every
    // product in the collection, with nothing logged.
    it('refuses a collection holding products, and uncollects nothing', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Autumn')
      const product = await createProductFixture(brand.id, { collection_id: collection.id })
      expect(await collectionIdFor(product.id)).toBe(collection.id)

      const response = await inject(
        'DELETE',
        `/admin/collections/${collection.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)

      const body = response.json()
      expect(body.blockers).toEqual([
        { relation: 'products', label: 'products', count: 1, capped: false },
      ])
      expect(body.message).toContain('1 products')
      expect(body.archivable).toBe(true)
      // The SET NULL that did not happen.
      expect(await collectionIdFor(product.id)).toBe(collection.id)
    })

    it('returns 404 for an unknown collection id', async () => {
      const response = await inject('DELETE', '/admin/collections/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })
})
