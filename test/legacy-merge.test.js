import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { withChangeContext } from '../src/pricing/price-history.js'
import {
  cfaFor,
  mergeLegacy,
  planReserveDockets,
  statusFor,
  stockItemAsColourwayRow,
} from '../src/legacy/merge.js'

// The cutover merge: D365 staging → live tables. The pure half is tested on
// its own; the database half runs the whole merge twice over a small fixture
// corpus and proves the second run changes nothing.

const PREFIX = 'ZZ Merge Test'
const HOUSE = 'ZZ Merge House'
const G = (n) => `7${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`

describe('the D365 → platform vocabulary', () => {
  it('maps CFA words and status reasons', () => {
    expect(cfaFor('Not required')).toBe('not_required')
    expect(cfaFor('Approved by Client')).toBe('approved')
    expect(cfaFor('')).toBeNull()
    expect(cfaFor(null)).toBeNull()
    expect(statusFor({ status_reason: 'Complete', reserve_number: '123' })).toBe('dispatched')
    expect(statusFor({ status_reason: 'In Progress', reserve_number: 'tba' })).toBe('requested')
    expect(statusFor({ status_reason: 'In Progress', reserve_number: '' })).toBe('requested')
    expect(statusFor({ status_reason: 'In Progress', reserve_number: 'R/1945' })).toBe('confirmed')
  })

  it('groups lines into one docket per customer, contact, owner and day', () => {
    const base = { customer: 'Zomia', customer_contact: '', customer_owner: 'RB', product: 'Costa', created_on: new Date('2025-09-07T10:00:00') }
    const { dockets, declined } = planReserveDockets([
      { ...base, guid: G(1), kind: 'reserve', quantity: '30.0000', status_reason: 'Complete', reserve_number: '4658840', cfa: 'Received', comments: 'a', order_stock_check_details: 'b', modified_on: new Date('2025-10-06T00:00:00') },
      { ...base, guid: G(2), kind: 'cutting', quantity: '1', status_reason: 'In Progress' },
      { ...base, guid: G(3), kind: 'reserve', customer_owner: 'CS', status_reason: 'In Progress', reserve_number: 'tba' },
      { ...base, guid: G(4), kind: 'reserve', customer: ' ', status_reason: 'Complete' },
      { ...base, guid: G(5), kind: 'reserve', product: '', status_reason: 'Complete' },
    ])
    expect(dockets).toHaveLength(2)
    expect(dockets[0].lines.map((l) => l.legacy_guid)).toEqual([G(1), G(2)])
    expect(dockets[1].owner_name).toBe('CS')
    const [first] = dockets[0].lines
    expect(first).toMatchObject({ kind: 'reserve', status: 'dispatched', qty: 30, cfa: 'received', comment: 'a\nb', reserve_number: '4658840' })
    expect(first.dispatched_at).toEqual(new Date('2025-10-06T00:00:00'))
    expect(dockets[0].lines[1]).toMatchObject({ kind: 'cutting', status: 'requested', cfa: null, dispatched_at: null })
    expect(declined).toEqual([{ guid: G(4), reason: 'no customer' }, { guid: G(5), reason: 'no product' }])
  })

  it('turns a stock item into the colour importer\'s row', () => {
    const row = stockItemAsColourwayRow({ item_code: 'F3518-003 23PF', name: 'CHARLOTTE 003 Blue', supplier: 'Colefax & Fowler', range_name: 'JANE CHURCHILL', product_price_list: 'Charlotte' }, 4)
    expect(row).toMatchObject({ brand: 'JANE CHURCHILL', design: 'Charlotte', colour_code: 'F3518-003', colour_name: 'CHARLOTTE 003 Blue', supplier: 'Colefax & Fowler', source_row: 5 })
    // No linked price row: the item's own name stands in as the design.
    expect(stockItemAsColourwayRow({ item_code: 'BROULIN5486', name: 'BROUILLARD LIN', range_name: 'SOLBIATI' }, 0))
      .toMatchObject({ design: 'BROUILLARD LIN', colour_code: 'BROULIN5486', supplier: 'SOLBIATI' })
  })
})

