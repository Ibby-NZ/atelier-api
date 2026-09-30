import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { runSeed } from '../src/seed/seed.js'
import { buildProductRows } from '../src/seed/catalogue-data.js'

const SEEDED_TABLES = [
  'brands',
  'collections',
  'products',
  'colourways',
  'inventory',
  'shipping_rates',
]

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const rowCounts = async (pool) => {
  const counts = {}
  for (const table of SEEDED_TABLES) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`)
    counts[table] = rows[0].n
  }
  return counts
}

describe('catalogue seed import', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await runSeed(pool)
  })

  afterAll(async () => {
    await pool.end()
  })

  it('is idempotent: a second run leaves row counts identical', async () => {
    const before = await rowCounts(pool)
    await runSeed(pool)
    const after = await rowCounts(pool)
    expect(after).toEqual(before)
  })

  it('imports realCatalogue brands with supplier currency and international flag', async () => {
    const { rows } = await pool.query(
      `SELECT name, currency, is_international, story FROM brands WHERE slug = 'pierre-frey'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Pierre Frey')
    expect(rows[0].currency).toBe('EUR')
    expect(rows[0].is_international).toBe(true)
    expect(rows[0].story).toMatch(/Founded 1935/)
  })

  // Both paths onto a seeded database must land the client's roster URL: on a
  // fresh database the seed writes it, and on an existing one the migration
  // overwrites whatever was there (the seed's COALESCE would have kept it).
  // Deliberately NOT pierre-frey: the COALESCE test further down overwrites
  // that row to simulate a CRM edit and leaves it that way, so asserting on it
  // here would only pass while this `it` happens to be declared first.
  it('gives every stocked house its roster website', async () => {
    const { rows } = await pool.query(
      `SELECT slug, website_url FROM brands WHERE slug = ANY($1) ORDER BY slug`,
      [['kieffer', 'liberty-london', 'rubelli-venezia']]
    )
    expect(rows).toEqual([
      { slug: 'kieffer', website_url: 'https://www.kieffertextiles.com/' },
      {
        slug: 'liberty-london',
        website_url: 'https://www.libertyfabric.com/product-category/fabrics/',
      },
      { slug: 'rubelli-venezia', website_url: 'https://rubelli.com/' },
    ])
  })

  it('creates the Atelier house brand as domestic (is_international=false)', async () => {
    const { rows } = await pool.query(
      `SELECT currency, is_international FROM brands WHERE slug = 'atelier-textiles-nz'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].currency).toBe('NZD')
    expect(rows[0].is_international).toBe(false)
  })

  it('creates brands referenced only by designs, with currency from suppliers.js', async () => {
    const { rows } = await pool.query(
      `SELECT currency, is_international FROM brands WHERE slug = 'vervain'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].currency).toBe('USD')
    expect(rows[0].is_international).toBe(true)
  })

  it('creates the represented-only houses, complete but empty', async () => {
    const { rows } = await pool.query(
      `SELECT name, country, currency, is_international, story, website_url
         FROM brands WHERE slug = 'verel-de-belval'`
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Verel de Belval')
    expect(rows[0].country).toBe('France')
    expect(rows[0].currency).toBe('EUR')
    expect(rows[0].is_international).toBe(true)
    expect(rows[0].story).toMatch(/Lyon silk house/)
    expect(rows[0].website_url).toBe('https://www.metaphores.com/en/verel-de-belval')
  })

  // The brand page renders the story as its lede, and foundedYear() parses
  // "Founded YYYY" out of it for the "est. YYYY" meta — so a house with no
  // story renders a bare page, which is what BRAND_STORIES exists to prevent.
  it('leaves no house without a description', async () => {
    const { rows } = await pool.query(
      `SELECT slug FROM brands WHERE story IS NULL OR btrim(story) = '' ORDER BY slug`
    )
    expect(rows).toEqual([])
  })

  // The snapshot is the source of record for every house it describes;
  // BRAND_STORIES only covers the ones it says nothing about.
  it('never lets BRAND_STORIES override a snapshot description', async () => {
    const { rows } = await pool.query(
      `SELECT story FROM brands WHERE slug = 'pierre-frey'`
    )
    expect(rows[0].story).toMatch(/^Founded 1935, an inventive/)
  })

  // The storefront gates its collections section house-level: no products under
  // the house, no section at all. These houses must therefore hold nothing — a
  // represented-only house that acquired a collection would render a tile that
  // cannot lead anywhere.
  it('leaves every represented-only house with no collections and no products', async () => {
    const { rows } = await pool.query(
      `SELECT b.slug,
              (SELECT count(*)::int FROM products p WHERE p.brand_id = b.id) AS products,
              (SELECT count(*)::int FROM collections c WHERE c.brand_id = b.id) AS collections
         FROM brands b
        WHERE b.slug = ANY($1)`,
      [['alpaka', 'armani-casa', 'fine', 'hamam', 'sette']]
    )
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.products).toBe(0)
      expect(row.collections).toBe(0)
    }
  })

  // Userback 8287655 / 8287611 / 8287607. The name is what the client asked to
  // change; the slug is the brands upsert key and every storefront URL, so it
  // deliberately still spells the house the old way.
  it('renames the three houses the client asked for, without moving a slug', async () => {
    const { rows } = await pool.query(
      `SELECT slug, name FROM brands WHERE slug = ANY($1) ORDER BY slug`,
      [['atelier-textiles-nz', 'kieffer', 'rubelli-venezia']]
    )
    expect(rows).toEqual([
      { slug: 'atelier-textiles-nz', name: 'Atelier Brand' },
      { slug: 'kieffer', name: 'Kieffer' },
      { slug: 'rubelli-venezia', name: 'Rubelli' },
    ])
  })

  // Userback 8287607 again: the house name had to leave the PRODUCT titles too.
  // A finished good's slug is slugify(its own name) and that name spells the
  // house out, so renaming the two cushions moves their slugs — which the
  // migration moves ahead of this reseed. Asserted through the SKU (the
  // colourway upsert key, which never moves) so it cannot pass by finding a
  // duplicate the reseed inserted; the stale-slug check is the other half,
  // because a missed move leaves the old product behind with no colourways.
  it('renames the Kieffer cushions onto their moved slugs', async () => {
    const { rows } = await pool.query(
      `SELECT c.sku, p.slug, p.name
         FROM products p JOIN colourways c ON c.product_id = p.id
        WHERE c.sku = ANY($1)
        ORDER BY c.sku`,
      [['DOM-1021', 'DOM-1022']]
    )
    expect(rows).toEqual([
      {
        sku: 'DOM-1021',
        slug: 'kieffer-rigatto-cushion-cover-blanc',
        name: 'Kieffer Rigatto Cushion Cover - Blanc',
      },
      {
        sku: 'DOM-1022',
        slug: 'kieffer-rigatto-cushion-cover-mahogany',
        name: 'Kieffer Rigatto Cushion Cover - Mahogany',
      },
    ])

    const { rows: stale } = await pool.query(
      `SELECT slug FROM products WHERE slug LIKE 'dominique-kieffer-%'`
    )
    expect(stale).toEqual([])
  })

  // Userback 8287607. Asserted as "not live" rather than "absent" because the
  // two halves land differently: a fresh database never seeds these houses (the
  // roster migration still creates three of them, which the archive migration
  // then archives), while an already-seeded one keeps its rows archived. Either
  // way none of the five may reach the public catalogue.
  it('leaves no departed house live in the catalogue', async () => {
    const { rows } = await pool.query(
      `SELECT slug FROM brands WHERE slug = ANY($1) AND archived_at IS NULL`,
      [['sahco', 'le-crin', 'timney-fowler', 'the-vale-london', 'brochier']]
    )
    expect(rows).toEqual([])
  })

  it('gives non-Atelier finished goods no retail price, house goods an indicative one', async () => {
    const { rows: international } = await pool.query(
      `SELECT retail_price_cents FROM products WHERE slug = 'pierre-frey-atlas-cushion-cover'`
    )
    expect(international).toHaveLength(1)
    expect(international[0].retail_price_cents).toBeNull()

    const { rows: house } = await pool.query(
      `SELECT retail_price_cents, currency, product_type FROM products WHERE slug = 'plaid-classic-throw'`
    )
    expect(house).toHaveLength(1)
    expect(house[0].retail_price_cents).toBe(38900)
    expect(house[0].currency).toBe('NZD')
    expect(house[0].product_type).toBe('finished_good')
  })

  it('categorises every seeded product: finished goods from their item type, fabrics as fabric', async () => {
    const { rows } = await pool.query(
      `SELECT slug, category FROM products
        WHERE slug IN ('pierre-frey-atlas-cushion-cover', 'plaid-classic-throw',
                       'heritage-duvet-cover', 'galata-organic-towels')`
    )
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.category]))).toEqual({
      'pierre-frey-atlas-cushion-cover': 'cushion',
      'plaid-classic-throw': 'throw',
      'heritage-duvet-cover': 'bed-linen',
      'galata-organic-towels': 'towel',
    })
    // Every seeded slug, not every product: other suites leave fixtures behind.
    const { rows: [blank] } = await pool.query(
      `SELECT count(*)::int AS n FROM products WHERE slug = ANY($1::text[]) AND category IS NULL`,
      [buildProductRows().map((row) => row.slug)]
    )
    expect(blank.n).toBe(0)
  })

  it('seed fills a blank category but never overwrites one the office set', async () => {
    await pool.query(`UPDATE products SET category = 'misc' WHERE slug = 'wolf-throw-xl'`)
    await runSeed(pool)
    const { rows } = await pool.query(`SELECT category FROM products WHERE slug = 'wolf-throw-xl'`)
    expect(rows[0].category).toBe('misc')
    await pool.query(`UPDATE products SET category = 'throw' WHERE slug = 'wolf-throw-xl'`)
  })

  it('imports fabric designs with specs, price band, and colourway hex tones', async () => {
    const { rows: products } = await pool.query(
      `SELECT id, product_type, composition, width, application, price_band, retail_price_cents
       FROM products WHERE slug = 'pierre-frey-atlas'`
    )
    expect(products).toHaveLength(1)
    expect(products[0].product_type).toBe('fabric')
    expect(products[0].composition).toBe('48% Viscose / 33% Cotton / 19% Linen')
    expect(products[0].width).toBe('140cm')
    expect(products[0].application).toBe('Upholstery')
    expect(products[0].price_band).toBe('NZ$420 / m')
    expect(products[0].retail_price_cents).toBeNull()

    const { rows: colourways } = await pool.query(
      `SELECT name, hex_tones, product_id FROM colourways WHERE sku = 'PF-ATL-04'`
    )
    expect(colourways).toHaveLength(1)
    expect(colourways[0].name).toBe('Indigo')
    expect(colourways[0].hex_tones).toEqual(['#5C6B86', '#2C3A55'])
    expect(colourways[0].product_id).toBe(products[0].id)
  })

  it('creates one inventory row per colourway with stock from design status', async () => {
    const { rows: counts } = await pool.query(
      `SELECT (SELECT count(*)::int FROM colourways) AS colourways,
              (SELECT count(*)::int FROM inventory) AS inventory`
    )
    expect(counts[0].inventory).toBe(counts[0].colourways)

    // Larsen Wright is 'Low stock' — matches the 12 m on hand from the sales-order demo data.
    const { rows: low } = await pool.query(
      `SELECT i.qty_available, i.unit FROM inventory i
       JOIN colourways c ON c.id = i.colourway_id WHERE c.sku = 'LAR-WRT-03'`
    )
    expect(low).toHaveLength(1)
    expect(Number(low[0].qty_available)).toBe(12)
    expect(low[0].unit).toBe('metres')

    const { rows: goods } = await pool.query(
      `SELECT i.unit FROM inventory i
       JOIN colourways c ON c.id = i.colourway_id WHERE c.sku = 'ATL-1032'`
    )
    expect(goods).toHaveLength(1)
    expect(goods[0].unit).toBe('units')
  })

  it('links collections to their brand, with tile editorial and a de-prefixed display name', async () => {
    const { rows } = await pool.query(
      `SELECT co.name, co.description, co.image_url FROM collections co
       JOIN brands b ON b.id = co.brand_id
       WHERE b.slug = 'pierre-frey' AND co.slug = 'pierre-frey-cappuccino'`
    )
    expect(rows).toHaveLength(1)
    // The snapshot titles it "Pierre Frey | Cappuccino"; the slug keeps the full
    // title (upsert-key stability) while the display name drops the redundant
    // brand prefix — it only ever renders on the brand's own page.
    expect(rows[0].name).toBe('Cappuccino')
    expect(rows[0].description).toMatch(/natural tones/i)
    expect(rows[0].image_url).toMatch(/^https:\/\/www\.atelier\.co\.nz\//)

    // The plain prefix is only stripped when something word-like remains:
    // a tile labelled just "2024" would read as a mistake.
    const { rows: larsen } = await pool.query(
      `SELECT co.name FROM collections co
       JOIN brands b ON b.id = co.brand_id
       WHERE b.slug = 'larsen' AND co.slug = 'larsen-2024'`
    )
    expect(larsen[0].name).toBe('Larsen 2024')
  })

  it('seeds the verified house website', async () => {
    const { rows } = await pool.query(
      `SELECT website_url FROM brands WHERE slug = 'manuel-canovas'`
    )
    expect(rows[0].website_url).toBe('https://www.manuelcanovas.com/')
  })

  it('seed fills a blank brand website but never overwrites a staff-entered one', async () => {
    // Simulate a CRM edit between seeds, then re-run the seed.
    await pool.query(
      `UPDATE brands SET website_url = 'https://staff-entered.example.com'
       WHERE slug = 'pierre-frey'`
    )
    await runSeed(pool)
    const { rows } = await pool.query(
      `SELECT website_url FROM brands WHERE slug = 'pierre-frey'`
    )
    expect(rows[0].website_url).toBe('https://staff-entered.example.com')
  })

  it('keeps an image the office uploaded in the CRM across a reseed', async () => {
    const UPLOADED = 'https://store.example.com/_emdash/api/media/file/01UPLOAD.jpg'
    const targets = [
      ['collections', 'image_url', `slug = 'pierre-frey-cappuccino'`],
      ['colourways', 'image_url', `sku = 'LAR-WRT-03'`],
      ['products', 'hi_res_asset_url', `id = (SELECT product_id FROM colourways WHERE sku = 'LAR-WRT-03')`],
    ]
    const read = async ([table, column, where]) =>
      (await pool.query(`SELECT ${column} AS url FROM ${table} WHERE ${where}`)).rows.map((r) => r.url)
    const before = await Promise.all(targets.map(read))
    try {
      for (const [table, column, where] of targets) {
        await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${where}`, [UPLOADED])
      }
      await runSeed(pool)
      for (const target of targets) {
        expect(await read(target)).toEqual([UPLOADED])
      }
    } finally {
      for (const [index, [table, column, where]] of targets.entries()) {
        await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${where}`, [before[index][0]])
      }
    }
  })

  it('opens the house workroom to the public and closes every represented maison', async () => {
    const { rows } = await pool.query(
      `SELECT slug FROM brands WHERE trade_only = false ORDER BY slug`
    )
    // Exactly one open house. If this ever grows a second entry it is because
    // someone opened a maison in the CRM or added a domestic brand — both are
    // real decisions, not a seed detail, so the assertion is deliberately exact.
    expect(rows.map((row) => row.slug)).toEqual(['atelier-textiles-nz'])
  })

  it('never re-closes a house the office opened, on any later reseed', async () => {
    // trade_only is written on INSERT only: which houses the public storefront
    // may browse is an operational decision, and a reseed silently pulling a
    // maison back off the public site would be invisible until someone noticed
    // the grid had shrunk.
    await pool.query(`UPDATE brands SET trade_only = false WHERE slug = 'pierre-frey'`)
    await runSeed(pool)
    const { rows } = await pool.query(
      `SELECT trade_only FROM brands WHERE slug = 'pierre-frey'`
    )
    expect(rows[0].trade_only).toBe(false)
    await pool.query(`UPDATE brands SET trade_only = true WHERE slug = 'pierre-frey'`)
  })

  // featured_rank is absent from the seed entirely — not merely from the
  // DO UPDATE set lists — so what the storefront leads with is an office
  // decision that outlives a reseed, the same posture as trade_only above and
  // as inventory / shipping_rates (INSERT … DO NOTHING). The rows featured here
  // must be ones the seed actually upserts: a prefix-namespaced fixture house is
  // not in the vendored catalogue, so a reseed never touches it and the
  // assertion would pass even against a set list that cleared the column. The
  // story is overwritten alongside the rank for exactly that reason — the seed
  // refreshes story unconditionally, so its return proves the row was upserted
  // rather than skipped.
  it('never moves a featured house or collection, on any later reseed', async () => {
    const featured = async () => {
      const { rows } = await pool.query(
        `SELECT b.featured_rank AS brand, b.story, c.featured_rank AS collection
           FROM brands b
           JOIN collections c ON c.brand_id = b.id AND c.slug = $2
          WHERE b.slug = $1`,
        ['pierre-frey', 'pierre-frey-cappuccino']
      )
      return rows[0]
    }

    const before = await featured()
    // Otherwise the ranks asserted below could be the ones already there.
    expect(before.brand).not.toBe(99)
    expect(before.collection).not.toBe(98)
    await pool.query(
      `UPDATE brands SET featured_rank = 99, story = 'reseed probe' WHERE slug = 'pierre-frey'`
    )
    // The pair, never the slug alone: collection slugs are unique per brand.
    await pool.query(
      `UPDATE collections c SET featured_rank = 98
         FROM brands b
        WHERE b.id = c.brand_id AND b.slug = $1 AND c.slug = $2`,
      ['pierre-frey', 'pierre-frey-cappuccino']
    )
    await runSeed(pool)

    const after = await featured()
    expect(after.brand).toBe(99)
    expect(after.collection).toBe(98)
    expect(after.story).toMatch(/^Founded 1935/)

    await pool.query(`UPDATE brands SET featured_rank = $1 WHERE slug = 'pierre-frey'`, [
      before.brand,
    ])
    await pool.query(
      `UPDATE collections c SET featured_rank = $3
         FROM brands b
        WHERE b.id = c.brand_id AND b.slug = $1 AND c.slug = $2`,
      ['pierre-frey', 'pierre-frey-cappuccino', before.collection]
    )
  })

  it('seeds shipping rates: three zones with two tiers each (boundary 20)', async () => {
    const { rows } = await pool.query(
      `SELECT zone, count(*)::int AS tiers,
              array_agg(threshold_qty::int ORDER BY threshold_qty) AS thresholds
       FROM shipping_rates GROUP BY zone ORDER BY zone`
    )
    expect(rows.map((row) => row.zone)).toEqual(['Auckland', 'North Island', 'South Island'])
    for (const row of rows) {
      expect(row.tiers).toBe(2)
      expect(row.thresholds).toEqual([0, 20])
    }
  })
})
