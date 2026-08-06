import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { csvCell, csvRow, csvDocument, csvRows } from '../src/lib/csv-text.js'
import {
  DEFAULT_BRAND_SLUG,
  PRODUCT_SHEET_HEADER,
  productSheetFilename,
  toProductSheetCsv,
} from '../src/products/product-sheet.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'sheet-test'
const DOMAIN = 'sheet-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const SLUG = {
  house: `${PREFIX}-house`,
  empty: `${PREFIX}-empty`,
  formula: `${PREFIX}-formula`,
  linen: `${PREFIX}-linen`,
  hidden: `${PREFIX}-hidden`,
  archived: `${PREFIX}-archived`,
}

// Two names that would break a naive writer, both reachable through
// PATCH /admin/products: one opens with a formula lead-in, one carries the two
// characters RFC 4180 quoting exists for.
const FORMULA_NAME = '=cut to order'
const QUOTED_NAME = 'Linen, "Ivory"'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const seedFixtures = async (pool) => {
  const { rows: brands } = await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     -- trade_only false so the fixture models a house an anonymous request can
     -- see; the column defaults to closed.
     VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
     RETURNING id`,
    ['Sheet Test House', SLUG.house]
  )
  const brandId = brands[0].id

  // A house whose NAME carries the characters that would corrupt a
  // Content-Disposition header, and which holds nothing at all.
  await pool.query(
    `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
     VALUES ($1, $2, 'Italy', 'EUR', true, false, 'An empty test house.')`,
    ['Sheet "Empty", Ltd', SLUG.empty]
  )

  const { rows: collections } = await pool.query(
    `INSERT INTO collections (brand_id, name, slug)
     VALUES ($1, 'Sheet Test Collection', $2) RETURNING id`,
    [brandId, `${PREFIX}-collection`]
  )
  const collectionId = collections[0].id

  await pool.query(
    `INSERT INTO products (brand_id, collection_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, $2, $3, $4, 'fabric', 'NZD', true)`,
    [brandId, collectionId, FORMULA_NAME, SLUG.formula]
  )
  await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, $2, $3, 'fabric', 'NZD', true)`,
    [brandId, QUOTED_NAME, SLUG.linen]
  )
  // Hidden but live: still the office's to categorise.
  await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
     VALUES ($1, 'Zephyr', $2, 'finished_good', 'NZD', false)`,
    [brandId, SLUG.hidden]
  )
  // Archived: out of the catalogue, so out of the sheet.
  await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website, archived_at)
     VALUES ($1, 'Archived Design', $2, 'fabric', 'NZD', true, now())`,
    [brandId, SLUG.archived]
  )
}

