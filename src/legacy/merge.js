// The cutover merge: promote what Dynamics 365 held into the platform's own
// tables, in preparation for going live. `npm run merge:legacy` drives it.
//
// FOUR THINGS ARE MERGED, each where the mapping is deterministic:
//
//   accounts  → trade_accounts           every D365 client becomes a live
//                                         trade account with its details
//                                         (keyed on the D365 guid;
//                                         no login is linked — that stays manual,
//                                         see src/trade-accounts/CLAUDE.md)
//   contacts  → trade_account_contacts   every person, filed under their company
//                                         where the export's company NAME is one
//                                         client's, else unattached with the
//                                         name as text
//   reserves + cuttings → reserve dockets one live docket per customer per day,
//                                         D365 states mapped onto the platform's
//                                         (reserve-line-states.js says how)
//   stock items → catalogue + inventory   one colourway per D365 stock item
//                                         (through the colour-file importer, so
//                                         a code the supplier files already
//                                         landed refreshes in place), then the
//                                         D365 on-hand figure onto its stock row
//
// FOUR THINGS ARE NOT, and the reasons are structural rather than unfinished:
// sales orders / invoices and purchase orders / invoices export HEADER-ONLY (no
// lines, no export path for them), and `orders` is owned by the checkout and
// the order-desk state machine — a header with no lines is not an order there.
// They stay in the Archive, which is what /admin/dynamics/* serves. Suppliers
// and the pricing parameters were already promoted by `backfill:suppliers` and
// `backfill:pricing-parameters`.
//
// RE-RUNNABLE, BY DESIGN. The staging import refreshes until cutover, so this
// will be run more than once: accounts upsert on their guid (details follow
// D365; the account manager the office set is kept), contacts land ON CONFLICT
// DO NOTHING on theirs, reserve lines skip guids already landed, and the catalogue half
// is the colour importer's own idempotent upsert. Stock QUANTITY is the one
// column overwritten on every run — D365 is the stock authority until the day
// this is run for real, so the platform's figure follows it. `qty_reserved` is
// never touched: reservations raised on the platform are the platform's.
//
// Everything but the catalogue upsert runs in ONE transaction; the catalogue
// runs in the colour importer's own (it owns that write path) and is itself
// all-or-nothing.

import { importColourways } from '../seed/colourways-import.js'
import { slugify } from '../seed/slugify.js'
import { CFA_STATES } from '../reserves/reserve-line-states.js'
import { withChangeContext } from '../pricing/price-history.js'

// D365's CFA words, onto the platform's vocabulary (carried over unchanged in
// meaning — the houses still speak it). Anything else, including blank, is null.
const CFA_BY_D365 = Object.freeze({
  'not required': 'not_required',
  required: 'required',
  ordered: 'ordered',
  received: 'received',
  'approved by client': 'approved',
})
for (const value of Object.values(CFA_BY_D365)) {
  if (!CFA_STATES.includes(value)) throw new Error(`merge: CFA "${value}" is not a platform state`)
}

export const cfaFor = (text) => CFA_BY_D365[String(text ?? '').trim().toLowerCase()] ?? null

// D365 kept In Progress / Complete / Inactive; the platform splits those (see
// reserve-line-states.js). Complete is done and gone — dispatched. In Progress
// is confirmed once the house has answered with a reference, else requested.
export const statusFor = ({ status_reason, reserve_number }) => {
  if (String(status_reason ?? '').trim().toLowerCase() === 'complete') return 'dispatched'
  const number = String(reserve_number ?? '').trim().toLowerCase()
  return number && number !== 'tba' ? 'confirmed' : 'requested'
}

const blankToNull = (text) => {
  const value = typeof text === 'string' ? text.trim() : text
  return value === '' || value === undefined ? null : value
}

// ---------------------------------------------------------------------------

// Who is a client. NOT `is_customer`: that D365 checkbox is ticked on 321 of the
// 866 accounts while 515 accounts typed "Trade" have it clear — it was never
// maintained. An account is a client unless it is ONLY a supplier (21 rows are
// suppliers; 15 of those are also customers and keep both roles).
const CLIENT = "(COALESCE(a.is_customer, false) OR NOT COALESCE(a.is_supplier, false))"

