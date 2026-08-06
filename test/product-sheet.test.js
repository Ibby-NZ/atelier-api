import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { csvCell, csvRow, csvDocument, csvRows } from '../src/lib/csv-text.js'
import {
  DEFAULT_BRAND_SLUG,
  PRODUCT_SHEET_HEADER,
  PRODUCT_CATEGORIES,
  MAX_REPORTED_ERRORS,
  parseProductSheet,
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

// ---------------------------------------------------------------------------
// The import half.
// ---------------------------------------------------------------------------

const HEADER_LINE = 'Product ID,House,Collection,Design,Category'

// The int4 ceiling: a legal Product ID that no `products` row will ever carry,
// so a row quoting it is unmatched rather than merely unlucky.
const UNMATCHED_ID = 2147483647

/** A sheet as staff would post it back: the contract header plus data lines. */
const sheetCsv = (lines) => `${[HEADER_LINE, ...lines].join('\r\n')}\r\n`

const utf8 = (text) => Buffer.from(text, 'utf8')

// A file saved by Excel on Windows: cp1252, declaring nothing. `é` is 0xE9 —
// invalid UTF-8 on its own — and `’` is 0x92, which is cp1252-specific (latin-1
// decodes that byte to a control character), so the pair proves the sniff
// reached cp1252 rather than merely surviving.
const WINDOWS_DESIGN = 'Café ’25'
const windows1252 = (text) =>
  Buffer.from(
    [...text].map((char) => {
      const code = char.charCodeAt(0)
      if (code === 0x2019) return 0x92
      if (code > 0xff) throw new Error(`no cp1252 byte for ${char}`)
      return code
    })
  )

describe('product sheet — parsing a filled-in sheet', () => {
  it('reads the Product ID and the Category, and counts the untouched rows', () => {
    const parsed = parseProductSheet(
      utf8(sheetCsv(['41,A House,,Atlas,fabric', '42,A House,,Bramble,', '43,A House,,Cirrus,wallpaper']))
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.rows).toBe(3)
    expect(parsed.skipped).toBe(1)
    expect(parsed.entries).toEqual([
      { row: 2, id: 41, design: 'Atlas', category: 'fabric' },
      { row: 4, id: 43, design: 'Cirrus', category: 'wallpaper' },
    ])
  })

  it('parses a file saved by Excel on Windows (cp1252)', () => {
    const parsed = parseProductSheet(
      windows1252(sheetCsv([`41,A House,,${WINDOWS_DESIGN},trimming`]))
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.entries).toEqual([
      { row: 2, id: 41, design: WINDOWS_DESIGN, category: 'trimming' },
    ])
  })

  it('tolerates the BOM Excel writes for a UTF-8 CSV', () => {
    const parsed = parseProductSheet(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        utf8(sheetCsv(['41,A House,,Atlas,fabric'])),
      ])
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.entries).toHaveLength(1)
  })

  it('tolerates a header line ending in a stray comma, and blank lines between rows', () => {
    const parsed = parseProductSheet(
      utf8(`${HEADER_LINE},\r\n41,A House,,Atlas,fabric\r\n\r\n43,A House,,Cirrus,fabric\r\n`)
    )
    expect(parsed.errors).toEqual([])
    // The blank line is not a row anybody typed, so it is neither counted nor
    // reported.
    expect(parsed.rows).toBe(2)
    expect(parsed.entries.map((entry) => entry.row)).toEqual([2, 4])
  })

  it('accepts the vocabulary however the office capitalised it', () => {
    for (const category of PRODUCT_CATEGORIES) {
      const typed = ` ${category.toUpperCase()} `
      const parsed = parseProductSheet(utf8(sheetCsv([`41,A House,,Atlas,${typed}`])))
      expect(parsed.errors).toEqual([])
      expect(parsed.entries[0].category).toBe(category)
    }
  })

  it('reports an unknown category with its row number and the legal values', () => {
    const parsed = parseProductSheet(
      utf8(sheetCsv(['41,A House,,Atlas,fabric', '42,A House,,Bramble,curtain']))
    )
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.errors).toHaveLength(1)
    // Row 3 is the second data row: the line number counts the header.
    expect(parsed.errors[0].row).toBe(3)
    expect(parsed.errors[0].message).toContain('"curtain"')
    for (const category of PRODUCT_CATEGORIES) {
      expect(parsed.errors[0].message).toContain(category)
    }
  })

  it('reports a Product ID that is not one, rather than guessing at the row', () => {
    const parsed = parseProductSheet(
      utf8(
        sheetCsv([
          'Atlas,A House,,Atlas,fabric',
          ',A House,,Bramble,fabric',
          // Past the int4 ceiling: it would otherwise surface as a 500 from the
          // int[] cast rather than as the typo it is.
          '99999999999,A House,,Cirrus,fabric',
        ])
      )
    )
    expect(parsed.entries).toEqual([])
    expect(parsed.errors.map((error) => error.row)).toEqual([2, 3, 4])
    expect(parsed.errors[0].message).toContain('is not a Product ID')
  })

  it('reports a row with the wrong number of columns', () => {
    const parsed = parseProductSheet(utf8(sheetCsv(['41,A House,,fabric'])))
    expect(parsed.errors).toEqual([
      { row: 2, message: '4 columns, expected 5.' },
    ])
  })

  it('collapses a repeated row and refuses a contradicting one', () => {
    const parsed = parseProductSheet(
      utf8(
        sheetCsv([
          '41,A House,,Atlas,fabric',
          '41,A House,,Atlas,fabric',
          '42,A House,,Bramble,wallpaper',
          '42,A House,,Bramble,trimming',
        ])
      )
    )
    expect(parsed.repeats).toBe(1)
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0].row).toBe(5)
    expect(parsed.errors[0].message).toContain('row 4')
    // The contradicted product keeps the first statement; nothing here chooses
    // between them, and the row error is what stops the file being applied.
    expect(parsed.entries).toEqual([
      { row: 2, id: 41, design: 'Atlas', category: 'fabric' },
      { row: 4, id: 42, design: 'Bramble', category: 'wallpaper' },
    ])
  })

  it('does not treat a blank Category as a contradiction', () => {
    const parsed = parseProductSheet(
      utf8(sheetCsv(['41,A House,,Atlas,', '41,A House,,Atlas,fabric']))
    )
    expect(parsed.errors).toEqual([])
    expect(parsed.skipped).toBe(1)
    expect(parsed.entries).toHaveLength(1)
  })

  it('400s a file that is not a product sheet at all', () => {
    const cases = [
      utf8(''),
      utf8('Product ID,House,Design,Category\r\n41,A House,Atlas,fabric\r\n'),
      utf8('Product ID,House,Collection,Design\r\n41,A House,,Atlas\r\n'),
      utf8('name,qty\r\nAtlas,3\r\n'),
    ]
    for (const bytes of cases) {
      expect(() => parseProductSheet(bytes)).toThrow(
        expect.objectContaining({ statusCode: 400 })
      )
    }
  })

  it('400s a body that is not a file', () => {
    expect(() => parseProductSheet({ rows: [] })).toThrow(
      expect.objectContaining({ statusCode: 400 })
    )
  })
})

