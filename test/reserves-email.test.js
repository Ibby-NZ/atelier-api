// W24 — the letters a reserve docket sends to the HOUSES.
//
// The routing rules are the ones that matter and the ones a later story cannot
// re-derive: one letter per house per kind, only the lines THIS request raised,
// a free-text house that matches no supplier reaches nobody (and the office is
// told), and only `cancelled` writes to the house after the request.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'reserve-mail-test'
const DOMAIN = 'reserve-mail-test.example.com'
const PASSWORD = 'correct horse battery staple'
const BACKOFFICE = 'backoffice@reserve-mail-test.example.com'

const HOUSE = {
  lelievre: { name: `${PREFIX} Lelievre`, slug: `${PREFIX}-lelievre`, email: `lelievre@${DOMAIN}` },
  pierre: { name: `${PREFIX} Pierre Frey`, slug: `${PREFIX}-pierre`, email: `pierre@${DOMAIN}` },
}

const cookieOf = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const buildMailer = () => {
  const transport = { sent: [], sendMail: async (message) => void transport.sent.push(message) }
  return {
    transport,
    mailer: createMailer({
      transport,
      from: `Atelier <no-reply@${DOMAIN}>`,
      backofficeEmail: BACKOFFICE,
    }),
  }
}

const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM reserve_lines WHERE request_id IN
       (SELECT id FROM reserve_requests WHERE account_name LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM reserve_requests WHERE account_name LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}-%`])
}

describe('reserve and cutting notifications', () => {
  let pool
  let app
  let transport
  let staffCookie

  const inject = (method, url, payload) =>
    app.inject({ method, url, headers: { cookie: staffCookie }, payload })

  const to = (address) => transport.sent.filter((message) => message.to === address)

  const line = (overrides = {}) => ({
    kind: 'reserve',
    product_name: 'Bruges',
    range_name: 'Heritage',
    supplier: HOUSE.lelievre.name,
    colour: 'Ivory',
    qty: 12,
    reserved_until: '2026-12-01',
    ...overrides,
  })

  const createDocket = async (lines) => {
    const response = await inject('POST', '/admin/reserves', {
      account_name: `${PREFIX} Client`,
      lines,
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
    const built = buildMailer()
    transport = built.transport
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      mailer: built.mailer,
      logger: false,
    })
    await app.ready()

    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    const staff = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: `staff@${DOMAIN}`, password: PASSWORD, name: 'Reserves Desk' },
    })
    staffCookie = cookieOf(staff)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [`staff@${DOMAIN}`])
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    transport.sent.length = 0
    await cleanupFixtures(pool)
    for (const house of Object.values(HOUSE)) {
      await pool.query(
        `INSERT INTO suppliers (name, slug, country, currency, po_email)
         VALUES ($1, $2, 'France', 'EUR', $3)`,
        [house.name, house.slug, house.email]
      )
    }
  })

  it('asks the house to hold, and copies the office', async () => {
    await createDocket([line()])

    expect(to(HOUSE.lelievre.email)).toHaveLength(1)
    const letter = to(HOUSE.lelievre.email)[0]
    expect(letter.subject).toContain('Reserve request')
    expect(letter.text).toContain('Bruges')
    expect(letter.text).toContain('Colour: Ivory')
    expect(letter.text).toContain('Please hold until: 2026-12-01')
    // A reserve is not an order and a house that reads it as one will ship.
    expect(letter.text).toContain('do not ship')

    expect(to(BACKOFFICE)).toHaveLength(1)
    expect(to(BACKOFFICE)[0].text).toContain(HOUSE.lelievre.email)
  })

  // "Hold this" and "post us a cutting" are different asks. A house that gets
  // them merged answers one of them.
  it('splits reserve and cutting into separate letters for the same house', async () => {
    await createDocket([line(), line({ kind: 'cutting', multiplier: 10 })])

    expect(to(HOUSE.lelievre.email)).toHaveLength(2)
    const subjects = to(HOUSE.lelievre.email).map((message) => message.subject)
    expect(subjects.some((subject) => subject.includes('Reserve request'))).toBe(true)
    expect(subjects.some((subject) => subject.includes('Cutting request'))).toBe(true)

    const cutting = to(HOUSE.lelievre.email).find((message) =>
      message.subject.includes('Cutting')
    )
    expect(cutting.text).toContain('send us cuttings')
    expect(cutting.text).toContain('Copies: 10')
  })

  it('writes to each house once, never to the other house', async () => {
    await createDocket([
      line(),
      line({ product_name: 'Carrousel' }),
      line({ supplier: HOUSE.pierre.name, product_name: 'Anemones' }),
    ])

    expect(to(HOUSE.lelievre.email)).toHaveLength(1)
    expect(to(HOUSE.pierre.email)).toHaveLength(1)
    expect(to(HOUSE.lelievre.email)[0].text).toContain('Carrousel')
    expect(to(HOUSE.lelievre.email)[0].text).not.toContain('Anemones')
    expect(to(HOUSE.pierre.email)[0].text).not.toContain('Bruges')
  })

  // The house on a reserve line is typed, not picked. A near-match resolved by
  // guesswork addresses a commercial conversation to the wrong mill.
  it('emails nobody when the typed house matches no supplier, and tells the office', async () => {
    await createDocket([line({ supplier: 'Maison Nobody' })])

    expect(transport.sent.filter((message) => message.to !== BACKOFFICE)).toHaveLength(0)
    expect(to(BACKOFFICE)).toHaveLength(1)
    expect(to(BACKOFFICE)[0].text).toContain('NO SUPPLIER MATCH')
  })

  it('matches the house case-insensitively, but not fuzzily', async () => {
    await createDocket([line({ supplier: HOUSE.lelievre.name.toUpperCase() })])
    expect(to(HOUSE.lelievre.email)).toHaveLength(1)
  })

  // A docket that grows is a NEW ask. Re-asking for what the house already
  // holds is how a mill ends up holding the same cloth twice.
  it('asks only for the lines the request added', async () => {
    const docket = await createDocket([line()])
    transport.sent.length = 0

    const response = await inject('POST', `/admin/reserves/${docket.id}/lines`, {
      lines: [line({ product_name: 'Carrousel' })],
    })
    expect(response.statusCode).toBe(200)

    expect(to(HOUSE.lelievre.email)).toHaveLength(1)
    expect(to(HOUSE.lelievre.email)[0].text).toContain('Carrousel')
    expect(to(HOUSE.lelievre.email)[0].text).not.toContain('Bruges')
  })

  it('asks the house to release the cloth when a line is cancelled', async () => {
    const docket = await createDocket([line()])
    transport.sent.length = 0

    const response = await inject(
      'POST',
      `/admin/reserves/lines/${docket.lines[0].id}/transition`,
      { status: 'cancelled' }
    )
    expect(response.statusCode).toBe(200)

    expect(to(HOUSE.lelievre.email)).toHaveLength(1)
    expect(to(HOUSE.lelievre.email)[0].subject).toContain('release')
    expect(to(HOUSE.lelievre.email)[0].text).toContain('Bruges')
  })

  // confirmed is the house telling US; arrived is our warehouse; dispatched is
  // our courier. A letter for any of them tells the house what it already knows.
  it('writes to nobody on confirmed, arrived or dispatched', async () => {
    const docket = await createDocket([line()])
    const lineId = docket.lines[0].id
    transport.sent.length = 0

    for (const status of ['confirmed', 'arrived', 'dispatched']) {
      const response = await inject('POST', `/admin/reserves/lines/${lineId}/transition`, {
        status,
      })
      expect(response.statusCode).toBe(200)
    }
    expect(transport.sent).toHaveLength(0)
  })

  it('is a no-op without a mailer — the routes still work', async () => {
    const bare = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await bare.ready()
    try {
      const response = await bare.inject({
        method: 'POST',
        url: '/admin/reserves',
        headers: { cookie: staffCookie },
        payload: { account_name: `${PREFIX} Client`, lines: [line()] },
      })
      expect(response.statusCode).toBe(201)
      expect(transport.sent).toHaveLength(0)
    } finally {
      await bare.close()
    }
  })
})
