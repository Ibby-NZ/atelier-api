// Supplier read models and the back-office admin module.
//
// Two halves, and the second is the point of the story:
//   1. The module itself — list (q / include_archived / pagination), the detail
//      read model with aliases, linked houses and per-brand terms, and the
//      writes through the frozen column whitelist.
//   2. A negative exposure suite. The supplier record IS cost-bearing: it names
//      the freight agent, the Incoterm, the PO address and how the house is
//      discounted, and the detail model embeds the per-brand terms outright.
//      `brands.supplier_id` was added by this workstream, so every public
//      catalogue body is now one careless `SELECT *` away from carrying it.
//      These assertions run over the REAL /catalogue/* responses rather than by
//      reading SELECT lists, the response-layer counterpart to the source scan
//      in test/suppliers-terms.test.js.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SUPPLIER_UPDATE_COLUMNS,
  createSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from '../src/suppliers/admin-suppliers.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'w3-admin-test'

// The same vocabulary test/price-list-exposure.test.js polices, plus the
// supplier-record fields that only exist since this workstream: a house's
// discount, its D365 roll-up token, the internal PO address and the negotiated
// freight terms.
const FORBIDDEN_KEY =
  /wholesale|landed|duty|freight|cost|margin|markup|credit_limit|payment_terms|discount|supplier|incoterm|po_email|d365|short_code|\bagent\b/i

const collectKeys = (value, keys = []) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key)
      collectKeys(entry, keys)
    }
  }
  return keys
}

