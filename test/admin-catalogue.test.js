import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { deleteOrExplain } from '../src/lifecycle/delete.js'
import { resolveCartLines } from '../src/catalogue/line-prices.js'

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
// Orders go first: `order_lines.colourway_id` is the schema's one RESTRICT edge,
// so a brand cascade cannot get past an order line and the cleanup itself would
// raise 23503. Deleting the order cascades its lines.
const cleanupFixtures = async (pool) => {
  await pool.query('DELETE FROM orders WHERE order_number LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
}

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

  // Commerce fixtures for the delete tests. There is no admin route that creates
  // an order line, and the request flow would reserve stock as a side effect, so
  // these go in directly — an order line is the thing a catalogue delete must
  // never destroy, and its presence is the whole assertion.
  let orderSeq = 0
  const createOrderLineFixture = async (colourwayId) => {
    orderSeq += 1
    const { rows } = await pool.query(
      `INSERT INTO orders (order_number, kind, status)
            VALUES ($1, 'order_request', 'quote_requested')
         RETURNING id`,
      [`${PREFIX}-order-${orderSeq}`]
    )
    await pool.query(
      `INSERT INTO order_lines (order_id, colourway_id, qty, unit_price_cents)
            VALUES ($1, $2, 3, 0)`,
      [rows[0].id, colourwayId]
    )
    return rows[0].id
  }

  // The colourway create route always makes the stock row at 0/0; a delete is
  // only blocked once there is something on hand or spoken for.
  const setStock = (colourwayId, { available = 0, reserved = 0 }) =>
    pool.query(
      `UPDATE inventory SET qty_available = $2, qty_reserved = $3 WHERE colourway_id = $1`,
      [colourwayId, available, reserved]
    )

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

  // The re-read the CRM does after a write. Its counts are the interesting part:
  // they answer the same question DELETE /admin/brands/:id answers, so a screen
  // can grey the button out instead of discovering the refusal.
  describe('GET /admin/brands/:id', () => {
    it('returns the house with its collections and both child counts', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      await createProductFixture(brand.id)
      await createProductFixture(brand.id, { name: 'Velvet Two' })

      const response = await inject('GET', `/admin/brands/${brand.id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      const detail = response.json().brand
      expect(detail.id).toBe(brand.id)
      expect(detail.slug).toBe(`${PREFIX}-house`)
      expect(detail.product_count).toBe(2)
      expect(detail.collection_count).toBe(1)
      // Same shape the collections list returns, so one renderer serves both.
      expect(detail.collections).toHaveLength(1)
      expect(detail.collections[0]).toMatchObject({
        id: collection.id,
        brand_id: brand.id,
        brand_name: brandName('House'),
        name: 'Spring Two Six',
        slug: 'spring-two-six',
      })
    })

    it('counts archived children, because the delete probes do', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id)
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      await inject('POST', `/admin/products/${product.id}/archive`, backofficeCookie)
      await inject('POST', `/admin/collections/${collection.id}/archive`, backofficeCookie)

      const detail = (
        await inject('GET', `/admin/brands/${brand.id}`, backofficeCookie)
      ).json().brand
      expect(detail.product_count).toBe(1)
      expect(detail.collection_count).toBe(1)
      // Listed too, carrying archived_at — hiding the row would hide the reason
      // the delete below is refused.
      expect(detail.collections[0].archived_at).not.toBeNull()

      // The invariant the counts exist for: non-zero counts mean the delete is
      // refused with those same numbers. A count that skipped archived rows
      // would say "empty house" and then be contradicted by the 409.
      const refusal = await inject('DELETE', `/admin/brands/${brand.id}`, backofficeCookie)
      expect(refusal.statusCode).toBe(409)
      expect(refusal.json().blockers.map((blocker) => blocker.count)).toEqual([1, 1])
    })

    it('reads zero counts for a house a delete would accept', async () => {
      const brand = await createBrandFixture('House')
      const detail = (
        await inject('GET', `/admin/brands/${brand.id}`, backofficeCookie)
      ).json().brand
      expect(detail.product_count).toBe(0)
      expect(detail.collection_count).toBe(0)
      expect(detail.collections).toEqual([])

      expect(
        (await inject('DELETE', `/admin/brands/${brand.id}`, backofficeCookie)).statusCode
      ).toBe(200)
    })

    it('returns an archived house rather than 404', async () => {
      const brand = await createBrandFixture('House')
      await inject('POST', `/admin/brands/${brand.id}/archive`, backofficeCookie)

      // Archiving is reversible, so the row must stay readable — the restore
      // screen reads it back.
      const response = await inject('GET', `/admin/brands/${brand.id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().brand.archived_at).not.toBeNull()
    })

    it('returns 404 for an unknown brand id', async () => {
      const response = await inject('GET', '/admin/brands/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    it('rejects an anonymous caller with 401 and a customer with 403', async () => {
      const brand = await createBrandFixture('House')
      expect(
        (await inject('GET', `/admin/brands/${brand.id}`, null)).statusCode
      ).toBe(401)
      expect(
        (await inject('GET', `/admin/brands/${brand.id}`, customerCookie)).statusCode
      ).toBe(403)
    })
  })

  describe('PATCH /admin/brands/:id', () => {
    // Onboarding a supplier from the CRM ends here. getSupplier attaches terms
    // per house, so terms given to a brand-new supplier are invisible until one
    // of its houses points at it — which nothing could do before this.
    it('links a house to a supplier, and clears the link again', async () => {
      const created = await createBrandFixture('Linkable')
      // Conflict-proof: a run that fails between the insert and the cleanup
      // below would otherwise poison every later run.
      const { rows } = await pool.query(
        `INSERT INTO suppliers (name, slug) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [`${PREFIX} Supplier`, `${PREFIX}-supplier`]
      )
      const supplierId = rows[0].id

      const linked = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { supplier_id: supplierId }
      )
      expect(linked.statusCode).toBe(200)
      expect(linked.json().brand.supplier_id).toBe(supplierId)

      // Nobody invoices this house yet is a real state, so null is a value the
      // office can set, not an absence the whitelist skips.
      const cleared = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { supplier_id: null }
      )
      expect(cleared.statusCode).toBe(200)
      expect(cleared.json().brand.supplier_id).toBeNull()

      await pool.query('DELETE FROM suppliers WHERE id = $1', [supplierId])
    })

    // A RESTRICT edge answers 23503; without a mapping that reaches the office
    // as a 500, which tells them nothing they can act on.
    it('refuses an unknown supplier with 422, not 500', async () => {
      const created = await createBrandFixture('Unlinkable')
      const response = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { supplier_id: 2147483600 }
      )
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/supplier/i)
    })

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

    // The house page's opening line (16 Sep 2026 feedback). Nullable, patchable,
    // and public — the storefront prints it above the story.
    it('headline is null by default, patchable, and reaches the public brand', async () => {
      const created = await createBrandFixture('Headline House')
      expect(created.headline).toBeNull()
      const response = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { headline: 'Silk, woven in Lyon since 1787.' }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().brand.headline).toBe('Silk, woven in Lyon since 1787.')
      const pub = await app.inject({ method: 'GET', url: `/catalogue/brands/${created.slug}` })
      expect(pub.json().brand.headline).toBe('Silk, woven in Lyon since 1787.')
    })

    // The CRM toggle behind the storefront's /bespoke page and the enquiry form
    // on a house page: off at birth, and the public read model carries it.
    it('bespoke defaults to false, is patchable, and reaches the public brand', async () => {
      const created = await createBrandFixture('Commissions')
      expect(created.bespoke).toBe(false)
      const response = await inject(
        'PATCH',
        `/admin/brands/${created.id}`,
        backofficeCookie,
        { bespoke: true }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().brand.bespoke).toBe(true)
      const pub = await inject('GET', `/catalogue/brands/${created.slug}`)
      expect(pub.statusCode).toBe(200)
      expect(pub.json().brand.bespoke).toBe(true)
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

    // Same public-`src` gate as a collection's image, so the same three cases.
    it('sets, clears and validates the image URL', async () => {
      const created = await createBrandFixture('House', {
        image_url: 'https://www.atelier.co.nz/img/house.jpg',
      })
      expect(created.image_url).toBe('https://www.atelier.co.nz/img/house.jpg')

      const clear = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        image_url: null,
      })
      expect(clear.json().brand.image_url).toBeNull()

      const bad = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        image_url: 'javascript:alert(1)',
      })
      expect(bad.statusCode).toBe(422)
    })

    // The logo lands in the same public `<img src>` as the house image.
    it('sets, clears and validates the logo URL', async () => {
      const created = await createBrandFixture('House', {
        logo_url: 'https://www.atelier.co.nz/img/house-logo.png',
      })
      expect(created.logo_url).toBe('https://www.atelier.co.nz/img/house-logo.png')

      const clear = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        logo_url: null,
      })
      expect(clear.json().brand.logo_url).toBeNull()

      const bad = await inject('PATCH', `/admin/brands/${created.id}`, backofficeCookie, {
        logo_url: 'javascript:alert(1)',
      })
      expect(bad.statusCode).toBe(422)
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

    // 1 Oct 2026: the unit a product is priced and freighted per is the
    // product's, no longer its house's freight rate's.
    it('carries the unit it is sold per, set on create, changed and cleared by a patch', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id, { name: brandName('Miette'), unit: 'yard' })
      expect(product.unit).toBe('yard')

      const patched = await inject('PATCH', `/admin/products/${product.id}`, backofficeCookie, { unit: 'roll' })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().product.unit).toBe('roll')
      const cleared = await inject('PATCH', `/admin/products/${product.id}`, backofficeCookie, { unit: null })
      expect(cleared.json().product.unit).toBe(null)
      const furlong = await inject('PATCH', `/admin/products/${product.id}`, backofficeCookie, { unit: 'furlong' })
      expect(furlong.statusCode).toBe(400)
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

  describe('GET /admin/collections/:id', () => {
    it('returns the collection with its house name and product count', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      await createProductFixture(brand.id, { collection_id: collection.id })
      // Same house, no collection: a product with a null collection_id is normal
      // (the seed never assigns one), and it must not be counted here.
      await createProductFixture(brand.id, { name: 'Velvet Two' })

      const response = await inject(
        'GET',
        `/admin/collections/${collection.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const detail = response.json().collection
      expect(detail).toMatchObject({
        id: collection.id,
        brand_id: brand.id,
        brand_name: brandName('House'),
        name: 'Spring Two Six',
        slug: 'spring-two-six',
        product_count: 1,
      })
    })

    it('counts an archived product, because the delete probe does', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      const product = await createProductFixture(brand.id, {
        collection_id: collection.id,
      })
      await inject('POST', `/admin/products/${product.id}/archive`, backofficeCookie)

      const detail = (
        await inject('GET', `/admin/collections/${collection.id}`, backofficeCookie)
      ).json().collection
      expect(detail.product_count).toBe(1)

      // collection_id is SET NULL, so a delete that trusted a count which
      // skipped archived rows would report success and quietly uncollect this
      // product. The refusal agrees with the count.
      const refusal = await inject(
        'DELETE',
        `/admin/collections/${collection.id}`,
        backofficeCookie
      )
      expect(refusal.statusCode).toBe(409)
      expect(refusal.json().blockers[0].count).toBe(1)
    })

    it('returns an archived collection rather than 404', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      await inject('POST', `/admin/collections/${collection.id}/archive`, backofficeCookie)

      const response = await inject(
        'GET',
        `/admin/collections/${collection.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().collection.archived_at).not.toBeNull()
    })

    it('returns 404 for an unknown collection id', async () => {
      const response = await inject('GET', '/admin/collections/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    it('rejects an anonymous caller with 401 and a customer with 403', async () => {
      const brand = await createBrandFixture('House')
      const collection = await createCollectionFixture(brand.id, 'Spring Two Six')
      expect(
        (await inject('GET', `/admin/collections/${collection.id}`, null)).statusCode
      ).toBe(401)
      expect(
        (await inject('GET', `/admin/collections/${collection.id}`, customerCookie))
          .statusCode
      ).toBe(403)
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

    // One product per size is the model, so the size is a column on THIS row
    // rather than a variant beneath it — a bath sheet and a face cloth carry
    // different prices, and price lives on the product.
    it('carries a size and a description, and both round-trip through a patch', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id, {
        name: brandName('Bath Towel'),
        product_type: 'finished_good',
        size: '70 x 140 cm',
        description: 'Woven in Turkey, long-staple cotton, pre-washed.',
        retail_price_cents: 8900,
      })
      expect(product.size).toBe('70 x 140 cm')
      expect(product.description).toBe('Woven in Turkey, long-staple cotton, pre-washed.')

      const patched = await inject(
        'PATCH',
        `/admin/products/${product.id}`,
        backofficeCookie,
        { size: '100 x 150 cm', description: null }
      )
      expect(patched.statusCode).toBe(200)
      expect(patched.json().product.size).toBe('100 x 150 cm')
      // An explicit null clears it — the field is nullable, and "no description"
      // is a real state rather than an untouched one.
      expect(patched.json().product.description).toBe(null)
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

    // The CRM pages this list now: `meta.total` is the filtered total it
    // divides by to draw the pager, and the pages partition the result set.
    it('pages in a stable order with a filtered total', async () => {
      const brand = await createBrandFixture('Paged House')
      await createProductFixture(brand.id, { name: 'Alpha' })
      await createProductFixture(brand.id, { name: 'Bravo' })
      await createProductFixture(brand.id, { name: 'Charlie' })

      const first = await inject(
        'GET',
        `/admin/products?brand_id=${brand.id}&limit=2`,
        backofficeCookie
      )
      expect(first.json().meta).toMatchObject({ total: 3, page: 1, limit: 2 })
      expect(first.json().products.map((row) => row.name)).toEqual(['Alpha', 'Bravo'])

      const second = await inject(
        'GET',
        `/admin/products?brand_id=${brand.id}&limit=2&page=2`,
        backofficeCookie
      )
      expect(second.json().meta).toMatchObject({ total: 3, page: 2, limit: 2 })
      expect(second.json().products.map((row) => row.name)).toEqual(['Charlie'])
    })

    it('rejects a limit above the maximum with 400', async () => {
      const response = await inject('GET', '/admin/products?limit=500', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })

    it('searches by name and narrows by category', async () => {
      const brand = await createBrandFixture('Search House')
      await createProductFixture(brand.id, { name: 'Atlas Velvet', category: 'wallpaper' })
      await createProductFixture(brand.id, { name: 'Atlas Linen', category: 'fabric' })
      await createProductFixture(brand.id, { name: 'Bora Linen', category: 'fabric' })

      const byName = await inject(
        'GET',
        `/admin/products?brand_id=${brand.id}&q=atlas`,
        backofficeCookie
      )
      expect(byName.json().products.map((row) => row.name)).toEqual(['Atlas Linen', 'Atlas Velvet'])

      const byCategory = await inject(
        'GET',
        `/admin/products?brand_id=${brand.id}&category=fabric`,
        backofficeCookie
      )
      expect(byCategory.json().products.map((row) => row.name)).toEqual(['Atlas Linen', 'Bora Linen'])
      expect(byCategory.json().meta.total).toBe(2)
    })

    // A price band is a cents range over the figure the CRM bands on — retail
    // first, trade where there is no retail — and "No price" is neither.
    it('narrows by price range and by having no price at all', async () => {
      const brand = await createBrandFixture('Priced House')
      await createProductFixture(brand.id, { name: 'Cheap', retail_price_cents: 5000 })
      await createProductFixture(brand.id, { name: 'Trade only', trade_price_cents: 15000 })
      await createProductFixture(brand.id, { name: 'Dear', retail_price_cents: 25000 })
      await createProductFixture(brand.id, { name: 'Unpriced' })

      const list = (query) =>
        inject('GET', `/admin/products?brand_id=${brand.id}&${query}`, backofficeCookie)
      const names = (response) => response.json().products.map((row) => row.name)

      expect(names(await list('price_min_cents=10000&price_max_cents=20000'))).toEqual(['Trade only'])
      expect(names(await list('price_max_cents=9999'))).toEqual(['Cheap'])
      expect(names(await list('unpriced=true'))).toEqual(['Unpriced'])
      // The ceiling the CRM builds its band list from, over the whole catalogue.
      expect((await list('')).json().meta.max_price_cents).toBeGreaterThanOrEqual(25000)
    })

    it('narrows to the uncategorised with a flag, since "" cannot travel', async () => {
      const brand = await createBrandFixture('Sorted House')
      await createProductFixture(brand.id, { name: 'Filed', category: 'fabric' })
      await createProductFixture(brand.id, { name: 'Nobody looked' })

      const response = await inject(
        'GET',
        `/admin/products?brand_id=${brand.id}&uncategorised=true`,
        backofficeCookie
      )
      expect(response.json().products.map((row) => row.name)).toEqual(['Nobody looked'])
    })
  })

  // The Categories screen used to group the whole product list on the client;
  // now that the list pages, the counts come from here.
  describe('GET /admin/products/categories', () => {
    it('counts products per category under the same filters as the list', async () => {
      const brand = await createBrandFixture('Counted House')
      await createProductFixture(brand.id, { name: 'A', category: 'fabric' })
      await createProductFixture(brand.id, { name: 'B', category: 'fabric' })
      await createProductFixture(brand.id, { name: 'C', category: 'wallpaper' })
      const gone = await createProductFixture(brand.id, { name: 'D', category: 'wallpaper' })
      await inject('POST', `/admin/products/${gone.id}/archive`, backofficeCookie)
      await createProductFixture(brand.id, { name: 'E' })

      const response = await inject(
        'GET',
        `/admin/products/categories?brand_id=${brand.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().categories).toEqual([
        { category: 'fabric', count: 2 },
        { category: 'wallpaper', count: 1 },
        { category: null, count: 1 },
      ])

      const archived = await inject(
        'GET',
        `/admin/products/categories?brand_id=${brand.id}&include_archived=true`,
        backofficeCookie
      )
      expect(archived.json().categories.find((row) => row.category === 'wallpaper').count).toBe(2)
    })

    it('is backoffice-only', async () => {
      expect((await inject('GET', '/admin/products/categories', customerCookie)).statusCode).toBe(403)
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

    // A variation sells at its own price when it has one, else its product's —
    // each figure on its own, on every read that prices a line.
    it('sets and clears a variation\'s own prices', async () => {
      const brand = await createBrandFixture('House')
      const product = await createProductFixture(brand.id, { retail_price_cents: 10000, trade_price_cents: 8000 })
      const colourway = await createColourwayFixture(product.id, { retail_price_cents: 12000 })
      expect(colourway.retail_price_cents).toBe(12000)
      // A context read gives the price the variation sells at.
      expect(colourway.trade_price_cents).toBe(8000)

      const detail = async () =>
        (await inject('GET', `/admin/products/${product.id}`, backofficeCookie)).json().product.colourways[0]
      expect(await detail()).toMatchObject({ retail_price_cents: 12000, trade_price_cents: null })
      expect(await resolveCartLines(pool, [{ sku: colourway.sku, qty: 1 }], false)).toMatchObject([{ unit_price_cents: 12000 }])
      expect(await resolveCartLines(pool, [{ sku: colourway.sku, qty: 1 }], true)).toMatchObject([{ unit_price_cents: 8000 }])

      const patched = await inject('PATCH', `/admin/colourways/${colourway.id}`, backofficeCookie, {
        retail_price_cents: null,
        trade_price_cents: 7000,
      })
      expect(patched.statusCode).toBe(200)
      expect(await detail()).toMatchObject({ retail_price_cents: null, trade_price_cents: 7000 })
      expect(await resolveCartLines(pool, [{ sku: colourway.sku, qty: 1 }], false)).toMatchObject([{ unit_price_cents: 10000 }])
      expect(await resolveCartLines(pool, [{ sku: colourway.sku, qty: 1 }], true)).toMatchObject([{ unit_price_cents: 7000 }])

      const negative = await inject('PATCH', `/admin/colourways/${colourway.id}`, backofficeCookie, { retail_price_cents: -1 })
      expect(negative.statusCode).toBe(400)
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

  // The SKU-level browse. Every assertion here scopes itself with brand_id or
  // product_id: this list spans the whole catalogue, so an unfiltered
  // `meta.total` counts every seeded colourway in the database too.
  describe('GET /admin/colourways', () => {
    const skusFrom = (response) =>
      response.json().colourways.map((colourway) => colourway.sku)

    const listColourways = (query) =>
      inject('GET', `/admin/colourways?${query}`, backofficeCookie)

    it('carries the design and house on every row, with the stock snapshot', async () => {
      const brand = await createBrandFixture('Swatch House')
      const product = await createProductFixture(brand.id, { name: 'Atlas' })
      const colourway = await createColourwayFixture(product.id, {
        name: 'Ivory',
        sku: `${PREFIX}-ivory`,
        hex_tones: ['#AABBCC'],
      })

      const response = await listColourways(`brand_id=${brand.id}`)
      expect(response.statusCode).toBe(200)

      const body = response.json()
      expect(body.meta).toEqual({ total: 1, page: 1, limit: 50 })
      // Without the parent context the screen shows a bare SKU and a colour
      // name, which is precisely what sending staff back to the product page to
      // identify it looks like.
      expect(body.colourways[0]).toMatchObject({
        id: colourway.id,
        product_id: product.id,
        name: 'Ivory',
        sku: `${PREFIX}-ivory`,
        hex_tones: ['#AABBCC'],
        product_name: 'Atlas',
        product_slug: product.slug,
        product_type: 'fabric',
        brand_id: brand.id,
        brand_name: brandName('Swatch House'),
      })
      expect(body.colourways[0].inventory.unit).toBe('metres')
    })

    // Paging is the story: this is the largest table in the catalogue, so the
    // pages must partition the result set rather than merely truncate it.
    it('pages in a stable order, with no row on two pages', async () => {
      const brand = await createBrandFixture('Paged House')
      const product = await createProductFixture(brand.id)
      await createColourwayFixture(product.id, { name: 'Alpha', sku: `${PREFIX}-a` })
      await createColourwayFixture(product.id, { name: 'Bravo', sku: `${PREFIX}-b` })
      await createColourwayFixture(product.id, { name: 'Charlie', sku: `${PREFIX}-c` })

      const first = await listColourways(`brand_id=${brand.id}&limit=2`)
      expect(first.json().meta).toEqual({ total: 3, page: 1, limit: 2 })
      expect(skusFrom(first)).toEqual([`${PREFIX}-a`, `${PREFIX}-b`])

      const second = await listColourways(`brand_id=${brand.id}&limit=2&page=2`)
      // total is the filtered total, not the page size — the CRM divides by it
      // to draw the pager.
      expect(second.json().meta).toEqual({ total: 3, page: 2, limit: 2 })
      expect(skusFrom(second)).toEqual([`${PREFIX}-c`])
    })

    it('rejects a limit above the maximum with 400', async () => {
      const response = await listColourways('limit=500')
      expect(response.statusCode).toBe(400)
    })

    it('filters by product_id', async () => {
      const brand = await createBrandFixture('Two Designs')
      const atlas = await createProductFixture(brand.id, { name: 'Atlas' })
      const orion = await createProductFixture(brand.id, { name: 'Orion' })
      await createColourwayFixture(atlas.id, { sku: `${PREFIX}-atlas-1` })
      await createColourwayFixture(orion.id, { sku: `${PREFIX}-orion-1` })

      const response = await listColourways(`product_id=${atlas.id}`)
      expect(skusFrom(response)).toEqual([`${PREFIX}-atlas-1`])
    })

    it('filters by brand_id', async () => {
      const mine = await createBrandFixture('Mine')
      const theirs = await createBrandFixture('Theirs')
      const ours = await createProductFixture(mine.id)
      const others = await createProductFixture(theirs.id)
      await createColourwayFixture(ours.id, { sku: `${PREFIX}-mine-1` })
      await createColourwayFixture(others.id, { sku: `${PREFIX}-theirs-1` })

      const response = await listColourways(`brand_id=${mine.id}`)
      expect(skusFrom(response)).toEqual([`${PREFIX}-mine-1`])
    })

    // Three ways staff arrive at a colourway: the code off a sample tag, the
    // colour name off an invoice, and the design name they were told over the
    // phone.
    it('searches the sku, the colour name and the design name', async () => {
      const brand = await createBrandFixture('Search House')
      const atlas = await createProductFixture(brand.id, { name: 'Atlas' })
      const orion = await createProductFixture(brand.id, { name: 'Orion' })
      await createColourwayFixture(atlas.id, { name: 'Ivory', sku: `${PREFIX}-ivory` })
      await createColourwayFixture(orion.id, { name: 'Slate', sku: `${PREFIX}-slate` })

      const bySku = await listColourways(`brand_id=${brand.id}&q=${PREFIX}-slate`)
      expect(skusFrom(bySku)).toEqual([`${PREFIX}-slate`])

      const byColour = await listColourways(`brand_id=${brand.id}&q=ivory`)
      expect(skusFrom(byColour)).toEqual([`${PREFIX}-ivory`])

      const byDesign = await listColourways(`brand_id=${brand.id}&q=Orion`)
      expect(skusFrom(byDesign)).toEqual([`${PREFIX}-slate`])
    })

    // A supplier code carrying a percent is not a wildcard. Without the escape
    // this term matches every colourway in the house.
    it('treats a percent in the search term as a literal', async () => {
      const brand = await createBrandFixture('Percent House')
      const product = await createProductFixture(brand.id)
      await createColourwayFixture(product.id, { sku: `${PREFIX}-100%-linen` })
      await createColourwayFixture(product.id, { sku: `${PREFIX}-plain` })

      const response = await listColourways(
        `brand_id=${brand.id}&q=${encodeURIComponent('100%')}`
      )
      expect(skusFrom(response)).toEqual([`${PREFIX}-100%-linen`])
    })

    it('hides archived colourways until include_archived is set', async () => {
      const brand = await createBrandFixture('Archive House')
      const product = await createProductFixture(brand.id)
      const live = await createColourwayFixture(product.id, { sku: `${PREFIX}-live` })
      const gone = await createColourwayFixture(product.id, {
        name: 'Zed',
        sku: `${PREFIX}-gone`,
      })
      await inject('POST', `/admin/colourways/${gone.id}/archive`, backofficeCookie)

      const working = await listColourways(`brand_id=${brand.id}`)
      expect(skusFrom(working)).toEqual([live.sku])
      expect(working.json().meta.total).toBe(1)

      const all = await listColourways(`brand_id=${brand.id}&include_archived=true`)
      expect(skusFrom(all)).toEqual([live.sku, gone.sku])
      const archived = all
        .json()
        .colourways.find((colourway) => colourway.id === gone.id)
      expect(archived.archived_at).not.toBeNull()
    })

    // Archiving a product does not archive its colourways, so they stay in the
    // working list — the same rows the product detail still returns. A filter on
    // the parent here would make the two screens disagree about what exists.
    it('keeps the colourways of an archived product', async () => {
      const brand = await createBrandFixture('Retired Design')
      const product = await createProductFixture(brand.id)
      await createColourwayFixture(product.id, { sku: `${PREFIX}-orphan` })
      await inject('POST', `/admin/products/${product.id}/archive`, backofficeCookie)

      const response = await listColourways(`brand_id=${brand.id}`)
      expect(skusFrom(response)).toEqual([`${PREFIX}-orphan`])
    })

    it('rejects an anonymous caller with 401 and a customer with 403', async () => {
      expect((await inject('GET', '/admin/colourways', null)).statusCode).toBe(401)
      expect((await inject('GET', '/admin/colourways', customerCookie)).statusCode).toBe(
        403
      )
    })
  })

  describe('GET /admin/colourways/:id', () => {
    it('returns the same row the list does, so one renderer serves both', async () => {
      const brand = await createBrandFixture('Detail House')
      const product = await createProductFixture(brand.id, { name: 'Atlas' })
      const created = await createColourwayFixture(product.id, {
        name: 'Ivory',
        sku: `${PREFIX}-ivory`,
        hex_tones: ['#AABBCC'],
      })

      const response = await inject(
        'GET',
        `/admin/colourways/${created.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const detail = response.json().colourway
      expect(detail).toMatchObject({
        id: created.id,
        product_id: product.id,
        sku: `${PREFIX}-ivory`,
        product_name: 'Atlas',
        brand_name: brandName('Detail House'),
      })
      // pg hands numeric back as a string — coerce, as every caller must.
      expect(Number(detail.inventory.qty_available)).toBe(0)
      expect(detail.inventory.unit).toBe('metres')

      const listed = (
        await inject('GET', `/admin/colourways?brand_id=${brand.id}`, backofficeCookie)
      ).json().colourways[0]
      expect(detail).toEqual(listed)
    })

    // A by-id admin read never filters on archived_at: the caller already knows
    // the row exists, and a 404 here reads as "someone deleted it".
    it('returns an archived colourway rather than 404', async () => {
      const brand = await createBrandFixture('Detail House')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      await inject('POST', `/admin/colourways/${colourway.id}/archive`, backofficeCookie)

      const response = await inject(
        'GET',
        `/admin/colourways/${colourway.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().colourway.archived_at).not.toBeNull()
    })

    it('returns 404 for an unknown colourway id', async () => {
      const response = await inject('GET', '/admin/colourways/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('Not Found')
    })

    it('rejects an anonymous caller with 401 and a customer with 403', async () => {
      const brand = await createBrandFixture('Detail House')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      expect(
        (await inject('GET', `/admin/colourways/${colourway.id}`, null)).statusCode
      ).toBe(401)
      expect(
        (await inject('GET', `/admin/colourways/${colourway.id}`, customerCookie))
          .statusCode
      ).toBe(403)
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

  // Product and colourway are where the catalogue meets commerce. A product
  // owns its colourways and their stock rows and takes them with it; an order
  // line is record and must survive, and stock that is on hand or reserved is
  // an operational fact the office has to resolve first.
  describe('DELETE /admin/products/:id', () => {
    const blockerFor = (body, relation) =>
      body.blockers.find((blocker) => blocker.relation === relation)

    const productExists = async (id) => {
      const { rows } = await pool.query('SELECT 1 FROM products WHERE id = $1', [id])
      return rows.length === 1
    }

    const colourwayExists = async (id) => {
      const { rows } = await pool.query('SELECT 1 FROM colourways WHERE id = $1', [id])
      return rows.length === 1
    }

    it('rejects an anonymous delete with 401', async () => {
      const brand = await createBrandFixture('Anon Product Delete')
      const product = await createProductFixture(brand.id)

      const response = await inject('DELETE', `/admin/products/${product.id}`, null)
      expect(response.statusCode).toBe(401)
      expect(await productExists(product.id)).toBe(true)
    })

    it('rejects a customer delete with 403', async () => {
      const brand = await createBrandFixture('Shopper Product Delete')
      const product = await createProductFixture(brand.id)

      const response = await inject(
        'DELETE',
        `/admin/products/${product.id}`,
        customerCookie
      )
      expect(response.statusCode).toBe(403)
      expect(await productExists(product.id)).toBe(true)
    })

    // The colourway and its zero-quantity stock row are owned children: they are
    // the product's own record, not somebody else's, so they go with it.
    it('deletes a never-sold product and cascades its colourway and stock row', async () => {
      const brand = await createBrandFixture('Unsold')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      expect(await inventoryForSku(`${PREFIX}-001`)).not.toBeNull()

      const response = await inject(
        'DELETE',
        `/admin/products/${product.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'product', id: product.id } })

      expect(await productExists(product.id)).toBe(false)
      expect(await colourwayExists(colourway.id)).toBe(false)
      expect(await inventoryForSku(`${PREFIX}-001`)).toBeNull()
      // The house it hung off is untouched.
      const houses = await inject('GET', '/admin/brands', backofficeCookie)
      expect(houses.json().brands.map((row) => row.id)).toContain(brand.id)
    })

    // The probe reaches the grandchild through the colourway: the order line
    // points at the colourway, not at the product, so nothing about the product
    // row itself says it has been sold.
    it('refuses a product whose colourway carries an order line', async () => {
      const brand = await createBrandFixture('Sold')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      await createOrderLineFixture(colourway.id)

      const response = await inject(
        'DELETE',
        `/admin/products/${product.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)

      const body = response.json()
      expect(blockerFor(body, 'order_lines')).toEqual({
        relation: 'order_lines',
        label: 'order lines',
        count: 1,
        capped: false,
      })
      expect(body.message).toContain('1 order lines')
      expect(body.archivable).toBe(true)
      expect(await productExists(product.id)).toBe(true)
      expect(await colourwayExists(colourway.id)).toBe(true)
    })

    it('refuses a product holding stock, and names the stock separately', async () => {
      const brand = await createBrandFixture('Stocked Product')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      await setStock(colourway.id, { available: 12 })

      const response = await inject(
        'DELETE',
        `/admin/products/${product.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)

      const body = response.json()
      expect(body.blockers).toEqual([
        {
          relation: 'inventory',
          label: 'colourways holding stock',
          count: 1,
          capped: false,
        },
      ])
      expect(Number((await inventoryForSku(`${PREFIX}-001`)).qty_available)).toBe(12)
    })

    // Reserved but not on hand still counts: the reservation is open demand the
    // order state machine has to release.
    it('refuses a product whose stock is reserved rather than on hand', async () => {
      const brand = await createBrandFixture('Reserved Product')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      await setStock(colourway.id, { available: 0, reserved: 4 })

      const response = await inject(
        'DELETE',
        `/admin/products/${product.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)
      expect(blockerFor(response.json(), 'inventory').count).toBe(1)
    })

    it('returns 404 for an unknown product id', async () => {
      const response = await inject('DELETE', '/admin/products/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
      expect(response.json().blockers).toEqual([])
    })

    // The one window the parent lock does not cover: the transaction locks the
    // product, so an order line inserted against one of its existing colourways
    // after the probes have run is not stopped by anything the probes did.
    // Postgres serialises that insert against the cascade's delete of the
    // colourway instead, and `order_lines.colourway_id` being the schema's one
    // RESTRICT edge turns the lost race into a 23503 — which delete.js catches
    // and re-answers as the same 409. Reproduced deterministically here by
    // wrapping the pool and committing the insert on its own connection at
    // exactly that moment; going through the route instead would leave the
    // window to chance.
    describe('the 23503 backstop', () => {
      const poolRacingTheDeleteWith = (race) => ({
        connect: async () => {
          const client = await pool.connect()
          return {
            query: async (sql, params) => {
              if (typeof sql === 'string' && sql.startsWith('DELETE FROM products')) {
                await race()
              }
              return client.query(sql, params)
            },
            release: () => client.release(),
          }
        },
      })

      it('answers a lost race with the 409 the probe would have produced', async () => {
        const brand = await createBrandFixture('Race')
        const product = await createProductFixture(brand.id)
        const colourway = await createColourwayFixture(product.id)

        const racingPool = poolRacingTheDeleteWith(() =>
          createOrderLineFixture(colourway.id)
        )
        const backstop = await deleteOrExplain(racingPool, 'product', product.id, {})

        expect(backstop).toMatchObject({
          deleted: false,
          status: 409,
          error: 'Conflict',
          archivable: true,
        })
        // "1, capped" because the database says at least one row exists and
        // nothing about how many.
        expect(backstop.blockers).toEqual([
          { relation: 'order_lines', label: 'order lines', count: 1, capped: true },
        ])
        // Rolled back: the DELETE is the only statement that writes.
        expect(await productExists(product.id)).toBe(true)
        expect(await colourwayExists(colourway.id)).toBe(true)

        // Same envelope as the probe path, field for field — the order line the
        // race committed is now visible to the probes, so the only difference is
        // the count the database could not give us.
        const probed = await deleteOrExplain(pool, 'product', product.id, {})
        expect(Object.keys(probed)).toEqual(Object.keys(backstop))
        expect(probed.message).toBe(backstop.message.replace('1+ order', '1 order'))
        expect(probed.blockers[0]).toMatchObject({
          relation: 'order_lines',
          label: 'order lines',
        })
      })
    })
  })

  describe('DELETE /admin/colourways/:id', () => {
    const colourwayExists = async (id) => {
      const { rows } = await pool.query('SELECT 1 FROM colourways WHERE id = $1', [id])
      return rows.length === 1
    }

    it('rejects a customer delete with 403', async () => {
      const brand = await createBrandFixture('Shopper Colourway Delete')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)

      const response = await inject(
        'DELETE',
        `/admin/colourways/${colourway.id}`,
        customerCookie
      )
      expect(response.statusCode).toBe(403)
      expect(await colourwayExists(colourway.id)).toBe(true)
    })

    it('deletes an unsold colourway with its stock row, keeping the product', async () => {
      const brand = await createBrandFixture('Colour Cleanup')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)

      const response = await inject(
        'DELETE',
        `/admin/colourways/${colourway.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        deleted: { entity: 'colourway', id: colourway.id },
      })
      expect(await colourwayExists(colourway.id)).toBe(false)
      expect(await inventoryForSku(`${PREFIX}-001`)).toBeNull()
      expect(await colourwayCountFor(product.id)).toBe(0)

      const remaining = await inject(
        'GET',
        `/admin/products/${product.id}`,
        backofficeCookie
      )
      expect(remaining.statusCode).toBe(200)
    })

    // Here the RESTRICT edge is direct, so the database would have raised
    // anyway. The probe still wins: it runs before anything is destroyed and it
    // can say how many.
    it('refuses a colourway with an order line against it', async () => {
      const brand = await createBrandFixture('Sold Colour')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      await createOrderLineFixture(colourway.id)

      const response = await inject(
        'DELETE',
        `/admin/colourways/${colourway.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)

      const body = response.json()
      expect(body.blockers).toEqual([
        { relation: 'order_lines', label: 'order lines', count: 1, capped: false },
      ])
      expect(body.message).toContain('1 order lines')
      expect(body.archivable).toBe(true)
      expect(await colourwayExists(colourway.id)).toBe(true)
    })

    it('refuses a colourway holding stock', async () => {
      const brand = await createBrandFixture('Stocked Colour')
      const product = await createProductFixture(brand.id)
      const colourway = await createColourwayFixture(product.id)
      await setStock(colourway.id, { available: 7 })

      const response = await inject(
        'DELETE',
        `/admin/colourways/${colourway.id}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        {
          relation: 'inventory',
          label: 'units of stock on hand',
          count: 1,
          capped: false,
        },
      ])
      expect(await colourwayExists(colourway.id)).toBe(true)
    })

    it('returns 404 for an unknown colourway id', async () => {
      const response = await inject('DELETE', '/admin/colourways/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })
})