describe('POST /admin/product-sheet/validate', () => {
  const PREFIX_IN = 'sheet-import-test'
  const DOMAIN_IN = 'sheet-import-test.example.com'
  const SLUG_IN = {
    house: `${PREFIX_IN}-house`,
    plain: `${PREFIX_IN}-plain`,
    already: `${PREFIX_IN}-already`,
    archived: `${PREFIX_IN}-archived`,
  }

  let pool
  let app
  let backofficeCookie
  let customerCookie
  let ids

  const cleanup = async () => {
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX_IN}-%`])
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN_IN}`])
  }

  const post = (payload, cookie, contentType = 'text/csv') =>
    app.inject({
      method: 'POST',
      url: '/admin/product-sheet/validate',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      payload,
    })

  const categoryOf = async (slug) => {
    const { rows } = await pool.query('SELECT category FROM products WHERE slug = $1', [slug])
    return rows[0].category
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

    await cleanup()

    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
       VALUES ('Import Test House', $1, 'New Zealand', 'NZD', false, false, 'A test house.')
       RETURNING id`,
      [SLUG_IN.house]
    )
    const brandId = brands[0].id

    // Uncategorised — the ordinary case, and what every product looked like the
    // day the column landed.
    await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
       VALUES ($1, 'Atlas', $2, 'fabric', 'NZD', true)`,
      [brandId, SLUG_IN.plain]
    )
    // Already carrying the value the sheet will state: the "unchanged" count.
    await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website, category)
       VALUES ($1, 'Bramble', $2, 'fabric', 'NZD', true, 'fabric')`,
      [brandId, SLUG_IN.already]
    )
    // Out of the catalogue, so off the sheet.
    await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website, archived_at)
       VALUES ($1, 'Cirrus', $2, 'fabric', 'NZD', true, now())`,
      [brandId, SLUG_IN.archived]
    )

    const { rows: products } = await pool.query(
      'SELECT slug, id FROM products WHERE slug LIKE $1',
      [`${PREFIX_IN}-%`]
    )
    ids = Object.fromEntries(products.map((row) => [row.slug, row.id]))

    // Registered ONCE: /auth/register is 10 per 15 min per IP. This suite has
    // its own app instance, so it has its own limiter store.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `boss@${DOMAIN_IN}`, password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `boss@${DOMAIN_IN}`,
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `shopper@${DOMAIN_IN}`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  afterAll(async () => {
    await cleanup()
    await app.close()
    await pool.end()
  })

  it('refuses an anonymous caller and a customer', async () => {
    const csv = utf8(sheetCsv([`${ids[SLUG_IN.plain]},Import Test House,,Atlas,fabric`]))
    expect((await post(csv)).statusCode).toBe(401)
    expect((await post(csv, customerCookie)).statusCode).toBe(403)
  })

  it('400s a body posted as JSON rather than as the file', async () => {
    const response = await post({ rows: [] }, backofficeCookie, 'application/json')
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('text/csv')
  })

  it('reports the counts and previews what would change', async () => {
    const response = await post(
      utf8(
        sheetCsv([
          `${ids[SLUG_IN.plain]},Import Test House,,Atlas,wallpaper`,
          `${ids[SLUG_IN.already]},Import Test House,,Bramble,fabric`,
          `${ids[SLUG_IN.plain]},Import Test House,,Atlas,wallpaper`,
          `${ids[SLUG_IN.already]},Import Test House,,Bramble,`,
        ])
      ),
      backofficeCookie
    )
    expect(response.statusCode).toBe(200)
    const { summary, changes } = response.json()
    expect(summary).toEqual({ rows: 4, skipped: 1, repeats: 1, unchanged: 1, changed: 1 })
    // Every row of the file is accounted for.
    expect(summary.rows).toBe(
      summary.skipped + summary.repeats + summary.unchanged + summary.changed
    )
    expect(changes).toEqual([
      { row: 2, id: ids[SLUG_IN.plain], design: 'Atlas', from: null, to: 'wallpaper' },
    ])
  })

  it('writes nothing — a validated sheet is still only a report', async () => {
    const response = await post(
      utf8(sheetCsv([`${ids[SLUG_IN.plain]},Import Test House,,Atlas,trimming`])),
      backofficeCookie
    )
    expect(response.statusCode).toBe(200)
    expect(response.json().summary.changed).toBe(1)
    expect(await categoryOf(SLUG_IN.plain)).toBeNull()
    expect(await categoryOf(SLUG_IN.already)).toBe('fabric')
  })

  it('reports an unmatched key rather than guessing at the House and Design beside it', async () => {
    const response = await post(
      utf8(
        sheetCsv([
          `${ids[SLUG_IN.plain]},Import Test House,,Atlas,fabric`,
          `${UNMATCHED_ID},Import Test House,,${WINDOWS_DESIGN},fabric`,
        ])
      ),
      backofficeCookie
    )
    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.error_count).toBe(1)
    expect(body.errors[0].row).toBe(3)
    expect(body.errors[0].message).toContain(`No product with ID ${UNMATCHED_ID}`)
    // The Design cell is quoted so a person can find the row, and is the only
    // place the file's own encoding surfaces in the report.
    expect(body.errors[0].message).toContain(WINDOWS_DESIGN)
  })

  it('refuses a row against an archived product, which is not on the sheet', async () => {
    const response = await post(
      utf8(sheetCsv([`${ids[SLUG_IN.archived]},Import Test House,,Cirrus,fabric`])),
      backofficeCookie
    )
    expect(response.statusCode).toBe(422)
    expect(response.json().errors[0].message).toContain('archived')
  })

  it('writes nothing when a row fails, including the rows that were fine', async () => {
    const response = await post(
      utf8(
        sheetCsv([
          `${ids[SLUG_IN.plain]},Import Test House,,Atlas,fabric`,
          `${UNMATCHED_ID},Import Test House,,Nowhere,fabric`,
        ])
      ),
      backofficeCookie
    )
    expect(response.statusCode).toBe(422)
    expect(await categoryOf(SLUG_IN.plain)).toBeNull()
  })

  it('caps the reported errors and states how many there really were', async () => {
    const broken = Array.from(
      { length: MAX_REPORTED_ERRORS + 10 },
      (unused, at) => `${ids[SLUG_IN.plain]},Import Test House,,Atlas,curtain-${at}`
    )
    const response = await post(utf8(sheetCsv(broken)), backofficeCookie)
    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.error_count).toBe(MAX_REPORTED_ERRORS + 10)
    expect(body.errors).toHaveLength(MAX_REPORTED_ERRORS)
    expect(body.message).toContain('Nothing has been written')
  })

  it('reads back the file it exported, filled in', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: `/admin/product-sheet/export.csv?brand=${SLUG_IN.house}`,
      headers: { cookie: backofficeCookie },
    })
    expect(exported.statusCode).toBe(200)

    const [header, ...dataRows] = [...csvRows(exported.body)]
    const filled = csvDocument([
      header[1],
      ...dataRows.map(([, fields]) => [...fields.slice(0, 4), 'accessory']),
    ])

    const response = await post(utf8(filled), backofficeCookie)
    expect(response.statusCode).toBe(200)
    // Two live products: one uncategorised, one already `fabric`.
    expect(response.json().summary).toEqual({
      rows: 2,
      skipped: 0,
      repeats: 0,
      unchanged: 0,
      changed: 2,
    })
  })
})