// FK order: brands RESTRICT-reference suppliers and terms CASCADE from brands,
// so the houses must go first or the supplier delete 23503s inside cleanup and
// every later test sees leftovers.
const cleanup = async (pool) => {
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

describe('supplier admin module', () => {
  let pool
  let app
  let alpha
  let houseChain
  let houseTiers

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

    const { rows: suppliers } = await pool.query(
      `INSERT INTO suppliers
         (name, slug, short_code, d365_token, country, currency, agent, incoterm,
          po_email, discount_method, archived_at)
       VALUES
         ($1, $2, 'W3ALP', 'W3AL', 'Italy', 'EUR', 'Wilson Freight', 'FOB Milan',
          'orders@w3alpha.test', 'per-brand', NULL),
         ($3, $4, NULL, NULL, 'Thailand', 'USD', NULL, NULL, NULL, 'averaged', NULL),
         ($5, $6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, now()),
         ($7, $8, NULL, NULL, 'France', 'EUR', NULL, NULL, NULL, 'averaged', NULL)
       RETURNING id, slug`,
      [
        `${PREFIX} alpha`,
        `${PREFIX}-alpha`,
        `${PREFIX} bravo`,
        `${PREFIX}-bravo`,
        `${PREFIX} charlie`,
        `${PREFIX}-charlie`,
        `${PREFIX} delta`,
        `${PREFIX}-delta`,
      ]
    )
    const supplierId = new Map(suppliers.map((row) => [row.slug, row.id]))
    alpha = supplierId.get(`${PREFIX}-alpha`)

    // The spelling the price-list filenames use for this house. Staff look a
    // supplier up by whichever spelling is in front of them, so the list search
    // has to reach it.
    await pool.query(
      `INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, $2), ($1, $3)`,
      [alpha, 'W3JWALL', ' W3 C&C Milano ']
    )

    // trade_only = false on every house here: the exposure half models what an
    // ANONYMOUS visitor receives, and the column is NOT NULL DEFAULT true.
    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, supplier_id)
       VALUES ($1, $2, 'Italy', 'EUR', true, false, $5),
              ($3, $4, 'Italy', 'EUR', true, false, $5)
       RETURNING id, slug`,
      [
        `${PREFIX} House Chain`,
        `${PREFIX}-house-chain`,
        `${PREFIX} House Tiers`,
        `${PREFIX}-house-tiers`,
        alpha,
      ]
    )
    const brandId = new Map(brands.map((row) => [row.slug, row.id]))
    houseChain = brandId.get(`${PREFIX}-house-chain`)
    houseTiers = brandId.get(`${PREFIX}-house-tiers`)

    // "40% off, then 40% off the result" — the JV Fabrics shape. x0.36.
    await pool.query(
      `INSERT INTO supplier_brand_terms (supplier_id, brand_id, discount_chain, markup, note)
       VALUES ($1, $2, ARRAY[0.4, 0.4]::numeric(6,4)[], 2.2, 'chain house')`,
      [alpha, houseChain]
    )
    const { rows: tierTerms } = await pool.query(
      `INSERT INTO supplier_brand_terms (supplier_id, brand_id, indicative)
       VALUES ($1, $2, true) RETURNING id`,
      [alpha, houseTiers]
    )
    await pool.query(
      `INSERT INTO supplier_discount_tiers (supplier_brand_term_id, label, pct, is_fallback)
       VALUES ($1, 'wallpaper', 0.4, false), ($1, 'All other collections', 0.5, true)`,
      [tierTerms[0].id]
    )

    const { rows: collections } = await pool.query(
      `INSERT INTO collections (brand_id, name, slug) VALUES ($1, 'W3 Range', $2)
       RETURNING id`,
      [houseChain, `${PREFIX}-range`]
    )
    const { rows: products } = await pool.query(
      `INSERT INTO products
         (brand_id, collection_id, name, slug, product_type, currency, show_on_website, category)
       VALUES ($1, $2, 'W3 Admin Fabric', $3, 'fabric', 'EUR', true, 'fabric')
       RETURNING id`,
      [houseChain, collections[0].id, `${PREFIX}-fabric`]
    )
    await pool.query(
      `INSERT INTO colourways (product_id, name, sku) VALUES ($1, 'Ink', $2)`,
      [products[0].id, `${PREFIX}-sku-1`]
    )

    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
  })

  afterAll(async () => {
    await cleanup(pool)
    await app?.close()
    await pool?.end()
  })

  describe('listSuppliers', () => {
    it('hides archived suppliers by default and includes them on request', async () => {
      const live = await listSuppliers(pool, { q: PREFIX })
      expect(live.total).toBe(3)
      expect(live.suppliers.map((s) => s.slug)).toEqual([
        `${PREFIX}-alpha`,
        `${PREFIX}-bravo`,
        `${PREFIX}-delta`,
      ])

      const all = await listSuppliers(pool, { q: PREFIX, includeArchived: true })
      expect(all.total).toBe(4)
      expect(all.suppliers.map((s) => s.slug)).toContain(`${PREFIX}-charlie`)
    })

    it('pages a filtered list, reporting the unpaged total', async () => {
      const first = await listSuppliers(pool, { q: PREFIX, page: 1, limit: 2 })
      expect(first.total).toBe(3)
      expect(first.suppliers.map((s) => s.slug)).toEqual([
        `${PREFIX}-alpha`,
        `${PREFIX}-bravo`,
      ])

      const second = await listSuppliers(pool, { q: PREFIX, page: 2, limit: 2 })
      expect(second.total).toBe(3)
      expect(second.suppliers.map((s) => s.slug)).toEqual([`${PREFIX}-delta`])
    })

    it('searches aliases, not just the canonical name', async () => {
      // 'W3JWALL' appears nowhere on the supplier row — only as an alias.
      const byAlias = await listSuppliers(pool, { q: 'W3JWALL' })
      expect(byAlias.suppliers.map((s) => s.slug)).toEqual([`${PREFIX}-alpha`])

      // Padded and mixed-case, exactly as a filename prefix arrives.
      const padded = await listSuppliers(pool, { q: 'w3 c&c mil' })
      expect(padded.suppliers.map((s) => s.slug)).toEqual([`${PREFIX}-alpha`])
    })

    it('searches the short code, the D365 token and the country', async () => {
      for (const q of ['W3ALP', 'W3AL', 'Thailand']) {
        const found = await listSuppliers(pool, { q })
        expect(found.suppliers.length).toBeGreaterThan(0)
      }
    })

    it('treats a blank term as no filter rather than as "match nothing"', async () => {
      const blank = await listSuppliers(pool, { q: '   ' })
      expect(blank.total).toBeGreaterThanOrEqual(3)
    })

    it('escapes LIKE wildcards so a literal underscore is a literal', async () => {
      const found = await listSuppliers(pool, { q: 'w3_admin_test' })
      expect(found.suppliers).toEqual([])
    })

    it('clamps the page size to MAX_LIMIT and falls back to DEFAULT_LIMIT', async () => {
      expect(MAX_LIMIT).toBeGreaterThan(DEFAULT_LIMIT)
      // A limit past the cap must not become an unbounded query.
      const huge = await listSuppliers(pool, { q: PREFIX, limit: 100000 })
      expect(huge.suppliers.length).toBeLessThanOrEqual(MAX_LIMIT)
      // A junk limit is ignored, not passed through to the SQL.
      const junk = await listSuppliers(pool, { q: PREFIX, limit: -5 })
      expect(junk.suppliers).toHaveLength(3)
    })
  })

  describe('getSupplier', () => {
    it('carries the aliases, the linked houses and their commercial terms', async () => {
      const supplier = await getSupplier(pool, alpha)

      expect(supplier).toMatchObject({
        slug: `${PREFIX}-alpha`,
        // The INVOICING currency, not the country's — Italy could equally be a
        // house that bills in USD.
        currency: 'EUR',
        country: 'Italy',
        agent: 'Wilson Freight',
        incoterm: 'FOB Milan',
        po_email: 'orders@w3alpha.test',
        discount_method: 'per-brand',
      })

      expect(supplier.aliases.map((a) => a.alias)).toEqual([' W3 C&C Milano ', 'W3JWALL'])
      expect(supplier.brands.map((b) => b.slug)).toEqual([
        `${PREFIX}-house-chain`,
        `${PREFIX}-house-tiers`,
      ])
    })

    it('resolves a {0.4, 0.4} chain to x0.36, never to -80%', async () => {
      const supplier = await getSupplier(pool, alpha)
      const chained = supplier.brands.find((b) => b.id === houseChain)

      expect(chained.terms.discount_chain).toEqual([0.4, 0.4])
      expect(chained.terms.net_source).toBe('chain')
      expect(chained.terms.net_multiplier).toBeCloseTo(0.36, 10)
      // A summed chain would be 0.8 off, i.e. a x0.2 multiplier.
      expect(chained.terms.net_multiplier).not.toBeCloseTo(0.2, 10)
      // markup is a scalar numeric, which pg hands back as a string.
      expect(chained.terms.markup).toBe(2.2)
      expect(chained.terms.discount).toBeNull()
    })

    it('falls back to the tier flagged is_fallback when no category matches', async () => {
      const supplier = await getSupplier(pool, alpha)
      const tiered = supplier.brands.find((b) => b.id === houseTiers)

      expect(tiered.terms.tiers.map((t) => t.label)).toEqual([
        'wallpaper',
        'All other collections',
      ])
      expect(tiered.terms.net_source).toBe('tier')
      expect(tiered.terms.net_label).toBe('All other collections')
      expect(tiered.terms.net_multiplier).toBeCloseTo(0.5, 10)
      expect(tiered.terms.indicative).toBe(true)
      expect(tiered.terms.invalid_reason).toBeNull()
    })

    it('returns null for an unknown id', async () => {
      expect(await getSupplier(pool, 0)).toBeNull()
    })
  })

  describe('createSupplier', () => {
    const created = []

    afterAll(async () => {
      if (created.length > 0) {
        await pool.query(`DELETE FROM suppliers WHERE id = ANY($1::int[])`, [created])
      }
    })

    it('derives the slug from the name and never accepts one', async () => {
      const supplier = await createSupplier(pool, {
        name: `${PREFIX} Echo & Sons`,
        slug: 'client-supplied-slug',
        country: 'Thailand',
        currency: 'USD',
      })
      created.push(supplier.id)

      expect(supplier.slug).toBe(`${PREFIX}-echo-sons`)
      // Jim Thompson is Thailand and invoices USD; nothing may derive one from
      // the other.
      expect(supplier).toMatchObject({ country: 'Thailand', currency: 'USD' })
      expect(supplier.archived_at).toBeNull()
    })

    it('leaves every optional column null rather than guessing one', async () => {
      const supplier = await createSupplier(pool, { name: `${PREFIX} Foxtrot` })
      created.push(supplier.id)

      expect(supplier).toMatchObject({
        short_code: null,
        d365_token: null,
        country: null,
        // Blank means "no invoice on file yet", which is honest; a value copied
        // from country would silently mis-convert every landed cost built on it.
        currency: null,
        agent: null,
        incoterm: null,
        po_email: null,
        discount_method: null,
      })
    })

    it('rejects a name with no letters or digits with a 422', async () => {
      await expect(createSupplier(pool, { name: '!!!' })).rejects.toMatchObject({
        statusCode: 422,
      })
    })

    it('lets the database detect a duplicate name (409, never a pre-check)', async () => {
      await expect(
        createSupplier(pool, { name: `${PREFIX} alpha` })
      ).rejects.toMatchObject({ statusCode: 409 })
    })

    it('names the field in a duplicate D365 token or short code', async () => {
      await expect(
        createSupplier(pool, { name: `${PREFIX} Golf`, d365_token: 'W3AL' })
      ).rejects.toMatchObject({ statusCode: 409, message: /D365 token/ })

      await expect(
        createSupplier(pool, { name: `${PREFIX} Hotel`, short_code: 'W3ALP' })
      ).rejects.toMatchObject({ statusCode: 409, message: /short code/ })
    })

    it('refuses a discount_method outside the checked vocabulary', async () => {
      await expect(
        createSupplier(pool, { name: `${PREFIX} India`, discount_method: 'guessed' })
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  describe('updateSupplier', () => {
    let target

    beforeAll(async () => {
      target = await createSupplier(pool, { name: `${PREFIX} Juliet` })
    })

    afterAll(async () => {
      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [target.id])
    })

    it('writes only whitelisted columns and stamps updated_at', async () => {
      const before = await getSupplier(pool, target.id)
      const patched = await updateSupplier(pool, target.id, {
        country: 'France',
        currency: 'EUR',
        agent: 'Ital Logistics',
      })

      expect(patched).toMatchObject({
        country: 'France',
        currency: 'EUR',
        agent: 'Ital Logistics',
      })
      expect(new Date(patched.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updated_at).getTime()
      )
    })

    it('ignores a key outside the frozen whitelist', async () => {
      // The whitelist is the gate, not the route schema: Ajv's removeAdditional
      // strips unknown keys before a handler ever runs, so a module called
      // directly must refuse them on its own.
      expect(SUPPLIER_UPDATE_COLUMNS).not.toContain('slug')
      expect(SUPPLIER_UPDATE_COLUMNS).not.toContain('archived_at')
      expect(Object.isFrozen(SUPPLIER_UPDATE_COLUMNS)).toBe(true)

      const patched = await updateSupplier(pool, target.id, {
        slug: 'rewritten',
        archived_at: null,
        country: 'Italy',
      })
      expect(patched.slug).toBe(`${PREFIX}-juliet`)
      expect(patched.archived_at).toBeNull()
      expect(patched.country).toBe('Italy')
    })

    it('keeps an explicit null (clear the field) distinct from an absent key', async () => {
      await updateSupplier(pool, target.id, { po_email: 'po@w3juliet.test' })
      const cleared = await updateSupplier(pool, target.id, { po_email: null })
      expect(cleared.po_email).toBeNull()
      // country was set by the previous test and must survive an unrelated patch.
      expect(cleared.country).toBe('Italy')
    })

    it('renames without moving the slug', async () => {
      const renamed = await updateSupplier(pool, target.id, {
        name: `${PREFIX} Juliet Renamed`,
      })
      expect(renamed.name).toBe(`${PREFIX} Juliet Renamed`)
      expect(renamed.slug).toBe(`${PREFIX}-juliet`)
    })

    it('400s an empty patch and 404s an unknown id', async () => {
      await expect(updateSupplier(pool, target.id, {})).rejects.toMatchObject({
        statusCode: 400,
      })
      await expect(updateSupplier(pool, 0, { country: 'Italy' })).rejects.toMatchObject({
        statusCode: 404,
      })
    })

    it('turns a duplicate name into a 409', async () => {
      await expect(
        updateSupplier(pool, target.id, { name: `${PREFIX} alpha` })
      ).rejects.toMatchObject({ statusCode: 409 })
    })
  })

  // ---------------------------------------------------------------------------
  // The half that matters: none of the above may reach a client.
  // ---------------------------------------------------------------------------
  describe('no supplier or cost field reaches a /catalogue/* response', () => {
    const CATALOGUE_URLS = [
      '/catalogue/products',
      `/catalogue/products?brand=${PREFIX}-house-chain`,
      `/catalogue/products/${PREFIX}-fabric`,
      '/catalogue/brands',
      `/catalogue/brands/${PREFIX}-house-chain`,
      `/catalogue/collections?brand=${PREFIX}-house-chain`,
      `/catalogue/brands/${PREFIX}-house-chain/collections/${PREFIX}-range`,
    ]

    it.each(CATALOGUE_URLS)('%s carries no cost-side key', async (url) => {
      const response = await app.inject({ method: 'GET', url })
      expect(response.statusCode).toBe(200)

      const offenders = collectKeys(response.json()).filter((key) =>
        FORBIDDEN_KEY.test(key)
      )
      expect(offenders).toEqual([])
    })

    it.each(CATALOGUE_URLS)('%s leaks no supplier value verbatim', async (url) => {
      const body = (await app.inject({ method: 'GET', url })).body
      // Values, not just keys: a renamed column would pass the key scan while
      // still shipping the freight agent and the internal PO address.
      for (const secret of ['Wilson Freight', 'FOB Milan', 'orders@w3alpha.test', 'W3JWALL']) {
        expect(body).not.toContain(secret)
      }
    })

    it('the admin read model DOES carry them — this is back-office only', async () => {
      // The mirror of the assertions above: the fields exist, they are simply
      // never served to a client. A test asserting only absence would still pass
      // if the read model quietly stopped returning them.
      const supplier = await getSupplier(pool, alpha)
      const keys = collectKeys(supplier).filter((key) => FORBIDDEN_KEY.test(key))
      expect(keys).toEqual(
        expect.arrayContaining(['discount_method', 'agent', 'incoterm', 'po_email'])
      )
      expect(supplier.brands.find((b) => b.id === houseChain).terms.markup).toBe(2.2)
    })
  })
})
