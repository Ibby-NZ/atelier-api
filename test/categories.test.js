// The category vocabulary as a TABLE — add, list, delete — and the three foreign
// keys that replaced the three CHECK constraints.
//
// The old suite (test/suppliers-product-category.test.js) proved the three CHECK
// definitions matched EACH OTHER, because a value in one and not the others did
// not fail anywhere: it silently stopped matching. The foreign keys make that
// unconstructable — there is one list now — so what is worth asserting moved
// here: that all three columns really do point at it, that a category in use
// cannot be deleted, and that a category added this minute is immediately a
// legal value on a product.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'category-test'
const DOMAIN = 'category-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// The nine the migration seeds, which every fixture here works around rather
// than against: they are real vocabulary and other suites depend on them.
const SEEDED = [
  'fabric',
  'wallpaper',
  'trimming',
  'accessory',
  'bed-linen',
  'towel',
  'cushion',
  'throw',
  'misc',
]

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

describe('product categories', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  let brandId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  // Fixture categories are prefixed so cleanup can delete by prefix without
  // touching the nine. Products go first — they reference a category.
  const cleanup = async () => {
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM price_list_items WHERE supplier LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM supplier_freight_rates WHERE range_name LIKE $1`, [
      `${PREFIX}-%`,
    ])
    await pool.query(`DELETE FROM product_categories WHERE slug LIKE $1`, [`${PREFIX}-%`])
  }

  const createProduct = ({ slug, category }) =>
    pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, category)
       VALUES ($1, $2, $2, 'fabric', 'NZD', $3) RETURNING id, category`,
      [brandId, `${PREFIX}-${slug}`, category ?? null]
    )

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

    await cleanup()
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`])

    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only)
       VALUES ($1, $1, 'NZD', false) RETURNING id`,
      [`${PREFIX}-house`]
    )
    brandId = rows[0].id

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

  beforeEach(cleanup)

  afterAll(async () => {
    await cleanup()
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  describe('the schema', () => {
    it('seeds the nine the CHECK used to hold, and nothing else', async () => {
      const { rows } = await pool.query(
        `SELECT slug FROM product_categories WHERE slug NOT LIKE $1 ORDER BY sort`,
        [`${PREFIX}-%`]
      )
      expect(rows.map((row) => row.slug)).toEqual(SEEDED)
    })

    it('points all three category columns at the one table', async () => {
      // The property the three CHECKs existed to give, now given by construction:
      // there is one list, so the sets cannot drift apart.
      const { rows } = await pool.query(
        `SELECT conrelid::regclass::text AS table_name
           FROM pg_constraint
          WHERE contype = 'f'
            AND confrelid = 'product_categories'::regclass
          ORDER BY 1`
      )
      expect(rows.map((row) => row.table_name)).toEqual([
        'price_list_items',
        'products',
        'supplier_freight_rates',
      ])
    })

    it('has dropped the three CHECK constraints it replaced', async () => {
      const { rows } = await pool.query(
        `SELECT conname FROM pg_constraint
          WHERE conname IN ('products_category_check',
                            'price_list_items_category_check',
                            'supplier_freight_rates_category_check')`
      )
      expect(rows).toEqual([])
    })

    it('refuses a product category that is not in the table', async () => {
      await expect(createProduct({ slug: 'bad', category: 'curtain' })).rejects.toThrow(
        /products_category_fkey/
      )
    })

    it('still leaves a product uncategorised rather than guessing one', async () => {
      const { rows } = await createProduct({ slug: 'unset' })
      expect(rows[0].category).toBeNull()
    })
  })

  describe('GET /admin/categories', () => {
    it('is backoffice-only', async () => {
      expect((await inject('GET', '/admin/categories', null)).statusCode).toBe(401)
      expect((await inject('GET', '/admin/categories', customerCookie)).statusCode).toBe(403)
    })

    it('lists the vocabulary in its own order, with a product count', async () => {
      await createProduct({ slug: 'counted', category: 'fabric' })
      const response = await inject('GET', '/admin/categories', backofficeCookie)
      expect(response.statusCode).toBe(200)

      const { categories } = response.json()
      const slugs = categories.map((category) => category.slug)
      expect(slugs.slice(0, SEEDED.length)).toEqual(SEEDED)

      const fabric = categories.find((category) => category.slug === 'fabric')
      expect(fabric.label).toBe('Fabric')
      expect(fabric.product_count).toBeGreaterThanOrEqual(1)
    })
  })

  describe('POST /admin/categories', () => {
    it('is backoffice-only', async () => {
      const body = { label: `${PREFIX} Rug` }
      expect((await inject('POST', '/admin/categories', null, body)).statusCode).toBe(401)
      expect((await inject('POST', '/admin/categories', customerCookie, body)).statusCode).toBe(
        403
      )
    })

    it('derives the slug from the label and files it after the seeded nine', async () => {
      const response = await inject('POST', '/admin/categories', backofficeCookie, {
        label: `${PREFIX} Area Rug`,
      })
      expect(response.statusCode).toBe(201)

      const { category } = response.json()
      expect(category.slug).toBe(`${PREFIX}-area-rug`)
      expect(category.label).toBe(`${PREFIX} Area Rug`)
      expect(category.sort).toBeGreaterThan(90)
    })

    it('makes the new category a legal product category immediately', async () => {
      // The point of the whole change: no migration, no deploy, no restart —
      // which is why this asserts through the product route (whose schema is
      // compiled at boot) and not just through SQL.
      const { category } = (
        await inject('POST', '/admin/categories', backofficeCookie, {
          label: `${PREFIX} Rug`,
        })
      ).json()

      const created = await inject('POST', '/admin/products', backofficeCookie, {
        brand_id: brandId,
        name: `${PREFIX} Kilim`,
        product_type: 'fabric',
        currency: 'NZD',
        category: category.slug,
      })
      expect(created.statusCode).toBe(201)
      expect(created.json().product.category).toBe(category.slug)
    })

    it('refuses a duplicate label with 409, not a second row', async () => {
      await inject('POST', '/admin/categories', backofficeCookie, { label: `${PREFIX} Rug` })
      const again = await inject('POST', '/admin/categories', backofficeCookie, {
        label: `${PREFIX} Rug`,
      })
      expect(again.statusCode).toBe(409)
      expect(again.json().message).toMatch(/already a category/)
    })

    it('refuses a label with nothing sluggable in it', async () => {
      const response = await inject('POST', '/admin/categories', backofficeCookie, {
        label: '!!!',
      })
      expect(response.statusCode).toBe(422)
    })

    it('refuses a blank label at the schema', async () => {
      const response = await inject('POST', '/admin/categories', backofficeCookie, { label: '' })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('DELETE /admin/categories/:slug', () => {
    const addCategory = async (label) =>
      (await inject('POST', '/admin/categories', backofficeCookie, { label })).json().category

    it('is backoffice-only', async () => {
      const { slug } = await addCategory(`${PREFIX} Guarded`)
      expect((await inject('DELETE', `/admin/categories/${slug}`, null)).statusCode).toBe(401)
      expect(
        (await inject('DELETE', `/admin/categories/${slug}`, customerCookie)).statusCode
      ).toBe(403)
    })

    it('deletes one nothing points at', async () => {
      const { slug } = await addCategory(`${PREFIX} Spare`)
      const response = await inject('DELETE', `/admin/categories/${slug}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().deleted).toEqual({ entity: 'category', id: slug })

      const { rows } = await pool.query(`SELECT 1 FROM product_categories WHERE slug = $1`, [
        slug,
      ])
      expect(rows).toEqual([])
    })

    it('refuses one a product still carries, naming the count', async () => {
      const { slug } = await addCategory(`${PREFIX} Used`)
      await createProduct({ slug: 'in-use', category: slug })

      const response = await inject('DELETE', `/admin/categories/${slug}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        { relation: 'products', label: 'products', count: 1, capped: false },
      ])

      const { rows } = await pool.query(`SELECT 1 FROM product_categories WHERE slug = $1`, [
        slug,
      ])
      expect(rows).toHaveLength(1)
    })

    it('refuses one a price list line or a freight rate carries', async () => {
      // The two sides the old CHECK comparison existed for. A category can be
      // unused by the catalogue and still be load-bearing on the buying side.
      const { slug } = await addCategory(`${PREFIX} Bought`)
      await pool.query(
        `INSERT INTO price_list_items
           (supplier, category, code, code_normalized, unit, wholesale_rate, currency, source_file)
         VALUES ($1, $2, $3, $3, 'metre', 10, 'EUR', 'manual-entry')`,
        [`${PREFIX}-supplier`, slug, `${PREFIX}-code`]
      )

      const blocked = await inject('DELETE', `/admin/categories/${slug}`, backofficeCookie)
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().blockers).toEqual([
        { relation: 'price_list_items', label: 'price list lines', count: 1, capped: false },
      ])

      await pool.query(`DELETE FROM price_list_items WHERE supplier = $1`, [
        `${PREFIX}-supplier`,
      ])
      await pool.query(
        `INSERT INTO supplier_freight_rates
           (range_name, category, basis, rate, unit, effective_from)
         VALUES ($1, $2, 'dollar', 5, 'metre', '2026-01-01')`,
        [`${PREFIX}-range`, slug]
      )

      const stillBlocked = await inject('DELETE', `/admin/categories/${slug}`, backofficeCookie)
      expect(stillBlocked.statusCode).toBe(409)
      expect(stillBlocked.json().blockers).toEqual([
        { relation: 'supplier_freight_rates', label: 'freight rates', count: 1, capped: false },
      ])
    })

    it('answers 404 for a category that does not exist', async () => {
      const response = await inject(
        'DELETE',
        `/admin/categories/${PREFIX}-never-existed`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('the vocabulary reaches the surfaces that write a category', () => {
    it('accepts a new category on a product PATCH, and 422s an unknown one', async () => {
      const { category } = (
        await inject('POST', '/admin/categories', backofficeCookie, {
          label: `${PREFIX} Runner`,
        })
      ).json()
      const { rows } = await createProduct({ slug: 'patched' })

      const patched = await inject(
        'PATCH',
        `/admin/products/${rows[0].id}`,
        backofficeCookie,
        { category: category.slug }
      )
      expect(patched.statusCode).toBe(200)
      expect(patched.json().product.category).toBe(category.slug)

      const rejected = await inject(
        'PATCH',
        `/admin/products/${rows[0].id}`,
        backofficeCookie,
        { category: 'not-a-category' }
      )
      expect(rejected.statusCode).toBe(422)
      expect(rejected.json().message).toMatch(/Add it on Categories first/)
    })

    it('accepts a new category on a freight rate, and 422s an unknown one', async () => {
      const { category } = (
        await inject('POST', '/admin/categories', backofficeCookie, {
          label: `${PREFIX} Matting`,
        })
      ).json()
      // A range rate is keyed on a house's name, so the house must exist.
      await pool.query(
        `INSERT INTO brands (name, slug, currency) VALUES ($1, $1, 'NZD') ON CONFLICT DO NOTHING`,
        [`${PREFIX}-range`]
      )

      const created = await inject('POST', '/admin/freight/rates', backofficeCookie, {
        range_name: `${PREFIX}-range`,
        category: category.slug,
        basis: 'dollar',
        rate: 4,
        unit: 'metre',
        effective_from: '2026-01-01',
      })
      expect(created.statusCode).toBe(201)
      expect(created.json().category).toBe(category.slug)

      const rejected = await inject('POST', '/admin/freight/rates', backofficeCookie, {
        range_name: `${PREFIX}-range`,
        category: 'not-a-category',
        basis: 'dollar',
        rate: 4,
        unit: 'metre',
        effective_from: '2026-01-02',
      })
      expect(rejected.statusCode).toBe(422)
      expect(rejected.json().message).toMatch(/is not a category/)
    })
  })
})
