// The Supplier Colours workbook, uploaded (25 Sep 2026): read by its header,
// and (28 Sep 2026) hung under the products the product prices built.
//   1. reading the workbook — the data sheet found by its five labels
//   2. /admin/catalogue/colours/import/* — director-only, dry run then apply,
//      a re-run changes nothing, no product or house is ever created
//
// Real Postgres, prefixed fixtures.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { buildWorkbook } from '../scripts/lib/xlsx-write.js'
import { readSupplierColoursWorkbook } from '../src/catalogue/supplier-colours-import.js'

const PREFIX = 'w-supplier-colours-test'
const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct horse battery staple'
const FILENAME = 'Supplier Colours 2026.xlsx'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const HEADER = ['Supplier', 'Brand', 'Product Name', 'Code', 'Colour']
const HOUSE = `${PREFIX} Madeaux`
const HOUSE_SLUG = `${PREFIX}-madeaux`

const notes = { name: 'Notes', rows: [['Supplier', 'Brand', 'Colourways', 'Notes'], ['Madeaux', 'Madeaux', '', 'Code is the colourway number.']] }
const colours = (rows) => buildWorkbook([notes, { name: 'Supplier Colours', rows: [HEADER, ...rows] }])

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

describe('reading the Supplier Colours workbook', () => {
  it('finds the data sheet by its header, not its position, and keeps each row’s coordinate', () => {
    const read = readSupplierColoursWorkbook(
      colours([
        ['Madeaux', 'Madeaux', 'ELLA STRIPE', '01', 'Sky'],
        ['Jannelli & Volpi', 'Altagamma', 'ALTA', '4711', ''],
        ['', '', '', '', ''],
      ]),
      FILENAME
    )
    expect(read.sheet).toBe('Supplier Colours')
    expect(read.rows_read).toBe(2)
    expect(read.rows[0]).toEqual({
      supplier: 'Madeaux',
      brand: 'Madeaux',
      design: 'ELLA STRIPE',
      design_code: '',
      colour_code: '01',
      colour_name: 'Sky',
      source_file: FILENAME,
      source_sheet: 'Supplier Colours',
      source_row: 2,
    })
    // No colour name is the importer's to resolve (it shows the code), not an error.
    expect(read.rows[1]).toMatchObject({ colour_code: '4711', colour_name: '' })
  })

  it('reads the optional Design Code column beside the five', () => {
    const read = readSupplierColoursWorkbook(
      buildWorkbook([{ name: 'Supplier Colours', rows: [[...HEADER, 'Design Code'], ['Fabricut', 'Stroheim', 'ACONITUM', '4539301', 'Ivory', '45393']] }]),
      FILENAME
    )
    expect(read.rows[0]).toMatchObject({ design: 'ACONITUM', design_code: '45393', colour_code: '4539301' })
  })

  it('refuses what is not the workbook, and a row with no house, in words the office can act on', () => {
    const refusal = (buffer) => {
      try {
        readSupplierColoursWorkbook(buffer, FILENAME)
      } catch (error) {
        return error
      }
      throw new Error('expected a refusal')
    }
    expect(refusal(Buffer.alloc(0)).message).toMatch(/empty/)
    expect(refusal(Buffer.from('Supplier,Brand\n')).message).toMatch(/not an Excel workbook/)
    expect(refusal(buildWorkbook([notes])).message).toMatch(/No sheet .* starts with the colour columns/)
    const noBrand = refusal(colours([['Madeaux', '', 'ELLA STRIPE', '01', 'Sky']]))
    expect(noBrand.statusCode).toBe(422)
    expect(noBrand.errors).toEqual(['row 2 (ELLA STRIPE): no brand'])
  })
})