// Every D365 client becomes a live trade account. The company DETAILS follow
// D365 on every run (it is the client authority until cutover); the account
// manager is fill-only because the office edits it in the CRM.
const mergeAccounts = async (client) => {
  const { rows: [{ created }] } = await client.query(
    `WITH landed AS (
       INSERT INTO trade_accounts
         (legacy_account_guid, legacy_customer_name, name_is_ambiguous, account_manager_name,
          account_number, customer_type, primary_contact_name, email, phone, address, city,
          country, payment_terms, xero_contact_id, archived_at)
       SELECT a.guid, BTRIM(a.name), COUNT(*) OVER (PARTITION BY BTRIM(a.name)) > 1,
              NULLIF(BTRIM(a.owner), ''),
              NULLIF(BTRIM(a.atelier_account_number), ''), NULLIF(BTRIM(a.customer_type), ''),
              NULLIF(BTRIM(a.primary_contact), ''),
              LOWER(NULLIF(BTRIM(COALESCE(NULLIF(a.email, ''), a.primary_contact_email)), '')),
              NULLIF(BTRIM(COALESCE(NULLIF(a.main_phone, ''), a.other_phone)), ''),
              NULLIF(BTRIM(a.address1_composite), ''), NULLIF(BTRIM(a.address1_city), ''),
              NULLIF(BTRIM(a.address1_country), ''), NULLIF(BTRIM(a.payment_terms), ''),
              NULLIF(BTRIM(a.xero_contact_id), ''),
              CASE WHEN a.status = 'Inactive' THEN COALESCE(a.modified_on, now()) END
         FROM legacy_accounts a
        WHERE ${CLIENT} AND NULLIF(BTRIM(a.name), '') IS NOT NULL
       ON CONFLICT (legacy_account_guid) DO UPDATE SET
         legacy_customer_name = EXCLUDED.legacy_customer_name,
         name_is_ambiguous = EXCLUDED.name_is_ambiguous,
         account_manager_name = COALESCE(trade_accounts.account_manager_name, EXCLUDED.account_manager_name),
         account_number = EXCLUDED.account_number,
         customer_type = EXCLUDED.customer_type,
         primary_contact_name = EXCLUDED.primary_contact_name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         address = EXCLUDED.address,
         city = EXCLUDED.city,
         country = EXCLUDED.country,
         payment_terms = EXCLUDED.payment_terms,
         xero_contact_id = EXCLUDED.xero_contact_id,
         archived_at = COALESCE(trade_accounts.archived_at, EXCLUDED.archived_at),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted
     )
     SELECT COUNT(*) FILTER (WHERE inserted)::int AS created FROM landed`
  )
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS skipped FROM legacy_accounts a
      WHERE ${CLIENT} AND NULLIF(BTRIM(a.name), '') IS NULL`
  )
  return { created, unnamed: rows[0].skipped }
}

// EVERY contact lands. The export names its company, not its company's guid,
// so a contact is filed under an account only where that name belongs to ONE
// client (865 of 866 do); the rest — no company, a supplier, a firm that never
// became a client, a shared name — land unattached with the company name D365
// gave them as text, for the office to file. Filing is the office's and is
// never undone by a re-run: an already-landed contact is left alone.
const mergeContacts = async (client) => {
  const { rowCount } = await client.query(
    `WITH named AS (
       SELECT BTRIM(name) AS name, MIN(guid::text)::uuid AS guid, COUNT(*) AS n
         FROM legacy_accounts a WHERE ${CLIENT} AND NULLIF(BTRIM(a.name), '') IS NOT NULL
        GROUP BY BTRIM(name)
     )
     INSERT INTO trade_account_contacts (trade_account_id, company_name, name, role, email, phone, note, legacy_guid)
     SELECT ta.id,
            CASE WHEN ta.id IS NULL THEN NULLIF(BTRIM(c.company_name), '') END,
            BTRIM(c.full_name), NULLIF(BTRIM(c.job_title), ''),
            LOWER(NULLIF(BTRIM(c.email), '')),
            COALESCE(NULLIF(BTRIM(c.mobile_phone), ''), NULLIF(BTRIM(c.business_phone), '')),
            NULLIF(BTRIM(c.description), ''),
            c.guid
       FROM legacy_contacts c
       LEFT JOIN named ON named.name = BTRIM(c.company_name) AND named.n = 1
       LEFT JOIN trade_accounts ta ON ta.legacy_account_guid = named.guid
      WHERE NULLIF(BTRIM(c.full_name), '') IS NOT NULL
     ON CONFLICT (legacy_guid) DO NOTHING`
  )
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE trade_account_id IS NOT NULL)::int AS filed,
       COUNT(*) FILTER (WHERE trade_account_id IS NULL AND company_name IS NULL)::int AS no_company,
       COUNT(*) FILTER (WHERE trade_account_id IS NULL AND company_name IS NOT NULL)::int AS unfiled
     FROM trade_account_contacts WHERE legacy_guid IS NOT NULL`
  )
  return { created: rowCount, ...rows[0] }
}

