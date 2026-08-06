import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { FEATURED_LIMIT } from '../src/catalogue/admin-brands.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'featured-admin-test'
const DOMAIN = 'featured-admin-test.example.com'
const PASSWORD = 'correct horse battery staple'

// Fixture houses are named so the server-generated slug carries PREFIX; cleanup
// deletes by that slug prefix and cascades to collections.
const brandName = (suffix) => `Featured Admin Test ${suffix}`
const brandSlug = (suffix) => `${PREFIX}-${suffix}`

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const cleanupFixtures = (pool) =>
  pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

describe('back-office featured ordering', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  // A whole-list reorder clears EVERY rank, including the ones the migration
  // seeded onto the real catalogue in this database. They are snapshotted here
  // and put back in afterAll, so this suite cannot falsify featured-rank.test.js
  // (which runs after it and asserts the seeded ranks are still in place).
  let seededBrandRanks = []
  let seededCollectionRanks = []

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const createBrandFixture = async (suffix) => {
    const response = await inject('POST', '/admin/brands', backofficeCookie, {
      name: brandName(suffix),
      currency: 'NZD',
      trade_only: false,
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

  const rankOf = async (table, id) => {
    const { rows } = await pool.query(`SELECT featured_rank FROM ${table} WHERE id = $1`, [id])
    return rows[0].featured_rank
  }

  const restoreSeededRanks = async () => {
    await pool.query(`UPDATE brands SET featured_rank = NULL WHERE featured_rank IS NOT NULL`)
    await pool.query(
      `UPDATE collections SET featured_rank = NULL WHERE featured_rank IS NOT NULL`
    )
    for (const row of seededBrandRanks) {
      await pool.query(`UPDATE brands SET featured_rank = $2 WHERE id = $1`, [
        row.id,
        row.featured_rank,
      ])
    }
    for (const row of seededCollectionRanks) {
      await pool.query(`UPDATE collections SET featured_rank = $2 WHERE id = $1`, [
        row.id,
        row.featured_rank,
      ])
    }
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

    seededBrandRanks = (
      await pool.query(`SELECT id, featured_rank FROM brands WHERE featured_rank IS NOT NULL`)
    ).rows
    seededCollectionRanks = (
      await pool.query(
        `SELECT id, featured_rank FROM collections WHERE featured_rank IS NOT NULL`
      )
    ).rows

    // Registered once and kept: register shares a rate-limit bucket of 10 per
    // 15 minutes per IP, which re-registering per test would exhaust.
    const staff = await inject('POST', '/auth/register', null, {
      email: `staff@${DOMAIN}`,
      password: PASSWORD,
      name: 'Featured Staff',
    })
    backofficeCookie = sessionCookieFrom(staff)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `staff@${DOMAIN}`,
    ])

    const customer = await inject('POST', '/auth/register', null, {
      email: `customer@${DOMAIN}`,
      password: PASSWORD,
      name: 'Featured Customer',
    })
    customerCookie = sessionCookieFrom(customer)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await restoreSeededRanks()
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
  })

  describe('create leaves a row unfeatured', () => {
    it('does not accept featured_rank on brand or collection create', async () => {
      // A house is not featured at birth: the field is absent from both create
      // whitelists, and Ajv's removeAdditional strips it from the body, so the
      // attempt succeeds as an ordinary create with a null rank.
      const response = await inject('POST', '/admin/brands', backofficeCookie, {
        name: brandName('Born'),
        currency: 'NZD',
        featured_rank: 1,
      })
      expect(response.statusCode).toEqual(201)
      expect(response.json().brand.featured_rank).toBeNull()

      const collection = await inject('POST', '/admin/collections', backofficeCookie, {
        brand_id: response.json().brand.id,
        name: 'Born Collection',
        featured_rank: 1,
      })
      expect(collection.statusCode).toEqual(201)
      expect(collection.json().collection.featured_rank).toBeNull()
    })
  })

  describe('PATCH', () => {
    it('sets a rank on a brand and on a collection', async () => {
      const brand = await createBrandFixture('Patch')
      const collection = await createCollectionFixture(brand.id, 'Patch Collection')

      const patched = await inject('PATCH', `/admin/brands/${brand.id}`, backofficeCookie, {
        featured_rank: 2,
      })
      expect(patched.statusCode).toEqual(200)
      expect(patched.json().brand.featured_rank).toEqual(2)

      const patchedCollection = await inject(
        'PATCH',
        `/admin/collections/${collection.id}`,
        backofficeCookie,
        { featured_rank: 3 }
      )
      expect(patchedCollection.statusCode).toEqual(200)
      expect(patchedCollection.json().collection.featured_rank).toEqual(3)
    })

    it('clears the rank with an explicit null, on both tables', async () => {
      const brand = await createBrandFixture('Clear')
      const collection = await createCollectionFixture(brand.id, 'Clear Collection')
      await inject('PATCH', `/admin/brands/${brand.id}`, backofficeCookie, { featured_rank: 1 })
      await inject('PATCH', `/admin/collections/${collection.id}`, backofficeCookie, {
        featured_rank: 1,
      })

      const brandCleared = await inject('PATCH', `/admin/brands/${brand.id}`, backofficeCookie, {
        featured_rank: null,
      })
      expect(brandCleared.json().brand.featured_rank).toBeNull()

      const collectionCleared = await inject(
        'PATCH',
        `/admin/collections/${collection.id}`,
        backofficeCookie,
        { featured_rank: null }
      )
      expect(collectionCleared.json().collection.featured_rank).toBeNull()
    })

    it('leaves the rank alone when the key is absent — absent is not null', async () => {
      const brand = await createBrandFixture('Absent')
      await inject('PATCH', `/admin/brands/${brand.id}`, backofficeCookie, { featured_rank: 4 })

      const renamed = await inject('PATCH', `/admin/brands/${brand.id}`, backofficeCookie, {
        country: 'France',
      })
      expect(renamed.json().brand.featured_rank).toEqual(4)
    })

    it('rejects a rank of zero or below by schema', async () => {
      const brand = await createBrandFixture('Zero')
      const zero = await inject('PATCH', `/admin/brands/${brand.id}`, backofficeCookie, {
        featured_rank: 0,
      })
      expect(zero.statusCode).toEqual(400)
      expect(await rankOf('brands', brand.id)).toBeNull()
    })
  })

  describe('PUT /admin/brands/featured', () => {
    it('ranks by position and returns the list in that order', async () => {
      const first = await createBrandFixture('One')
      const second = await createBrandFixture('Two')

      const response = await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: [second.slug, first.slug],
      })
      expect(response.statusCode).toEqual(200)
      expect(response.json().brands.map((brand) => brand.slug)).toEqual([
        second.slug,
        first.slug,
      ])
      expect(await rankOf('brands', second.id)).toEqual(1)
      expect(await rankOf('brands', first.id)).toEqual(2)
    })

    it('clears anything absent from the submitted list', async () => {
      const kept = await createBrandFixture('Kept')
      const dropped = await createBrandFixture('Dropped')
      await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: [kept.slug, dropped.slug],
      })

      const response = await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: [kept.slug],
      })
      expect(response.json().brands.map((brand) => brand.slug)).toEqual([kept.slug])
      expect(await rankOf('brands', dropped.id)).toBeNull()
    })

    it('features nothing for an empty list', async () => {
      const brand = await createBrandFixture('Off')
      await inject('PUT', '/admin/brands/featured', backofficeCookie, { slugs: [brand.slug] })

      const response = await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: [],
      })
      expect(response.json().brands).toEqual([])
      expect(await rankOf('brands', brand.id)).toBeNull()
    })

    it('422s naming an unknown slug, and commits nothing', async () => {
      const brand = await createBrandFixture('Survivor')
      await inject('PUT', '/admin/brands/featured', backofficeCookie, { slugs: [brand.slug] })

      const response = await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: [brand.slug, brandSlug('ghost')],
      })
      expect(response.statusCode).toEqual(422)
      expect(response.json().message).toContain(brandSlug('ghost'))
      // The clear and the re-apply are one transaction, so a refusal must leave
      // the previous list exactly as it was rather than half-cleared.
      expect(await rankOf('brands', brand.id)).toEqual(1)
    })

    it('422s naming a slug listed twice', async () => {
      const brand = await createBrandFixture('Twice')
      const response = await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: [brand.slug, brand.slug],
      })
      expect(response.statusCode).toEqual(422)
      expect(response.json().message).toContain(brand.slug)
      expect(await rankOf('brands', brand.id)).toBeNull()
    })

    it('400s a list past the cap', async () => {
      const response = await inject('PUT', '/admin/brands/featured', backofficeCookie, {
        slugs: Array.from({ length: FEATURED_LIMIT + 1 }, (_, index) =>
          brandSlug(`cap-${index}`)
        ),
      })
      expect(response.statusCode).toEqual(400)
    })
  })

  describe('PUT /admin/collections/featured', () => {
    it('features only the named house when two share a collection slug', async () => {
      // The regression the (brand_slug, slug) pair exists to prevent. A fixture
      // with distinct slugs would pass a slug-only implementation too.
      const houseA = await createBrandFixture('House A')
      const houseB = await createBrandFixture('House B')
      const shared = 'Shared Collection'
      const inA = await createCollectionFixture(houseA.id, shared)
      const inB = await createCollectionFixture(houseB.id, shared)
      expect(inA.slug).toEqual(inB.slug)

      const response = await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [{ brand_slug: houseA.slug, slug: inA.slug }],
      })
      expect(response.statusCode).toEqual(200)
      expect(response.json().collections.map((row) => row.id)).toEqual([inA.id])
      expect(await rankOf('collections', inA.id)).toEqual(1)
      expect(await rankOf('collections', inB.id)).toBeNull()
    })

    it('ranks by position and clears anything absent', async () => {
      const brand = await createBrandFixture('Coll Order')
      const first = await createCollectionFixture(brand.id, 'Alpha')
      const second = await createCollectionFixture(brand.id, 'Beta')
      const dropped = await createCollectionFixture(brand.id, 'Gamma')

      await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [{ brand_slug: brand.slug, slug: dropped.slug }],
      })
      const response = await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [
          { brand_slug: brand.slug, slug: second.slug },
          { brand_slug: brand.slug, slug: first.slug },
        ],
      })

      expect(response.json().collections.map((row) => row.id)).toEqual([second.id, first.id])
      expect(await rankOf('collections', second.id)).toEqual(1)
      expect(await rankOf('collections', first.id)).toEqual(2)
      expect(await rankOf('collections', dropped.id)).toBeNull()
    })

    it('422s naming an unknown pair, and commits nothing', async () => {
      const brand = await createBrandFixture('Coll Ghost')
      const collection = await createCollectionFixture(brand.id, 'Real')
      await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [{ brand_slug: brand.slug, slug: collection.slug }],
      })

      const response = await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [
          { brand_slug: brand.slug, slug: collection.slug },
          { brand_slug: brand.slug, slug: `${PREFIX}-ghost` },
        ],
      })
      expect(response.statusCode).toEqual(422)
      expect(response.json().message).toContain(`${brand.slug}/${PREFIX}-ghost`)
      expect(await rankOf('collections', collection.id)).toEqual(1)
    })

    it('422s when the collection exists but under another house', async () => {
      // The pair is the key: naming house B's slug under house A must refuse,
      // not quietly feature house A's own collection of the same name.
      const houseA = await createBrandFixture('Pair A')
      const houseB = await createBrandFixture('Pair B')
      const onlyInB = await createCollectionFixture(houseB.id, 'Only In B')

      const response = await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [{ brand_slug: houseA.slug, slug: onlyInB.slug }],
      })
      expect(response.statusCode).toEqual(422)
      expect(await rankOf('collections', onlyInB.id)).toBeNull()
    })

    it('422s a pair listed twice', async () => {
      const brand = await createBrandFixture('Coll Twice')
      const collection = await createCollectionFixture(brand.id, 'Repeated')
      const entry = { brand_slug: brand.slug, slug: collection.slug }

      const response = await inject('PUT', '/admin/collections/featured', backofficeCookie, {
        collections: [entry, entry],
      })
      expect(response.statusCode).toEqual(422)
      expect(response.json().message).toContain(`${brand.slug}/${collection.slug}`)
      expect(await rankOf('collections', collection.id)).toBeNull()
    })
  })

  describe('access', () => {
    it('is backoffice-only on both reorder endpoints', async () => {
      for (const url of ['/admin/brands/featured', '/admin/collections/featured']) {
        const body = url.includes('brands') ? { slugs: [] } : { collections: [] }
        expect((await inject('PUT', url, null, body)).statusCode).toEqual(401)
        expect((await inject('PUT', url, customerCookie, body)).statusCode).toEqual(403)
      }
    })
  })
})
