// Migration 1791638400000: a house invoiced by more than one supplier, and the
// discount tier staff pick per product.
//   1. additional suppliers — the brand routes, promotion to main, the supplier
//      list/detail, the waterfall's supplier choice
//   2. product tiers — the finance-gated routes, the house check, the waterfall
//      using the choice, resolveTermsChain's precedence
//
// Real Postgres, prefixed fixtures. Sessions are registered once (register and
// login share a 10-per-15-min bucket).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { resolveTermsChain } from '../src/suppliers/discount-chain.js'

const PREFIX = 'brand-suppliers-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

const cleanup = async (pool) => {
  // links, terms, tiers and product choices all CASCADE from brands/suppliers
  await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
}

const one = (pool, sql, params) => pool.query(sql, params).then(({ rows }) => rows[0].id)

const insertSupplier = (pool, suffix, currency = 'USD') =>
  one(pool, `INSERT INTO suppliers (name, slug, currency) VALUES ($1, $2, $3) RETURNING id`, [
    `${PREFIX} ${suffix}`,
    `${PREFIX}-${suffix}`,
    currency,
  ])

const insertBrand = (pool, suffix, supplierId) =>
  one(
    pool,
    `INSERT INTO brands (name, slug, currency, trade_only, supplier_id)
     VALUES ($1, $2, 'NZD', true, $3) RETURNING id`,
    [`${PREFIX} ${suffix}`, `${PREFIX}-${suffix}`, supplierId]
  )

const insertProduct = (pool, suffix, brandId) =>
  one(
    pool,
    `INSERT INTO products (brand_id, name, slug, product_type, currency)
     VALUES ($1, $2, $3, 'fabric', 'NZD') RETURNING id`,
    [brandId, `${PREFIX} ${suffix}`, `${PREFIX}-${suffix}`]
  )

