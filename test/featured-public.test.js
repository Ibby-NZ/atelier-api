import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'feat-pub-test'
const DOMAIN = 'feat-pub-test.example.com'
const PASSWORD = 'correct horse battery staple'

const slug = (suffix) => `${PREFIX}-${suffix}`

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Ranks are deliberately high and set by direct UPDATE rather than through the
// reorder endpoints: those clear EVERY rank in the table, which would wipe the
// ones the migration seeded onto this database and that featured-rank.test.js
// asserts are still in place.
//
// The fixture is built so that no assertion could pass by accident:
//   - "Zulu" is featured ahead of "Alpha", so rank must beat name.
//   - Two houses and two collections share a rank, so the tie-break is exercised.
//   - The featured house at the LOWEST rank is archived, so a consumer that
//     assumed rank N sits at position N would be wrong.
//   - One featured house is trade_only, holding a featured collection with a
//     product: a guest must still see it in place, only with a zero count.
const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, featured_rank)
     VALUES ('Featured Public Zulu',     $1, 'New Zealand', 'NZD', false, false, 101),
            ('Featured Public Alpha',    $2, 'France',      'EUR', true,  false, 102),
            ('Featured Public Closed',   $3, 'Italy',       'EUR', true,  true,  103),
            ('Featured Public Tie B',    $4, 'France',      'EUR', true,  false, 104),
            ('Featured Public Tie A',    $5, 'France',      'EUR', true,  false, 104),
            ('Featured Public Aaa',      $6, 'France',      'EUR', true,  false, NULL),
            ('Featured Public Zzz',      $7, 'France',      'EUR', true,  false, NULL),
            ('Featured Public Archived', $8, 'France',      'EUR', true,  false, 100)
     RETURNING id, slug`,
    [
      slug('zulu'),
      slug('alpha'),
      slug('closed'),
      slug('tie-b'),
      slug('tie-a'),
      slug('aaa'),
      slug('zzz'),
      slug('archived'),
    ]
  )
  const brandId = new Map(brands.map((row) => [row.slug, row.id]))

  await pool.query(`UPDATE brands SET archived_at = now() WHERE slug = $1`, [slug('archived')])

  const { rows: collections } = await pool.query(
    `INSERT INTO collections (brand_id, name, slug, featured_rank)
     VALUES ($1, 'Zulu Featured',   $2,  201),
            ($1, 'Zulu Tie Bravo',  $3,  204),
            ($1, 'Zulu Tie Alpha',  $4,  204),
            ($1, 'Zulu Plain',      $5,  NULL),
            ($6, 'Alpha Featured',  $7,  202),
            ($8, 'Closed Featured', $9,  203)
     RETURNING id, slug`,
    [
      brandId.get(slug('zulu')),
      slug('zulu-featured'),
      slug('zulu-tie-bravo'),
      slug('zulu-tie-alpha'),
      slug('zulu-plain'),
      brandId.get(slug('alpha')),
      slug('alpha-featured'),
      brandId.get(slug('closed')),
      slug('closed-featured'),
    ]
  )
  const collectionId = new Map(collections.map((row) => [row.slug, row.id]))

  await pool.query(
    `INSERT INTO products
       (brand_id, collection_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, $2, 'Closed Design', $3, 'fabric', 'EUR', true)`,
    [brandId.get(slug('closed')), collectionId.get(slug('closed-featured')), slug('closed-design')]
  )
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
}

describe('public read-model featured ordering', () => {
  let pool
  let app
  let tradeCookie

  const get = (url, cookie) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

  const fixtureBrands = (body) => body.brands.filter((brand) => brand.slug.startsWith(PREFIX))

  const fixtureCollections = (body) =>
    body.collections.filter((collection) => collection.slug.startsWith(PREFIX))

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

    // Registered once: /auth/register is rate-limited 10 per 15 minutes per IP.
    const trade = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `trade@${DOMAIN}`, password: PASSWORD, name: 'Featured Trade' },
    })
    tradeCookie = sessionCookieFrom(trade)
    await pool.query(
      `UPDATE users SET role = 'trade', trade_approved = true WHERE email = $1`,
      [`trade@${DOMAIN}`]
    )
  })

  afterAll(async () => {
    await cleanup(pool)
    await app.close()
    await pool.end()
  })

  describe('GET /catalogue/brands', () => {
    it('leads with the featured houses in rank order, then the rest by name', async () => {
      const response = await get('/catalogue/brands')
      expect(response.statusCode).toBe(200)
      // Zulu is ranked ahead of Alpha, so a list that merely sorted by name
      // would fail here.
      expect(fixtureBrands(response.json()).map((brand) => brand.slug)).toEqual([
        slug('zulu'),
        slug('alpha'),
        slug('closed'),
        slug('tie-a'),
        slug('tie-b'),
        slug('aaa'),
        slug('zzz'),
      ])
    })

    it('breaks a shared rank by name then id, so the order is stable', async () => {
      // Two houses on rank 104: nothing in the schema stops that (there is no
      // unique index), so the ORDER BY has to be total on its own. Repeating the
      // request must not shuffle them.
      const first = fixtureBrands((await get('/catalogue/brands')).json())
      const second = fixtureBrands((await get('/catalogue/brands')).json())
      const tied = (brands) =>
        brands.filter((brand) => brand.featured_rank === 104).map((brand) => brand.slug)

      expect(tied(first)).toEqual([slug('tie-a'), slug('tie-b')])
      expect(tied(second)).toEqual(tied(first))
    })

    it('exposes featured_rank, explicitly null for an unfeatured house', async () => {
      const brands = new Map(
        fixtureBrands((await get('/catalogue/brands')).json()).map((brand) => [
          brand.slug,
          brand,
        ])
      )
      expect(brands.get(slug('zulu')).featured_rank).toBe(101)
      expect(brands.get(slug('aaa')).featured_rank).toBeNull()
      expect(brands.get(slug('zulu'))).toHaveProperty('featured_rank')
    })

    it('leaves no hole when a featured house is archived', async () => {
      // The archived house holds the lowest rank of the fixture, so its absence
      // would be a gap for anything that treated rank as a position. The list is
      // simply shorter: the featured rows are still an unbroken prefix.
      const brands = fixtureBrands((await get('/catalogue/brands')).json())
      expect(brands.map((brand) => brand.slug)).not.toContain(slug('archived'))

      const ranks = brands.map((brand) => brand.featured_rank)
      const firstUnfeatured = ranks.indexOf(null)
      expect(ranks.slice(0, firstUnfeatured).every((rank) => rank !== null)).toBe(true)
      expect(ranks.slice(firstUnfeatured).every((rank) => rank === null)).toBe(true)
    })
  })

  describe('GET /catalogue/collections', () => {
    it('leads with the featured collections in rank order, across houses', async () => {
      const response = await get('/catalogue/collections')
      expect(response.statusCode).toBe(200)
      // Rank 201 belongs to Zulu and 202 to Alpha: featuring orders the list
      // ACROSS houses, so grouping by house name first would fail here.
      expect(fixtureCollections(response.json()).map((collection) => collection.slug)).toEqual([
        slug('zulu-featured'),
        slug('alpha-featured'),
        slug('closed-featured'),
        slug('zulu-tie-alpha'),
        slug('zulu-tie-bravo'),
        slug('zulu-plain'),
      ])
    })

    it('exposes featured_rank, explicitly null when not featured', async () => {
      const collections = new Map(
        fixtureCollections((await get('/catalogue/collections')).json()).map((collection) => [
          collection.slug,
          collection,
        ])
      )
      expect(collections.get(slug('zulu-featured')).featured_rank).toBe(201)
      expect(collections.get(slug('zulu-plain')).featured_rank).toBeNull()
    })

    it('orders a house-scoped list featured-first too', async () => {
      const response = await get(`/catalogue/collections?brand=${slug('zulu')}`)
      expect(response.json().collections.map((collection) => collection.slug)).toEqual([
        slug('zulu-featured'),
        slug('zulu-tie-alpha'),
        slug('zulu-tie-bravo'),
        slug('zulu-plain'),
      ])
    })
  })

  describe('featuring and the trade-only gate', () => {
    it('keeps a featured closed house in its rank position for a guest', async () => {
      // Houses stay listed for everyone (only a product grid is gated), so a
      // house a guest may not BUY from cannot drop out of the strip and leave
      // the office's ordering with a gap in it.
      const anonymous = fixtureBrands((await get('/catalogue/brands')).json())
      const trade = fixtureBrands((await get('/catalogue/brands', tradeCookie)).json())

      expect(anonymous.map((brand) => brand.slug)).toEqual(trade.map((brand) => brand.slug))
      const closed = anonymous.find((brand) => brand.slug === slug('closed'))
      expect(closed.trade_only).toBe(true)
      expect(closed.featured_rank).toBe(103)
    })

    it('moves only the product count, never the position, for a guest', async () => {
      const anonymous = fixtureCollections((await get('/catalogue/collections')).json())
      const trade = fixtureCollections(
        (await get('/catalogue/collections', tradeCookie)).json()
      )
      expect(anonymous.map((collection) => collection.slug)).toEqual(
        trade.map((collection) => collection.slug)
      )

      const countOf = (collections) =>
        collections.find((collection) => collection.slug === slug('closed-featured'))
          .product_count
      expect(countOf(anonymous)).toBe(0)
      expect(countOf(trade)).toBe(1)
    })
  })

  describe('GET /catalogue/brands/:slug', () => {
    it('orders the house collections featured-first and carries the rank', async () => {
      const response = await get(`/catalogue/brands/${slug('zulu')}`)
      expect(response.statusCode).toBe(200)

      const { collections } = response.json().brand
      expect(collections.map((collection) => collection.slug)).toEqual([
        slug('zulu-featured'),
        slug('zulu-tie-alpha'),
        slug('zulu-tie-bravo'),
        slug('zulu-plain'),
      ])
      expect(collections[0].featured_rank).toBe(201)
      expect(collections.at(-1).featured_rank).toBeNull()
    })

    it('carries featured_rank on the house itself', async () => {
      const response = await get(`/catalogue/brands/${slug('closed')}`)
      expect(response.json().brand.featured_rank).toBe(103)
    })
  })

  describe('schema', () => {
    it('adds no unique index on featured_rank', async () => {
      // Duplicate ranks are legal by design — the ORDER BY is total without
      // help, and a unique index would turn every step of a reorder into a
      // potential 409. The fixture above holds two rows on rank 104, so this
      // would already have failed at insert time; the catalogue check is what
      // stops one being added later "for safety".
      const { rows } = await pool.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = ANY($1) AND indexdef ILIKE '%featured_rank%'`,
        [['brands', 'collections']]
      )
      expect(rows.filter((row) => /UNIQUE/i.test(row.indexdef))).toEqual([])
    })
  })
})