// ---------------------------------------------------------------------------

const RESERVE_SOURCES = Object.freeze([
  { table: 'legacy_reserves', kind: 'reserve' },
  { table: 'legacy_cuttings', kind: 'cutting' },
])

const loadPendingReserveRows = async (client) => {
  const rows = []
  for (const source of RESERVE_SOURCES) {
    const extra = source.kind === 'reserve'
      ? 'r.reserve_number, r.reserved_until, r.cfa,'
      : 'NULL::text AS reserve_number, NULL::timestamp AS reserved_until, NULL::text AS cfa,'
    const result = await client.query(
      `SELECT r.guid, r.name, r.range_name, r.customer, r.customer_contact, r.customer_owner,
              r.product, r.product_code, r.colour_code, r.supplier, r.quantity,
              ${extra}
              r.comments, r.order_stock_check_details, r.status_reason,
              r.created_on, r.modified_on
         FROM ${source.table} r
        WHERE NOT EXISTS (SELECT 1 FROM reserve_lines l WHERE l.legacy_guid = r.guid)
        ORDER BY r.created_on NULLS LAST, r.guid`
    )
    for (const row of result.rows) rows.push({ ...row, kind: source.kind })
  }
  return rows
}

// A docket per customer per day, with the same contact and owner: that is how
// the office keys them, and how D365's one-record-per-line reads back as one
// visit. The key is only used to group THIS run's rows; nothing stores it.
const docketKey = (row) => [
  blankToNull(row.customer) ?? '',
  blankToNull(row.customer_contact) ?? '',
  blankToNull(row.customer_owner) ?? '',
  row.created_on ? new Date(row.created_on).toISOString().slice(0, 10) : '',
].join('\u0000')

/** Pure: the plan for one batch of pending rows — which docket each line joins. */
export const planReserveDockets = (rows) => {
  const dockets = new Map()
  const declined = []
  for (const row of rows) {
    if (!blankToNull(row.customer) || !blankToNull(row.product)) {
      declined.push({ guid: row.guid, reason: !blankToNull(row.customer) ? 'no customer' : 'no product' })
      continue
    }
    const key = docketKey(row)
    if (!dockets.has(key)) {
      dockets.set(key, {
        account_name: row.customer.trim(),
        contact_name: blankToNull(row.customer_contact),
        owner_name: blankToNull(row.customer_owner),
        created_at: row.created_on ?? null,
        lines: [],
      })
    }
    const status = statusFor(row)
    dockets.get(key).lines.push({
      legacy_guid: row.guid,
      kind: row.kind,
      status,
      product_name: row.product.trim(),
      range_name: blankToNull(row.range_name),
      supplier: blankToNull(row.supplier),
      product_code: blankToNull(row.product_code),
      colour: blankToNull(row.colour_code),
      qty: row.quantity == null ? null : Number(row.quantity),
      customer_reference: blankToNull(row.name),
      reserve_number: blankToNull(row.reserve_number),
      reserved_until: row.reserved_until ?? null,
      cfa: cfaFor(row.cfa),
      comment: [blankToNull(row.comments), blankToNull(row.order_stock_check_details)]
        .filter(Boolean).join('\n') || null,
      requested_at: row.created_on ?? null,
      // Complete rows carry no per-step dates; the last touch is the best
      // reading of when the material went out.
      dispatched_at: status === 'dispatched' ? (row.modified_on ?? row.created_on ?? null) : null,
      confirmed_at: status === 'confirmed' ? (row.modified_on ?? row.created_on ?? null) : null,
    })
  }
  return { dockets: [...dockets.values()], declined }
}

