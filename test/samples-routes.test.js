// Sample register routes (W4-US-005).
//
// Three acceptance criteria drive this file, and each one is a statement about a
// STATUS CODE, which is why the story could not ship as a module:
//   1. `GET /admin/samples/by-barcode/:barcode` answers 200 or 404 and never a
//      filtered list — the scanner's whole contract.
//   2. `POST` answers 409 on a duplicate barcode, detected by the DATABASE.
//   3. `DELETE` is blocked by `sample_loans`, through the shared lifecycle
//      module, so the refusal carries the counts and offers archiving.
//
// The fourth thing under test is the guard. Every /admin/* route in this API is
// backoffice-only and the check is parameterised over the whole surface, so a
// route added later without one fails here rather than in production.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  SAMPLE_STATUSES,
  SAMPLE_UPDATE_COLUMNS,
  WRITABLE_SAMPLE_STATUSES,
  createSample as createSampleDirect,
  updateSample as updateSampleDirect,
  setSampleArchived as setSampleArchivedDirect,
} from '../src/samples/admin-samples.js'
import { LIFECYCLE_ENTITIES } from '../src/lifecycle/registry.js'
import { deleteOrExplain } from '../src/lifecycle/delete.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
// Anchored with no separator, so the pattern matches every name this suite
// writes and not only the ones it inserts.
const PREFIX = 'w4-routes-test'
const DOMAIN = 'w4-routes-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

const DAY_MS = 86_400_000
const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString()

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Loans first (sample_id is RESTRICT), then samples ahead of brands — a brand
// cascade cannot get past samples.colourway_id, also RESTRICT.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM sample_loans WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM samples WHERE barcode LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM showrooms WHERE name LIKE $1', [`${PREFIX}%`])
}

const insertShowroom = (pool, name) =>
  pool
    .query('INSERT INTO showrooms (name) VALUES ($1) RETURNING id', [name])
    .then(({ rows }) => rows[0].id)

const insertSupplier = (pool, name) =>
  pool
    .query('INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id', [
      `${PREFIX} ${name}`,
      `${PREFIX}-${name}`,
    ])
    .then(({ rows }) => rows[0].id)

