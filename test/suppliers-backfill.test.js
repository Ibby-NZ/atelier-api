// The supplier backfill: populate `suppliers` from what the office already
// holds, rather than retyping 40 names into the CRM.
//
// Three halves, and the middle one is the story:
//   1. The planner against the REAL sources — the committed
//      src/seed/data/price-lists.json (19.5k rates, 40 spellings) and the
//      vendored src/seed/data/suppliers.js. Pure, so the real-data assertions
//      cost no database writes: this is where "reported, not guessed" is
//      actually proved, on the two spellings that genuinely do not match.
//   2. The apply layer against prefixed fixtures — the SQL, the link updates
//      and idempotency. It runs with an INJECTED snapshot so it can never
//      create the 9 real houses in a shared test database.
//   3. A drift test over scripts/convert-price-lists.js: SUPPLIER_OVERRIDES is
//      not exported, so the alias source here is a boundary copy and the two
//      can silently diverge.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { suppliers as SNAPSHOT } from '../src/seed/data/suppliers.js'
import {
  FALLBACK_TIER_LABEL,
  SUPPLIER_ALIAS_SOURCES,
  nameKey,
  planSupplierBackfill,
} from '../src/suppliers/backfill-plan.js'
import { backfillSuppliers } from '../src/suppliers/backfill.js'
import { chainMultiplier } from '../src/suppliers/discount-chain.js'

const PREFIX = 'w3-backfill-test'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

