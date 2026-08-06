// The sample-order lifecycle: the machine, the routes and the delete rule
// (W4-US-007).
//
// Three acceptance criteria drive this file:
//   1. `ALLOWED_TRANSITIONS` and `requireStatus` live in a module the CRM
//      mirrors — so the machine is asserted with NO database at all, which is
//      the only honest proof that a browser bundle could import it.
//   2. An invalid transition is a 409.
//   3. DELETE is refused unless the order is `requested` or `cancelled`.
//
// (2) is asserted three ways, because a status code alone does not distinguish a
// machine from a coincidence: an illegal move must 409, must change NOTHING, and
// must still 409 when two staff advance one order at the same instant — which is
// what the row lock in `withSampleOrderTxn` is for.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import {
  SAMPLE_ORDER_STATUSES,
  INITIAL_SAMPLE_ORDER_STATUS,
  ALLOWED_TRANSITIONS,
  SOURCE_STATUSES,
  STATUS_STAMPS,
  DELETABLE_SAMPLE_ORDER_STATUSES,
  requireStatus,
  requireTransition,
  isDeletableStatus,
} from '../src/samples/sample-order-states.js'
import {
  SAMPLE_ORDER_UPDATE_COLUMNS,
  createSampleOrder as createSampleOrderDirect,
  updateSampleOrder as updateSampleOrderDirect,
  transitionSampleOrder as transitionSampleOrderDirect,
  setSampleOrderArchived as setSampleOrderArchivedDirect,
} from '../src/samples/sample-orders.js'
import { LIFECYCLE_ENTITIES } from '../src/lifecycle/registry.js'
import { deleteOrExplain } from '../src/lifecycle/delete.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
// Anchored with no separator, so the pattern matches every name this suite
// writes and not only the ones it inserts.
const PREFIX = 'w4-order-test'
const DOMAIN = 'w4-order-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'

// The linear spine, requested -> displayed. The tests walk it rather than
// re-listing it, so widening the machine cannot leave a stale copy behind.
const SPINE = ['ordered', 'in_transit', 'received', 'displayed']

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Orders first: showroom_id is RESTRICT (and NOT NULL, so every fixture order
// hangs off a fixture showroom) and colourway_id is RESTRICT too, which stops a
// brand cascade dead exactly as samples.colourway_id does.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM sample_orders
      WHERE showroom_id IN (SELECT id FROM showrooms WHERE name LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM suppliers WHERE slug LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM showrooms WHERE name LIKE $1', [`${PREFIX}%`])
}

const insertShowroom = (pool, name) =>
  pool
    .query('INSERT INTO showrooms (name) VALUES ($1) RETURNING id', [`${PREFIX} ${name}`])
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
    [brand.rows[0].id, `${PREFIX} Nuage`, `${PREFIX}-${slug}-design`]
  )
  const colourway = await pool.query(
    'INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3) RETURNING id',
    [product.rows[0].id, `${PREFIX} colour`, `${PREFIX}-SKU-${slug}`]
  )
  return colourway.rows[0].id
}

