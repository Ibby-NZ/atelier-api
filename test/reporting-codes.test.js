// W21 — reporting codes. The migration, the two planners, the two new report
// filters and the two statements every report using them has to make.
//
// The planner assertions run against the COMMITTED corpus
// (`src/seed/data/price-lists.json`, 19,514 rows) through the pure module, so
// the real-data properties are proved without a single write to the shared test
// database — the posture `test/suppliers-backfill.test.js` established. Only the
// schema block needs Postgres.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { listBrands, getBrandBySlug } from '../src/catalogue/brands.js'
import {
  planReportingCodes,
  itemCodeToken,
  nameKey,
} from '../src/products/reporting-codes-plan.js'
import { planSupplierRollup } from '../src/suppliers/supplier-rollup.js'
import { nameKey as supplierNameKey } from '../src/suppliers/backfill-plan.js'
import {
  FILTER_COLUMNS,
  FREE_TEXT_FILTERS,
  REPORT_FILTER_NAMES,
  parseReportFilters,
  buildReportFilters,
} from '../src/reports/filters.js'
import {
  STOCK_SOURCES,
  STOCK_SOURCE_DISAGREEMENT,
  DIMENSION_COVERAGE_NOTE,
  dimensionCoverage,
  stockSource,
} from '../src/reports/coverage.js'
import { toReportCsv } from '../src/reports/export.js'
import { defineColumns } from '../src/reports/access.js'
import { STOCK_FILTERS } from '../src/reports/stock.js'

const PREFIX = 'w21-codes-test'

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

// ---------------------------------------------------------------------------
// US-001 — the columns and the per-supplier unique index
// ---------------------------------------------------------------------------

describe('W21-US-001 — products.product_range and brands.brand_code', () => {
  let pool

  const insertSupplier = (name) =>
    pool
      .query(`INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`, [
        `${PREFIX} ${name}`,
        `${PREFIX}-${name}`,
      ])
      .then(({ rows }) => rows[0].id)

  const insertBrand = ({ slug, supplierId = null, brandCode = null }) =>
    pool
      .query(
        `INSERT INTO brands (name, slug, currency, trade_only, supplier_id, brand_code)
         VALUES ($1, $2, 'NZD', false, $3, $4) RETURNING id`,
        [`${PREFIX} ${slug}`, `${PREFIX}-${slug}`, supplierId, brandCode]
      )
      .then(({ rows }) => rows[0].id)

  const cleanup = async () => {
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}-%`])
  }

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  beforeEach(cleanup)

  it('re-running the migrations is a no-op', async () => {
    expect(await runMigrations(loadConfig().databaseUrl)).toEqual([])
  })

  it('adds both columns as nullable text', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE (table_name, column_name) IN (('products','product_range'), ('brands','brand_code'))
        ORDER BY table_name`
    )
    expect(rows).toEqual([
      { table_name: 'brands', column_name: 'brand_code', data_type: 'text', is_nullable: 'YES' },
      {
        table_name: 'products',
        column_name: 'product_range',
        data_type: 'text',
        is_nullable: 'YES',
      },
    ])
  })

  // A blank string is a second spelling of "unset", and two spellings of it is
  // how a reader ends up with a third state to interpret.
  it('refuses a blank code and a blank range, on both tables', async () => {
    await expect(insertBrand({ slug: 'blank-code', brandCode: '   ' })).rejects.toMatchObject({
      constraint: 'brands_brand_code_check',
    })

    const brandId = await insertBrand({ slug: 'range-host' })
    await expect(
      pool.query(
        `INSERT INTO products (brand_id, name, slug, product_type, currency, product_range)
         VALUES ($1, $2, $3, 'fabric', 'NZD', '')`,
        [brandId, `${PREFIX} design`, `${PREFIX}-design`]
      )
    ).rejects.toMatchObject({ constraint: 'products_product_range_check' })
  })

  // Two houses under one invoicing entity cannot share a designation — which is
  // exactly the F18 case (`CF` for Colefax & Fowler and Jane Churchill), refused
  // by the database rather than by a reviewer.
  it('refuses one supplier two houses with the same code, case- and space-insensitively', async () => {
    const supplierId = await insertSupplier('fabricut')
    await insertBrand({ slug: 'stroheim', supplierId, brandCode: 'ST' })

    await expect(
      insertBrand({ slug: 'stoker', supplierId, brandCode: '  st ' })
    ).rejects.toMatchObject({ constraint: 'brands_supplier_brand_code_unique' })
  })

  // The letters are reused across unrelated houses in the corpus, so a GLOBAL
  // unique would refuse the second, correct row.
  it('lets two suppliers each use the same code', async () => {
    const first = await insertSupplier('fabricut')
    const second = await insertSupplier('stoker-mills')
    await insertBrand({ slug: 'stroheim', supplierId: first, brandCode: 'ST' })
    await expect(
      insertBrand({ slug: 'stoker', supplierId: second, brandCode: 'ST' })
    ).resolves.toEqual(expect.any(Number))
  })

  // 26 of 41 houses have no supplier, and Postgres treats NULLs as distinct: an
  // unlinked house has no invoicing entity for its code to be unique inside of.
  it('does not constrain houses that are not linked to a supplier', async () => {
    await insertBrand({ slug: 'one', brandCode: 'XX' })
    await expect(insertBrand({ slug: 'two', brandCode: 'XX' })).resolves.toEqual(expect.any(Number))
  })

  // `test/price-list-exposure.test.js` scans COST vocabulary, so a code leaking
  // into a public house response is a regression it would not catch.
  it('never puts brand_code in the public brand read model', async () => {
    await insertBrand({ slug: 'public-house', brandCode: 'ZZ' })

    const brands = await listBrands(pool)
    const mine = brands.find((brand) => brand.slug === `${PREFIX}-public-house`)
    expect(mine).toBeDefined()
    expect(mine).not.toHaveProperty('brand_code')

    const detail = await getBrandBySlug(pool, `${PREFIX}-public-house`)
    expect(detail).not.toHaveProperty('brand_code')
    // The VALUE, not only the key: a renamed column passes a key scan while
    // still shipping the designation.
    expect(JSON.stringify({ brands, detail })).not.toContain('ZZ')
  })
})

