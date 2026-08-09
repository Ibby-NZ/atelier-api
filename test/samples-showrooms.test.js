// Showroom address book — routes and read/write module (W4-US-008).
//
// `showrooms` had a table from W4-US-001 and nothing else: no routes, no registry
// entry. The CRM's `AdminShowrooms` screen is US-008's deliverable and had
// nothing to call, and so did the register's showroom filter and the sample
// form's showroom picker. This file covers what that gap needed.
//
// Two things here are not ceremony:
//   - **The DELETE probes.** `sample_orders.showroom_id` is NOT NULL + RESTRICT,
//     so the database refuses that half loudly. `samples.showroom_id` is SET
//     NULL, so without its probe a delete would report 200 while silently
//     un-homing every sample that stood in the showroom. The test asserts the
//     samples are untouched after a refusal, because that failure mode is
//     invisible — the same shape `test/admin-catalogue.test.js` uses for a
//     collection's SET NULL children.
//   - **The by-id counts agree with the blockers, in both directions.** The CRUD
//     kit forbids a pre-flight "can I delete this" GET, so the detail read is the
//     only advance warning a screen has; a count that disagreed with the 409
//     would be worse than none.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  SHOWROOM_UPDATE_COLUMNS,
  listShowrooms,
  getShowroom,
  createShowroom as createShowroomDirect,
  updateShowroom as updateShowroomDirect,
  setShowroomArchived as setShowroomArchivedDirect,
  MAX_LIMIT,
} from '../src/samples/showrooms.js'
import { LIFECYCLE_ENTITIES } from '../src/lifecycle/registry.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
// Anchored with no separator, so the pattern matches every name this suite
// WRITES and not only the ones it inserts — a rename that dropped the separator
// would otherwise leak a row and 23505 the unique name on the next run.
const PREFIX = 'w4-showrooms-test'
const DOMAIN = 'w4-showrooms-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Orders and samples first — `sample_orders.showroom_id` is RESTRICT and
// `samples.colourway_id` is RESTRICT, so a showroom delete or a brand cascade
// would 23503 inside the cleanup itself.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM sample_orders
      WHERE showroom_id IN (SELECT id FROM showrooms WHERE name LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query(
    `DELETE FROM sample_loans WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM samples WHERE barcode LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM showrooms WHERE name LIKE $1', [`${PREFIX}%`])
}

describe('showrooms', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const create = (name, body = {}) =>
    inject('POST', '/admin/showrooms', backofficeCookie, { name, ...body })

  // A sample hanging off a showroom, inserted directly: this suite is about
  // showrooms, and going through /admin/samples would couple it to that surface.
  const insertSample = (showroomId, barcode) =>
    pool
      .query(
        'INSERT INTO samples (barcode, showroom_id) VALUES ($1, $2) RETURNING id',
        [barcode, showroomId]
      )
      .then(({ rows }) => rows[0].id)

  const insertSampleOrder = (showroomId, label) =>
    pool
      .query(
        'INSERT INTO sample_orders (showroom_id, label) VALUES ($1, $2) RETURNING id',
        [showroomId, `${PREFIX} ${label}`]
      )
      .then(({ rows }) => rows[0].id)

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

    // Register the two users ONCE — register shares a 10/15min/IP rate-limit
    // bucket, so re-registering per test would 429 and yield no cookie.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const customer = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD, name: 'Shopper' },
    })
    customerCookie = sessionCookieFrom(customer)
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
  })

  describe('the route is reachable at all', () => {
    it('is registered on the real app, not merely written', async () => {
      // There is no plugin auto-loader in this repo: a route module buildApp
      // never registers 404s every path in it. This asserts the registration
      // itself, ahead of anything about behaviour.
      const response = await inject('GET', '/admin/showrooms', backofficeCookie)
      expect(response.statusCode).toBe(200)
    })
  })

  describe('authorisation', () => {
    // Every payload here is VALID: Fastify validates before it runs a
    // preHandler, so a malformed body would 400 and the guard assertion would
    // pass without the guard existing.
    const surface = [
      ['GET', '/admin/showrooms', undefined],
      ['GET', '/admin/showrooms/1', undefined],
      ['POST', '/admin/showrooms', { name: `${PREFIX} guard` }],
      ['PATCH', '/admin/showrooms/1', { city: 'Auckland' }],
      ['POST', '/admin/showrooms/1/archive', undefined],
      ['POST', '/admin/showrooms/1/restore', undefined],
      ['DELETE', '/admin/showrooms/1', undefined],
    ]

    it.each(surface)('%s %s is 401 for an anonymous caller', async (method, url, payload) => {
      const response = await inject(method, url, undefined, payload)
      expect(response.statusCode).toBe(401)
    })

    it.each(surface)('%s %s is 403 for a signed-in customer', async (method, url, payload) => {
      const response = await inject(method, url, customerCookie, payload)
      expect(response.statusCode).toBe(403)
    })
  })

  describe('POST /admin/showrooms', () => {
    it('opens a showroom and answers 201 with the whole row', async () => {
      const response = await create(`${PREFIX} Newmarket`, {
        address: '12 Broadway',
        city: 'Auckland',
        contact_name: 'Liz',
        contact_email: 'liz@example.com',
        contact_phone: '09 555 0000',
        notes: 'Upstairs, past the lift.',
      })

      expect(response.statusCode).toBe(201)
      const { showroom } = response.json()
      expect(showroom).toMatchObject({
        name: `${PREFIX} Newmarket`,
        address: '12 Broadway',
        city: 'Auckland',
        contact_name: 'Liz',
        contact_email: 'liz@example.com',
        contact_phone: '09 555 0000',
        notes: 'Upstairs, past the lift.',
        archived_at: null,
      })
      // Every write returns through getShowroom, so a create hands the CRM the
      // same shape a read does — counts included.
      expect(showroom.sample_count).toBe(0)
      expect(showroom.sample_order_count).toBe(0)
    })

    it('needs a name', async () => {
      const response = await inject('POST', '/admin/showrooms', backofficeCookie, {
        city: 'Auckland',
      })
      expect(response.statusCode).toBe(400)
    })

    it('answers 409 on a duplicate name, detected by the database', async () => {
      await create(`${PREFIX} Ponsonby`)
      const response = await create(`${PREFIX} Ponsonby`, { city: 'Auckland' })

      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/already exists/i)
    })

    it('lets the database, not a pre-check, decide two concurrent creates', async () => {
      // A read-then-insert pre-check reads a row the other transaction is about
      // to write. Fired together, exactly one may win.
      const [first, second] = await Promise.all([
        create(`${PREFIX} Race`),
        create(`${PREFIX} Race`),
      ])
      expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409])

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM showrooms WHERE name = $1', [
        `${PREFIX} Race`,
      ])
      expect(rows[0].n).toBe(1)
    })
  })

  describe('GET /admin/showrooms', () => {
    it('orders by name and pages with a meta envelope', async () => {
      await create(`${PREFIX} Wellington`)
      await create(`${PREFIX} Auckland`)
      await create(`${PREFIX} Christchurch`)

      const response = await inject(
        'GET',
        `/admin/showrooms?q=${encodeURIComponent(PREFIX)}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.showrooms.map((s) => s.name)).toEqual([
        `${PREFIX} Auckland`,
        `${PREFIX} Christchurch`,
        `${PREFIX} Wellington`,
      ])
      expect(body.meta.total).toBe(3)
      expect(body.meta.page).toBe(1)
    })

    it('searches the name, the city and the contact — not the notes', async () => {
      await create(`${PREFIX} Alpha`, { city: 'Dunedin', contact_name: 'Marguerite' })
      await create(`${PREFIX} Beta`, { notes: 'Marguerite used to run this one' })

      const byCity = await inject('GET', '/admin/showrooms?q=Dunedin', backofficeCookie)
      expect(byCity.json().showrooms.map((s) => s.name)).toEqual([`${PREFIX} Alpha`])

      // The contact matches Alpha only: Beta merely mentions the name in its
      // running commentary, and a list of showrooms answering with one whose own
      // fields match nothing typed is the search being wrong, not generous.
      const byContact = await inject('GET', '/admin/showrooms?q=Marguerite', backofficeCookie)
      expect(byContact.json().showrooms.map((s) => s.name)).toEqual([`${PREFIX} Alpha`])
    })

    it('hides archived rows until include_archived asks for them', async () => {
      const live = await create(`${PREFIX} Live`)
      const gone = await create(`${PREFIX} Closed`)
      await inject(
        'POST',
        `/admin/showrooms/${gone.json().showroom.id}/archive`,
        backofficeCookie
      )

      const listed = await inject(
        'GET',
        `/admin/showrooms?q=${encodeURIComponent(PREFIX)}`,
        backofficeCookie
      )
      expect(listed.json().showrooms.map((s) => s.id)).toEqual([live.json().showroom.id])

      const all = await inject(
        'GET',
        `/admin/showrooms?q=${encodeURIComponent(PREFIX)}&include_archived=true`,
        backofficeCookie
      )
      expect(all.json().showrooms).toHaveLength(2)
    })

    it('answers 400 rather than clamping an over-large limit', async () => {
      // A silent clamp reports a page size the caller did not ask for. The
      // module still clamps, because it is also called directly.
      const response = await inject(
        'GET',
        `/admin/showrooms?limit=${MAX_LIMIT + 1}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(400)

      const direct = await listShowrooms(pool, { limit: MAX_LIMIT + 1 })
      expect(direct.showrooms.length).toBeLessThanOrEqual(MAX_LIMIT)
    })

    it('escapes a LIKE wildcard in the search term', async () => {
      await create(`${PREFIX} 100% Wool Room`)
      await create(`${PREFIX} Plain Room`)

      const response = await inject(
        'GET',
        `/admin/showrooms?q=${encodeURIComponent('100%')}`,
        backofficeCookie
      )
      expect(response.json().showrooms.map((s) => s.name)).toEqual([`${PREFIX} 100% Wool Room`])
    })
  })

  describe('GET /admin/showrooms/:id', () => {
    it('carries the counts of what points at it, archived rows included', async () => {
      const showroom = (await create(`${PREFIX} Counted`)).json().showroom
      await insertSample(showroom.id, `${PREFIX}-0001`)
      const archivedSample = await insertSample(showroom.id, `${PREFIX}-0002`)
      await pool.query('UPDATE samples SET archived_at = now() WHERE id = $1', [archivedSample])
      await insertSampleOrder(showroom.id, 'hanger')

      const response = await inject('GET', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      // An archived sample still blocks the delete, so it must still be counted
      // here — a count that filtered archived_at would promise a delete the 409
      // then refuses.
      expect(response.json().showroom.sample_count).toBe(2)
      expect(response.json().showroom.sample_order_count).toBe(1)
    })

    it('answers 404 for an unknown id', async () => {
      const response = await inject('GET', '/admin/showrooms/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    it('still reads an archived showroom back', async () => {
      // The by-id rule for every admin read here: the restore screen has to be
      // able to re-read the archive it just made.
      const showroom = (await create(`${PREFIX} Archived`)).json().showroom
      await inject('POST', `/admin/showrooms/${showroom.id}/archive`, backofficeCookie)

      const response = await inject('GET', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().showroom.archived_at).not.toBeNull()
    })
  })

  describe('PATCH /admin/showrooms/:id', () => {
    it('renames and clears a nullable column', async () => {
      const showroom = (await create(`${PREFIX} Old Name`, { city: 'Hamilton' })).json().showroom

      const response = await inject(
        'PATCH',
        `/admin/showrooms/${showroom.id}`,
        backofficeCookie,
        { name: `${PREFIX} New Name`, city: null }
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().showroom).toMatchObject({
        name: `${PREFIX} New Name`,
        city: null,
      })
    })

    it('answers 400 on an empty body and on a cleared name', async () => {
      const showroom = (await create(`${PREFIX} Patchable`)).json().showroom

      const empty = await inject('PATCH', `/admin/showrooms/${showroom.id}`, backofficeCookie, {})
      expect(empty.statusCode).toBe(400)

      // `name` is NOT NULL, so an explicit null is refused at the schema rather
      // than reaching the column as a 23502.
      const cleared = await inject(
        'PATCH',
        `/admin/showrooms/${showroom.id}`,
        backofficeCookie,
        { name: null }
      )
      expect(cleared.statusCode).toBe(400)
    })

    it('answers 409 on a rename into an existing name, and 404 for an unknown id', async () => {
      await create(`${PREFIX} Taken`)
      const other = (await create(`${PREFIX} Free`)).json().showroom

      const clash = await inject('PATCH', `/admin/showrooms/${other.id}`, backofficeCookie, {
        name: `${PREFIX} Taken`,
      })
      expect(clash.statusCode).toBe(409)

      const missing = await inject('PATCH', '/admin/showrooms/99999999', backofficeCookie, {
        city: 'Nelson',
      })
      expect(missing.statusCode).toBe(404)
    })

    it('writes only the whitelisted columns', async () => {
      // Ajv's removeAdditional strips an unknown key rather than 400ing it, so
      // the whitelist is the real defence — same rule as every other PATCH here.
      expect(SHOWROOM_UPDATE_COLUMNS).not.toContain('id')
      expect(SHOWROOM_UPDATE_COLUMNS).not.toContain('archived_at')
      expect(SHOWROOM_UPDATE_COLUMNS).not.toContain('created_at')
    })
  })

  describe('archive and restore', () => {
    it('round-trips and answers 404 for an unknown id', async () => {
      const showroom = (await create(`${PREFIX} Seasonal`)).json().showroom

      const archived = await inject(
        'POST',
        `/admin/showrooms/${showroom.id}/archive`,
        backofficeCookie
      )
      expect(archived.statusCode).toBe(200)
      expect(archived.json().showroom.archived_at).not.toBeNull()

      const restored = await inject(
        'POST',
        `/admin/showrooms/${showroom.id}/restore`,
        backofficeCookie
      )
      expect(restored.statusCode).toBe(200)
      expect(restored.json().showroom.archived_at).toBeNull()

      const missing = await inject('POST', '/admin/showrooms/99999999/archive', backofficeCookie)
      expect(missing.statusCode).toBe(404)
    })

    it('leaves the samples standing in it alone', async () => {
      const showroom = (await create(`${PREFIX} Still Here`)).json().showroom
      const sample = await insertSample(showroom.id, `${PREFIX}-0100`)

      await inject('POST', `/admin/showrooms/${showroom.id}/archive`, backofficeCookie)

      const { rows } = await pool.query('SELECT showroom_id FROM samples WHERE id = $1', [sample])
      expect(rows[0].showroom_id).toBe(showroom.id)
    })
  })

  describe('DELETE /admin/showrooms/:id', () => {
    it('removes an empty showroom', async () => {
      const showroom = (await create(`${PREFIX} Empty`)).json().showroom

      const response = await inject('DELETE', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().deleted).toMatchObject({ entity: 'showroom', id: showroom.id })

      const { rows } = await pool.query('SELECT id FROM showrooms WHERE id = $1', [showroom.id])
      expect(rows).toHaveLength(0)
    })

    it('is blocked by the samples standing in it, and does not un-home one', async () => {
      const showroom = (await create(`${PREFIX} Stocked`)).json().showroom
      const sample = await insertSample(showroom.id, `${PREFIX}-0200`)

      const response = await inject('DELETE', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      const body = response.json()
      expect(body.blockers).toEqual([
        expect.objectContaining({ relation: 'samples', label: 'samples', count: 1 }),
      ])
      // `samples.showroom_id` is SET NULL: without the probe the delete would
      // have answered 200 and silently un-homed this row. That is the assertion
      // the status code alone cannot make.
      const { rows } = await pool.query('SELECT showroom_id FROM samples WHERE id = $1', [sample])
      expect(rows[0].showroom_id).toBe(showroom.id)
      expect(body.archivable).toBe(true)
    })

    it('is blocked by a sample order addressed to it', async () => {
      const showroom = (await create(`${PREFIX} Ordering`)).json().showroom
      await insertSampleOrder(showroom.id, 'wallpaper')

      const response = await inject('DELETE', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers).toEqual([
        expect.objectContaining({ relation: 'sample_orders', label: 'sample orders', count: 1 }),
      ])
    })

    it('names both relations in one refusal', async () => {
      const showroom = (await create(`${PREFIX} Both`)).json().showroom
      await insertSample(showroom.id, `${PREFIX}-0300`)
      await insertSampleOrder(showroom.id, 'book')

      const response = await inject('DELETE', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      const relations = response.json().blockers.map((b) => b.relation).sort()
      // The probes run as ONE UNION ALL, so reporting only the first would send
      // staff round the loop once per relation.
      expect(relations).toEqual(['sample_orders', 'samples'])
    })

    it('is blocked by an ARCHIVED sample too', async () => {
      const showroom = (await create(`${PREFIX} Archived Child`)).json().showroom
      const sample = await insertSample(showroom.id, `${PREFIX}-0400`)
      await pool.query('UPDATE samples SET archived_at = now() WHERE id = $1', [sample])

      const response = await inject('DELETE', `/admin/showrooms/${showroom.id}`, backofficeCookie)
      // Archiving is not deletion, and a delete that skipped archived rows would
      // quietly destroy the archive.
      expect(response.statusCode).toBe(409)
    })

    it('answers 404 for an unknown id', async () => {
      const response = await inject('DELETE', '/admin/showrooms/99999999', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })

    it('agrees with the detail read, in both directions', async () => {
      const blocked = (await create(`${PREFIX} Warned`)).json().showroom
      await insertSample(blocked.id, `${PREFIX}-0500`)

      const detail = await inject('GET', `/admin/showrooms/${blocked.id}`, backofficeCookie)
      const counts = detail.json().showroom
      expect(counts.sample_count).toBe(1)

      const refusal = await inject('DELETE', `/admin/showrooms/${blocked.id}`, backofficeCookie)
      expect(refusal.json().blockers[0].count).toBe(counts.sample_count)

      // And a showroom reading 0/0 really does delete.
      const empty = (await create(`${PREFIX} Unwarned`)).json().showroom
      const emptyDetail = await inject('GET', `/admin/showrooms/${empty.id}`, backofficeCookie)
      expect(emptyDetail.json().showroom).toMatchObject({
        sample_count: 0,
        sample_order_count: 0,
      })
      const gone = await inject('DELETE', `/admin/showrooms/${empty.id}`, backofficeCookie)
      expect(gone.statusCode).toBe(200)
    })
  })

  describe('the registry entry', () => {
    it('declares both edges and offers archiving', () => {
      const entity = LIFECYCLE_ENTITIES.showroom
      expect(entity.table).toBe('showrooms')
      expect(entity.archivable).toBe(true)
      expect(entity.probes.map((p) => p.relation).sort()).toEqual(['sample_orders', 'samples'])
    })
  })

  describe('the module is callable directly', () => {
    it('creates, patches, archives and reads without going through a route', async () => {
      // The module is exported and used directly by tests and by any future
      // caller, so its own answers must stand up without the route's schema in
      // front of them.
      const made = await createShowroomDirect(pool, { name: `${PREFIX} Direct` })
      expect(made.name).toBe(`${PREFIX} Direct`)

      const patched = await updateShowroomDirect(pool, made.id, { city: 'Napier' })
      expect(patched.city).toBe('Napier')

      const archived = await setShowroomArchivedDirect(pool, made.id, true)
      expect(archived.archived_at).not.toBeNull()
      expect(await setShowroomArchivedDirect(pool, 99999999, true)).toBeNull()

      const read = await getShowroom(pool, made.id)
      expect(read.id).toBe(made.id)
      expect(await getShowroom(pool, 99999999)).toBeNull()
    })

    it('answers 422 for a direct caller who clears the name', async () => {
      // The route schema makes this a 400. A direct caller reaches the NOT NULL
      // column instead, and a rejected value must not surface as a 500.
      const made = await createShowroomDirect(pool, { name: `${PREFIX} Nameless` })
      await expect(updateShowroomDirect(pool, made.id, { name: null })).rejects.toMatchObject({
        statusCode: 422,
      })
    })
  })

  describe('samples are not stock', () => {
    it('issues no statement that touches inventory', async () => {
      // The static source scan in test/samples-schema.test.js already globs
      // src/samples/**; this is the runtime counterpart over the statements this
      // module actually issues.
      const statements = []
      const stub = {
        query: async (text) => {
          statements.push(text)
          return { rows: [{ id: 1, sample_count: 0, sample_order_count: 0, total: 0 }], rowCount: 1 }
        },
      }

      await listShowrooms(stub, { q: 'anything', includeArchived: true })
      await getShowroom(stub, 1)

      expect(statements.length).toBeGreaterThan(0)
      for (const sql of statements) {
        expect(sql).not.toMatch(/qty_available|qty_reserved/)
        expect(sql).not.toMatch(/(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i)
      }
    })
  })
})