const cleanupFixtures = (pool) =>
  pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}-%`])

const deleteUsers = (pool) =>
  pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

const productIdFor = async (pool, slug) => {
  const { rows } = await pool.query('SELECT id FROM products WHERE slug = $1', [slug])
  return rows[0].id
}

/** The CSV parsed back through the module's own reader: [lineNumber, fields][]. */
const parse = (csv) => [...csvRows(csv)]

describe('product sheet — the CSV writer', () => {
  it('leaves an ordinary value alone and empties null/undefined', () => {
    expect(csvCell('Atlas')).toBe('Atlas')
    expect(csvCell(12)).toBe('12')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('neutralises every formula lead-in a spreadsheet would evaluate', () => {
    // No quote or comma in the payload: those would additionally wrap the cell
    // in RFC-4180 quoting, which is a different rule tested below.
    for (const prefix of ['=', '+', '-', '@', '\t']) {
      expect(csvCell(`${prefix}cut to order`)).toBe(`'${prefix}cut to order`)
    }
    // A CR opens a formula AND forces quoting, so both rules apply at once.
    expect(csvCell('\rcut to order')).toBe('"\'\rcut to order"')
    // And the neutralised value survives being written into a whole document.
    expect(csvRow(['=WEBSERVICE(x)', 'Atlas'])).toBe("'=WEBSERVICE(x),Atlas")
  })

  it('quotes per RFC 4180 and doubles an embedded quote', () => {
    expect(csvCell('Linen, Ivory')).toBe('"Linen, Ivory"')
    expect(csvCell('Linen "Ivory"')).toBe('"Linen ""Ivory"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvRow(['a', 'b,c', null])).toBe('a,"b,c",')
  })

  it('separates records with CRLF and ends the file with one', () => {
    expect(csvDocument([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n')
  })
})

describe('product sheet — the header contract', () => {
  it('is the five columns the re-import matches on', () => {
    expect([...PRODUCT_SHEET_HEADER]).toEqual([
      'Product ID',
      'House',
      'Collection',
      'Design',
      'Category',
    ])
  })

  it('defaults to Atelier’s own workroom', () => {
    expect(DEFAULT_BRAND_SLUG).toBe('atelier-textiles-nz')
  })

  it('builds the filename from the slug alone', () => {
    expect(productSheetFilename('pierre-frey')).toBe('atelier-product-sheet-pierre-frey.csv')
  })

  it('emits Category empty for every row, whatever the product carries', () => {
    const csv = toProductSheetCsv({
      rows: [{ id: 7, house: 'A House', collection: null, design: 'Atlas' }],
    })
    expect(csv).toBe('Product ID,House,Collection,Design,Category\r\n7,A House,,Atlas,\r\n')
  })
})

describe('GET /admin/product-sheet/export.csv', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const download = (url, cookie) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} })

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
    await seedFixtures(pool)

    // Register both users ONCE: /auth/register is 10 per 15 min per IP, and a
    // per-test registration yields 429 and no cookie.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('boss')])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await deleteUsers(pool)
    await app.close()
    await pool.end()
  })

  it('refuses an anonymous caller and a customer', async () => {
    expect((await download('/admin/product-sheet/export.csv')).statusCode).toBe(401)
    expect(
      (await download('/admin/product-sheet/export.csv', customerCookie)).statusCode
    ).toBe(403)
  })

  it('400s a brand that is not a slug, rather than looking it up', async () => {
    for (const brand of ['Not%20A%20Slug', 'UPPER', '', 'a_b']) {
      const response = await download(
        `/admin/product-sheet/export.csv?brand=${brand}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(400)
    }
  })

  it('404s a slug that names no house', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${PREFIX}-no-such-house`,
      backofficeCookie
    )
    expect(response.statusCode).toBe(404)
    expect(response.json().message).toContain(`${PREFIX}-no-such-house`)
  })

  it('serves a CSV download named after the brand slug', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="atelier-product-sheet-${SLUG.house}.csv"`
    )
  })

  it('opens with the documented header row', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    expect(response.body.split('\r\n')[0]).toBe('Product ID,House,Collection,Design,Category')
    expect(parse(response.body)[0][1]).toEqual([...PRODUCT_SHEET_HEADER])
  })

  it('carries the server key on every row and leaves Category empty', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    const [, ...dataRows] = parse(response.body)
    expect(dataRows.length).toBe(3)

    for (const [, fields] of dataRows) {
      expect(fields).toHaveLength(PRODUCT_SHEET_HEADER.length)
      // Category: present, and empty for every row.
      expect(fields[4]).toBe('')
      expect(fields[1]).toBe('Sheet Test House')
    }

    // The key is products.id, so a re-import matches on identity, never on the
    // position of the row in the file.
    const ids = dataRows.map(([, fields]) => Number(fields[0]))
    expect(ids).toContain(await productIdFor(pool, SLUG.linen))
    expect(ids).toContain(await productIdFor(pool, SLUG.hidden))
    expect(ids).toContain(await productIdFor(pool, SLUG.formula))
  })

  it('includes a hidden product and excludes an archived one', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    const designs = parse(response.body)
      .slice(1)
      .map(([, fields]) => fields[3])
    expect(designs).toContain('Zephyr')
    expect(designs).not.toContain('Archived Design')
  })

  it('states the collection where there is one and leaves it blank otherwise', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    const rows = parse(response.body).slice(1)
    const collections = new Map(rows.map(([, fields]) => [fields[3], fields[2]]))
    expect(collections.get('Zephyr')).toBe('')
    // The collected product is the one with the formula name, read back through
    // the reader (which strips the quoting but not the neutralising apostrophe).
    expect(collections.get(`'${FORMULA_NAME}`)).toBe('Sheet Test Collection')
  })

  it('neutralises a staff-typed name that would be a formula in Excel', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    expect(response.body).toContain(`'${FORMULA_NAME}`)
    // The raw name never appears at the start of a cell.
    expect(response.body).not.toContain(`,${FORMULA_NAME}`)
  })

  it('quotes a name carrying a comma and a quote, and reads back verbatim', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    expect(response.body).toContain('"Linen, ""Ivory"""')
    const designs = parse(response.body)
      .slice(1)
      .map(([, fields]) => fields[3])
    expect(designs).toContain(QUOTED_NAME)
  })

  it('serves a house with no products as the header alone', async () => {
    const response = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.empty}`,
      backofficeCookie
    )
    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('Product ID,House,Collection,Design,Category\r\n')
    // The house name carries a quote and a comma; the filename takes the slug.
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="atelier-product-sheet-${SLUG.empty}.csv"`
    )
  })

  it('defaults to the house DEFAULT_BRAND_SLUG names', async () => {
    const implicit = await download('/admin/product-sheet/export.csv', backofficeCookie)
    const explicit = await download(
      `/admin/product-sheet/export.csv?brand=${DEFAULT_BRAND_SLUG}`,
      backofficeCookie
    )
    expect(implicit.statusCode).toBe(explicit.statusCode)
    expect(implicit.body).toBe(explicit.body)
  })

  it('exports the same bytes twice, so re-downloading is not a diff', async () => {
    const first = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    const second = await download(
      `/admin/product-sheet/export.csv?brand=${SLUG.house}`,
      backofficeCookie
    )
    expect(second.body).toBe(first.body)
  })
})