// FK order: terms CASCADE from both sides, brands RESTRICT-reference suppliers,
// price_list_items SET NULL. The houses must go before the suppliers or the
// supplier delete 23503s inside cleanup and every later test sees leftovers.
const cleanup = async (pool) => {
  await pool.query(`DELETE FROM price_list_items WHERE supplier LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
}

// --------------------------------------------------------------------------
// 1. The planner, against the real committed sources
// --------------------------------------------------------------------------

describe('supplier backfill plan (real sources)', () => {
  let priceListSuppliers

  beforeAll(async () => {
    const items = JSON.parse(
      await readFile(new URL('../src/seed/data/price-lists.json', import.meta.url), 'utf8')
    )
    const grouped = new Map()
    for (const item of items) {
      if (!grouped.has(item.supplier)) {
        grouped.set(item.supplier, { name: item.supplier, items: 0, currencies: new Set() })
      }
      const entry = grouped.get(item.supplier)
      entry.items += 1
      entry.currencies.add(item.currency)
    }
    priceListSuppliers = [...grouped.values()]
      .map((entry) => ({ ...entry, currencies: [...entry.currencies] }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const plan = () =>
    planSupplierBackfill({
      snapshot: SNAPSHOT,
      priceListSuppliers,
      brands: [],
      existingSuppliers: [],
      existingAliases: [],
    })

  it('plans a supplier for every distinct price-list name and every snapshot house', () => {
    const { suppliers } = plan()
    const keys = new Set(suppliers.map((row) => nameKey(row.name)))
    for (const entry of priceListSuppliers) expect(keys.has(nameKey(entry.name))).toBe(true)
    for (const supplier of SNAPSHOT) expect(keys.has(nameKey(supplier.name))).toBe(true)
    // 40 spellings on the rate ledger; the snapshot adds only the two it spells
    // differently, which is exactly the case the reports below cover.
    expect(priceListSuppliers).toHaveLength(40)
    expect(suppliers).toHaveLength(42)
  })

  it('gives every planned supplier a slug and never invents a currency', () => {
    for (const row of plan().suppliers) {
      expect(row.slug).toMatch(/^[a-z0-9-]+$/)
      expect(row.currency == null || ['EUR', 'USD', 'GBP'].includes(row.currency)).toBe(true)
    }
  })

  it('takes the currency from the rate ledger, and the two sources now agree', () => {
    const { suppliers, reports } = plan()
    const byName = new Map(suppliers.map((row) => [row.name, row]))
    // Manuel Canovas was the one live disagreement — the snapshot said EUR while
    // every rate on file was quoted GBP. The office settled it in the ledger's
    // favour, so the snapshot now says GBP too and nothing is left to report.
    expect(byName.get('Manuel Canovas').currency).toBe('GBP')
    expect(reports.currencyConflicts).toEqual([])
    // Jim Thompson is the invoicing-currency rule itself: Thailand, USD.
    expect(byName.get('Jim Thompson').currency).toBe('USD')
    expect(byName.get('Jim Thompson').country).toBe('Thailand')
  })

  // No real source disagrees any more, so the reporting path needs an injected
  // one — losing this would let a future snapshot edit go by unreported.
  it('still reports a disagreement when the two sources do differ', () => {
    const { suppliers, reports } = planSupplierBackfill({
      snapshot: [{ name: 'Larsen', country: 'United Kingdom', currency: 'EUR' }],
      priceListSuppliers: [{ name: 'Larsen', items: 12, currencies: ['GBP'] }],
      brands: [],
      existingSuppliers: [],
      existingAliases: [],
    })
    expect(suppliers[0].currency).toBe('GBP')
    expect(reports.currencyConflicts).toEqual([
      { supplier: 'Larsen', price_list: 'GBP', snapshot: 'EUR' },
    ])
  })

  it('carries the snapshot metadata onto the houses it does match', () => {
    const byName = new Map(plan().suppliers.map((row) => [row.name, row]))
    expect(byName.get('Fabricut')).toMatchObject({
      country: 'United States',
      currency: 'USD',
      agent: 'Mainfreight Air',
      incoterm: 'FOB',
      po_email: 'orders@fabricut.com',
      discount_method: 'averaged',
    })
    expect(byName.get('Janelli Volpi')).toMatchObject({
      short_code: 'JV',
      discount_method: 'per-brand',
    })
    // A price-list-only name gets a currency and nothing else — no country
    // guessed from the name, no discount method assumed.
    expect(byName.get('Hamam')).toMatchObject({
      currency: 'EUR',
      country: null,
      discount_method: null,
      agent: null,
    })
  })

  it('reports the two spellings it cannot match instead of merging them', () => {
    const { reports } = plan()
    // 'Jannelli Volpi' (2,516 rates) and 'Janelli Volpi' (the snapshot) are one
    // house to a reader and two to a matcher. Both are planned, the pair is
    // reported, and a human merges them with an alias.
    expect(reports.unmatchedSnapshotSuppliers).toEqual(['Rubelli Venezia', 'Janelli Volpi'])
    expect(reports.priceListSuppliersWithoutSnapshot).toContain('Jannelli Volpi')
    expect(reports.priceListSuppliersWithoutSnapshot).toContain('Rubelli')
    expect(reports.slugConflicts).toEqual([])
  })

  it('an alias merges two spellings on the next run instead of creating a duplicate', () => {
    const merged = planSupplierBackfill({
      snapshot: SNAPSHOT,
      priceListSuppliers,
      brands: [],
      existingSuppliers: [{ name: 'Janelli Volpi', slug: 'janelli-volpi' }],
      existingAliases: [{ alias: 'Jannelli Volpi', supplier_name: 'Janelli Volpi' }],
    })
    const names = merged.suppliers.map((row) => row.name)
    expect(names).not.toContain('Jannelli Volpi')
    // ...and its 2,516 rate rows now resolve to the house that holds the terms.
    expect(merged.matches).toContainEqual({
      key: 'jannelli volpi',
      supplier: 'Jannelli Volpi',
      supplier_name: 'Janelli Volpi',
    })
  })

  it('turns SUPPLIER_OVERRIDES into alias rows against the spelling the rates carry', () => {
    const { aliases } = plan()
    expect(aliases).toEqual([
      { alias: 'JV', supplier_name: 'Jannelli Volpi' },
      { alias: 'JV DESIGN LICENSE', supplier_name: 'JV Design' },
      { alias: 'JWALL', supplier_name: 'JWall' },
      { alias: 'C&C MILANO', supplier_name: 'C&C Milano' },
    ])
  })

  it('reports an alias whose target is in neither source rather than inventing a house', () => {
    const { aliases, reports } = planSupplierBackfill({
      snapshot: [],
      priceListSuppliers: [],
      brands: [],
      existingSuppliers: [],
      existingAliases: [],
    })
    expect(aliases).toEqual([])
    expect(reports.unmatchedAliasTargets).toHaveLength(SUPPLIER_ALIAS_SOURCES.length)
  })

  it('links the catalogued houses and reports the ones that were never catalogued', () => {
    const brands = [
      { id: 11, name: 'Fabricut', supplier_id: null },
      { id: 12, name: 'S. Harris', supplier_id: null },
      { id: 13, name: 'Dominique Kieffer by Rubelli', supplier_id: null },
    ]
    const { brandLinks, reports } = planSupplierBackfill({
      snapshot: SNAPSHOT,
      priceListSuppliers,
      brands,
      existingSuppliers: [],
      existingAliases: [],
    })
    expect(brandLinks).toContainEqual({ brand_id: 11, supplier_name: 'Fabricut' })
    expect(brandLinks).toContainEqual({ brand_id: 13, supplier_name: 'Rubelli Venezia' })
    // JV's whole stable is uncatalogued, so none of it may be linked.
    const unmatched = reports.unmatchedBrands.map((row) => row.brand)
    expect(unmatched).toContain('JV Fabrics')
    expect(unmatched).toContain('Altagamma')
    expect(unmatched).not.toContain('Fabricut')
  })

  it('leaves a house that is already linked alone, and reports it', () => {
    const { brandLinks, reports } = planSupplierBackfill({
      snapshot: SNAPSHOT,
      priceListSuppliers,
      brands: [{ id: 11, name: 'Fabricut', supplier_id: 99 }],
      existingSuppliers: [],
      existingAliases: [],
    })
    expect(brandLinks).toEqual([])
    expect(reports.brandsLinkedElsewhere).toContainEqual({
      brand: 'Fabricut',
      supplier: 'Fabricut',
    })
  })

  it('plans the per-brand terms the snapshot records, in the shape the schema takes', () => {
    const brands = SNAPSHOT.flatMap((supplier) => supplier.brands).map((entry, index) => ({
      id: 100 + index,
      name: entry.name,
      supplier_id: null,
    }))
    const { brandTerms } = planSupplierBackfill({
      snapshot: SNAPSHOT,
      priceListSuppliers,
      brands,
      existingSuppliers: [],
      existingAliases: [],
    })
    const byBrand = new Map(brandTerms.map((row) => [row.brand_name, row]))

    // The compounded chain stays a sequence: x0.36, not -80%.
    expect(byBrand.get('JV Fabrics').discount_chain).toEqual([0.4, 0.4])
    expect(byBrand.get('JV Fabrics').discount).toBeNull()
    expect(chainMultiplier(byBrand.get('JV Fabrics').discount_chain)).toBeCloseTo(0.36, 10)

    // A flat sister-brand rate is the other shape, and never both.
    expect(byBrand.get('JWall')).toMatchObject({ discount: 0.5, discount_chain: [] })

    // Tiers, with exactly one catch-all carried as the flag rather than the string.
    const tiers = byBrand.get('Janelli Volpi').tiers
    expect(tiers).toHaveLength(3)
    expect(tiers.filter((tier) => tier.is_fallback)).toEqual([
      { label: FALLBACK_TIER_LABEL, pct: 0.5, is_fallback: true },
    ])

    // Fabricut's retail multipliers.
    expect(byBrand.get('S. Harris')).toMatchObject({ markup: 2.3, discount: null })

    // Nothing carries a shape the database would refuse.
    for (const row of brandTerms) {
      expect(row.discount === null || row.discount_chain.length === 0).toBe(true)
      expect(row.tiers.filter((tier) => tier.is_fallback).length).toBeLessThanOrEqual(1)
    }
  })

  it('reports a name that cannot produce a slug rather than defaulting one', () => {
    const { suppliers, reports } = planSupplierBackfill({
      snapshot: [],
      priceListSuppliers: [{ name: '???', items: 4, currencies: ['EUR'] }],
      brands: [],
      existingSuppliers: [],
      existingAliases: [],
    })
    expect(suppliers).toEqual([])
    expect(reports.unmatchedPriceListSuppliers).toHaveLength(1)
    expect(reports.unmatchedPriceListSuppliers[0]).toMatchObject({ supplier: '???', items: 4 })
  })

  it('reports a slug already held by another supplier rather than colliding on it', () => {
    const { suppliers, reports } = planSupplierBackfill({
      snapshot: [],
      priceListSuppliers: [{ name: 'C & C  Milano', items: 9, currencies: ['EUR'] }],
      brands: [],
      existingSuppliers: [{ name: 'C&C Milano', slug: 'c-c-milano' }],
      existingAliases: [],
    })
    // Nothing is planned: the spelling on the ledger is skipped, and the
    // supplier already holding the slug is not named by either source, so
    // there is nothing to fill on it either.
    expect(suppliers).toEqual([])
    expect(reports.slugConflicts).toEqual([
      { supplier: 'C & C  Milano', slug: 'c-c-milano', held_by: 'C&C Milano' },
    ])
  })

  it('matches on name BEFORE alias, so a live supplier row wins over an alias', () => {
    const { matches, reports } = planSupplierBackfill({
      snapshot: [],
      priceListSuppliers: [{ name: 'Jannelli Volpi', items: 2516, currencies: ['EUR'] }],
      brands: [],
      existingSuppliers: [
        { name: 'Janelli Volpi', slug: 'janelli-volpi' },
        { name: 'Jannelli Volpi', slug: 'jannelli-volpi' },
      ],
      existingAliases: [{ alias: 'Jannelli Volpi', supplier_name: 'Janelli Volpi' }],
    })
    // The alias says "these are one house", but a supplier of that exact name
    // still exists — so the rates stay on it. Merging the two is a deletion a
    // human makes, not something a backfill may decide.
    expect(matches).toEqual([
      { key: 'jannelli volpi', supplier: 'Jannelli Volpi', supplier_name: 'Jannelli Volpi' },
    ])
    expect(reports.slugConflicts).toEqual([])
  })

  it('reports several currencies on one name instead of choosing between them', () => {
    const { suppliers, reports } = planSupplierBackfill({
      snapshot: [],
      priceListSuppliers: [{ name: 'Split House', items: 6, currencies: ['EUR', 'USD'] }],
      brands: [],
      existingSuppliers: [],
      existingAliases: [],
    })
    expect(suppliers[0].currency).toBeNull()
    expect(reports.ambiguousCurrencies).toEqual([
      { supplier: 'Split House', currencies: ['EUR', 'USD'] },
    ])
  })
})

// --------------------------------------------------------------------------
// 2. The apply layer
// --------------------------------------------------------------------------

describe('supplier backfill (database)', () => {
  let pool

  // A prefixed stand-in for the office snapshot. Injected so this suite can
  // never create the nine real houses in a shared test database.
  const snapshot = [
    {
      id: `${PREFIX}-alpha`,
      name: `${PREFIX} Alpha`,
      short: 'W3BA',
      country: 'Italy',
      currency: 'EUR',
      agent: 'Wilson Freight',
      incoterm: 'FCA',
      poEmail: 'orders@w3-backfill.test',
      terms: { method: 'per-brand' },
      brands: [
        { name: `${PREFIX} House One`, discountChain: [0.4, 0.4], note: 'compounded' },
        {
          name: `${PREFIX} House Two`,
          discountTiers: [
            { label: 'Wallpapers by the metre', pct: 0.4 },
            { label: FALLBACK_TIER_LABEL, pct: 0.5 },
          ],
        },
        { name: `${PREFIX} Uncatalogued`, discount: 0.5 },
      ],
    },
    {
      id: `${PREFIX}-beta`,
      name: `${PREFIX} Beta`,
      country: 'Thailand',
      currency: 'EUR',
      terms: { method: 'averaged' },
      brands: [],
    },
  ]

  // 'W3BA-RAW' is the raw filename prefix; the rates are filed under the
  // canonical spelling, exactly as SUPPLIER_OVERRIDES arranges for JV.
  const aliasSources = [{ alias: 'W3BA-RAW', supplier: `${PREFIX} Alpha` }]

  const insertRate = (supplier, code, currency = 'EUR') =>
    pool.query(
      `INSERT INTO price_list_items
         (supplier, category, code, code_normalized, unit, wholesale_rate, currency, source_file)
       VALUES ($1, 'fabric', $2, $2, 'metre', 100, $3, 'backfill-test.csv')`,
      [supplier, code, currency]
    )

  const insertBrand = (name) =>
    pool
      .query(
        `INSERT INTO brands (name, slug, currency, trade_only)
         VALUES ($1, $2, 'NZD', false) RETURNING id`,
        [name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')]
      )
      .then(({ rows }) => rows[0].id)

  const testPriceListSuppliers = () =>
    pool
      .query(
        `SELECT supplier AS name,
                count(*)::int AS items,
                array_agg(DISTINCT currency) AS currencies
           FROM price_list_items
          WHERE supplier LIKE $1
          GROUP BY supplier
          ORDER BY supplier`,
        [`${PREFIX}%`]
      )
      .then(({ rows }) => rows)

  const run = async () =>
    backfillSuppliers(pool, {
      snapshot,
      aliasSources,
      priceListSuppliers: await testPriceListSuppliers(),
    })

  const supplierRow = (name) =>
    pool
      .query(`SELECT * FROM suppliers WHERE name = $1`, [name])
      .then(({ rows }) => rows[0] ?? null)

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runMigrations(config.databaseUrl)
    await cleanup(pool)

    await insertBrand(`${PREFIX} House One`)
    await insertBrand(`${PREFIX} House Two`)
    await insertRate(`${PREFIX} Alpha`, 'A-1')
    await insertRate(`${PREFIX} Alpha`, 'A-2')
    // A rate ledger name with no office record: it still becomes a supplier,
    // because the whole point is that nobody retypes 40 names.
    await insertRate(`${PREFIX} Gamma`, 'G-1', 'USD')
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  it('creates a supplier per source, links the rate ledger and writes the terms', async () => {
    const summary = await run()

    expect(summary.suppliers.created).toBe(3)
    expect(summary.aliases).toBe(1)
    expect(summary.priceListItems).toBe(3)
    expect(summary.brands).toBe(2)
    expect(summary.terms).toBe(2)
    expect(summary.tiers).toBe(2)

    const alpha = await supplierRow(`${PREFIX} Alpha`)
    expect(alpha).toMatchObject({
      slug: `${PREFIX}-alpha`,
      short_code: 'W3BA',
      country: 'Italy',
      currency: 'EUR',
      agent: 'Wilson Freight',
      incoterm: 'FCA',
      po_email: 'orders@w3-backfill.test',
      discount_method: 'per-brand',
    })

    // The price list is the currency authority; the snapshot said EUR.
    const gamma = await supplierRow(`${PREFIX} Gamma`)
    expect(gamma.currency).toBe('USD')
    expect(gamma.country).toBeNull()

    const { rows: linked } = await pool.query(
      `SELECT supplier, supplier_id FROM price_list_items
        WHERE supplier LIKE $1 ORDER BY code`,
      [`${PREFIX}%`]
    )
    expect(linked.every((row) => row.supplier_id != null)).toBe(true)
    expect(new Set(linked.filter((r) => r.supplier === `${PREFIX} Alpha`).map((r) => r.supplier_id)))
      .toEqual(new Set([alpha.id]))

    const { rows: aliasRows } = await pool.query(
      `SELECT alias, supplier_id FROM supplier_aliases WHERE supplier_id = $1`,
      [alpha.id]
    )
    expect(aliasRows).toEqual([{ alias: 'W3BA-RAW', supplier_id: alpha.id }])
  })

  it('stores the chain as a sequence and the tiers with exactly one fallback', async () => {
    const { rows } = await pool.query(
      `SELECT b.name, t.discount, t.discount_chain, t.note
         FROM supplier_brand_terms t
         JOIN brands b ON b.id = t.brand_id
        WHERE b.slug LIKE $1 ORDER BY b.name`,
      [`${PREFIX}-%`]
    )
    expect(rows).toHaveLength(2)
    // pg parses numeric[] into JS numbers but a scalar numeric into a string —
    // the chain arrives already numeric, the flat rate would not.
    expect(rows[0].discount_chain).toEqual([0.4, 0.4])
    expect(chainMultiplier(rows[0].discount_chain)).toBeCloseTo(0.36, 10)
    expect(rows[0].discount).toBeNull()

    const { rows: tiers } = await pool.query(
      `SELECT label, pct, is_fallback FROM supplier_discount_tiers t
         JOIN supplier_brand_terms bt ON bt.id = t.supplier_brand_term_id
         JOIN brands b ON b.id = bt.brand_id
        WHERE b.slug LIKE $1 ORDER BY label`,
      [`${PREFIX}-%`]
    )
    expect(tiers.map((row) => row.is_fallback)).toEqual([true, false])
    expect(tiers.find((row) => row.is_fallback).label).toBe(FALLBACK_TIER_LABEL)
  })

  it('reports the uncatalogued house rather than creating a brand for it', async () => {
    const summary = await run()
    expect(summary.reports.unmatchedBrands).toContainEqual({
      supplier: `${PREFIX} Alpha`,
      brand: `${PREFIX} Uncatalogued`,
    })
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM brands WHERE name = $1`, [
      `${PREFIX} Uncatalogued`,
    ])
    expect(rows[0].n).toBe(0)
  })

  it('changes nothing on a second run', async () => {
    const before = await pool.query(
      `SELECT id, name, currency, updated_at FROM suppliers
        WHERE slug LIKE $1 ORDER BY name`,
      [`${PREFIX}-%`]
    )
    const summary = await run()

    expect(summary.suppliers.created).toBe(0)
    expect(summary.suppliers.enriched).toBe(0)
    expect(summary.aliases).toBe(0)
    expect(summary.priceListItems).toBe(0)
    expect(summary.brands).toBe(0)
    expect(summary.terms).toBe(0)
    expect(summary.tiers).toBe(0)

    const after = await pool.query(
      `SELECT id, name, currency, updated_at FROM suppliers
        WHERE slug LIKE $1 ORDER BY name`,
      [`${PREFIX}-%`]
    )
    expect(after.rows).toEqual(before.rows)

    const counts = await pool.query(
      `SELECT (SELECT count(*)::int FROM supplier_aliases a
                JOIN suppliers s ON s.id = a.supplier_id WHERE s.slug LIKE $1) AS aliases,
              (SELECT count(*)::int FROM supplier_brand_terms t
                JOIN brands b ON b.id = t.brand_id WHERE b.slug LIKE $1) AS terms`,
      [`${PREFIX}-%`]
    )
    expect(counts.rows[0]).toEqual({ aliases: 1, terms: 2 })
  })

  it('fills a NULL column left by an earlier run without touching a staff edit', async () => {
    const alpha = await supplierRow(`${PREFIX} Alpha`)
    await pool.query(
      `UPDATE suppliers SET country = NULL, agent = 'Staff Freight' WHERE id = $1`,
      [alpha.id]
    )

    const summary = await run()
    expect(summary.suppliers.created).toBe(0)
    expect(summary.suppliers.enriched).toBe(1)

    const refreshed = await supplierRow(`${PREFIX} Alpha`)
    expect(refreshed.country).toBe('Italy')
    // The corrected agent survives — a backfill that overwrote what it found
    // would undo an office correction on every re-run.
    expect(refreshed.agent).toBe('Staff Freight')
  })

  it('re-points the rate ledger once a duplicate is merged away by alias', async () => {
    const alpha = await supplierRow(`${PREFIX} Alpha`)
    const gamma = await supplierRow(`${PREFIX} Gamma`)
    expect(gamma.id).not.toBe(alpha.id)

    // The merge a human performs in the CRM: record the spelling as an alias of
    // the surviving house, then delete the duplicate. Name beats alias while
    // both rows exist, so the deletion is what hands the rates over —
    // `price_list_items.supplier_id` is SET NULL, which is why they survive it.
    await pool.query(`INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, $2)`, [
      alpha.id,
      `${PREFIX} Gamma`,
    ])
    await pool.query(`DELETE FROM suppliers WHERE id = $1`, [gamma.id])

    const summary = await run()
    expect(summary.priceListItems).toBe(1)
    // The alias is also what stops this run recreating the duplicate.
    expect(summary.suppliers.created).toBe(0)
    expect(await supplierRow(`${PREFIX} Gamma`)).toBeNull()

    const { rows } = await pool.query(
      `SELECT supplier_id FROM price_list_items WHERE supplier = $1`,
      [`${PREFIX} Gamma`]
    )
    expect(rows[0].supplier_id).toBe(alpha.id)
  })

  it('leaves a house whose supplier staff already set alone', async () => {
    const beta = await supplierRow(`${PREFIX} Beta`)
    const { rows } = await pool.query(`SELECT id FROM brands WHERE name = $1`, [
      `${PREFIX} House One`,
    ])
    await pool.query(`UPDATE brands SET supplier_id = $1 WHERE id = $2`, [beta.id, rows[0].id])

    const summary = await run()
    expect(summary.brands).toBe(0)
    expect(summary.reports.brandsLinkedElsewhere).toContainEqual({
      brand: `${PREFIX} House One`,
      supplier: `${PREFIX} Alpha`,
    })

    const { rows: after } = await pool.query(`SELECT supplier_id FROM brands WHERE id = $1`, [
      rows[0].id,
    ])
    expect(after[0].supplier_id).toBe(beta.id)
  })
})

// --------------------------------------------------------------------------
// 3. The boundary copy
// --------------------------------------------------------------------------

describe('SUPPLIER_ALIAS_SOURCES', () => {
  it('matches SUPPLIER_OVERRIDES in scripts/convert-price-lists.js', async () => {
    const source = await readFile(
      new URL('../scripts/convert-price-lists.js', import.meta.url),
      'utf8'
    )
    const block = /const SUPPLIER_OVERRIDES = new Map\(\[([\s\S]*?)\]\)/.exec(source)
    expect(block).not.toBeNull()

    const pairs = [...block[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map(([, alias, supplier]) => ({
      alias,
      supplier,
    }))
    // A regex that silently matched nothing would pass every assertion below.
    expect(pairs.length).toBeGreaterThan(0)
    expect(pairs).toEqual([...SUPPLIER_ALIAS_SOURCES])
  })
})