describe('mergeLegacy against the database', () => {
  let pool

  const cleanup = async () => {
    await pool.query('DELETE FROM reserve_requests WHERE account_name LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM trade_account_contacts WHERE legacy_guid IN ($1, $2, $3)', [G(21), G(22), G(23)])
    await pool.query('DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM legacy_contacts WHERE company_name LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM legacy_accounts WHERE name LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM legacy_reserves WHERE customer LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM legacy_cuttings WHERE customer LIKE $1', [`${PREFIX}%`])
    await pool.query('DELETE FROM legacy_stock_items WHERE range_name = $1', [HOUSE])
    await dropHouse()
  }

  // The price fill is captured in product_price_history (RESTRICT), so the
  // ledger rows go first; the same order the lifecycle delete takes.
  const dropHouse = async () => {
    await pool.query(
      `DELETE FROM product_price_history WHERE product_id IN
         (SELECT id FROM products WHERE brand_id IN (SELECT id FROM brands WHERE name = $1))`, [HOUSE]
    )
    await pool.query(
      `DELETE FROM products WHERE brand_id IN (SELECT id FROM brands WHERE name = $1)`, [HOUSE]
    )
    await pool.query('DELETE FROM brands WHERE name = $1', [HOUSE])
  }

  const seed = async () => {
    await pool.query(
      `INSERT INTO legacy_accounts (guid, name, is_customer, is_supplier, owner, atelier_account_number, customer_type, primary_contact, email, main_phone, address1_composite, address1_city, source_file, raw) VALUES
         ($1, $2, false, false, 'Rebecca', '01234', 'Trade', 'Ann Alpha', 'Ann@Example.test', '09 555', '1 Quay St\nAuckland', 'Auckland', 't.xlsx', '{}'),
         ($3, $4, true,  true,  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 't.xlsx', '{}'),
         ($5, $6, false, true,  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 't.xlsx', '{}'),
         ($7, $8, false, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 't.xlsx', '{}'),
         ($9, $8, false, false, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 't.xlsx', '{}')`,
      [G(11), `${PREFIX} Alpha`, G(12), `${PREFIX} Both`, G(13), `${PREFIX} Supplier`, G(14), `${PREFIX} Twin`, G(15)]
    )
    await pool.query(
      `INSERT INTO legacy_contacts (guid, full_name, company_name, job_title, email, mobile_phone, source_file, raw) VALUES
         ($1, 'Ann Alpha', $2, 'Designer', 'ann@example.test', '021 1', 't.xlsx', '{}'),
         ($3, 'Tom Twin',  $4, NULL, NULL, NULL, 't.xlsx', '{}'),
         ($5, 'Sue Supplier', $6, NULL, NULL, NULL, 't.xlsx', '{}')`,
      [G(21), `${PREFIX} Alpha`, G(22), `${PREFIX} Twin`, G(23), `${PREFIX} Supplier`]
    )
    await pool.query(
      `INSERT INTO legacy_reserves (guid, name, customer, customer_owner, product, product_code, colour_code, supplier, quantity, reserve_number, reserved_until, cfa, status_reason, created_on, modified_on, source_file, raw) VALUES
         ($1, 'Alpha wants a reserve', $2, 'Rebecca', 'Costa', 'L9482', '02 Pearl', 'Colefax', 30, '4658840', '2025-09-24', 'Not required', 'Complete', '2025-09-07 10:00', '2025-10-06 09:00', 't.xlsx', '{}'),
         ($3, 'Alpha wants a reserve', $2, 'Rebecca', 'Voila', '17262', '02 Blanc', 'Kieffer', 15, 'tba', NULL, '', 'In Progress', '2025-09-07 11:00', NULL, 't.xlsx', '{}')`,
      [G(31), `${PREFIX} Alpha`, G(32)]
    )
    await pool.query(
      `INSERT INTO legacy_cuttings (guid, name, customer, product, product_code, colour_code, quantity, status_reason, created_on, source_file, raw) VALUES
         ($1, 'Alpha wants Cutting', $2, 'Catenary', '23994', 'doe', 1, 'Complete', '2025-04-08', 't.xlsx', '{}')`,
      [G(41), `${PREFIX} Alpha`]
    )
    await pool.query(
      `INSERT INTO legacy_stock_items (guid, item_code, name, supplier, range_name, product_price_list, stock_on_hand, trade_price, retail_price, currency, source_file, raw) VALUES
         ($1, 'F3518-003 23PF', 'CHARLOTTE 003 Blue', 'Colefax', $2, 'Charlotte', 12.5, 210, 300, 'New Zealand Dollar', 't.xlsx', '{}'),
         ($3, 'F3518-004 23PF', 'CHARLOTTE 004 Red',  'Colefax', $2, 'Charlotte', 0,    210, 300, 'New Zealand Dollar', 't.xlsx', '{}')`,
      [G(51), HOUSE, G(52)]
    )
  }

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({ databaseUrl: config.databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })
    await cleanup()
    await seed()
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  const ours = async (sql, params = []) => (await pool.query(sql, params)).rows

  it('promotes clients, their contacts, dockets and stock — and a second run changes nothing', async () => {
    const first = await mergeLegacy(pool, { createHouses: true })

    // Accounts: every account that is not ONLY a supplier; the twins are flagged.
    const accounts = await ours(
      'SELECT legacy_customer_name AS name, name_is_ambiguous, account_manager_name, account_number, customer_type, primary_contact_name, email, phone, city FROM trade_accounts WHERE legacy_customer_name LIKE $1 ORDER BY 1',
      [`${PREFIX}%`]
    )
    expect(accounts.map((a) => a.name)).toEqual([`${PREFIX} Alpha`, `${PREFIX} Both`, `${PREFIX} Twin`, `${PREFIX} Twin`])
    expect(accounts[0]).toMatchObject({
      name_is_ambiguous: false, account_manager_name: 'Rebecca', account_number: '01234', customer_type: 'Trade',
      primary_contact_name: 'Ann Alpha', email: 'ann@example.test', phone: '09 555', city: 'Auckland',
    })
    expect(accounts[2].name_is_ambiguous).toBe(true)

    // Contacts: EVERY one lands. Filed under the account where the company name
    // is one client's; the twin's (shared name) and the supplier's (not a
    // client) land unattached with the company as text.
    const contacts = await ours(
      `SELECT c.name, c.role, c.email, c.phone, t.legacy_customer_name AS account, c.company_name
         FROM trade_account_contacts c LEFT JOIN trade_accounts t ON t.id = c.trade_account_id
        WHERE c.legacy_guid IN ($1, $2, $3) ORDER BY c.name`,
      [G(21), G(22), G(23)]
    )
    expect(contacts).toEqual([
      { name: 'Ann Alpha', role: 'Designer', email: 'ann@example.test', phone: '021 1', account: `${PREFIX} Alpha`, company_name: null },
      { name: 'Sue Supplier', role: null, email: null, phone: null, account: null, company_name: `${PREFIX} Supplier` },
      { name: 'Tom Twin', role: null, email: null, phone: null, account: null, company_name: `${PREFIX} Twin` },
    ])
    expect(first.contacts.created).toBeGreaterThanOrEqual(3)

    // Dockets: the two reserves and the cutting for Alpha, on two days → two dockets.
    const lines = await ours(
      `SELECT l.kind, l.status, l.product_name, l.reserve_number, l.cfa, l.qty::float AS qty, r.account_name, r.owner_name
         FROM reserve_lines l JOIN reserve_requests r ON r.id = l.request_id
        WHERE r.account_name LIKE $1 ORDER BY l.requested_at`,
      [`${PREFIX}%`]
    )
    expect(lines).toEqual([
      { kind: 'cutting', status: 'dispatched', product_name: 'Catenary', reserve_number: null, cfa: null, qty: 1, account_name: `${PREFIX} Alpha`, owner_name: null },
      { kind: 'reserve', status: 'dispatched', product_name: 'Costa', reserve_number: '4658840', cfa: 'not_required', qty: 30, account_name: `${PREFIX} Alpha`, owner_name: 'Rebecca' },
      { kind: 'reserve', status: 'requested', product_name: 'Voila', reserve_number: 'tba', cfa: null, qty: 15, account_name: `${PREFIX} Alpha`, owner_name: 'Rebecca' },
    ])
    expect((await ours('SELECT COUNT(*)::int AS n FROM reserve_requests WHERE account_name LIKE $1', [`${PREFIX}%`]))[0].n).toBe(2)

    // Stock: the house was raised, one product with two colourways, on-hand and prices landed.
    expect(first.housesRaised).toContain(HOUSE)
    const stock = await ours(
      `SELECT c.sku, i.qty_available::float AS qty, p.trade_price_cents, p.retail_price_cents, p.name
         FROM colourways c JOIN inventory i ON i.colourway_id = c.id JOIN products p ON p.id = c.product_id
         JOIN brands b ON b.id = p.brand_id WHERE b.name = $1 ORDER BY c.sku`,
      [HOUSE]
    )
    expect(stock).toEqual([
      { sku: 'ZZ-MERGE-HOUSE-CHARLOTTE-F3518-003', qty: 12.5, trade_price_cents: 21000, retail_price_cents: 30000, name: 'Charlotte' },
      { sku: 'ZZ-MERGE-HOUSE-CHARLOTTE-F3518-004', qty: 0, trade_price_cents: 21000, retail_price_cents: 30000, name: 'Charlotte' },
    ])

    // Second run: nothing new, and the office's edits survive it — the account
    // manager they set stays, while the company details follow D365.
    await pool.query(`UPDATE trade_accounts SET account_manager_name = 'Charlotte' WHERE legacy_account_guid = $1`, [G(11)])
    await pool.query(`UPDATE legacy_accounts SET main_phone = '09 777' WHERE guid = $1`, [G(11)])
    await withChangeContext(pool, { source: 'manual', reason: 'test', userId: null }, (client) =>
      client.query('UPDATE products SET trade_price_cents = 99900 WHERE name = $1 AND brand_id = (SELECT id FROM brands WHERE name = $2)', ['Charlotte', HOUSE])
    )
    await pool.query('UPDATE legacy_stock_items SET stock_on_hand = 7 WHERE guid = $1', [G(51)])
    const second = await mergeLegacy(pool, { createHouses: true })
    expect(second.accounts.created).toBe(0)
    expect((await ours('SELECT account_manager_name, phone FROM trade_accounts WHERE legacy_account_guid = $1', [G(11)])))
      .toEqual([{ account_manager_name: 'Charlotte', phone: '09 777' }])
    expect(second.contacts.created).toBe(0)
    expect(second.reserves).toMatchObject({ dockets: 0, lines: 0 })
    expect(second.housesRaised).toEqual([])
    expect(second.catalogue.inventoryCreated).toBe(0)
    const after = await ours(
      `SELECT i.qty_available::float AS qty, p.trade_price_cents FROM colourways c
         JOIN inventory i ON i.colourway_id = c.id JOIN products p ON p.id = c.product_id WHERE c.sku = $1`,
      ['ZZ-MERGE-HOUSE-CHARLOTTE-F3518-003']
    )
    // Quantity follows D365 (it is the stock authority until cutover); the price the office set does not.
    expect(after).toEqual([{ qty: 7, trade_price_cents: 99900 }])
    expect((await ours('SELECT COUNT(*)::int AS n FROM reserve_requests WHERE account_name LIKE $1', [`${PREFIX}%`]))[0].n).toBe(2)
  })

  it('leaves a house it does not know alone unless told to raise it', async () => {
    await dropHouse()
    const summary = await mergeLegacy(pool)
    expect(summary.housesRaised).toEqual([])
    expect(summary.catalogue.unknownBrands.map((b) => b.brand)).toContain(HOUSE)
    expect((await ours('SELECT COUNT(*)::int AS n FROM brands WHERE name = $1', [HOUSE]))[0].n).toBe(0)
  })
})
