import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { CATEGORIES, categoryForItemType } from '../scripts/lib/price-template.js'

// The merchandising category end to end: the vocabulary itself, the public
// catalogue filter it unlocks, and the single-design admin door onto the column.
//
// The three CHECK definitions are compared to each other in
// test/suppliers-product-category.test.js — that suite owns the schema half and
// this one owns the behaviour.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'cat-axis-test'
const DOMAIN = 'cat-axis-test.example.com'
const PASSWORD = 'correct horse battery staple'
const testEmail = (local) => `${local}@${DOMAIN}`

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('the category vocabulary', () => {
  it('carries the four the rate sheet buys on plus the five Atelier sells', () => {
    expect([...CATEGORIES]).toEqual([
      'fabric',
      'wallpaper',
      'trimming',
      'accessory',
      'bed-linen',
      'towel',
      'cushion',
      'throw',
      'misc',
    ])
  })

  it('has a word for every item type on the corrected in-stock sheet', () => {
    // The seven the office's own corrected workbook uses, which between them
    // cover all 381 active, in-stock, current-version rows. A blank here is the
    // failure this widening exists to remove.
    for (const itemType of [
      'Fabrics',
      'Towels',
      'Bed Linen',
      'Throws/Blankets',
      'Cushions',
      'Accessories',
      'Miscellaneous',
    ]) {
      expect(categoryForItemType(itemType)).not.toBeNull()
    }
    expect(categoryForItemType('Towels')).toBe('towel')
    expect(categoryForItemType('Bed Linen')).toBe('bed-linen')
    expect(categoryForItemType('Throws/Blankets')).toBe('throw')
    expect(categoryForItemType('Cushions')).toBe('cushion')
    expect(categoryForItemType('Miscellaneous')).toBe('misc')
  })

  it('is case- and whitespace-insensitive, because the cell is typed by a person', () => {
    expect(categoryForItemType('  bed linen  ')).toBe('bed-linen')
    expect(categoryForItemType('THROWS/BLANKETS')).toBe('throw')
  })

  it('still has no word for the types nobody has ruled on, and says so with null', () => {
    // Deliberately unmapped (scripts/lib/price-template.js records the reason
    // for each). `Bedding` is the load-bearing one: the corrected sheet SPLIT
    // its three rows two ways, so a mapping would assert the wrong answer for
    // most of them. Guessing here is worse than a blank, because the office
    // confirms a suggestion by doing nothing.
    for (const itemType of [
      'Bedding',
      'Leather',
      'Rug/Carpet',
      'Candles',
      'Furniture',
      'Samples and Displays',
      'No Group Selected',
      '',
      null,
    ]) {
      expect(categoryForItemType(itemType)).toBeNull()
    }
  })

  it('maps nothing to a value the database could not store', () => {
    // assertStorable already proves this at module load; asserting it here is
    // what makes the failure legible if that ever stops running.
    expect(CATEGORIES.has(categoryForItemType('Towels'))).toBe(true)
  })
})

