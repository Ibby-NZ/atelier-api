import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'col-test'

const get = (app, url) => app.inject({ method: 'GET', url })

// Two houses that BOTH have a collection slugged `<PREFIX>-shared`: collection
// slugs are unique per brand, not globally, so every collection lookup has to
// be brand-scoped or it would mix two houses' products together.
//
// House A: `shared` (1 visible + 1 hidden product), `archived` (archived
// collection holding a still-visible product), plus a product with no
// collection at all. House B: `shared` with one product.
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international)
     VALUES ($1, $2, 'New Zealand', 'NZD', false),
            ($3, $4, 'France', 'EUR', true)
     RETURNING id, slug`,
    ['Col Test House A', `${PREFIX}-house-a`, 'Col Test House B', `${PREFIX}-house-b`]
  )
  const brandId = new Map(brands.map((b) => [b.slug, b.id]))
  const houseA = brandId.get(`${PREFIX}-house-a`)
  const houseB = brandId.get(`${PREFIX}-house-b`)

  const { rows: collections } = await pool.query(
    `INSERT INTO collections (brand_id, name, slug, description, image_url)
     VALUES ($1, 'Shared Name A', $2, 'A blurb.', 'https://cdn.example/shared-a.jpg'),
            ($1, 'Retired', $3, NULL, NULL),
            ($4, 'Shared Name B', $5, NULL, NULL)
     RETURNING id, brand_id, slug`,
    [houseA, `${PREFIX}-shared`, `${PREFIX}-archived`, houseB, `${PREFIX}-shared`]
  )
  const collectionId = (brand, slug) =>
    collections.find((c) => c.brand_id === brand && c.slug === slug).id

  const sharedA = collectionId(houseA, `${PREFIX}-shared`)
  const retiredA = collectionId(houseA, `${PREFIX}-archived`)
  const sharedB = collectionId(houseB, `${PREFIX}-shared`)

  await pool.query(
    `INSERT INTO products
       (brand_id, collection_id, name, slug, product_type, currency, show_on_website)
     VALUES
       ($1, $2,   'A In Collection', $3, 'fabric', 'NZD', true),
       ($1, $2,   'A Hidden',        $4, 'fabric', 'NZD', false),
       ($1, $5,   'A Retired',       $6, 'fabric', 'NZD', true),
       ($1, NULL, 'A Loose',         $7, 'fabric', 'NZD', true),
       ($8, $9,   'B In Collection', $10,'fabric', 'EUR', true)`,
    [
      houseA,
      sharedA,
      `${PREFIX}-a-in-collection`,
      `${PREFIX}-a-hidden`,
      retiredA,
      `${PREFIX}-a-retired`,
      `${PREFIX}-a-loose`,
      houseB,
      sharedB,
      `${PREFIX}-b-in-collection`,
    ]
  )

  await pool.query(`UPDATE collections SET archived_at = now() WHERE id = $1`, [retiredA])
}

const cleanup = (pool) =>
  pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

describe('public collection endpoints and the collection product filter', () => {
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

  const fixtureCollections = (collections) =>
    collections.filter((c) => c.brand.slug.startsWith(PREFIX))

  describe('GET /catalogue/collections', () => {
    it('lists collections with their house and a visible-product count', async () => {
      const response = await get(app, '/catalogue/collections')
      expect(response.statusCode).toBe(200)

      const mine = fixtureCollections(response.json().collections)
      expect(mine).toHaveLength(2)

      const houseA = mine.find((c) => c.brand.slug === `${PREFIX}-house-a`)
      expect(houseA).toMatchObject({
        slug: `${PREFIX}-shared`,
        name: 'Shared Name A',
        // Tile editorial (seeded from the atelier.co.nz snapshot, CRM-editable).
        description: 'A blurb.',
        image_url: 'https://cdn.example/shared-a.jpg',
        // The hidden product is not counted.
        product_count: 1,
        brand: { slug: `${PREFIX}-house-a`, name: 'Col Test House A' },
      })
      // Absent editorial is explicit null, not a missing key.
      const houseB = mine.find((c) => c.brand.slug === `${PREFIX}-house-b`)
      expect(houseB.description).toBeNull()
      expect(houseB.image_url).toBeNull()
    })

    it('omits archived collections', async () => {
      const response = await get(app, '/catalogue/collections')
      const slugs = fixtureCollections(response.json().collections).map((c) => c.slug)
      expect(slugs).not.toContain(`${PREFIX}-archived`)
    })

    it('filters by brand slug', async () => {
      const response = await get(app, `/catalogue/collections?brand=${PREFIX}-house-b`)
      expect(response.statusCode).toBe(200)

      const { collections } = response.json()
      expect(collections).toHaveLength(1)
      expect(collections[0]).toMatchObject({
        slug: `${PREFIX}-shared`,
        name: 'Shared Name B',
        product_count: 1,
      })
    })

    it('returns an empty list for an unknown brand', async () => {
      const response = await get(app, `/catalogue/collections?brand=${PREFIX}-nobody`)
      expect(response.statusCode).toBe(200)
      expect(response.json().collections).toEqual([])
    })
  })

  describe('GET /catalogue/brands/:slug/collections/:collectionSlug', () => {
    it('returns the collection scoped to its house', async () => {
      const response = await get(
        app,
        `/catalogue/brands/${PREFIX}-house-b/collections/${PREFIX}-shared`
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().collection).toMatchObject({
        slug: `${PREFIX}-shared`,
        name: 'Shared Name B',
        product_count: 1,
        brand: { slug: `${PREFIX}-house-b`, name: 'Col Test House B' },
      })
    })

    it('404s when the collection slug belongs to a different house', async () => {
      const response = await get(
        app,
        `/catalogue/brands/${PREFIX}-house-a/collections/${PREFIX}-nothing`
      )
      expect(response.statusCode).toBe(404)
    })

    it('404s for an archived collection', async () => {
      const response = await get(
        app,
        `/catalogue/brands/${PREFIX}-house-a/collections/${PREFIX}-archived`
      )
      expect(response.statusCode).toBe(404)
    })

    it('404s for an unknown brand', async () => {
      const response = await get(
        app,
        `/catalogue/brands/${PREFIX}-nobody/collections/${PREFIX}-shared`
      )
      expect(response.statusCode).toBe(404)
    })

    it('still resolves the single brand route', async () => {
      const response = await get(app, `/catalogue/brands/${PREFIX}-house-a`)
      expect(response.statusCode).toBe(200)
      const { brand } = response.json()
      expect(brand.collections.map((c) => c.slug)).toEqual([`${PREFIX}-shared`])
    })
  })

  describe('GET /catalogue/products?collection=', () => {
    it('narrows the grid to one house collection when combined with brand', async () => {
      const response = await get(
        app,
        `/catalogue/products?brand=${PREFIX}-house-a&collection=${PREFIX}-shared&limit=100`
      )
      expect(response.statusCode).toBe(200)

      const { products, meta } = response.json()
      expect(products.map((p) => p.slug)).toEqual([`${PREFIX}-a-in-collection`])
      expect(meta.total).toBe(1)
    })

    it('matches every house sharing the slug when brand is omitted', async () => {
      const response = await get(
        app,
        `/catalogue/products?collection=${PREFIX}-shared&limit=100`
      )
      const slugs = response.json().products.map((p) => p.slug)
      expect(slugs).toContain(`${PREFIX}-a-in-collection`)
      expect(slugs).toContain(`${PREFIX}-b-in-collection`)
    })

    it('never matches an archived collection', async () => {
      const response = await get(
        app,
        `/catalogue/products?collection=${PREFIX}-archived&limit=100`
      )
      expect(response.json().products).toEqual([])
      expect(response.json().meta.total).toBe(0)
    })

    it('carries the collection on each product card, null when unassigned', async () => {
      const response = await get(
        app,
        `/catalogue/products?brand=${PREFIX}-house-a&limit=100`
      )
      const byslug = new Map(response.json().products.map((p) => [p.slug, p]))

      expect(byslug.get(`${PREFIX}-a-in-collection`).collection).toEqual({
        slug: `${PREFIX}-shared`,
        name: 'Shared Name A',
      })
      expect(byslug.get(`${PREFIX}-a-loose`).collection).toBeNull()
      // Archived collection: the product stays on the website, but reads as
      // uncollected rather than advertising a retired collection.
      expect(byslug.get(`${PREFIX}-a-retired`).collection).toBeNull()
    })

    it('carries the collection on product detail', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-a-in-collection`)
      expect(response.statusCode).toBe(200)
      expect(response.json().product.collection).toEqual({
        slug: `${PREFIX}-shared`,
        name: 'Shared Name A',
      })
    })

    it('reports a null collection on detail for an unassigned product', async () => {
      const response = await get(app, `/catalogue/products/${PREFIX}-a-loose`)
      expect(response.json().product.collection).toBeNull()
    })
  })
})