// ---------------------------------------------------------------------------
// US-002 — the reporting-codes backfill planner
// ---------------------------------------------------------------------------

describe('W21-US-002 — the reporting-codes backfill planner', () => {
  const brand = (id, name, slug, extra = {}) => ({
    id,
    name,
    slug,
    supplier_id: null,
    brand_code: null,
    ...extra,
  })
  const product = (id, name, brandId, extra = {}) => ({
    id,
    name,
    brand_id: brandId,
    product_range: null,
    ...extra,
  })
  const item = (range, description) => ({ product_range: range, description })

  describe('the house is the only key that assigns', () => {
    it('gives a product its own house’s range on an exact name match', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Pierre Frey', 'pierre-frey')],
        products: [product(10, 'Atlas', 1)],
        priceListItems: [item('PIERRE FREY', 'ATLAS')],
      })

      expect(plan.productRanges).toEqual([
        {
          product_id: 10,
          product: 'Atlas',
          brand: 'Pierre Frey',
          product_range: 'PIERRE FREY',
          via: 'house',
          corroborated: true,
        },
      ])
    })

    it('matches on the slug too — `BRAQUENIE` is Braquenié', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Braquenié', 'braquenie')],
        products: [product(10, 'Toile', 1)],
        priceListItems: [item('BRAQUENIE', 'Something else')],
      })

      expect(plan.productRanges[0].product_range).toBe('BRAQUENIE')
      // Nothing corroborated it; that is a third state, not a failure.
      expect(plan.productRanges[0].corroborated).toBeNull()
    })

    // A house split by product line is a real state — `C & C MILANO` and
    // `C & C Milano Bedding` carry different duty and different freight — and
    // which line a given design sits in is not in this corpus.
    it('refuses a house that resolves to more than one range', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'S. Harris', 's-harris')],
        products: [product(10, 'Ondine', 1)],
        // Two spellings the ledger really carries: the slug route lands on one
        // and the exact name route on the other.
        priceListItems: [item('S HARRIS', 'x'), item('S. Harris', 'y')],
      })

      expect(plan.productRanges).toEqual([])
      expect(plan.reports.ambiguousHouses).toHaveLength(1)
      expect(plan.reports.ambiguousHouses[0].ranges.slice().sort()).toEqual([
        'S HARRIS',
        'S. Harris',
      ])
      expect(plan.summary.products_unmatched).toBe(1)
    })

    it('reports a house that matches no range, with what the design name would have said', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Rubelli Venezia', 'rubelli-venezia')],
        products: [product(10, 'Nirvana', 1)],
        priceListItems: [item('RUBELLI', 'NIRVANA')],
      })

      expect(plan.productRanges).toEqual([])
      expect(plan.reports.unmatchedProducts).toHaveLength(1)
      // The evidence is reported so a person can add the alias — it is never
      // applied, because a design name is a resemblance and a house is a key.
      expect(plan.reports.unmatchedProducts[0].design_name_evidence).toEqual(['RUBELLI'])
      expect(plan.reports.rangesWithoutHouse).toEqual(['RUBELLI'])
    })
  })

  describe('the design name is evidence and never an assigner', () => {
    it('does not assign from an unanimous design name when the house resolves to nothing', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Sahco', 'sahco')],
        products: [product(10, 'Coco', 1)],
        // One range and one only — and still not applied: this house is not
        // that range, and nothing in the corpus could contradict it.
        priceListItems: [item('PIERRE FREY', 'Coco')],
      })

      expect(plan.productRanges).toEqual([])
      expect(plan.reports.unmatchedProducts[0].design_name_evidence).toEqual(['PIERRE FREY'])
    })

    it('applies the house and reports the disagreement rather than refusing', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Fabricut', 'fabricut')],
        products: [product(10, 'Mesa', 1)],
        priceListItems: [item('Fabricut', 'Something'), item('STROHEIM', 'Mesa')],
      })

      expect(plan.productRanges[0].product_range).toBe('Fabricut')
      expect(plan.productRanges[0].corroborated).toBe(false)
      expect(plan.reports.designNameDisagrees).toEqual([
        {
          product_id: 10,
          product: 'Mesa',
          brand: 'Fabricut',
          assigned: 'Fabricut',
          design_name_names: 'STROHEIM',
          reason: 'the design name appears under a different range; the house was applied',
        },
      ])
    })

    it('says nothing at all when the design name sits under several ranges', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Pierre Frey', 'pierre-frey')],
        products: [product(10, 'Atlas', 1)],
        priceListItems: [
          item('PIERRE FREY', 'Nothing'),
          item('Larsen', 'Atlas'),
          item('METAPHORES', 'Atlas'),
        ],
      })

      expect(plan.productRanges[0].corroborated).toBeNull()
      expect(plan.reports.designNameDisagrees).toEqual([])
    })
  })

  it('never overwrites a range that is already set', () => {
    const plan = planReportingCodes({
      brands: [brand(1, 'Pierre Frey', 'pierre-frey')],
      products: [product(10, 'Atlas', 1, { product_range: 'HAND CORRECTED' })],
      priceListItems: [item('PIERRE FREY', 'ATLAS')],
    })

    expect(plan.productRanges).toEqual([])
    expect(plan.reports.productsAlreadySet).toEqual([
      { product_id: 10, product: 'Atlas', brand: 'Pierre Frey', product_range: 'HAND CORRECTED' },
    ])
  })

  describe('the brand code, which has no source', () => {
    it('plans none, ever', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Colefax & Fowler', 'colefax-fowler')],
        products: [],
        priceListItems: [item('COLEFAX & FOWLER', 'x')],
        stockItems: [{ range_name: 'COLEFAX & FOWLER', item_code: 'ABC-01 23CF' }],
      })

      expect(plan.brandCodes).toEqual([])
      expect(plan.summary.brands_without_code).toBe(1)
    })

    it('reports the item-code tokens whole, without reducing them to a mode', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Jim Thompson', 'jim-thompson')],
        products: [],
        priceListItems: [item('JIM THOMPSON', 'x')],
        stockItems: [
          { range_name: 'JIM THOMPSON', item_code: 'JT01 23JT' },
          { range_name: 'JIM THOMPSON', item_code: 'JT02 24JT' },
          // The corpus carries typos beside real codes; a mode over it is a
          // guess wearing a number, so the breakdown survives intact.
          { range_name: 'JIM THOMPSON', item_code: 'JT03 24JJT' },
        ],
      })

      const [row] = plan.reports.brandsWithoutCode
      expect(row.brand).toBe('Jim Thompson')
      expect(row.range).toBe('JIM THOMPSON')
      expect(row.evidence).toEqual([
        { token: 'JT', items: 2 },
        { token: 'JJT', items: 1 },
      ])
    })

    // F18: `CFJC` is two codes run together or one combined line, and nothing
    // here decides which.
    it('reports a token claimed by several houses rather than giving it to one', () => {
      const plan = planReportingCodes({
        brands: [
          brand(1, 'Colefax & Fowler', 'colefax-fowler'),
          brand(2, 'Jane Churchill', 'jane-churchill'),
        ],
        products: [],
        priceListItems: [item('COLEFAX & FOWLER', 'x'), item('JANE CHURCHILL', 'y')],
        stockItems: [
          { range_name: 'COLEFAX & FOWLER', item_code: 'A1 23CF' },
          { range_name: 'JANE CHURCHILL', item_code: 'B1 23CF' },
        ],
      })

      expect(plan.brandCodes).toEqual([])
      expect(plan.reports.tokensClaimedBySeveralHouses).toEqual([
        { token: 'CF', brands: ['Colefax & Fowler', 'Jane Churchill'] },
      ])
    })

    it('leaves a code someone has already entered alone', () => {
      const plan = planReportingCodes({
        brands: [brand(1, 'Larsen', 'larsen', { brand_code: 'LA' })],
        products: [],
        priceListItems: [],
      })

      expect(plan.reports.brandCodesAlreadySet).toEqual([{ brand: 'Larsen', brand_code: 'LA' }])
      expect(plan.reports.brandsWithoutCode).toEqual([])
    })
  })

  describe('the item-code grammar', () => {
    it('reads the token only where the year-and-letters suffix is actually there', () => {
      expect(itemCodeToken('F3518-003 23PF')).toBe('PF')
      expect(itemCodeToken('10190 20MIWP')).toBe('MIWP')
      // A house finished good has no suffix, and neither does a bare code that
      // happens to end in letters.
      expect(itemCodeToken('CUSH*SPEC55X55')).toBeNull()
      expect(itemCodeToken('AIREWCWH')).toBeNull()
      expect(itemCodeToken('MP400-10')).toBeNull()
      expect(itemCodeToken(null)).toBeNull()
    })
  })

  describe('against the committed price-list corpus', () => {
    const priceListItems = JSON.parse(
      readFileSync(new URL('../src/seed/data/price-lists.json', import.meta.url), 'utf8')
    )

    it('is the ledger the converter emits, keyed on the two columns this reads', () => {
      expect(priceListItems.length).toBeGreaterThan(19000)
      expect(priceListItems[0]).toHaveProperty('product_range')
      expect(priceListItems[0]).toHaveProperty('description')
    })

    // Three real houses: one that matches its range by name, one that matches by
    // slug, and one whose spelling is a naming decision nobody has made.
    it('matches the houses whose spelling agrees and refuses the one whose does not', () => {
      const plan = planReportingCodes({
        brands: [
          brand(1, 'Pierre Frey', 'pierre-frey'),
          brand(2, 'S. Harris', 's-harris'),
          brand(3, 'Rubelli Venezia', 'rubelli-venezia'),
        ],
        products: [
          product(10, 'Atlas', 1),
          product(11, 'Ondine', 2),
          product(12, 'Nirvana', 3),
        ],
        priceListItems,
      })

      expect(plan.productRanges.map((row) => [row.product, row.product_range])).toEqual([
        ['Atlas', 'Pierre Frey'],
        ['Ondine', 'S HARRIS'],
      ])
      expect(plan.reports.unmatchedProducts.map((row) => row.product)).toEqual(['Nirvana'])
      // The corpus really does spell one house several ways, which is why the
      // refusal is a naming decision and not a bug.
      expect(plan.summary.ranges).toBeGreaterThan(30)
      expect(plan.summary.ranges_without_house).toBeGreaterThan(0)
    })

    it('never assigns a range a design name alone points at', () => {
      // "Ondine" is a design name several houses use; a house that resolves to
      // nothing must not inherit one of them.
      const plan = planReportingCodes({
        brands: [brand(1, 'Sahco', 'sahco')],
        products: [product(10, 'Ondine', 1)],
        priceListItems,
      })
      expect(plan.productRanges).toEqual([])
    })
  })

  it('returns a frozen plan, so a caller cannot edit the refusals away', () => {
    const plan = planReportingCodes({ brands: [], products: [], priceListItems: [] })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.reports)).toBe(true)
    expect(Object.isFrozen(plan.reports.unmatchedProducts)).toBe(true)
    expect(Object.isFrozen(plan.summary)).toBe(true)
  })

  // Two modules in two domains carry the rule, so the drift is worth one
  // assertion — the posture the boundary copies of the database CHECKs take.
  it('normalises a name exactly as the supplier backfill does', () => {
    for (const value of ['  Pierre  Frey ', 'MÉTAPHORES', '', null, undefined]) {
      expect(nameKey(value)).toBe(supplierNameKey(value))
    }
    expect(nameKey('  Pierre Frey ')).toBe('pierre frey')
  })
})