describe('category on the catalogue', () => {
  let pool
  let app
  let backofficeCookie
  let brandId
  let brandSlug

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const cleanupFixtures = (db) =>
    db.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

  const createProduct = async (suffix, overrides = {}) => {
    const response = await inject('POST', '/admin/products', backofficeCookie, {
      brand_id: brandId,
      name: `Cat Axis ${suffix}`,
      product_type: 'finished_good',
      currency: 'NZD',
      show_on_website: true,
      ...overrides,
    })
    return response.json().product
  }

  const publicSlugs = async (query) => {
    const response = await inject('GET', `/catalogue/products?${query}`, null)
    expect(response.statusCode).toBe(200)
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
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered once: register shares a 10-per-15-min bucket with login and
    // the limiter store is per buildApp() instance.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('boss')])
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    const brand = await inject('POST', '/admin/brands', backofficeCookie, {
      name: `Cat Axis Test ${PREFIX}`,
      currency: 'NZD',
      trade_only: false,
    })
    brandId = brand.json().brand.id
    // Server-generated from the name, so it is read back rather than assumed —
    // and every public read below is scoped to it, so an assertion can never be
    // decided by whatever else happens to be in the catalogue.
    brandSlug = brand.json().brand.slug
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  it('creates a product with a category and reads it back', async () => {
    const product = await createProduct('cushion', { category: 'cushion' })
    expect(product.category).toBe('cushion')

    const read = await inject('GET', `/admin/products/${product.id}`, backofficeCookie)
    expect(read.json().product.category).toBe('cushion')
  })

  it('defaults to null — uncategorised is a real state, not a gap', async () => {
    const product = await createProduct('blank')
    expect(product.category).toBeNull()
  })

  it('patches the category of an existing design', async () => {
    // The whole point of the admin door: before this the column could only be
    // written by uploading a CSV to /admin/product-sheet/apply.
    const product = await createProduct('patch')
    const patched = await inject('PATCH', `/admin/products/${product.id}`, backofficeCookie, {
      category: 'throw',
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().product.category).toBe('throw')
  })

  it('clears it back to uncategorised with an explicit null', async () => {
    const product = await createProduct('clear', { category: 'towel' })
    const patched = await inject('PATCH', `/admin/products/${product.id}`, backofficeCookie, {
      category: null,
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().product.category).toBeNull()
  })

  it('refuses a category outside the vocabulary at the schema, not the database', async () => {
    const response = await inject('POST', '/admin/products', backofficeCookie, {
      brand_id: brandId,
      name: 'Cat Axis Curtain',
      product_type: 'fabric',
      currency: 'NZD',
      category: 'curtain',
    })
    expect(response.statusCode).toBe(400)
  })

  it('is independent of product_type — a fabric may be a towel', async () => {
    // product_type drives the colourway's inventory unit; category is the
    // merchandising axis. Conflating them is the trap the column has to survive.
    const product = await createProduct('towelling', {
      product_type: 'fabric',
      category: 'towel',
    })
    expect(product.product_type).toBe('fabric')
    expect(product.category).toBe('towel')
  })

  describe('the public filter', () => {
    it('narrows the grid to one category and carries it on the card', async () => {
      const cushion = await createProduct('pub-cushion', { category: 'cushion' })
      await createProduct('pub-throw', { category: 'throw' })
      await createProduct('pub-none')

      const slugs = await publicSlugs(`brand=${brandSlug}&category=cushion`)
      expect(slugs).toEqual([cushion.slug])

      const response = await inject(
        'GET',
        `/catalogue/products?brand=${brandSlug}&category=cushion`,
        null
      )
      expect(response.json().products[0].category).toBe('cushion')
    })

    it('carries the category on every card, null included', async () => {
      // Always present so the storefront branches on the value rather than on
      // whether the key arrived — most of the catalogue is uncategorised.
      const bare = await createProduct('pub-bare')
      const response = await inject('GET', `/catalogue/products?brand=${brandSlug}`, null)
      const card = response
        .json()
        .products.find((product) => product.slug === bare.slug)
      expect(card).toBeDefined()
      expect(card).toHaveProperty('category', null)
    })

    it('carries it on the detail endpoint too', async () => {
      const product = await createProduct('detail', { category: 'bed-linen' })
      const response = await inject('GET', `/catalogue/products/${product.slug}`, null)
      expect(response.statusCode).toBe(200)
      expect(response.json().product.category).toBe('bed-linen')
    })

    it('400s an unknown category rather than serving an empty grid', async () => {
      // A word the database could not hold would otherwise match nothing and
      // read exactly like a catalogue with nothing in it.
      const response = await inject('GET', '/catalogue/products?category=curtain', null)
      expect(response.statusCode).toBe(400)
    })

    it('accepts every value in the vocabulary', async () => {
      for (const category of CATEGORIES) {
        const response = await inject('GET', `/catalogue/products?category=${category}`, null)
        expect(response.statusCode).toBe(200)
      }
    })

    it('counts the filtered total, not the whole catalogue', async () => {
      await createProduct('meta-a', { category: 'towel' })
      await createProduct('meta-b', { category: 'towel' })
      await createProduct('meta-c', { category: 'throw' })
      const response = await inject(
        'GET',
        `/catalogue/products?brand=${brandSlug}&category=towel`,
        null
      )
      expect(response.json().meta.total).toBe(2)
    })
  })
})
