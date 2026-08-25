// /admin/reserves — dockets, lines, the state machine over HTTP, the supplier
// report and its CSV. Hits real Postgres like every suite here.
//
// Fixture rule: every docket this suite creates carries an account name
// starting with PREFIX, and cleanup deletes by that prefix (lines CASCADE).
// Users are registered ONCE in beforeAll — register shares a 10-per-15-min
// per-IP bucket, so a per-test registration 429s and yields no cookie.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { RESERVE_LINE_STATUSES } from '../src/reserves/reserve-line-states.js'
import { seedReserves, DEMO_TAG } from '../src/seed/seed-reserves.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'rsv-test'
const DOMAIN = 'rsv-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const account = (name) => `${PREFIX} ${name}`

const line = (over = {}) => ({
  kind: 'reserve',
  product_name: 'Marldon',
  range_name: 'COLEFAX & FOWLER',
  supplier: 'Colefax & Fowler',
  product_code: 'F3701',
  colour: 'Blue',
  qty: 11,
  ...over,
})

let pool
let app
let staffCookie
let customerCookie

const cleanupFixtures = async (db) => {
  await db.query(`DELETE FROM reserve_requests WHERE account_name LIKE $1`, [`${PREFIX}%`])
  await db.query(`DELETE FROM reserve_requests WHERE notes LIKE $1`, [`${DEMO_TAG}%`])
}

const post = (url, payload, cookie = staffCookie) =>
  app.inject({ method: 'POST', url, payload, headers: { cookie } })
const patch = (url, payload, cookie = staffCookie) =>
  app.inject({ method: 'PATCH', url, payload, headers: { cookie } })
const get = (url, cookie = staffCookie) => app.inject({ method: 'GET', url, headers: { cookie } })
const del = (url, cookie = staffCookie) =>
  app.inject({ method: 'DELETE', url, headers: { cookie } })

const createDocket = async (name, lines, extra = {}) => {
  const response = await post('/admin/reserves', {
    account_name: account(name),
    lines,
    ...extra,
  })
  expect(response.statusCode).toBe(201)
  return response.json().reserve
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

  await cleanupFixtures(pool)
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

  const staff = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: testEmail('staff'), password: PASSWORD, name: 'Reserve Clerk' },
  })
  staffCookie = cookieOf(staff)
  await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('staff')])

  const shopper = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email: testEmail('shopper'), password: PASSWORD },
  })
  customerCookie = cookieOf(shopper)
})

beforeEach(async () => {
  await cleanupFixtures(pool)
})

afterAll(async () => {
  await cleanupFixtures(pool)
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
  await app.close()
  await pool.end()
})

describe('the guard covers the whole surface', () => {
  // Payloads are schema-valid on purpose: Fastify validates before it runs a
  // preHandler, so a malformed body would assert a 400 and pass with the
  // guard deleted.
  const surface = [
    ['GET', '/admin/reserves'],
    ['GET', '/admin/reserves/1'],
    ['GET', '/admin/reserves/suppliers'],
    ['GET', '/admin/reserves/report?supplier=x'],
    ['GET', '/admin/reserves/report/export.csv?supplier=x'],
    ['POST', '/admin/reserves', { account_name: 'x', lines: [line()] }],
    ['PATCH', '/admin/reserves/1', { notes: 'x' }],
    ['POST', '/admin/reserves/1/lines', { lines: [line()] }],
    ['PATCH', '/admin/reserves/lines/1', { colour: 'x' }],
    ['POST', '/admin/reserves/lines/1/transition', { status: 'confirmed' }],
    ['DELETE', '/admin/reserves/1'],
    ['DELETE', '/admin/reserves/lines/1'],
  ]

  it.each(surface)('%s %s answers 401 anonymous and 403 customer', async (method, url, payload) => {
    const anonymous = await app.inject({ method, url, payload })
    expect(anonymous.statusCode).toBe(401)
    const customer = await app.inject({ method, url, payload, headers: { cookie: customerCookie } })
    expect(customer.statusCode).toBe(403)
  })
})