describe('brand additional suppliers and product discount tiers', () => {
  let pool
  let app
  let financeCookie
  let plainCookie
  let mainId
  let otherId
  let strangerId
  let houseId
  let otherHouseId
  let productId
  let otherProductId
  let tierIds

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
    return header.split(';')[0]
  }
  const inject = (method, url, { cookie = financeCookie, payload } = {}) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload ? { payload } : {}) })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup(pool)
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    mainId = await insertSupplier(pool, 'main', 'USD')
    otherId = await insertSupplier(pool, 'other', 'THB')
    strangerId = await insertSupplier(pool, 'stranger')
    houseId = await insertBrand(pool, 'house', mainId)
    otherHouseId = await insertBrand(pool, 'other-house', mainId)
    productId = await insertProduct(pool, 'product', houseId)
    otherProductId = await insertProduct(pool, 'other-product', otherHouseId)

    const termsId = await one(
      pool,
      `INSERT INTO supplier_brand_terms (supplier_id, brand_id) VALUES ($1, $2) RETURNING id`,
      [mainId, houseId]
    )
    const { rows } = await pool.query(
      `INSERT INTO supplier_discount_tiers (supplier_brand_term_id, label, pct, is_fallback)
       VALUES ($1, 'Standard', 0.40, true), ($1, 'Design', 0.45, false), ($1, 'Contract', 0.50, false)
       RETURNING id, label`,
      [termsId]
    )
    tierIds = Object.fromEntries(rows.map((row) => [row.label, row.id]))

    for (const [key, finance] of [
      ['finance', true],
      ['plain', false],
    ]) {
      const email = `${PREFIX}-${key}@example.test`
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: PASSWORD, name: key },
      })
      await pool.query(`UPDATE users SET role = 'backoffice', can_view_finance = $2 WHERE email = $1`, [
        email,
        finance,
      ])
      if (key === 'finance') financeCookie = sessionCookieFrom(res)
      else plainCookie = sessionCookieFrom(res)
    }
  })

  afterAll(async () => {
    await app.close()
    await cleanup(pool)
    await pool.end()
  })

  describe('additional suppliers', () => {
    it('adds another supplier to a house, idempotently, and lists it on the brand', async () => {
      const first = await inject('POST', `/admin/brands/${houseId}/suppliers`, {
        cookie: plainCookie,
        payload: { supplier_id: otherId },
      })
      expect(first.statusCode).toBe(201)
      expect(first.json().brand.supplier_id).toBe(mainId)
      expect(first.json().brand.additional_suppliers).toEqual([{ id: otherId, name: `${PREFIX} other` }])

      const again = await inject('POST', `/admin/brands/${houseId}/suppliers`, { payload: { supplier_id: otherId } })
      expect(again.json().brand.additional_suppliers).toHaveLength(1)

      const list = await inject('GET', '/admin/brands?include_archived=true')
      const row = list.json().brands.find((brand) => brand.id === houseId)
      expect(row.additional_suppliers.map((s) => s.id)).toEqual([otherId])
    })

    it('refuses the main supplier, an unknown supplier and an unknown house', async () => {
      const main = await inject('POST', `/admin/brands/${houseId}/suppliers`, { payload: { supplier_id: mainId } })
      expect(main.statusCode).toBe(422)
      const unknown = await inject('POST', `/admin/brands/${houseId}/suppliers`, { payload: { supplier_id: 999999999 } })
      expect(unknown.statusCode).toBe(422)
      const house = await inject('POST', '/admin/brands/999999999/suppliers', { payload: { supplier_id: otherId } })
      expect(house.statusCode).toBe(404)
    })

    it('shows the house on both suppliers, marking which one is main', async () => {
      const detail = (await inject('GET', `/admin/suppliers/${otherId}`)).json().supplier
      expect(detail.brands).toEqual([expect.objectContaining({ id: houseId, is_main: false })])
      const main = (await inject('GET', `/admin/suppliers/${mainId}`)).json().supplier
      expect(main.brands.find((b) => b.id === houseId).is_main).toBe(true)

      const list = await inject('GET', `/admin/suppliers?q=${encodeURIComponent(`${PREFIX} house`)}`)
      const found = list.json().suppliers.find((s) => s.id === otherId)
      expect(found.brand_count).toBe(1)
    })

    it('prices through the chosen supplier, and refuses one that does not invoice the house', async () => {
      const base = `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100`
      expect((await inject('GET', base)).json().supplier.id).toBe(mainId)
      const other = (await inject('GET', `${base}&supplier_id=${otherId}`)).json()
      expect(other.supplier).toMatchObject({ id: otherId, currency: 'THB' })
      expect(other.currency).toBe('THB')
      const stranger = await inject('GET', `${base}&supplier_id=${strangerId}`)
      expect(stranger.statusCode).toBe(422)
    })

    it('drops the link when the additional supplier is promoted to main', async () => {
      const promoted = await inject('PATCH', `/admin/brands/${houseId}`, { payload: { supplier_id: otherId } })
      expect(promoted.statusCode).toBe(200)
      const brand = (await inject('GET', `/admin/brands/${houseId}`)).json().brand
      expect(brand.supplier_id).toBe(otherId)
      expect(brand.additional_suppliers).toEqual([])
      await inject('PATCH', `/admin/brands/${houseId}`, { payload: { supplier_id: mainId } })
    })

    it('removes an additional supplier, and 404s one that is not linked', async () => {
      await inject('POST', `/admin/brands/${houseId}/suppliers`, { payload: { supplier_id: otherId } })
      const removed = await inject('DELETE', `/admin/brands/${houseId}/suppliers/${otherId}`)
      expect(removed.statusCode).toBe(200)
      expect(removed.json().brand.additional_suppliers).toEqual([])
      const again = await inject('DELETE', `/admin/brands/${houseId}/suppliers/${otherId}`)
      expect(again.statusCode).toBe(404)
    })
  })

  describe('product discount tiers', () => {
    it('refuses a login without finance visibility', async () => {
      const read = await inject('GET', `/admin/products/${productId}/discount-tier`, { cookie: plainCookie })
      expect(read.statusCode).toBe(403)
      const write = await inject('PUT', `/admin/products/${productId}/discount-tier`, {
        cookie: plainCookie,
        payload: { tier_id: tierIds.Design },
      })
      expect(write.statusCode).toBe(403)
    })

    it('offers every tier of the product’s house, lowest rate first, with no choice yet', async () => {
      const res = await inject('GET', `/admin/products/${productId}/discount-tier`)
      expect(res.statusCode).toBe(200)
      const tier = res.json().discount_tier
      expect(tier.tier_id).toBeNull()
      expect(tier.tiers.map((t) => [t.label, t.pct])).toEqual([
        ['Standard', 0.4],
        ['Design', 0.45],
        ['Contract', 0.5],
      ])
    })

    it('stores a choice, and the waterfall prices the product with it', async () => {
      const put = await inject('PUT', `/admin/products/${productId}/discount-tier`, { payload: { tier_id: tierIds.Contract } })
      expect(put.statusCode).toBe(200)
      expect(put.json().discount_tier.tier_id).toBe(tierIds.Contract)

      const base = `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100`
      const withProduct = (await inject('GET', `${base}&product_id=${productId}`)).json()
      expect(withProduct.inputs.discount_percent).toMatchObject({ value: 50, source: 'terms' })
      expect(withProduct.inputs.discount_percent.detail).toMatchObject({ shape: 'tier', label: 'Contract' })

      // Without a product the fallback tier still applies.
      const houseOnly = (await inject('GET', base)).json()
      expect(houseOnly.inputs.discount_percent).toMatchObject({ value: 40 })
    })

    it('refuses another house’s tier and another house’s product', async () => {
      const otherTermsId = await one(
        pool,
        `INSERT INTO supplier_brand_terms (supplier_id, brand_id) VALUES ($1, $2) RETURNING id`,
        [mainId, otherHouseId]
      )
      const foreign = await one(
        pool,
        `INSERT INTO supplier_discount_tiers (supplier_brand_term_id, label, pct) VALUES ($1, 'Other', 0.1) RETURNING id`,
        [otherTermsId]
      )
      const put = await inject('PUT', `/admin/products/${productId}/discount-tier`, { payload: { tier_id: foreign } })
      expect(put.statusCode).toBe(422)

      const wrongProduct = await inject(
        'GET',
        `/admin/pricing/waterfall?brand_id=${houseId}&wholesale_rate=100&product_id=${otherProductId}`
      )
      expect(wrongProduct.statusCode).toBe(422)
      const missing = await inject('GET', '/admin/products/999999999/discount-tier')
      expect(missing.statusCode).toBe(404)
    })

    it('clears the choice with null, and loses it when the tier is deleted', async () => {
      const cleared = await inject('PUT', `/admin/products/${productId}/discount-tier`, { payload: { tier_id: null } })
      expect(cleared.json().discount_tier.tier_id).toBeNull()

      await inject('PUT', `/admin/products/${productId}/discount-tier`, { payload: { tier_id: tierIds.Design } })
      await pool.query('DELETE FROM supplier_discount_tiers WHERE id = $1', [tierIds.Design])
      const after = (await inject('GET', `/admin/products/${productId}/discount-tier`)).json().discount_tier
      expect(after.tier_id).toBeNull()
    })
  })
})

describe('resolveTermsChain with a chosen tier', () => {
  const tiers = [
    { id: 1, label: 'fabric', pct: 0.4, is_fallback: false },
    { id: 2, label: 'Contract', pct: 0.5, is_fallback: false },
    { id: 3, label: 'Other', pct: 0.3, is_fallback: true },
  ]

  it('prefers the chosen tier over category matching and the fallback', () => {
    expect(resolveTermsChain({}, tiers, 'fabric', 2)).toMatchObject({ chain: [0.5], source: 'tier', label: 'Contract' })
  })

  it('ignores a tier id that is not one of the tiers', () => {
    expect(resolveTermsChain({}, tiers, 'fabric', 99)).toMatchObject({ label: 'fabric' })
  })

  it('still lets a compounded chain win', () => {
    expect(resolveTermsChain({ discount_chain: [0.4, 0.4] }, tiers, null, 2).source).toBe('chain')
  })
})