// ---------------------------------------------------------------------------
// US-003 — the supplier roll-up from the staged parameters
// ---------------------------------------------------------------------------

describe('W21-US-003 — the supplier roll-up', () => {
  const range = (name, supplier) => ({ name, supplier })
  const supplier = (id, name, slug) => ({ id, name, slug })
  const house = (id, name, slug, supplierId = null) => ({
    id,
    name,
    slug,
    supplier_id: supplierId,
  })

  it('rolls every range up under the invoicing entity that bills it', () => {
    const plan = planSupplierRollup({
      parameters: [
        range('COLEFAX & FOWLER', 'Colefax & Fowler'),
        range('JANE CHURCHILL', 'Colefax & Fowler'),
        range('PIERRE FREY', 'Pierre Frey Paris'),
      ],
      suppliers: [supplier(1, 'Colefax & Fowler', 'colefax-fowler')],
      brands: [
        house(10, 'Colefax & Fowler', 'colefax-fowler'),
        house(11, 'Jane Churchill', 'jane-churchill'),
        house(12, 'Pierre Frey', 'pierre-frey'),
      ],
    })

    expect(plan.summary).toMatchObject({ suppliers: 2, suppliers_matched: 1, brand_links: 2 })
    expect(plan.rollup[0]).toMatchObject({
      supplier: 'Colefax & Fowler',
      supplier_id: 1,
      matched_via: 'name',
      ranges: ['COLEFAX & FOWLER', 'JANE CHURCHILL'],
    })
    expect(plan.brandLinks.map((link) => link.brand)).toEqual([
      'Colefax & Fowler',
      'Jane Churchill',
    ])
  })

  it('matches a live supplier by slug and by alias, and by nothing else', () => {
    const plan = planSupplierRollup({
      parameters: [
        range('JANNELLI VOLPI', 'Jannelli & Volpi'),
        range('FABRICUT', 'Fabricut Inc'),
        range('LIBERTY', 'Liberty London'),
      ],
      suppliers: [supplier(1, 'Jannelli Volpi', 'jannelli-volpi'), supplier(2, 'Fabricut', 'fabricut')],
      aliases: [{ alias: 'Fabricut Inc', supplier_id: 2 }],
      brands: [],
    })

    const byName = Object.fromEntries(plan.rollup.map((row) => [row.supplier, row.matched_via]))
    expect(byName).toEqual({
      'Jannelli & Volpi': 'slug',
      'Fabricut Inc': 'alias',
      // The legal-entity form of a house we hold — a correction to make in the
      // CRM, never a fuzzy rule to write.
      'Liberty London': null,
    })
  })

  it('reports an unmatched entity with its ranges and its houses, and plans no link for it', () => {
    const plan = planSupplierRollup({
      parameters: [range('PIERRE FREY', 'Pierre Frey Paris'), range('BRAQUENIE', 'Pierre Frey Paris')],
      suppliers: [supplier(1, 'Pierre Frey', 'pierre-frey')],
      brands: [house(10, 'Pierre Frey', 'pierre-frey'), house(11, 'Braquenié', 'braquenie')],
    })

    expect(plan.brandLinks).toEqual([])
    expect(plan.reports.unmatchedSuppliers).toEqual([
      {
        supplier: 'Pierre Frey Paris',
        ranges: ['BRAQUENIE', 'PIERRE FREY'],
        houses: ['Pierre Frey', 'Braquenié'],
        reason:
          'no live supplier matches this invoicing entity by name, by slug or by alias — add ' +
          'the alias in the CRM, one at a time, and re-run',
      },
    ])
  })

  // `brands.supplier_id` is staff-curated: a house's supplier is a commercial
  // decision, so the existing link stands and the disagreement is reported.
  it('never re-points a house that is already linked', () => {
    const plan = planSupplierRollup({
      parameters: [range('LARSEN', 'Colefax & Fowler')],
      suppliers: [supplier(1, 'Colefax & Fowler', 'colefax-fowler'), supplier(2, 'Larsen', 'larsen')],
      brands: [house(10, 'Larsen', 'larsen', 2)],
    })

    expect(plan.brandLinks).toEqual([])
    expect(plan.reports.brandsLinkedElsewhere).toEqual([
      {
        brand: 'Larsen',
        linked_to: 'Larsen',
        parameters_say: 'Colefax & Fowler',
        reason: 'a house’s supplier is a commercial decision; the existing link stands',
      },
    ])
  })

  it('reports the ranges that name no supplier and the ranges that resolve to no house', () => {
    const plan = planSupplierRollup({
      parameters: [
        range('ATELIER STOCK', null),
        range('Miscellaneous', '  '),
        range('NO 9', 'Jim Thompson / The Thai Silk Co. Ltd.'),
      ],
      suppliers: [],
      brands: [house(10, 'No.9 Thompson', 'no-9-thompson')],
    })

    expect(plan.reports.rangesWithoutSupplier).toEqual(['ATELIER STOCK', 'Miscellaneous'])
    expect(plan.reports.rangesWithoutBrand).toEqual([
      {
        range: 'NO 9',
        supplier: 'Jim Thompson / The Thai Silk Co. Ltd.',
        reason: 'no live house matches this range by name or by slug',
      },
    ])
  })

  it('reports a house two invoicing entities both claim', () => {
    const plan = planSupplierRollup({
      parameters: [range('LARSEN', 'Colefax & Fowler'), range('Larsen', 'Larsen Ltd')],
      suppliers: [],
      brands: [house(10, 'Larsen', 'larsen')],
    })

    expect(plan.reports.brandsClaimedBySeveralSuppliers).toEqual([
      { brand: 'Larsen', suppliers: ['Colefax & Fowler', 'Larsen Ltd'] },
    ])
  })

  it('returns a frozen plan', () => {
    const plan = planSupplierRollup({ parameters: [], suppliers: [], brands: [] })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.reports)).toBe(true)
    expect(plan.summary.suppliers).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// US-004 — the two filters
// ---------------------------------------------------------------------------

describe('W21-US-004 — brand_code and range as report filters', () => {
  it('are on the whitelist, mapped to trusted alias.column references', () => {
    expect(FILTER_COLUMNS.brand_code).toBe('b.brand_code')
    expect(FILTER_COLUMNS.range).toBe('p.product_range')
    expect([...FREE_TEXT_FILTERS]).toEqual(['brand_code', 'range'])
    for (const name of FREE_TEXT_FILTERS) {
      expect(REPORT_FILTER_NAMES).toContain(name)
    }
  })

  // parseSlug is safe only because slugs are [a-z0-9-] BY CONSTRUCTION. A range
  // is `RAMM, SON & CROCKER` and a code is `CF`, so reusing it would 400 every
  // real value the office holds.
  it('accepts the free-text values a slug parser would refuse', () => {
    expect(parseReportFilters({ range: 'RAMM, SON & CROCKER' })).toEqual({
      range: 'RAMM, SON & CROCKER',
    })
    expect(parseReportFilters({ brand_code: 'CF' })).toEqual({ brand_code: 'CF' })
    expect(parseReportFilters({ range: '  C & C Milano Bedding  ' })).toEqual({
      range: 'C & C Milano Bedding',
    })
  })

  it('refuses a value that is not a single line of printable text, naming the filter', () => {
    expect(() => parseReportFilters({ range: 'a\nb' })).toThrow(/Invalid value for filter "range"/)
    expect(() => parseReportFilters({ brand_code: 'x'.repeat(101) })).toThrow(
      /Invalid value for filter "brand_code"/
    )
    expect(() => parseReportFilters({ range: 42 })).toThrow(/expected a text value/)
  })

  it('is absent when blank, never "match nothing"', () => {
    expect(parseReportFilters({ range: '   ', brand_code: '' })).toEqual({})
  })

  it('binds as an escaped ILIKE with a matching ESCAPE', () => {
    const filters = parseReportFilters({ brand_code: 'CF', range: 'Pierre Frey' })
    const { where, params } = buildReportFilters(filters)

    expect(where).toBe(
      "b.brand_code ILIKE $1 ESCAPE '\\' AND p.product_range ILIKE $2 ESCAPE '\\'"
    )
    expect(params).toEqual(['%CF%', '%Pierre Frey%'])
  })

  // The escape and the ESCAPE clause are one rule; a range typed as `100%` has
  // to match a literal percent rather than everything.
  it('escapes the wildcards a person can type', () => {
    const { params } = buildReportFilters(parseReportFilters({ range: '100% _ \\ linen' }))
    expect(params).toEqual(['%100\\% \\_ \\\\ linen%'])
  })

  // meta.filters is echoed into the payload and into the CSV's notes block, so
  // the pattern must not be what the office reads back.
  it('echoes what the office typed, not the pattern that was bound', () => {
    expect(parseReportFilters({ range: '100%' }).range).toBe('100%')
  })

  // Ajv's removeAdditional STRIPS an unlisted key rather than rejecting it, so a
  // filter missing from the route schema answers 200 having filtered nothing.
  it('is named in the report route’s querystring schema', () => {
    const source = readFileSync(
      new URL('../src/routes/admin-reports.js', import.meta.url),
      'utf8'
    )
    const properties = source.slice(
      source.indexOf('const FILTER_PROPERTIES'),
      source.indexOf('const reportQuerySchema')
    )
    expect(properties).toContain('brand_code:')
    expect(properties).toContain('range:')
  })

  it('is honoured by the stock report, whose FROM already carries both columns', () => {
    expect([...STOCK_FILTERS]).toContain('brand_code')
    expect([...STOCK_FILTERS]).toContain('range')

    const filters = parseReportFilters({ range: 'TREND', from: '2026-01-01' })
    const built = buildReportFilters(filters, { names: STOCK_FILTERS })
    expect(built.where).toBe("p.product_range ILIKE $1 ESCAPE '\\'")
  })
})

// ---------------------------------------------------------------------------
// US-005 / US-006 — the two statements
// ---------------------------------------------------------------------------

describe('W21-US-005 — the coverage statement on the new dimensions', () => {
  it('states how much of THIS population carries each dimension', () => {
    expect(dimensionCoverage({ rows: 40, with_brand_code: 0, with_range: 12 })).toEqual({
      rows: 40,
      brand_code: 0,
      range: 12,
      historic_sales: 'header-only — not attributable to a product, brand code or range',
      note: DIMENSION_COVERAGE_NOTE,
    })
  })

  it('defaults to zeroes rather than to undefined, so an empty population still states one', () => {
    expect(dimensionCoverage()).toMatchObject({ rows: 0, brand_code: 0, range: 0 })
  })

  // The constraint that makes an empty range report legible: the D365
  // transaction exports carry no line items at all.
  it('says why no historic sale can be attributed to either dimension', () => {
    expect(DIMENSION_COVERAGE_NOTE).toMatch(/header-only/)
    expect(DIMENSION_COVERAGE_NOTE).toMatch(/live platform orders only/)
    expect(DIMENSION_COVERAGE_NOTE).toMatch(/weeks rather than years/)
  })
})

describe('W21-US-006 — a stock figure names its source', () => {
  it('knows the three places a stock quantity can come from', () => {
    expect(Object.keys(STOCK_SOURCES)).toEqual([
      'inventory',
      'legacy_stock_items',
      'legacy_item_locations',
    ])
    expect(Object.isFrozen(STOCK_SOURCES)).toBe(true)
  })

  it('states the source, its table and the unreconciled disagreement', () => {
    expect(stockSource('inventory')).toEqual({
      source: 'inventory',
      label: 'live platform inventory',
      table: 'inventory',
      columns: ['qty_available', 'qty_reserved'],
      reconciled_with_d365: false,
      disagreement: STOCK_SOURCE_DISAGREEMENT,
    })
  })

  it('quantifies the disagreement rather than gesturing at it, and picks no winner', () => {
    expect(STOCK_SOURCE_DISAGREEMENT).toMatch(/2\.65×/)
    expect(STOCK_SOURCE_DISAGREEMENT).toMatch(/5,332\.8/)
    expect(STOCK_SOURCE_DISAGREEMENT).toMatch(/14,157\.9/)
    expect(STOCK_SOURCE_DISAGREEMENT).toMatch(/neither has been picked/)
  })

  // A code literal, like a lifecycle registry key: unreachable from a caller, so
  // an unknown one is a bug and a plain Error.
  it('throws on a source nobody declared', () => {
    expect(() => stockSource('xero')).toThrow(/Unknown stock source/)
  })
})

describe('W21-US-005/006 — both statements reach the FILE, not only the screen', () => {
  const columns = defineColumns([
    { key: 'sku', label: 'SKU' },
    { key: 'on_hand', label: 'On hand', kind: 'number' },
  ])

  const report = {
    report: 'stock',
    title: 'Stock holdings by colourway',
    columns,
    rows: [{ sku: 'A-1', on_hand: 4 }],
    totals: null,
    meta: {
      filters: { range: 'TREND' },
      masked_columns: [],
      coverage: {
        note: 'A snapshot.',
        stock_source: stockSource('inventory'),
        dimensions: dimensionCoverage({ rows: 1, with_brand_code: 0, with_range: 1 }),
      },
    },
  }

  it('writes the stock source and the dimension coverage into the notes block', () => {
    const csv = toReportCsv(report)
    const notes = csv.slice(csv.indexOf('Report,'))

    expect(notes).toContain('Stock source')
    expect(notes).toContain('live platform inventory (inventory)')
    expect(notes).toContain('2.65')
    expect(notes).toContain('Dimensions')
    expect(notes).toContain('Brand code on 0 of 1 rows, range on 1 of 1')
  })

  it('leaves a report that states neither exactly as it was', () => {
    const bare = { ...report, meta: { ...report.meta, coverage: { note: 'A snapshot.' } } }
    const csv = toReportCsv(bare)
    expect(csv).not.toContain('Stock source')
    expect(csv).not.toContain('Dimensions')
  })
})