const mergeReserves = async (client) => {
  const rows = await loadPendingReserveRows(client)
  const plan = planReserveDockets(rows)
  let lines = 0
  for (const docket of plan.dockets) {
    const { rows: [request] } = await client.query(
      `INSERT INTO reserve_requests (account_name, contact_name, owner_name, created_at, updated_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamp, now()), COALESCE($4::timestamp, now()))
       RETURNING id`,
      [docket.account_name, docket.contact_name, docket.owner_name, docket.created_at]
    )
    for (const line of docket.lines) {
      await client.query(
        `INSERT INTO reserve_lines
           (request_id, kind, status, product_name, range_name, supplier, product_code, colour,
            qty, multiplier, customer_reference, reserve_number, reserved_until, cfa, comment,
            requested_at, confirmed_at, dispatched_at, legacy_guid)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $12, $13, $14,
                 COALESCE($15::timestamp, now()), $16, $17, $18)
         ON CONFLICT (legacy_guid) DO NOTHING`,
        [
          request.id, line.kind, line.status, line.product_name, line.range_name, line.supplier,
          line.product_code, line.colour, line.qty, line.customer_reference, line.reserve_number,
          line.reserved_until, line.cfa, line.comment, line.requested_at, line.confirmed_at,
          line.dispatched_at, line.legacy_guid,
        ]
      )
      lines += 1
    }
  }
  return { dockets: plan.dockets.length, lines, declined: plan.declined }
}

// ---------------------------------------------------------------------------

// A D365 item as the colour importer's row. The design is the linked price
// row's description where the item has one (6,547 of 7,611); otherwise the
// item's own name stands in — a product per item, which the office can rename.
// The colour code is the item code before its year/supplier token
// (`F3518-003 23PF` → `F3518-003`), which for the houses whose colour files
// have landed is exactly the SKU those files produced.
export const stockItemAsColourwayRow = (item, index) => {
  const code = String(item.item_code ?? '').trim().split(/\s+/)[0] ?? ''
  const design = blankToNull(item.product_price_list) ?? blankToNull(item.name) ?? ''
  return {
    supplier: blankToNull(item.supplier) ?? blankToNull(item.range_name) ?? '',
    brand: blankToNull(item.range_name) ?? '',
    design,
    design_code: '',
    colour_code: code,
    colour_name: blankToNull(item.name) ?? code,
    source_file: 'legacy_stock_items',
    source_sheet: 'd365',
    source_row: index + 1,
  }
}

const loadStockItems = async (client) => {
  const { rows } = await client.query(
    `SELECT guid, item_code, name, supplier, range_name, product_price_list, item_type,
            stock_on_hand, trade_price, retail_price, currency
       FROM legacy_stock_items
      WHERE NULLIF(BTRIM(item_code), '') IS NOT NULL
      ORDER BY item_code`
  )
  return rows
}