describe('POST /admin/product-sheet/apply', () => {
  const PREFIX_UP = 'sheet-apply-test'
  const DOMAIN_UP = 'sheet-apply-test.example.com'
  const SLUG_UP = {
    house: `${PREFIX_UP}-house`,
    plain: `${PREFIX_UP}-plain`,
    second: `${PREFIX_UP}-second`,
    already: `${PREFIX_UP}-already`,
    archived: `${PREFIX_UP}-archived`,
  }
  const HOUSE_NAME = 'Apply Test House'

  let pool
  let app
  let backofficeCookie
  let customerCookie
  let ids

  const cleanup = async () => {
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX_UP}-%`])
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN_UP}`])
  }

  const send = (url, payload, cookie, contentType = 'text/csv') =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      payload,
    })

  const apply = (payload, cookie, contentType) =>
    send('/admin/product-sheet/apply', payload, cookie, contentType)

  const categoryOf = async (slug) => {
    const { rows } = await pool.query('SELECT category FROM products WHERE slug = $1', [slug])
    return rows[0].category
  }

  /** A data line for one fixture product; the House and Design cells are the human's. */
  const line = (slug, category) => `${ids[slug]},${HOUSE_NAME},,Design,${category}`

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

    const { rows: brands } = await pool.query(
      `INSERT INTO brands (name, slug, country, currency, is_international, trade_only, story)
       VALUES ($1, $2, 'New Zealand', 'NZD', false, false, 'A test house.')
       RETURNING id`,
      [HOUSE_NAME, SLUG_UP.house]
    )
    const brandId = brands[0].id

    for (const [slug, name] of [
      [SLUG_UP.plain, 'Atlas'],
      [SLUG_UP.second, 'Bramble'],
      [SLUG_UP.already, 'Cirrus'],
    ]) {
      await pool.query(
        `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website)
         VALUES ($1, $2, $3, 'fabric', 'NZD', true)`,
        [brandId, name, slug]
      )
    }
    // Out of the catalogue, so off the sheet — a row against it is refused.
    await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, show_on_website, archived_at)
       VALUES ($1, 'Dune', $2, 'fabric', 'NZD', true, now())`,
      [brandId, SLUG_UP.archived]
    )

    const { rows: products } = await pool.query(
      'SELECT slug, id FROM products WHERE slug LIKE $1',
      [`${PREFIX_UP}-%`]
    )
    ids = Object.fromEntries(products.map((row) => [row.slug, row.id]))

    // Registered ONCE: /auth/register is 10 per 15 min per IP. This suite has
    // its own app instance, so it has its own limiter store.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `boss@${DOMAIN_UP}`, password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      `boss@${DOMAIN_UP}`,
    ])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `shopper@${DOMAIN_UP}`, password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(shopper)
  })

  // This suite WRITES, so every test starts from the same catalogue state.
  // Products only — re-registering the users would spend the rate-limit bucket.
  beforeEach(async () => {
    await pool.query(
      `UPDATE products SET category = NULL WHERE slug = ANY($1::text[])`,
      [[SLUG_UP.plain, SLUG_UP.second, SLUG_UP.archived]]
    )
    await pool.query(`UPDATE products SET category = 'fabric' WHERE slug = $1`, [SLUG_UP.already])
  })

  afterAll(async () => {
    await cleanup()
    await app.close()
    await pool.end()
  })

  it('refuses an anonymous caller and a customer', async () => {
    const csv = utf8(sheetCsv([line(SLUG_UP.plain, 'fabric')]))
    expect((await apply(csv)).statusCode).toBe(401)
    expect((await apply(csv, customerCookie)).statusCode).toBe(403)
    // And neither refusal wrote anything on the way past.
    expect(await categoryOf(SLUG_UP.plain)).toBeNull()
  })

  it('400s a body posted as JSON rather than as the file', async () => {
    const response = await apply({ rows: [] }, backofficeCookie, 'application/json')
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('text/csv')
  })

  it('400s a file that is not a product sheet, before it opens a transaction', async () => {
    const response = await apply(utf8('name,qty\r\nAtlas,3\r\n'), backofficeCookie)
    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('Download the sheet again')
  })

  it('writes the categories and reports what it wrote', async () => {
    const response = await apply(
      utf8(
        sheetCsv([
          line(SLUG_UP.plain, 'wallpaper'),
          line(SLUG_UP.second, 'trimming'),
          // Already `fabric`: confirmed, not written.
          line(SLUG_UP.already, 'fabric'),
          // Blank: the row nobody got to.
          line(SLUG_UP.plain, ''),
        ])
      ),
      backofficeCookie
    )

    expect(response.statusCode).toBe(200)
    const { applied, summary, changes } = response.json()
    expect(summary).toEqual({ rows: 4, skipped: 1, repeats: 0, unchanged: 1, changed: 2 })
    // Every row of the file is accounted for.
    expect(summary.rows).toBe(
      summary.skipped + summary.repeats + summary.unchanged + summary.changed
    )
    // The database's own count, not the report's prediction.
    expect(applied).toBe(2)
    expect(changes.map((change) => change.to).sort()).toEqual(['trimming', 'wallpaper'])

    expect(await categoryOf(SLUG_UP.plain)).toBe('wallpaper')
    expect(await categoryOf(SLUG_UP.second)).toBe('trimming')
    expect(await categoryOf(SLUG_UP.already)).toBe('fabric')
  })

  it('changes nothing when the same file is applied again', async () => {
    const csv = utf8(
      sheetCsv([line(SLUG_UP.plain, 'wallpaper'), line(SLUG_UP.second, 'trimming')])
    )

    const first = await apply(csv, backofficeCookie)
    expect(first.statusCode).toBe(200)
    expect(first.json().applied).toBe(2)

    const second = await apply(csv, backofficeCookie)
    expect(second.statusCode).toBe(200)
    const { applied, summary, changes } = second.json()
    // Every row now states what the catalogue already holds: confirmed, not
    // written. That is why the export leaves Category empty — blank is
    // "skipped" and a stored value is "unchanged", which are different rows.
    expect(applied).toBe(0)
    expect(summary).toEqual({ rows: 2, skipped: 0, repeats: 0, unchanged: 2, changed: 0 })
    expect(changes).toEqual([])

    expect(await categoryOf(SLUG_UP.plain)).toBe('wallpaper')
    expect(await categoryOf(SLUG_UP.second)).toBe('trimming')
  })

  it('applies nothing at all when one row fails — the whole sheet is one transaction', async () => {
    const response = await apply(
      utf8(
        sheetCsv([
          // Good, and FIRST: a per-row write would have landed it before
          // reaching the row that fails.
          line(SLUG_UP.plain, 'wallpaper'),
          line(SLUG_UP.second, 'trimming'),
          `${UNMATCHED_ID},${HOUSE_NAME},,Nowhere,fabric`,
        ])
      ),
      backofficeCookie
    )

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body.error_count).toBe(1)
    expect(body.errors[0].row).toBe(4)
    expect(body.message).toContain('Nothing has been written')
    // Refused whole: the two good rows are untouched too.
    expect(await categoryOf(SLUG_UP.plain)).toBeNull()
    expect(await categoryOf(SLUG_UP.second)).toBeNull()
  })

  it('refuses a row against an archived product and writes nothing', async () => {
    const response = await apply(
      utf8(
        sheetCsv([line(SLUG_UP.plain, 'fabric'), line(SLUG_UP.archived, 'fabric')])
      ),
      backofficeCookie
    )
    expect(response.statusCode).toBe(422)
    expect(response.json().errors[0].message).toContain('archived')
    expect(await categoryOf(SLUG_UP.plain)).toBeNull()
    expect(await categoryOf(SLUG_UP.archived)).toBeNull()
  })

  it('refuses a sheet contradicting itself, in the words the dry run used', async () => {
    const csv = utf8(
      sheetCsv([line(SLUG_UP.plain, 'wallpaper'), line(SLUG_UP.plain, 'trimming')])
    )
    const dryRun = await send('/admin/product-sheet/validate', csv, backofficeCookie)
    const applied = await apply(csv, backofficeCookie)

    expect(applied.statusCode).toBe(422)
    // One report, whichever button the office pressed.
    expect(applied.json()).toEqual(dryRun.json())
    expect(await categoryOf(SLUG_UP.plain)).toBeNull()
  })

  it('leaves the dry run with nothing left to report', async () => {
    const csv = utf8(
      sheetCsv([line(SLUG_UP.plain, 'accessory'), line(SLUG_UP.second, 'accessory')])
    )
    expect((await apply(csv, backofficeCookie)).json().applied).toBe(2)

    const dryRun = await send('/admin/product-sheet/validate', csv, backofficeCookie)
    expect(dryRun.statusCode).toBe(200)
    expect(dryRun.json().summary).toEqual({
      rows: 2,
      skipped: 0,
      repeats: 0,
      unchanged: 2,
      changed: 0,
    })
  })

  it('applies the sheet it exported, filled in', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: `/admin/product-sheet/export.csv?brand=${SLUG_UP.house}`,
      headers: { cookie: backofficeCookie },
    })
    expect(exported.statusCode).toBe(200)

    const [header, ...dataRows] = [...csvRows(exported.body)]
    const filled = csvDocument([
      header[1],
      ...dataRows.map(([, fields]) => [...fields.slice(0, 4), 'wallpaper']),
    ])

    const response = await apply(utf8(filled), backofficeCookie)
    expect(response.statusCode).toBe(200)
    // Three live products: two uncategorised, one already `fabric`.
    expect(response.json().summary).toEqual({
      rows: 3,
      skipped: 0,
      repeats: 0,
      unchanged: 0,
      changed: 3,
    })
    for (const slug of [SLUG_UP.plain, SLUG_UP.second, SLUG_UP.already]) {
      expect(await categoryOf(slug)).toBe('wallpaper')
    }
    // The archived design was never on the sheet, so it is still uncategorised.
    expect(await categoryOf(SLUG_UP.archived)).toBeNull()
  })
})