describe('the schema CHECK and the state module agree', () => {
  it('reserve_lines_status_check holds exactly the module vocabulary', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = 'reserve_lines_status_check'`
    )
    const def = rows[0]?.def ?? ''
    for (const status of RESERVE_LINE_STATUSES) {
      expect(def).toContain(`'${status}'`)
    }
    const quoted = def.match(/'[a-z_]+'/g) ?? []
    expect(new Set(quoted).size).toBe(RESERVE_LINE_STATUSES.length)
  })
})

describe('creating a docket', () => {
  it('creates account-first with lines, all defaults applied', async () => {
    const reserve = await createDocket('Harbour', [
      line(),
      line({ kind: 'cutting', product_name: 'Gillan Stripe', qty: null, multiplier: 10 }),
    ])
    expect(reserve.account_name).toBe(account('Harbour'))
    expect(reserve.owner_name).toBe('Reserve Clerk')
    expect(reserve.lines).toHaveLength(2)
    const [first, second] = reserve.lines
    expect(first.status).toBe('requested')
    expect(first.requested_at).toBeTruthy()
    expect(first.multiplier).toBe(1)
    expect(Number(first.qty)).toBe(11)
    expect(second.kind).toBe('cutting')
    expect(second.qty).toBeNull()
    expect(second.multiplier).toBe(10)
  })

  it('snapshots the account name off a platform user', async () => {
    const { rows } = await pool.query(`SELECT id, name FROM users WHERE email = $1`, [
      testEmail('shopper'),
    ])
    const response = await post('/admin/reserves', {
      user_id: rows[0].id,
      lines: [line()],
    })
    expect(response.statusCode).toBe(201)
    const reserve = response.json().reserve
    expect(reserve.user_id).toBe(rows[0].id)
    // The registered shopper has no name, so the snapshot falls back to email.
    expect(reserve.account_name).toBe(testEmail('shopper'))
    // Keep it out of the docket list the other tests count.
    await pool.query(`DELETE FROM reserve_requests WHERE id = $1`, [reserve.id])
  })

  it('422s a docket with no account at all', async () => {
    const response = await post('/admin/reserves', { lines: [line()] })
    expect(response.statusCode).toBe(422)
    expect(response.json().message).toContain('account')
  })

  it('400s an empty lines array and a zero quantity', async () => {
    const empty = await post('/admin/reserves', { account_name: account('x'), lines: [] })
    expect(empty.statusCode).toBe(400)
    const zeroQty = await post('/admin/reserves', {
      account_name: account('x'),
      lines: [line({ qty: 0 })],
    })
    expect(zeroQty.statusCode).toBe(400)
  })

  it('422s an unknown platform user', async () => {
    const response = await post('/admin/reserves', { user_id: 999999, lines: [line()] })
    expect(response.statusCode).toBe(422)
  })
})

describe('the docket list', () => {
  it('is docket-grain with lines embedded, filtered by line facts via EXISTS', async () => {
    await createDocket('Alpha', [line({ supplier: 'de Le Cuona', product_name: 'Limestone' })])
    await createDocket('Beta', [line({ kind: 'cutting', qty: null })])

    const all = await get('/admin/reserves')
    expect(all.statusCode).toBe(200)
    const mine = all.json().reserves.filter((r) => r.account_name.startsWith(PREFIX))
    expect(mine).toHaveLength(2)
    expect(mine[0].lines.length).toBeGreaterThan(0)

    const cuttings = await get('/admin/reserves?kind=cutting')
    const cuttingAccounts = cuttings
      .json()
      .reserves.filter((r) => r.account_name.startsWith(PREFIX))
      .map((r) => r.account_name)
    expect(cuttingAccounts).toEqual([account('Beta')])

    const bySupplier = await get(`/admin/reserves?supplier=${encodeURIComponent('de Le')}`)
    const supplierAccounts = bySupplier
      .json()
      .reserves.filter((r) => r.account_name.startsWith(PREFIX))
      .map((r) => r.account_name)
    expect(supplierAccounts).toEqual([account('Alpha')])

    const byTerm = await get('/admin/reserves?q=Limestone')
    const termAccounts = byTerm
      .json()
      .reserves.filter((r) => r.account_name.startsWith(PREFIX))
      .map((r) => r.account_name)
    expect(termAccounts).toEqual([account('Alpha')])
  })

  it('hides an all-terminal docket unless include_done, but keeps an empty one', async () => {
    const closed = await createDocket('Closed', [line()])
    await post(`/admin/reserves/lines/${closed.lines[0].id}/transition`, { status: 'cancelled' })

    const emptied = await createDocket('Emptied', [line()])
    await del(`/admin/reserves/lines/${emptied.lines[0].id}`)

    const working = await get('/admin/reserves')
    const workingAccounts = working
      .json()
      .reserves.filter((r) => r.account_name.startsWith(PREFIX))
      .map((r) => r.account_name)
    expect(workingAccounts).toContain(account('Emptied'))
    expect(workingAccounts).not.toContain(account('Closed'))

    const everything = await get('/admin/reserves?include_done=true')
    const allAccounts = everything
      .json()
      .reserves.filter((r) => r.account_name.startsWith(PREFIX))
      .map((r) => r.account_name)
    expect(allAccounts).toContain(account('Closed'))
  })

  it('404s an unknown docket and 400s a non-integer id', async () => {
    expect((await get('/admin/reserves/999999')).statusCode).toBe(404)
    expect((await get('/admin/reserves/nope')).statusCode).toBe(400)
  })
})

describe('editing', () => {
  it('PATCHes the header and the line, and refuses an empty patch', async () => {
    const docket = await createDocket('Edit', [line()])

    const header = await patch(`/admin/reserves/${docket.id}`, {
      contact_name: 'Mia Calder',
      notes: 'ring before dispatch',
    })
    expect(header.statusCode).toBe(200)
    expect(header.json().reserve.contact_name).toBe('Mia Calder')

    // The everyday edit: the house replied, type its reference onto the line.
    const lineEdit = await patch(`/admin/reserves/lines/${docket.lines[0].id}`, {
      reserve_number: '4823562',
      reserved_until: '2027-03-01',
      cfa: 'required',
    })
    expect(lineEdit.statusCode).toBe(200)
    const edited = lineEdit.json().reserve.lines[0]
    expect(edited.reserve_number).toBe('4823562')
    expect(edited.reserved_until).toBe('2027-03-01')
    expect(edited.cfa).toBe('required')
    expect(edited.status).toBe('requested')

    expect((await patch(`/admin/reserves/${docket.id}`, {})).statusCode).toBe(400)
    // `status` is not in the PATCH schema: Ajv strips it, minProperties 400s.
    expect(
      (await patch(`/admin/reserves/lines/${docket.lines[0].id}`, { status: 'arrived' }))
        .statusCode
    ).toBe(400)
  })

  it('adds lines after the fact, cutting-from-reserve link included', async () => {
    const docket = await createDocket('Grow', [line()])
    const sourceId = docket.lines[0].id
    const response = await post(`/admin/reserves/${docket.id}/lines`, {
      lines: [
        line({ kind: 'cutting', qty: null, multiplier: 5, source_line_id: sourceId }),
      ],
    })
    expect(response.statusCode).toBe(200)
    const added = response.json().reserve.lines.at(-1)
    expect(added.kind).toBe('cutting')
    expect(added.source_line_id).toBe(sourceId)
  })
})

describe('the state machine over HTTP', () => {
  it('moves a line and writes the stamp; an illegal move is a 409', async () => {
    const docket = await createDocket('Move', [line()])
    const id = docket.lines[0].id

    const confirmed = await post(`/admin/reserves/lines/${id}/transition`, {
      status: 'confirmed',
    })
    expect(confirmed.statusCode).toBe(200)
    const confirmedLine = confirmed.json().reserve.lines[0]
    expect(confirmedLine.status).toBe('confirmed')
    expect(confirmedLine.confirmed_at).toBeTruthy()

    const skip = await post(`/admin/reserves/lines/${id}/transition`, { status: 'dispatched' })
    expect(skip.statusCode).toBe(409)
    expect(skip.json().message).toContain('"confirmed"')

    const arrived = await post(`/admin/reserves/lines/${id}/transition`, {
      status: 'arrived',
      at: '2026-08-20T10:00:00Z',
    })
    expect(arrived.statusCode).toBe(200)
    expect(arrived.json().reserve.lines[0].arrived_at).toContain('2026-08-20')
  })

  it('derives `expired` server-side for open lines whose hold date passed', async () => {
    const docket = await createDocket('Expiry', [line(), line({ colour: 'Celadon' })])
    const [open, closed] = docket.lines
    await pool.query(
      `UPDATE reserve_lines SET reserved_until = CURRENT_DATE - 1, status = 'confirmed' WHERE id = $1`,
      [open.id]
    )
    await pool.query(
      `UPDATE reserve_lines SET reserved_until = CURRENT_DATE - 1, status = 'dispatched' WHERE id = $1`,
      [closed.id]
    )
    const response = await get(`/admin/reserves/${docket.id}`)
    const [first, second] = response.json().reserve.lines
    expect(first.expired).toBe(true)
    expect(second.expired).toBe(false)
  })
})

describe('deleting', () => {
  it('deletes a requested line, refuses a confirmed one with archivable:false', async () => {
    const docket = await createDocket('DelLine', [line(), line({ colour: 'Celadon' })])
    const [keep, remove] = docket.lines

    const ok = await del(`/admin/reserves/lines/${remove.id}`)
    expect(ok.statusCode).toBe(200)

    await post(`/admin/reserves/lines/${keep.id}/transition`, { status: 'confirmed' })
    const refused = await del(`/admin/reserves/lines/${keep.id}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().archivable).toBe(false)
    expect(refused.json().message).toContain('Cancel')
  })

  it('deletes an all-requested docket with its lines, refuses one a house is acting on', async () => {
    const gone = await createDocket('DelDocket', [line()])
    const okay = await del(`/admin/reserves/${gone.id}`)
    expect(okay.statusCode).toBe(200)
    const orphanLines = await pool.query(`SELECT 1 FROM reserve_lines WHERE request_id = $1`, [
      gone.id,
    ])
    expect(orphanLines.rowCount).toBe(0)

    const held = await createDocket('DelHeld', [line()])
    await post(`/admin/reserves/lines/${held.lines[0].id}/transition`, { status: 'confirmed' })
    const refused = await del(`/admin/reserves/${held.id}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().archivable).toBe(false)
  })
})

describe('the supplier report', () => {
  const seedReportFixtures = async () => {
    const docket = await createDocket('Report', [
      line({ supplier: 'Colefax & Fowler', reserve_number: '4823562' }),
      line({
        supplier: 'Colefax & Fowler',
        kind: 'cutting',
        product_name: '=SUM(A1)',
        qty: null,
        multiplier: 10,
        customer_reference: 'HV-2201',
      }),
      line({ supplier: 'de Le Cuona', product_name: 'Limestone' }),
    ])
    // One Colefax line is already here — it must drop out of the report.
    await post(`/admin/reserves/lines/${docket.lines[0].id}/transition`, { status: 'confirmed' })
    await post(`/admin/reserves/lines/${docket.lines[2].id}/transition`, { status: 'arrived' })
    return docket
  }

  it('lists the suppliers owed a chase with open-line counts', async () => {
    await seedReportFixtures()
    const response = await get('/admin/reserves/suppliers')
    expect(response.statusCode).toBe(200)
    const colefax = response.json().suppliers.find((s) => s.supplier === 'Colefax & Fowler')
    expect(colefax.open_lines).toBe(2)
    // de Le Cuona's only line arrived, so it is not owed anything.
    expect(response.json().suppliers.find((s) => s.supplier === 'de Le Cuona')).toBeUndefined()
  })

  it('reports one supplier, open statuses only, labels spelled out', async () => {
    await seedReportFixtures()
    const response = await get(
      `/admin/reserves/report?supplier=${encodeURIComponent('Colefax & Fowler')}`
    )
    expect(response.statusCode).toBe(200)
    const report = response.json().report
    expect(report.supplier).toBe('Colefax & Fowler')
    expect(report.total).toBe(2)
    expect(report.rows.map((r) => r.status).sort()).toEqual(['Confirmed', 'Requested'])
    expect(report.rows.map((r) => r.kind).sort()).toEqual(['Cutting', 'Reserve'])
    expect((await get('/admin/reserves/report')).statusCode).toBe(400)
  })

  it('serves the CSV with a disposition filename and neutralised formulas', async () => {
    await seedReportFixtures()
    const response = await get(
      `/admin/reserves/report/export.csv?supplier=${encodeURIComponent('Colefax & Fowler')}`
    )
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="atelier-reserves-colefax-fowler.csv"'
    )
    const body = response.body
    expect(body.startsWith('Type,Range,Customer')).toBe(true)
    // The design named like a formula is apostrophe-guarded, not executable.
    expect(body).toContain("'=SUM(A1)")
    expect(body).not.toContain(',=SUM(A1)')
    // A multiplier of 1 prints empty; the ×10 cutting prints its count.
    expect(body).toContain(',10,')
  })
})

describe('the demo seed', () => {
  it('inserts tagged dockets and replaces them on a re-run without touching others', async () => {
    const untouched = await createDocket('Untouched', [line()])

    const first = await seedReserves(pool)
    expect(first.dockets).toBeGreaterThan(0)
    const second = await seedReserves(pool)
    expect(second.removed).toBe(first.dockets)

    const still = await get(`/admin/reserves/${untouched.id}`)
    expect(still.statusCode).toBe(200)

    // The generated-cutting link survives the round trip.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS linked FROM reserve_lines WHERE source_line_id IS NOT NULL`
    )
    expect(rows[0].linked).toBeGreaterThan(0)
  })
})