// trade_only = false: the house rule for every catalogue fixture, even one made
// purely to hang a foreign key off (the column is NOT NULL DEFAULT true).
const insertColourway = async (pool, slug) => {
  const brand = await pool.query(
    `INSERT INTO brands (name, slug, currency, trade_only)
     VALUES ($1, $2, 'NZD', false) RETURNING id`,
    [`${PREFIX} house ${slug}`, `${PREFIX}-${slug}`]
  )
  const product = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency)
     VALUES ($1, $2, $3, 'fabric', 'NZD') RETURNING id`,
    [brand.rows[0].id, `${PREFIX} Atlas`, `${PREFIX}-${slug}-design`]
  )
  const colourway = await pool.query(
    'INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3) RETURNING id',
    [product.rows[0].id, `${PREFIX} colour`, `${PREFIX}-SKU-${slug}`]
  )
  return colourway.rows[0].id
}

describe('back-office sample routes', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const createSample = (barcode, body = {}) =>
    inject('POST', '/admin/samples', backofficeCookie, { barcode, ...body })

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

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD, name: 'Shopper' },
    })
    customerCookie = sessionCookieFrom(shopper)
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
      // never registers is dead code that 404s every path in it. This asserts
      // the registration itself, ahead of anything about behaviour.
      const response = await inject('GET', '/admin/samples', backofficeCookie)
      expect(response.statusCode).toBe(200)
    })
  })

  describe('authorisation', () => {
    // Every payload here is VALID: Fastify validates before it runs a
    // preHandler, so a malformed body would 400 and the guard assertion would
    // pass without the guard existing.
    const surface = [
      ['GET', '/admin/samples', undefined],
      ['GET', '/admin/samples/by-barcode/anything', undefined],
      ['GET', '/admin/samples/1', undefined],
      ['POST', '/admin/samples', { barcode: `${PREFIX}-guard` }],
      ['PATCH', '/admin/samples/1', { location: 'Bay 1' }],
      ['POST', '/admin/samples/1/archive', undefined],
      ['POST', '/admin/samples/1/restore', undefined],
      ['POST', '/admin/samples/1/check-out', { holder_name: 'Somebody' }],
      ['POST', '/admin/samples/1/check-in', undefined],
      ['DELETE', '/admin/samples/1', undefined],
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

  describe('GET /admin/samples/by-barcode/:barcode', () => {
    it('answers 200 with exactly one sample', async () => {
      await createSample(`${PREFIX}-0001`, { label: 'Atlas hanger' })

      const response = await inject(
        'GET',
        `/admin/samples/by-barcode/${PREFIX}-0001`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      const body = response.json()
      // One object, never a list — the scanner has nothing to disambiguate with.
      expect(Array.isArray(body.sample)).toBe(false)
      expect(body.samples).toBeUndefined()
      expect(body.meta).toBeUndefined()
      expect(body.sample).toMatchObject({
        barcode: `${PREFIX}-0001`,
        label: 'Atlas hanger',
        status: 'in_library',
        overdue: false,
        loan_count: 0,
        open_loan: null,
      })
    })

    it('answers 404 for an unknown barcode rather than an empty list', async () => {
      const response = await inject(
        'GET',
        `/admin/samples/by-barcode/${PREFIX}-nothing`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
      expect(response.json().samples).toBeUndefined()
    })

    it('does not match a prefix, so a short scan cannot resolve to a neighbour', async () => {
      await createSample(`${PREFIX}-00220`)
      await createSample(`${PREFIX}-002201`)

      const short = await inject(
        'GET',
        `/admin/samples/by-barcode/${PREFIX}-0022`,
        backofficeCookie
      )
      expect(short.statusCode).toBe(404)

      const exact = await inject(
        'GET',
        `/admin/samples/by-barcode/${PREFIX}-00220`,
        backofficeCookie
      )
      expect(exact.statusCode).toBe(200)
      expect(exact.json().sample.barcode).toBe(`${PREFIX}-00220`)
    })

    it('does not treat a LIKE wildcard in the barcode as a pattern', async () => {
      await createSample(`${PREFIX}-0030`)
      const response = await inject(
        'GET',
        `/admin/samples/by-barcode/${encodeURIComponent(`${PREFIX}-00%`)}`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
    })

    it('finds an archived sample — a scanned object exists whatever the list shows', async () => {
      const created = await createSample(`${PREFIX}-0040`)
      const id = created.json().sample.id
      await inject('POST', `/admin/samples/${id}/archive`, backofficeCookie)

      const response = await inject(
        'GET',
        `/admin/samples/by-barcode/${PREFIX}-0040`,
        backofficeCookie
      )
      expect(response.statusCode).toBe(200)
      expect(response.json().sample.archived_at).not.toBeNull()
    })

    it('does not collide with the by-id route', async () => {
      const created = await createSample(`${PREFIX}-0050`)
      const id = created.json().sample.id

      const byId = await inject('GET', `/admin/samples/${id}`, backofficeCookie)
      expect(byId.statusCode).toBe(200)
      expect(byId.json().sample.barcode).toBe(`${PREFIX}-0050`)

      // A non-numeric :id is a 400 by schema and never reaches the handler.
      const bogus = await inject('GET', '/admin/samples/not-a-number', backofficeCookie)
      expect(bogus.statusCode).toBe(400)
    })
  })

  describe('POST /admin/samples', () => {
    it('creates a sample and returns it in the read shape', async () => {
      const showroomId = await insertShowroom(pool, `${PREFIX} Ponsonby`)
      const supplierId = await insertSupplier(pool, 'rubelli')
      const colourwayId = await insertColourway(pool, 'pf')

      const response = await createSample(`${PREFIX}-0100`, {
        label: 'Atlas hanger',
        colourway_id: colourwayId,
        supplier_id: supplierId,
        showroom_id: showroomId,
        sample_type: 'hanger',
        location: 'Bay 4',
        notes: 'Second cutting',
      })

      expect(response.statusCode).toBe(201)
      // The same shape a plain read hands back — parents by NAME, the open loan,
      // the count and the derived overdue — so one CRM renderer serves both.
      expect(response.json().sample).toMatchObject({
        barcode: `${PREFIX}-0100`,
        status: 'in_library',
        showroom_name: `${PREFIX} Ponsonby`,
        supplier_name: `${PREFIX} rubelli`,
        colourway_sku: `${PREFIX}-SKU-pf`,
        product_name: `${PREFIX} Atlas`,
        overdue: false,
        loan_count: 0,
        open_loan: null,
        loans: [],
      })
    })

    it('answers 409 on a duplicate barcode, detected by the database', async () => {
      const first = await createSample(`${PREFIX}-0110`)
      expect(first.statusCode).toBe(201)

      const second = await createSample(`${PREFIX}-0110`, { label: 'Different label' })
      expect(second.statusCode).toBe(409)
      expect(second.json().message).toMatch(/barcode/i)

      // The refusal created nothing — the unique index is what stopped it.
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM samples WHERE barcode = $1', [
        `${PREFIX}-0110`,
      ])
      expect(rows[0].n).toBe(1)
    })

    it('is the DATABASE that detects it, not a pre-check', async () => {
      // Two creates raced against one barcode: exactly one wins and the other is
      // a 409 from `samples_barcode_key`. A read-then-insert pre-check would let
      // both through, which is the failure the scanner (a concurrent device)
      // would actually hit.
      const [a, b] = await Promise.all([
        createSample(`${PREFIX}-0120`),
        createSample(`${PREFIX}-0120`),
      ])
      const codes = [a.statusCode, b.statusCode].sort()
      expect(codes).toEqual([201, 409])
    })

    it('requires a barcode', async () => {
      const response = await inject('POST', '/admin/samples', backofficeCookie, {
        label: 'No tag on it',
      })
      expect(response.statusCode).toBe(400)
    })

    it('answers 422 for a parent that does not exist', async () => {
      const response = await createSample(`${PREFIX}-0130`, { colourway_id: 987_654_321 })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/colourway/i)
    })

    it('refuses to create a sample already marked out', async () => {
      // `out` asserts an open loan exists and this route writes no loan. Only
      // check-out (US-006) can make that true, in one transaction over both
      // tables.
      const response = await createSample(`${PREFIX}-0140`, { status: 'out' })
      expect(response.statusCode).toBe(400)
    })

    it('accepts the statuses that are statements about the object', async () => {
      for (const [index, status] of WRITABLE_SAMPLE_STATUSES.entries()) {
        const response = await createSample(`${PREFIX}-015${index}`, { status })
        expect(response.statusCode).toBe(201)
        expect(response.json().sample.status).toBe(status)
      }
    })
  })

  describe('PATCH /admin/samples/:id', () => {
    it('edits the whitelisted columns and clears one with an explicit null', async () => {
      const showroomId = await insertShowroom(pool, `${PREFIX} Parnell`)
      const created = await createSample(`${PREFIX}-0200`, {
        showroom_id: showroomId,
        location: 'Bay 1',
      })
      const id = created.json().sample.id

      const moved = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {
        location: 'Bay 9',
        status: 'missing',
      })
      expect(moved.statusCode).toBe(200)
      expect(moved.json().sample).toMatchObject({ location: 'Bay 9', status: 'missing' })

      // An explicit null clears a nullable column; an absent key leaves it alone.
      const unhomed = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {
        showroom_id: null,
      })
      expect(unhomed.json().sample).toMatchObject({
        showroom_id: null,
        showroom_name: null,
        location: 'Bay 9',
      })
    })

    it('corrects a mistyped barcode, and a collision is the same 409', async () => {
      await createSample(`${PREFIX}-0210`)
      const created = await createSample(`${PREFIX}-0211`)
      const id = created.json().sample.id

      const fixed = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {
        barcode: `${PREFIX}-0212`,
      })
      expect(fixed.statusCode).toBe(200)
      expect(fixed.json().sample.barcode).toBe(`${PREFIX}-0212`)

      const clash = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {
        barcode: `${PREFIX}-0210`,
      })
      expect(clash.statusCode).toBe(409)
    })

    it('refuses an empty patch and an unknown id', async () => {
      const created = await createSample(`${PREFIX}-0220`)
      const id = created.json().sample.id

      const empty = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {})
      expect(empty.statusCode).toBe(400)

      const missing = await inject('PATCH', '/admin/samples/987654321', backofficeCookie, {
        location: 'Bay 2',
      })
      expect(missing.statusCode).toBe(404)
    })

    it('cannot mark a sample out — that is check-out, not a status PATCH', async () => {
      const created = await createSample(`${PREFIX}-0230`)
      const id = created.json().sample.id

      const response = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {
        status: 'out',
      })
      expect(response.statusCode).toBe(400)

      const after = await inject('GET', `/admin/samples/${id}`, backofficeCookie)
      expect(after.json().sample.status).toBe('in_library')
    })
  })

  describe('archive and restore', () => {
    it('hides a sample from the working list and brings it back', async () => {
      const created = await createSample(`${PREFIX}-0300`)
      const id = created.json().sample.id

      const archived = await inject('POST', `/admin/samples/${id}/archive`, backofficeCookie)
      expect(archived.statusCode).toBe(200)
      expect(archived.json().sample.archived_at).not.toBeNull()

      const live = await inject(
        'GET',
        `/admin/samples?q=${PREFIX}-0300`,
        backofficeCookie
      )
      expect(live.json().meta.total).toBe(0)

      const withArchived = await inject(
        'GET',
        `/admin/samples?q=${PREFIX}-0300&include_archived=true`,
        backofficeCookie
      )
      expect(withArchived.json().meta.total).toBe(1)

      const restored = await inject('POST', `/admin/samples/${id}/restore`, backofficeCookie)
      expect(restored.json().sample.archived_at).toBeNull()
    })

    it('answers 404 for an unknown id', async () => {
      const response = await inject('POST', '/admin/samples/987654321/archive', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('DELETE /admin/samples/:id', () => {
    it('deletes a sample nothing points at', async () => {
      const created = await createSample(`${PREFIX}-0400`)
      const id = created.json().sample.id

      const response = await inject('DELETE', `/admin/samples/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ deleted: { entity: 'sample', id } })

      const after = await inject('GET', `/admin/samples/${id}`, backofficeCookie)
      expect(after.statusCode).toBe(404)
    })

    it('is blocked by sample_loans, with the count and an archive alternative', async () => {
      const created = await createSample(`${PREFIX}-0410`)
      const id = created.json().sample.id
      await pool.query(
        `INSERT INTO sample_loans (sample_id, holder_name, due_back_at)
         VALUES ($1, 'Ana at the counter', $2)`,
        [id, daysFromNow(7)]
      )

      const response = await inject('DELETE', `/admin/samples/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        blockers: [{ relation: 'sample_loans', label: 'loans', count: 1, capped: false }],
        // samples.archived_at exists, so the dialog may offer the alternative.
        archivable: true,
      })

      // Nothing was destroyed — neither the sample nor its movement history.
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM samples WHERE id = $1', [id])
      expect(rows[0].n).toBe(1)
    })

    it('is blocked by a CLOSED loan too — history is a record, not a live link', async () => {
      // The obvious wrong simplification is to block only while something is
      // out. A returned loan is exactly the movement the register exists to
      // remember, so it blocks just as hard.
      const created = await createSample(`${PREFIX}-0420`)
      const id = created.json().sample.id
      await pool.query(
        `INSERT INTO sample_loans (sample_id, holder_name, returned_at)
         VALUES ($1, 'Brought it back', now())`,
        [id]
      )

      const response = await inject('DELETE', `/admin/samples/${id}`, backofficeCookie)
      expect(response.statusCode).toBe(409)
      expect(response.json().blockers[0].relation).toBe('sample_loans')
    })

    it('counts every movement in the refusal', async () => {
      const created = await createSample(`${PREFIX}-0430`)
      const id = created.json().sample.id
      for (const holder of ['One', 'Two', 'Three']) {
        await pool.query(
          `INSERT INTO sample_loans (sample_id, holder_name, returned_at)
           VALUES ($1, $2, now())`,
          [id, holder]
        )
      }

      const response = await inject('DELETE', `/admin/samples/${id}`, backofficeCookie)
      expect(response.json().blockers[0].count).toBe(3)
      expect(response.json().message).toMatch(/3 loans/)
    })

    it('answers 404 for an unknown id', async () => {
      const response = await inject('DELETE', '/admin/samples/987654321', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('GET /admin/samples', () => {
    it('builds the meta envelope and pages', async () => {
      for (const suffix of ['0500', '0501', '0502']) {
        await createSample(`${PREFIX}-${suffix}`)
      }

      const first = await inject(
        'GET',
        `/admin/samples?q=${PREFIX}-05&page=1&limit=2`,
        backofficeCookie
      )
      expect(first.statusCode).toBe(200)
      expect(first.json().meta).toEqual({ total: 3, page: 1, limit: 2 })
      expect(first.json().samples).toHaveLength(2)

      const second = await inject(
        'GET',
        `/admin/samples?q=${PREFIX}-05&page=2&limit=2`,
        backofficeCookie
      )
      expect(second.json().samples).toHaveLength(1)
    })

    it('rejects an over-large limit rather than clamping it silently', async () => {
      const response = await inject('GET', '/admin/samples?limit=5000', backofficeCookie)
      expect(response.statusCode).toBe(400)
    })

    it('rejects a status outside the vocabulary and accepts every one inside it', async () => {
      const bogus = await inject('GET', '/admin/samples?status=lost', backofficeCookie)
      expect(bogus.statusCode).toBe(400)

      for (const status of SAMPLE_STATUSES) {
        const response = await inject('GET', `/admin/samples?status=${status}`, backofficeCookie)
        expect(response.statusCode).toBe(200)
      }
    })

    it('filters on overdue, showroom and supplier through the route', async () => {
      const showroomId = await insertShowroom(pool, `${PREFIX} Wellington`)
      const late = await createSample(`${PREFIX}-0600`, { showroom_id: showroomId })
      const lateId = late.json().sample.id
      await pool.query(
        `INSERT INTO sample_loans (sample_id, holder_name, due_back_at)
         VALUES ($1, 'Late borrower', $2)`,
        [lateId, daysFromNow(-2)]
      )
      await createSample(`${PREFIX}-0601`, { showroom_id: showroomId })

      const overdue = await inject(
        'GET',
        `/admin/samples?q=${PREFIX}-06&overdue=true`,
        backofficeCookie
      )
      expect(overdue.json().samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0600`])

      const byShowroom = await inject(
        'GET',
        `/admin/samples?q=${PREFIX}-06&showroom_id=${showroomId}`,
        backofficeCookie
      )
      expect(byShowroom.json().meta.total).toBe(2)
    })
  })

  describe('invariants', () => {
    it('registers "sample" in the lifecycle registry with the sample_loans probe', async () => {
      const entity = LIFECYCLE_ENTITIES.sample
      expect(entity).toBeDefined()
      expect(entity.table).toBe('samples')
      expect(entity.idColumn).toBe('id')
      // samples.archived_at exists, so a blocked delete may offer archiving.
      expect(entity.archivable).toBe(true)
      expect(entity.probes.map((probe) => probe.relation)).toEqual(['sample_loans'])
    })

    it('never lets a write reach a column outside the whitelist', async () => {
      const created = await createSample(`${PREFIX}-0700`)
      const id = created.json().sample.id

      // Ajv's removeAdditional strips an unknown key rather than 400ing it, so
      // the body arrives as {} and minProperties produces the 400. The column
      // whitelist is the real defence, which is what this asserts.
      const response = await inject('PATCH', `/admin/samples/${id}`, backofficeCookie, {
        archived_at: null,
        created_at: '1999-01-01T00:00:00Z',
      })
      expect(response.statusCode).toBe(400)
      expect(SAMPLE_UPDATE_COLUMNS).not.toContain('archived_at')
      expect(SAMPLE_UPDATE_COLUMNS).not.toContain('created_at')
      expect(SAMPLE_UPDATE_COLUMNS).not.toContain('id')
    })

    it('keeps the writable statuses a strict subset of the CHECK vocabulary', async () => {
      // Widening the CHECK widens the writable set with it — the constant is
      // derived, not re-typed — but `out` must never join it.
      for (const status of WRITABLE_SAMPLE_STATUSES) {
        expect(SAMPLE_STATUSES).toContain(status)
      }
      expect(WRITABLE_SAMPLE_STATUSES).not.toContain('out')
      expect(WRITABLE_SAMPLE_STATUSES).toHaveLength(SAMPLE_STATUSES.length - 1)
    })

    it('reads and writes no stock, over every statement the writes and the delete issue', async () => {
      // test/samples-read-models.test.js already does this for the reads. The
      // new SQL this story adds is the three writes and the delete's probe —
      // and the probe is the interesting one, because it is generated from the
      // registry entry rather than written here.
      const statements = []
      const client = {
        query: async (text) => {
          statements.push(text)
          // A row for every statement, so the lock finds its parent and the
          // probe actually runs — with an empty result the delete would stop at
          // the 404 and never emit the SQL under test.
          return { rows: [{ id: 1, total: 0, open_loan_id: null }] }
        },
        release: () => {},
      }
      const recording = { connect: async () => client, query: client.query }

      await createSampleDirect(recording, { barcode: `${PREFIX}-stub` })
      await updateSampleDirect(recording, 1, { location: 'Bay 1' })
      await setSampleArchivedDirect(recording, 1, true)
      await deleteOrExplain(recording, 'sample', 1, {})

      // A recorder that captured nothing would pass every check below vacuously.
      expect(statements.length).toBeGreaterThan(0)
      expect(statements.some((sql) => /sample_loans/.test(sql))).toBe(true)
      const offending = statements.filter(
        (sql) =>
          /qty_available|qty_reserved/.test(sql) ||
          /(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i.test(sql)
      )
      expect(offending).toEqual([])
    })
  })
})
