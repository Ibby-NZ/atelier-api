// Demo reserves & cuttings — `npm run seed:reserves`.
//
// Dummy dockets for the office to test the new reserves/cuttings screens
// against (the CRM prototype replacing the D365 fulmar_reserve form). The
// shapes echo the real "In Progress Reserves" book — a big one-account docket
// whose lines share one supplier reference, "TBA" reserve numbers, an expired
// hold date to chase, ×10/×20 cutting multipliers, a cutting generated from a
// reserve — but every ACCOUNT and CONTACT name is invented. The real report is
// client PII and none of it may be committed or seeded.
//
// Idempotent by tag, not by upsert: every seeded docket's notes start with
// DEMO_TAG, and a re-run deletes those dockets (lines CASCADE) before
// inserting fresh. Office-typed dockets carry no tag and are never touched.
//
// Statuses and stamps are written directly rather than through the state
// machine — a seed is allowed to fabricate history, and it writes the stamp
// beside every status so the rows stay self-consistent.

import { pathToFileURL } from 'node:url'
import { loadConfig } from '../config.js'
import { createPool } from '../db.js'

export const DEMO_TAG = '[demo]'

const daysFrom = (days) => {
  const date = new Date(Date.now() + days * 86400000)
  return date.toISOString().slice(0, 10)
}

const stampFrom = (days) => new Date(Date.now() + days * 86400000).toISOString()

// One entry = one docket. Lines may carry `status` plus the matching stamp
// offsets (in days, negative = past); everything else mirrors the API's
// create shape. Suppliers and designs are real trade names (public catalogue
// facts); accounts, contacts and references are invented.
const DEMO_DOCKETS = [
  {
    account_name: 'Harbourview Interiors',
    contact_name: 'Mia Calder',
    owner_name: 'Jette Canlapan',
    notes: `${DEMO_TAG} New collection launch — client shortlisting for a lodge refit.`,
    lines: [
      {
        kind: 'reserve',
        product_name: 'Marldon',
        range_name: 'COLEFAX & FOWLER',
        supplier: 'Colefax & Fowler',
        product_code: 'F3701',
        colour: 'Blue',
        qty: 11,
        customer_reference: 'HV-2201',
        reserve_number: 'TBA',
        status: 'requested',
      },
      {
        kind: 'reserve',
        product_name: 'Stratford',
        range_name: 'COLEFAX & FOWLER',
        supplier: 'Colefax & Fowler',
        product_code: 'F3831',
        colour: 'Navy',
        qty: 10,
        customer_reference: 'HV-2201',
        reserve_number: '4823562',
        reserved_until: 14,
        cfa: 'not_required',
        status: 'confirmed',
        confirmed_at: -2,
      },
      {
        kind: 'cutting',
        product_name: 'Gillan Stripe',
        range_name: 'COLEFAX & FOWLER',
        supplier: 'Colefax & Fowler',
        product_code: 'F4772',
        colour: 'Red/Green',
        multiplier: 10,
        customer_reference: 'HV-2201',
        comment: 'Returnable memos for the client presentation.',
        status: 'requested',
      },
    ],
  },
  {
    // The Cheshire-shaped docket: one account, one house, many colours, one
    // shared supplier reference — the case the account-first form exists for.
    account_name: 'Fern & Field Design',
    contact_name: 'Lauren Brady',
    owner_name: 'Charlotte Savill',
    notes: `${DEMO_TAG} Full scheme sampling across de Le Cuona.`,
    lines: [
      { kind: 'reserve', product_name: 'Limestone', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'LIM', colour: 'Plaster', qty: 1.3, reserve_number: '224326', status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Tatami', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'TAT', colour: 'Rice', qty: 1, reserve_number: '224326', status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Merchant', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'MERC', colour: 'Salt', qty: 12.5, reserve_number: '224326', reserved_until: 11, status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Merchant', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'MERC', colour: 'Sumac', qty: 1, reserve_number: '224326', status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Chukka', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'CHU', colour: 'Iguana', qty: 3, reserve_number: '224326', status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Chukka', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'CHU', colour: 'Tortoise', qty: 1, reserve_number: '224326', status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Haiku', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'HAIK', colour: 'Paper', qty: 12.5, reserve_number: '224326', reserved_until: 11, status: 'confirmed', confirmed_at: -5 },
      { kind: 'reserve', product_name: 'Shore', range_name: 'DE LE CUONA', supplier: 'de Le Cuona', product_code: 'SHO', colour: 'Sand', qty: 1.3, reserve_number: '224326', status: 'confirmed', confirmed_at: -5 },
    ],
  },
  {
    account_name: 'Te Awa Living',
    contact_name: 'Sam Hoyle',
    owner_name: 'Jette Canlapan',
    notes: `${DEMO_TAG} Hold date already passed — chase the house.`,
    lines: [
      {
        kind: 'reserve',
        product_name: 'Cheyenne',
        range_name: 'PIERRE FREY',
        supplier: 'Pierre Frey Paris',
        product_code: 'F3222',
        colour: 'Souris',
        qty: 20,
        customer_reference: 'TA-118',
        reserve_number: 'SOFR111245',
        reserved_until: -3,
        cfa: 'required',
        comment: 'Client confirming metreage this week.',
        status: 'confirmed',
        confirmed_at: -12,
      },
      {
        kind: 'reserve',
        product_name: 'Dingle',
        range_name: 'LORO PIANA',
        supplier: 'Loro Piana',
        product_code: 'AL2009',
        colour: 'Spago',
        qty: 10,
        reserve_number: 'TBA',
        cfa: 'not_required',
        status: 'requested',
      },
    ],
  },
  {
    account_name: 'Marlow & Finch',
    contact_name: 'Priya Nathan',
    owner_name: 'Charlotte Savill',
    notes: `${DEMO_TAG} Cuttings arrived and dispatched — the visibility case.`,
    lines: [
      {
        kind: 'cutting',
        product_name: 'Wool Mohair',
        range_name: 'S HARRIS',
        supplier: 'Fabricut Inc',
        product_code: '97810',
        colour: 'Brown 97810-05',
        multiplier: 20,
        customer_reference: 'MF-77',
        comment: 'Whole colour bank for the studio library.',
        status: 'arrived',
        confirmed_at: -9,
        arrived_at: -2,
      },
      {
        kind: 'cutting',
        product_name: 'Eden Stitch',
        range_name: 'LIBERTY',
        supplier: 'Liberty London',
        product_code: '08912401',
        colour: 'Lichen',
        customer_reference: 'MF-74',
        status: 'dispatched',
        confirmed_at: -15,
        arrived_at: -6,
        dispatched_at: -1,
      },
      {
        kind: 'reserve',
        product_name: 'Plaza',
        range_name: 'C & C MILANO',
        supplier: 'C & C Milano',
        product_code: '216691',
        colour: 'Beige',
        qty: 30,
        reserve_number: 'TBA',
        status: 'cancelled',
        cancelled_at: -4,
        comment: 'Client went with the Larsen instead.',
      },
    ],
  },
  {
    // A cutting generated from a reserve — linked after insert (see below).
    account_name: 'Southern Light Studio',
    contact_name: 'Nell Harding',
    owner_name: 'Jette Canlapan',
    notes: `${DEMO_TAG} Reserve first, cutting generated from it.`,
    lines: [
      {
        kind: 'reserve',
        product_name: 'Komba',
        range_name: 'LARSEN',
        supplier: 'Colefax & Fowler',
        product_code: 'L9549',
        colour: 'Clay',
        qty: 15,
        customer_reference: 'SLS-9',
        reserve_number: '4833001A',
        reserved_until: 8,
        cfa: 'ordered',
        status: 'confirmed',
        confirmed_at: -3,
        linkKey: 'komba-reserve',
      },
      {
        kind: 'cutting',
        product_name: 'Komba',
        range_name: 'LARSEN',
        supplier: 'Colefax & Fowler',
        product_code: 'L9549',
        colour: 'Clay',
        customer_reference: 'SLS-9',
        sourceKey: 'komba-reserve',
        status: 'requested',
      },
    ],
  },
]