// Houses the stock names and the catalogue does not hold. The colour importer
// REPORTS these and refuses to create them, and that rule stands by default —
// but at cutover the office's own stock lines (Solbiati, Libeco, the Interweave
// range) sit under exactly such names, so `createHouses` lets the merge raise
// them, plainly named after the D365 range, for the office to tidy in the CRM.
// Only houses that actually carry stock are raised; a zero-stock range that is
// not a house is a naming question, not a go-live one.
const raiseHouses = async (client, items) => {
  const { rows: brands } = await client.query('SELECT slug FROM brands')
  const known = new Set(brands.map((brand) => brand.slug))
  const wanted = new Map()
  for (const item of items) {
    const name = blankToNull(item.range_name)
    if (!name || Number(item.stock_on_hand) <= 0) continue
    const slug = slugify(name)
    if (slug && !known.has(slug) && !wanted.has(slug)) wanted.set(slug, name)
  }
  for (const [slug, name] of wanted) {
    await client.query(
      `INSERT INTO brands (name, slug, currency, is_international, trade_only)
       VALUES ($1, $2, 'NZD', true, true)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slug]
    )
  }
  return [...wanted.values()]
}

const cents = (value) => (value == null ? null : Math.round(Number(value) * 100))

// The on-hand figure onto the colourway's stock row, and a price onto a
// product that has none. Matching is by SKU, derived exactly as the importer
// derived it, through the catalogue's own brand row.
const landStock = async (pool, items) => {
  const { rows: brands } = await pool.query('SELECT id, name, slug FROM brands')
  const bySlug = new Map(brands.map((brand) => [brand.slug, brand]))
  const skus = []
  const qty = []
  const trade = []
  const retail = []
  let unmatchedHouse = 0
  for (const item of items) {
    const brand = bySlug.get(slugify(blankToNull(item.range_name) ?? ''))
    if (!brand) { unmatchedHouse += 1; continue }
    const row = stockItemAsColourwayRow(item, 0)
    const design = slugify(row.design)
    const colour = slugify(row.colour_code)
    if (!design || !colour) continue
    skus.push(`${brand.slug}-${design}-${colour}`.toUpperCase())
    qty.push(Number(item.stock_on_hand ?? 0))
    const nzd = String(item.currency ?? '').toLowerCase().includes('new zealand')
    trade.push(nzd ? cents(item.trade_price) : null)
    retail.push(nzd ? cents(item.retail_price) : null)
  }
  // The price fill fires the price-history capture trigger, which refuses a
  // change with no declared source (AT001) — the same context the seed sets.
  return withChangeContext(pool, { source: 'import', sourceFile: 'merge:legacy' }, async (client) => {
  const { rowCount: stocked } = await client.query(
    `UPDATE inventory i
        SET qty_available = s.qty
       FROM unnest($1::text[], $2::numeric[]) AS s(sku, qty)
       JOIN colourways c ON c.sku = s.sku
      WHERE i.colourway_id = c.id AND i.qty_available IS DISTINCT FROM s.qty`,
    [skus, qty]
  )
  // Fill-only: a price the office set in the CRM, or the seed's, is never
  // overwritten by D365's.
  const { rowCount: priced } = await client.query(
    `UPDATE products p
        SET trade_price_cents = COALESCE(p.trade_price_cents, s.trade),
            retail_price_cents = COALESCE(p.retail_price_cents, s.retail)
       FROM unnest($1::text[], $2::int[], $3::int[]) AS s(sku, trade, retail)
       JOIN colourways c ON c.sku = s.sku
      WHERE p.id = c.product_id
        AND ((p.trade_price_cents IS NULL AND s.trade IS NOT NULL)
          OR (p.retail_price_cents IS NULL AND s.retail IS NOT NULL))`,
    [skus, trade, retail]
  )
  return { matched: skus.length, stocked, priced, unmatchedHouse }
  })
}

// ---------------------------------------------------------------------------

/**
 * @param {import('pg').Pool} pool
 * @param {{ createHouses?: boolean }} [opts]
 */
export const mergeLegacy = async (pool, { createHouses = false } = {}) => {
  const client = await pool.connect()
  let summary
  try {
    await client.query('BEGIN')
    const accounts = await mergeAccounts(client)
    const contacts = await mergeContacts(client)
    const reserves = await mergeReserves(client)
    const items = await loadStockItems(client)
    const housesRaised = createHouses ? await raiseHouses(client, items) : []
    await client.query('COMMIT')
    summary = { accounts, contacts, reserves, housesRaised, items }
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* surface the original failure */ }
    throw error
  } finally {
    client.release()
  }

  // The catalogue half, through the importer that owns that write path (its
  // own transaction, all-or-nothing), then the quantities in one more.
  // An item naming no range at all (89 in the corpus) cannot be filed under a
  // house and is counted rather than handed to the importer, which would
  // refuse the whole batch as malformed.
  const filed = summary.items.filter((item) => blankToNull(item.range_name) !== null)
  const catalogue = await importColourways(pool, filed.map(stockItemAsColourwayRow))
  const stock = await landStock(pool, filed)

  return Object.freeze({
    accounts: summary.accounts,
    contacts: summary.contacts,
    reserves: summary.reserves,
    housesRaised: summary.housesRaised,
    catalogue: {
      items: summary.items.length,
      noHouse: summary.items.length - filed.length,
      products: catalogue.products,
      colourways: catalogue.colourways,
      inventoryCreated: catalogue.inventoryCreated,
      unknownBrands: catalogue.unknownBrands,
      skips: catalogue.skips,
      conflicts: catalogue.conflicts.length,
    },
    stock,
  })
}