// The machine is pure, so this block needs no database, no app and no fixtures —
// which is the point. `atelier-crm/src/screens/sampleFlow.js` (US-009) imports
// the same shapes into a browser bundle, and anything reaching for pg here would
// make that impossible.
describe('the sample-order state machine (pure)', () => {
  it('declares a transition list and a timestamp column for every status', () => {
    for (const status of SAMPLE_ORDER_STATUSES) {
      expect(Array.isArray(ALLOWED_TRANSITIONS[status])).toBe(true)
      expect(typeof STATUS_STAMPS[status]).toBe('string')
    }
    // No status outside the vocabulary may appear as a key or a destination.
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...SAMPLE_ORDER_STATUSES].sort())
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const target of targets) expect(SAMPLE_ORDER_STATUSES).toContain(target)
    }
  })

  it('runs the spine and offers cancel from every state short of terminal', () => {
    expect(ALLOWED_TRANSITIONS.requested).toEqual(['ordered', 'cancelled'])
    expect(ALLOWED_TRANSITIONS.ordered).toEqual(['in_transit', 'cancelled'])
    expect(ALLOWED_TRANSITIONS.in_transit).toEqual(['received', 'cancelled'])
    expect(ALLOWED_TRANSITIONS.received).toEqual(['displayed', 'cancelled'])
    // Terminal: an abandoned order is re-raised, never resurrected, or
    // `cancelled_at` would sit stamped on a live row and the six stamps would lie.
    expect(ALLOWED_TRANSITIONS.displayed).toEqual([])
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([])
  })

  it('derives SOURCE_STATUSES as the exact inverse, never a second copy', () => {
    for (const from of SAMPLE_ORDER_STATUSES) {
      for (const to of SAMPLE_ORDER_STATUSES) {
        expect(SOURCE_STATUSES[to].includes(from)).toBe(ALLOWED_TRANSITIONS[from].includes(to))
      }
    }
    // Nothing may move to the state it is already in.
    for (const status of SAMPLE_ORDER_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).not.toContain(status)
    }
  })

  it('requireStatus refuses with a 409 naming the state it found', () => {
    expect(() => requireStatus({ status: 'received' }, ['requested'], 'delete')).toThrowError(
      /status "received"/
    )
    try {
      requireStatus({ status: 'received' }, 'requested', 'delete')
      throw new Error('should have refused')
    } catch (error) {
      expect(error.statusCode).toBe(409)
    }
    // A single string and a list are both accepted, as in admin-orders.js.
    expect(() => requireStatus({ status: 'requested' }, 'requested', 'delete')).not.toThrow()
    expect(() =>
      requireStatus({ status: 'requested' }, ['requested', 'cancelled'], 'delete')
    ).not.toThrow()
  })

  it('requireTransition refuses a self-move and any move out of a terminal state', () => {
    expect(() => requireTransition({ status: 'ordered' }, 'ordered')).toThrowError(/ordered/)
    expect(() => requireTransition({ status: 'displayed' }, 'cancelled')).toThrowError(/displayed/)
    expect(() => requireTransition({ status: 'cancelled' }, 'ordered')).toThrowError(/cancelled/)
    expect(() => requireTransition({ status: 'requested' }, 'ordered')).not.toThrow()
  })

  it('names exactly the two states nothing has acted on as deletable', () => {
    expect([...DELETABLE_SAMPLE_ORDER_STATUSES]).toEqual(['requested', 'cancelled'])
    for (const status of SAMPLE_ORDER_STATUSES) {
      expect(isDeletableStatus(status)).toBe(DELETABLE_SAMPLE_ORDER_STATUSES.includes(status))
    }
    expect(INITIAL_SAMPLE_ORDER_STATUS).toBe('requested')
  })
})