describe('/admin/catalogue/colours/import', () => {
  let pool
  let app
  let directorCookie
  let backofficeCookie
  let houseId

  const sessionCookieFrom = (response) => {
    const setCookie = response.headers['set-cookie']
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0]
  }
  const upload = (step, buffer, cookie = directorCookie) =>
    app.inject({
      method: 'POST',
      url: `/admin/catalogue/colours/import/${step}?filename=${encodeURIComponent(FILENAME)}`,
      headers: { 'content-type': XLSX, ...(cookie ? { cookie } : {}) },
      payload: buffer,
    })

  const cleanup = async () => {
    await pool.query(`DELETE FROM colourways WHERE sku LIKE $1`, [`${HOUSE_SLUG.toUpperCase()}-%`])
    // Price moves are RESTRICT on the product: the history goes first.
    await pool.query(`DELETE FROM product_price_history WHERE product_id IN (SELECT id FROM products WHERE slug LIKE $1)`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM products WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM product_prices WHERE guid::text LIKE '00000000-0000-4000-9000-%'`)
    await pool.query(`DELETE FROM product_price_imports WHERE filename = $1`, [`${PREFIX}.xlsx`])
    await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}-%`])
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${PREFIX}-%`])
  }

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup()
    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only) VALUES ($1, $2, 'NZD', true) RETURNING id`,
      [HOUSE, HOUSE_SLUG]
    )
    houseId = rows[0].id
    // A product price for ELLA STRIPE under this house, so the plan can say the
    // design it lands is priced.
    const { rows: imported } = await pool.query(
      `INSERT INTO product_price_imports (filename, rows_read, rows_new, rows_changed, rows_unchanged)
       VALUES ($1, 1, 1, 0, 0) RETURNING id`,
      [`${PREFIX}.xlsx`]
    )
    await pool.query(
      `INSERT INTO product_prices (guid, code, description, range_name, currency, wholesale_rate, first_import_id, last_import_id)
       VALUES ('00000000-0000-4000-9000-000000000001', 'ELLA STRIPE', 'ELLA STRIPE', $1, 'GBP', 47.6, $2, $2)`,
      [HOUSE, imported[0].id]
    )
    for (const [key, role] of [
      ['director', 'director'],
      ['backoffice', 'backoffice'],
    ]) {
      const email = `${PREFIX}-${key}@example.test`
      const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD, name: key } })
      await pool.query(`UPDATE users SET role = $2 WHERE email = $1`, [email, role])
      if (key === 'director') directorCookie = sessionCookieFrom(res)
      else backofficeCookie = sessionCookieFrom(res)
    }
  })

  afterAll(async () => {
    await app.close()
    await cleanup()
    await pool.end()
  })

  it('is director-only', async () => {
    const book = colours([[HOUSE, HOUSE, 'ELLA STRIPE', '01', 'Sky']])
    for (const step of ['validate', 'apply']) {
      expect((await upload(step, book, null)).statusCode).toBe(401)
      expect((await upload(step, book, backofficeCookie)).statusCode).toBe(403)
    }
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM products WHERE brand_id = $1`, [houseId])
    expect(rows[0].n).toBe(0)
  })

  it('hangs a colour under the product its price row built, never creates one, and a re-run changes nothing', async () => {
    const { rows: price } = await pool.query(`SELECT id FROM product_prices WHERE guid = '00000000-0000-4000-9000-000000000001'`)
    const { rows: made } = await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency, product_price_id)
       VALUES ($1, 'ELLA STRIPE', $2, 'fabric', 'GBP', $3) RETURNING id`,
      [houseId, `${HOUSE_SLUG}-ella-stripe`, price[0].id]
    )
    const book = colours([
      ['Madeaux', HOUSE, 'ELLA STRIPE', '01', 'Sky'],
      ['Madeaux', HOUSE, 'NO SUCH DESIGN', '02', 'Straw'],
      ['Nobody', `${PREFIX} Nobody`, 'GHOST', '1', 'Grey'],
    ])
    const dry = await upload('validate', book)
    expect(dry.statusCode).toBe(200)
    const sku = `${HOUSE_SLUG}-ella-stripe-01`.toUpperCase()
    expect(dry.json()).toMatchObject({
      rows_read: 3,
      products: 1,
      products_new: 0,
      colourways: 1,
      colourways_new: 1,
      unknown_brands: [{ brand: `${PREFIX} Nobody`, rows: 1 }],
      skips: [{ reason: 'no product in its house has this design or code', rows: 1 }],
      sample: [{ sku, name: 'Sky', is_new: true }],
      houses: [{ house: { id: houseId }, products: 1, products_new: 0, colourways: 1 }],
    })
    expect((await pool.query(`SELECT 1 FROM colourways WHERE sku = $1`, [sku])).rows).toHaveLength(0)

    const applied = await upload('apply', book)
    expect(applied.statusCode).toBe(200)
    expect(applied.json()).toMatchObject({ colourways_new: 1, applied: { colourways: 1, products: 1, stock_rows_created: 1 } })
    const { rows } = await pool.query(
      `SELECT c.product_id, c.name AS colour, i.qty_available::float AS qty, i.unit
         FROM colourways c JOIN inventory i ON i.colourway_id = c.id
        WHERE c.sku = $1`,
      [sku]
    )
    expect(rows).toEqual([{ product_id: made[0].id, colour: 'Sky', qty: 0, unit: 'metres' }])
    // No product was made for the design nothing names, and no house for the unknown brand.
    expect((await pool.query(`SELECT count(*)::int AS n FROM products WHERE brand_id = $1`, [houseId])).rows[0].n).toBe(1)
    expect((await pool.query(`SELECT 1 FROM brands WHERE slug = $1`, [`${PREFIX}-nobody`])).rows).toHaveLength(0)

    const again = await upload('apply', book)
    expect(again.json()).toMatchObject({ colourways_new: 0, applied: { stock_rows_created: 0 } })
  })

  it('answers a bad file with the per-row reasons', async () => {
    const response = await upload('validate', colours([['Madeaux', '', 'ELLA STRIPE', '01', 'Sky']]))
    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error_count: 1, errors: ['row 2 (ELLA STRIPE): no brand'] })
  })
})