/**
 * Replace the demo dockets: delete everything tagged, insert the fixture set.
 * Returns { removed, dockets, lines } for the summary line.
 *
 * @param {import('pg').Pool} pool
 */
export const seedReserves = async (pool) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const removed = await client.query(`DELETE FROM reserve_requests WHERE notes LIKE $1`, [
      `${DEMO_TAG}%`,
    ])

    let lineCount = 0
    for (const docket of DEMO_DOCKETS) {
      const { rows } = await client.query(
        `INSERT INTO reserve_requests (account_name, contact_name, owner_name, notes)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [docket.account_name, docket.contact_name, docket.owner_name, docket.notes]
      )
      const requestId = rows[0].id
      const idsByKey = new Map()

      for (const line of docket.lines) {
        const inserted = await client.query(
          `INSERT INTO reserve_lines
             (request_id, kind, status, product_name, range_name, supplier,
              product_code, colour, qty, multiplier, customer_reference,
              reserve_number, reserved_until, cfa, comment, source_line_id,
              confirmed_at, arrived_at, dispatched_at, cancelled_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                   $15, $16, $17, $18, $19, $20)
           RETURNING id`,
          [
            requestId,
            line.kind,
            line.status ?? 'requested',
            line.product_name,
            line.range_name ?? null,
            line.supplier ?? null,
            line.product_code ?? null,
            line.colour ?? null,
            line.qty ?? null,
            line.multiplier ?? 1,
            line.customer_reference ?? null,
            line.reserve_number ?? null,
            line.reserved_until != null ? daysFrom(line.reserved_until) : null,
            line.cfa ?? null,
            line.comment ?? null,
            line.sourceKey ? idsByKey.get(line.sourceKey) ?? null : null,
            line.confirmed_at != null ? stampFrom(line.confirmed_at) : null,
            line.arrived_at != null ? stampFrom(line.arrived_at) : null,
            line.dispatched_at != null ? stampFrom(line.dispatched_at) : null,
            line.cancelled_at != null ? stampFrom(line.cancelled_at) : null,
          ]
        )
        if (line.linkKey) idsByKey.set(line.linkKey, inserted.rows[0].id)
        lineCount += 1
      }
    }

    await client.query('COMMIT')
    return { removed: removed.rowCount, dockets: DEMO_DOCKETS.length, lines: lineCount }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

const main = async () => {
  const config = loadConfig()
  const pool = createPool(config.databaseUrl)
  try {
    const { removed, dockets, lines } = await seedReserves(pool)
    console.log(
      `Reserves demo seed complete — removed ${removed} old demo docket(s), ` +
        `inserted ${dockets} docket(s) / ${lines} line(s).`
    )
    console.log('Office-typed dockets (no [demo] tag) were not touched.')
  } catch (error) {
    console.error(`atelier-api reserves seed failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

// Run when invoked directly, not when imported by tests. `file://${argv[1]}`
// is the wrong spelling: import.meta.url is percent-encoded and argv[1] is
// not, so one space in the checkout path makes it false.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