describe('sample orders', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie
  let showroomId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  const createOrder = (body = {}) =>
    inject('POST', '/admin/sample-orders', backofficeCookie, {
      showroom_id: showroomId,
      ...body,
    })

  const move = (id, status, at) =>
    inject('POST', `/admin/sample-orders/${id}/transition`, backofficeCookie, {
      status,
      ...(at ? { at } : {}),
    })

  // Walk the spine (or stop at `cancelled`) to put a fixture order in a state.
  const orderInStatus = async (status, body = {}) => {
    const created = await createOrder(body)
    const id = created.json().sample_order.id
    if (status === INITIAL_SAMPLE_ORDER_STATUS) return id
    if (status === 'cancelled') {
      await move(id, 'cancelled')
      return id
    }
    for (const step of SPINE) {
      await move(id, step)
      if (step === status) break
    }
    return id
  }

  const readOrder = (id) => inject('GET', `/admin/sample-orders/${id}`, backofficeCookie)

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
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('boss')])

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
    // One showroom per test: every order needs a destination (NOT NULL), and
    // cleaning by showroom is what sweeps the orders away with it.
    showroomId = await insertShowroom(pool, 'Ponsonby')
  })

  describe('the vocabulary agrees with the database', () => {
    it('matches the live sample_orders_status_check', async () => {
      // The CHECK holds the vocabulary and the module holds the machine, so the
      // two must agree on what a status IS or a legal move raises a 23514.
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conname = 'sample_orders_status_check'`
      )
      expect(rows).toHaveLength(1)
      const inCheck = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
      expect(inCheck.sort()).toEqual([...SAMPLE_ORDER_STATUSES].sort())
    })

    it('stamps a column that actually exists, for every status', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sample_orders'`
      )
      const columns = new Set(rows.map((row) => row.column_name))
      for (const status of SAMPLE_ORDER_STATUSES) {
        expect(columns.has(STATUS_STAMPS[status])).toBe(true)
      }
    })
  })

  describe('authorisation', () => {
    // Every payload here is VALID: Fastify validates before it runs a
    // preHandler, so a malformed body would 400 and the guard assertion would
    // pass without the guard existing.
    const surface = [
      ['GET', '/admin/sample-orders', undefined],
      ['GET', '/admin/sample-orders/1', undefined],
      ['POST', '/admin/sample-orders', { showroom_id: 1 }],
      ['PATCH', '/admin/sample-orders/1', { label: 'Nuage hanger' }],
      ['POST', '/admin/sample-orders/1/transition', { status: 'ordered' }],
      ['POST', '/admin/sample-orders/1/archive', undefined],
      ['POST', '/admin/sample-orders/1/restore', undefined],
      ['DELETE', '/admin/sample-orders/1', undefined],
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

  describe('POST /admin/sample-orders', () => {
    it('raises a request and returns it with its parents by name', async () => {
      const supplierId = await insertSupplier(pool, 'rubelli')
      const colourwayId = await insertColourway(pool, 'pf')

      const response = await createOrder({
        colourway_id: colourwayId,
        supplier_id: supplierId,
        label: 'Nuage, two hangers',
        notes: 'For the window',
      })

      expect(response.statusCode).toBe(201)
      const order = response.json().sample_order
      expect(order).toMatchObject({
        status: 'requested',
        showroom_name: `${PREFIX} Ponsonby`,
        supplier_name: `${PREFIX} rubelli`,
        colourway_sku: `${PREFIX}-SKU-pf`,
        product_name: `${PREFIX} Nuage`,
        label: 'Nuage, two hangers',
      })
      expect(order.requested_at).not.toBeNull()
      // A NULL stamp reads as "has not been there" without consulting `status`.
      expect(order.ordered_at).toBeNull()
      expect(order.in_transit_at).toBeNull()
      expect(order.received_at).toBeNull()
      expect(order.displayed_at).toBeNull()
      expect(order.cancelled_at).toBeNull()
    })

    it('requires a showroom — an order with no destination is unroutable', async () => {
      const response = await inject('POST', '/admin/sample-orders', backofficeCookie, {
        label: 'Nowhere to send it',
      })
      expect(response.statusCode).toBe(400)
    })

    it('answers 422 for a parent that does not exist', async () => {
      const response = await inject('POST', '/admin/sample-orders', backofficeCookie, {
        showroom_id: 987_654_321,
      })
      expect(response.statusCode).toBe(422)
      expect(response.json().message).toMatch(/showroom/i)
    })

    it('always starts at requested, whatever the body says', async () => {
      // Ajv's removeAdditional strips the key rather than 400ing it, which is
      // exactly why the machine may not rely on schema strictness: an order
      // created at `received` would carry none of the stamps that say how it got
      // there.
      const response = await createOrder({ status: 'received' })
      expect(response.statusCode).toBe(201)
      expect(response.json().sample_order.status).toBe('requested')
      expect(response.json().sample_order.received_at).toBeNull()
    })

    it('back-dates the request when asked', async () => {
      const response = await createOrder({ requested_at: '2026-07-01T09:00:00Z' })
      expect(new Date(response.json().sample_order.requested_at).toISOString()).toBe(
        '2026-07-01T09:00:00.000Z'
      )
    })
  })

  describe('GET /admin/sample-orders', () => {
    it('builds the meta envelope and pages', async () => {
      for (const label of ['one', 'two', 'three']) await createOrder({ label })

      const first = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}&page=1&limit=2`,
        backofficeCookie
      )
      expect(first.statusCode).toBe(200)
      expect(first.json().meta).toEqual({ total: 3, page: 1, limit: 2 })
      expect(first.json().sample_orders).toHaveLength(2)

      const second = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}&page=2&limit=2`,
        backofficeCookie
      )
      expect(second.json().sample_orders).toHaveLength(1)
    })

    it('filters by status, supplier and free text', async () => {
      const supplierId = await insertSupplier(pool, 'jt')
      await createOrder({ label: 'Nuage hanger', supplier_id: supplierId })
      const moved = await createOrder({ label: 'Atlas book' })
      await move(moved.json().sample_order.id, 'ordered')

      const ordered = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}&status=ordered`,
        backofficeCookie
      )
      expect(ordered.json().sample_orders.map((row) => row.label)).toEqual(['Atlas book'])

      const bySupplier = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}&supplier_id=${supplierId}`,
        backofficeCookie
      )
      expect(bySupplier.json().meta.total).toBe(1)

      const byTerm = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}&q=Nuage`,
        backofficeCookie
      )
      expect(byTerm.json().sample_orders.map((row) => row.label)).toEqual(['Nuage hanger'])
    })

    it('rejects an over-large limit and a status outside the vocabulary', async () => {
      expect((await inject('GET', '/admin/sample-orders?limit=5000', backofficeCookie)).statusCode).toBe(400)
      expect(
        (await inject('GET', '/admin/sample-orders?status=posted', backofficeCookie)).statusCode
      ).toBe(400)

      for (const status of SAMPLE_ORDER_STATUSES) {
        const response = await inject(
          'GET',
          `/admin/sample-orders?status=${status}`,
          backofficeCookie
        )
        expect(response.statusCode).toBe(200)
      }
    })

    it('answers 404 for an unknown id', async () => {
      expect((await readOrder(987_654_321)).statusCode).toBe(404)
    })
  })

  describe('PATCH /admin/sample-orders/:id', () => {
    it('edits the whitelisted columns and clears one with an explicit null', async () => {
      const colourwayId = await insertColourway(pool, 'lm')
      const created = await createOrder({ colourway_id: colourwayId, label: 'Nuage' })
      const id = created.json().sample_order.id

      const edited = await inject('PATCH', `/admin/sample-orders/${id}`, backofficeCookie, {
        label: 'Nuage, three hangers',
        notes: 'Chased 4 Aug',
      })
      expect(edited.statusCode).toBe(200)
      expect(edited.json().sample_order).toMatchObject({
        label: 'Nuage, three hangers',
        notes: 'Chased 4 Aug',
      })

      const detached = await inject('PATCH', `/admin/sample-orders/${id}`, backofficeCookie, {
        colourway_id: null,
      })
      expect(detached.json().sample_order).toMatchObject({
        colourway_id: null,
        colourway_name: null,
        label: 'Nuage, three hangers',
      })
    })

    it('redirects an order to another showroom but refuses to un-home it', async () => {
      const other = await insertShowroom(pool, 'Parnell')
      const created = await createOrder()
      const id = created.json().sample_order.id

      const moved = await inject('PATCH', `/admin/sample-orders/${id}`, backofficeCookie, {
        showroom_id: other,
      })
      expect(moved.json().sample_order.showroom_name).toBe(`${PREFIX} Parnell`)

      const unhomed = await inject('PATCH', `/admin/sample-orders/${id}`, backofficeCookie, {
        showroom_id: null,
      })
      expect(unhomed.statusCode).toBe(400)
    })

    it('cannot move the status — that is a transition, not a PATCH', async () => {
      const id = await orderInStatus('requested')

      // Ajv strips the unknown key, so the body arrives as {} and minProperties
      // produces the 400. The column whitelist is the real defence.
      const response = await inject('PATCH', `/admin/sample-orders/${id}`, backofficeCookie, {
        status: 'ordered',
      })
      expect(response.statusCode).toBe(400)
      expect(SAMPLE_ORDER_UPDATE_COLUMNS).not.toContain('status')
      for (const status of SAMPLE_ORDER_STATUSES) {
        expect(SAMPLE_ORDER_UPDATE_COLUMNS).not.toContain(STATUS_STAMPS[status])
      }
      expect(SAMPLE_ORDER_UPDATE_COLUMNS).not.toContain('archived_at')

      expect((await readOrder(id)).json().sample_order.status).toBe('requested')
    })

    it('refuses an empty patch and an unknown id', async () => {
      const id = await orderInStatus('requested')
      expect(
        (await inject('PATCH', `/admin/sample-orders/${id}`, backofficeCookie, {})).statusCode
      ).toBe(400)
      expect(
        (
          await inject('PATCH', '/admin/sample-orders/987654321', backofficeCookie, {
            label: 'Ghost',
          })
        ).statusCode
      ).toBe(404)
    })
  })

  describe('POST /admin/sample-orders/:id/transition', () => {
    it('walks the whole spine, stamping one column per move', async () => {
      const created = await createOrder({ label: 'Nuage' })
      const id = created.json().sample_order.id

      for (const status of SPINE) {
        const response = await move(id, status)
        expect(response.statusCode).toBe(200)
        const order = response.json().sample_order
        expect(order.status).toBe(status)
        // The stamp for this move is set; every later one is still null.
        expect(order[STATUS_STAMPS[status]]).not.toBeNull()
        for (const later of SPINE.slice(SPINE.indexOf(status) + 1)) {
          expect(order[STATUS_STAMPS[later]]).toBeNull()
        }
        // Cancelling never happened, so its stamp never got written.
        expect(order.cancelled_at).toBeNull()
      }
    })

    it('cancels from any state short of terminal', async () => {
      for (const from of ['requested', 'ordered', 'in_transit', 'received']) {
        const id = await orderInStatus(from)
        const response = await move(id, 'cancelled')
        expect(response.statusCode).toBe(200)
        expect(response.json().sample_order).toMatchObject({ status: 'cancelled' })
        expect(response.json().sample_order.cancelled_at).not.toBeNull()
      }
    })

    it('answers 409 for an illegal move and changes NOTHING', async () => {
      const id = await orderInStatus('requested')
      const before = (await readOrder(id)).json().sample_order

      // Skipping the middle of the spine is the mistake a screen makes when it
      // offers every status as a button.
      const response = await move(id, 'received')
      expect(response.statusCode).toBe(409)
      expect(response.json().message).toMatch(/status "requested"/)

      const after = (await readOrder(id)).json().sample_order
      expect(after).toEqual(before)
    })

    it('answers 409 for a move to the state it is already in', async () => {
      const id = await orderInStatus('ordered')
      const first = (await readOrder(id)).json().sample_order.ordered_at

      const response = await move(id, 'ordered')
      expect(response.statusCode).toBe(409)
      // The stamp was not rewritten, which is what a re-run would have done.
      expect((await readOrder(id)).json().sample_order.ordered_at).toBe(first)
    })

    it.each([
      ['displayed', 'cancelled'],
      ['cancelled', 'ordered'],
    ])('answers 409 for any move out of %s', async (from, to) => {
      const id = await orderInStatus(from)
      const response = await move(id, to)
      expect(response.statusCode).toBe(409)
      expect((await readOrder(id)).json().sample_order.status).toBe(from)
    })

    it('rejects a status outside the vocabulary at the schema, and at the module', async () => {
      const id = await orderInStatus('requested')
      expect((await move(id, 'posted')).statusCode).toBe(400)

      // The module is also called directly, so it answers for itself rather than
      // interpolating an undefined column name into the UPDATE.
      await expect(transitionSampleOrderDirect(pool, id, { status: 'posted' })).rejects.toMatchObject(
        { statusCode: 422 }
      )
    })

    it('back-dates a move, and refuses a date that is not in the calendar', async () => {
      const id = await orderInStatus('requested')

      const dated = await move(id, 'ordered', '2026-07-15T10:30:00Z')
      expect(new Date(dated.json().sample_order.ordered_at).toISOString()).toBe(
        '2026-07-15T10:30:00.000Z'
      )

      // The route's pattern polices the SHAPE; only Postgres knows the calendar,
      // and a rejected value must not surface as a 500.
      const impossible = await move(id, 'in_transit', '2026-02-31')
      expect(impossible.statusCode).toBe(422)
      expect((await readOrder(id)).json().sample_order.status).toBe('ordered')

      expect((await move(id, 'in_transit', 'the fifteenth')).statusCode).toBe(400)
    })

    it('answers 404 for an unknown id', async () => {
      expect((await move(987_654_321, 'ordered')).statusCode).toBe(404)
    })

    it('serialises two staff advancing one order at the same instant', async () => {
      // The row lock is what makes `requireTransition` mean anything: without it
      // both reads see `requested`, both writes land, and the second silently
      // rewrites the first's stamp with its own clock.
      //
      // The two moves must be the SAME move for this to discriminate. Racing
      // `ordered` against `cancelled` proves nothing — serialised, the loser
      // arrives at `ordered` and `ordered -> cancelled` is legal, so both
      // legitimately answer 200.
      const id = await orderInStatus('requested')

      const [a, b] = await Promise.all([move(id, 'ordered'), move(id, 'ordered')])
      const codes = [a.statusCode, b.statusCode].sort()
      expect(codes).toEqual([200, 409])

      // The winner's stamp is the one that stands: the loser never wrote.
      const winner = [a, b].find((response) => response.statusCode === 200)
      const order = (await readOrder(id)).json().sample_order
      expect(order.status).toBe('ordered')
      expect(order.ordered_at).toBe(winner.json().sample_order.ordered_at)
    })
  })

  describe('archive and restore', () => {
    it('hides a finished order from the working list and brings it back', async () => {
      const id = await orderInStatus('displayed', { label: 'On the shelf' })

      const archived = await inject(
        'POST',
        `/admin/sample-orders/${id}/archive`,
        backofficeCookie
      )
      expect(archived.statusCode).toBe(200)
      expect(archived.json().sample_order.archived_at).not.toBeNull()

      const live = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}`,
        backofficeCookie
      )
      expect(live.json().meta.total).toBe(0)

      const withArchived = await inject(
        'GET',
        `/admin/sample-orders?showroom_id=${showroomId}&include_archived=true`,
        backofficeCookie
      )
      expect(withArchived.json().meta.total).toBe(1)

      const restored = await inject(
        'POST',
        `/admin/sample-orders/${id}/restore`,
        backofficeCookie
      )
      expect(restored.json().sample_order.archived_at).toBeNull()
    })

    it('answers 404 for an unknown id', async () => {
      const response = await inject(
        'POST',
        '/admin/sample-orders/987654321/archive',
        backofficeCookie
      )
      expect(response.statusCode).toBe(404)
    })
  })

  describe('DELETE /admin/sample-orders/:id', () => {
    it.each([...DELETABLE_SAMPLE_ORDER_STATUSES])(
      'deletes an order that is %s — nothing acted on it',
      async (status) => {
        const id = await orderInStatus(status)
        const response = await inject('DELETE', `/admin/sample-orders/${id}`, backofficeCookie)
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ deleted: { entity: 'sample_order', id } })
        expect((await readOrder(id)).statusCode).toBe(404)
      }
    )

    it.each(SAMPLE_ORDER_STATUSES.filter((status) => !isDeletableStatus(status)))(
      'refuses to delete an order that is %s',
      async (status) => {
        const id = await orderInStatus(status)
        const response = await inject('DELETE', `/admin/sample-orders/${id}`, backofficeCookie)

        expect(response.statusCode).toBe(409)
        expect(response.json()).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          // A guard refusal, not a probe: nothing in the schema points at a
          // sample order, so there is nothing to count.
          blockers: [],
          // sample_orders.archived_at exists, so the dialog offers the way out.
          archivable: true,
        })
        expect(response.json().message).toMatch(new RegExp(status))

        // The refusal destroyed nothing.
        expect((await readOrder(id)).statusCode).toBe(200)
      }
    )

    it('answers 404 for an unknown id', async () => {
      const response = await inject('DELETE', '/admin/sample-orders/987654321', backofficeCookie)
      expect(response.statusCode).toBe(404)
    })
  })

  describe('invariants', () => {
    it('registers "sample_order" in the lifecycle registry with a guard and no probes', async () => {
      const entity = LIFECYCLE_ENTITIES.sample_order
      expect(entity).toBeDefined()
      expect(entity.table).toBe('sample_orders')
      expect(entity.idColumn).toBe('id')
      expect(entity.archivable).toBe(true)
      expect(entity.probes).toEqual([])
      expect(typeof entity.guard).toBe('function')
    })

    it('reads and writes no stock, over every statement this story adds', async () => {
      // Samples are not inventory, and an order for them is not a purchase
      // order. test/samples-schema.test.js scans this source statically; this is
      // the runtime half, and it covers the delete's guard too — which is
      // generated from the registry rather than written in the module.
      const statements = []
      const client = {
        query: async (text) => {
          statements.push(text)
          // A row for every statement, so the lock finds its parent and the
          // guard actually runs — with an empty result the delete would stop at
          // the 404 and never emit the SQL under test.
          return { rows: [{ id: 1, status: 'requested', total: 0 }], rowCount: 1 }
        },
        release: () => {},
      }
      const recording = { connect: async () => client, query: client.query }

      await createSampleOrderDirect(recording, { showroom_id: 1 })
      await updateSampleOrderDirect(recording, 1, { label: 'Nuage' })
      await transitionSampleOrderDirect(recording, 1, { status: 'ordered' })
      await setSampleOrderArchivedDirect(recording, 1, true)
      await deleteOrExplain(recording, 'sample_order', 1, {})

      // A recorder that captured nothing would pass every check below vacuously.
      expect(statements.length).toBeGreaterThan(0)
      expect(statements.some((sql) => /sample_orders/.test(sql))).toBe(true)
      const offending = statements.filter(
        (sql) =>
          /qty_available|qty_reserved/.test(sql) ||
          /(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i.test(sql)
      )
      expect(offending).toEqual([])
    })

    it('decides a move inside the transaction that holds the row locked', async () => {
      // FOR UPDATE, never FOR NO KEY UPDATE: nothing weaker conflicts with the
      // FOR KEY SHARE a referencing insert takes, and the read that decides the
      // 409 is only trustworthy while the row cannot move underneath it.
      const statements = []
      const client = {
        query: async (text) => {
          statements.push(text)
          return { rows: [{ id: 1, status: 'requested' }], rowCount: 1 }
        },
        release: () => {},
      }
      const recording = { connect: async () => client, query: client.query }

      await transitionSampleOrderDirect(recording, 1, { status: 'ordered' })

      expect(statements[0]).toBe('BEGIN')
      expect(statements[1]).toMatch(/FROM sample_orders WHERE id = \$1 FOR UPDATE/)
      expect(statements[1]).not.toMatch(/FOR NO KEY UPDATE/)
      expect(statements.some((sql) => /UPDATE sample_orders/.test(sql))).toBe(true)
      expect(statements).toContain('COMMIT')
      expect(statements).not.toContain('ROLLBACK')
    })

    it('rolls the transaction back when the move is refused', async () => {
      const statements = []
      const client = {
        query: async (text) => {
          statements.push(text)
          return { rows: [{ id: 1, status: 'displayed' }], rowCount: 1 }
        },
        release: () => {},
      }
      const recording = { connect: async () => client, query: client.query }

      await expect(
        transitionSampleOrderDirect(recording, 1, { status: 'ordered' })
      ).rejects.toMatchObject({ statusCode: 409 })

      expect(statements).toContain('ROLLBACK')
      expect(statements).not.toContain('COMMIT')
      // The refusal happened before any write, so no UPDATE was ever issued.
      expect(statements.some((sql) => /UPDATE sample_orders/.test(sql))).toBe(false)
    })
  })
})
