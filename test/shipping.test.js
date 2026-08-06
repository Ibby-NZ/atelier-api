import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const TEST_DOMAIN = 'shipping-test.example.com'
const testEmail = (local) => `${local}@${TEST_DOMAIN}`
const PASSWORD = 'correct horse battery'

// Own test zones so the suite never depends on whether the seed has run and
// cleans up after itself.
const ZONE = 'Shipping Test Zone'
const EMPTY_ZONE = 'Nowhere Test Zone'

// The single-row CRUD block owns two more zones so it never depends on what the
// bulk-PUT tests above have left behind. Both end in "Test Zone", so the
// file-level cleanup sweeps them up as well.
const CRUD_ZONE = 'Shipping CRUD Test Zone'   // two tiers: a delete is allowed
const SOLO_ZONE = 'Shipping Solo Test Zone'   // one tier: the last-tier guard fires
const UNKNOWN_RATE_ID = 999999999

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const deleteTestData = async (pool) => {
  await pool.query('DELETE FROM shipping_rates WHERE zone LIKE $1', ['%Test Zone'])
  await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${TEST_DOMAIN}`])
}

describe('shipping quote and admin rates', () => {
  let pool
  let app
  let backofficeCookie
  let customerCookie

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
    await deleteTestData(pool)

    // Two tiers: floor 0 -> 1200c, floor 20 -> 3000c.
    await pool.query(
      `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
       VALUES ($1, 0, 1200), ($1, 20, 3000)`,
      [ZONE]
    )

    app = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
    await app.ready()

    const backoffice = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(backoffice)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [
      testEmail('boss'),
    ])

    const customer = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD },
    })
    customerCookie = sessionCookieFrom(customer)
  })

  afterAll(async () => {
    await deleteTestData(pool)
    await app.close()
    await pool.end()
  })

  const quote = (zone, qty) =>
    app.inject({
      method: 'GET',
      url: `/shipping/quote?zone=${encodeURIComponent(zone)}&qty=${qty}`,
    })

  describe('GET /shipping/quote', () => {
    it('returns the lower tier below the threshold', async () => {
      const response = await quote(ZONE, 5)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({
        zone: ZONE,
        rate_cents: 1200,
        threshold_qty: 0,
      })
    })

    it('returns the upper tier exactly at the threshold boundary', async () => {
      const response = await quote(ZONE, 20)
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ rate_cents: 3000, threshold_qty: 20 })
    })

    it('stays on the lower tier just under the threshold', async () => {
      const response = await quote(ZONE, 19.99)
      expect(response.statusCode).toBe(200)
      expect(response.json().rate_cents).toBe(1200)
    })

    it('returns the upper tier above the threshold', async () => {
      const response = await quote(ZONE, 100)
      expect(response.statusCode).toBe(200)
      expect(response.json().rate_cents).toBe(3000)
    })

    it('returns 400 with a clear message for an unknown zone', async () => {
      const response = await quote(EMPTY_ZONE, 5)
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain(EMPTY_ZONE)
    })

    it('returns 400 when qty is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/shipping/quote?zone=${encodeURIComponent(ZONE)}`,
      })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('PUT /admin/shipping-rates', () => {
    it('rejects an anonymous request with 401', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        payload: { rates: [{ zone: ZONE, threshold_qty: 0, rate_cents: 999 }] },
      })
      expect(response.statusCode).toBe(401)
    })

    it('rejects a non-backoffice user with 403', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: customerCookie },
        payload: { rates: [{ zone: ZONE, threshold_qty: 0, rate_cents: 999 }] },
      })
      expect(response.statusCode).toBe(403)
    })

    it('updates an existing tier for a backoffice user', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: { rates: [{ zone: ZONE, threshold_qty: 0, rate_cents: 1500 }] },
      })
      expect(response.statusCode).toBe(200)
      const updated = await quote(ZONE, 5)
      expect(updated.json().rate_cents).toBe(1500)
    })

    it('adds a new tier without redeploy', async () => {
      await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: { rates: [{ zone: ZONE, threshold_qty: 50, rate_cents: 6000 }] },
      })
      const updated = await quote(ZONE, 60)
      expect(updated.json()).toMatchObject({ rate_cents: 6000, threshold_qty: 50 })
    })

    it('rejects an empty rates array with 400', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: { rates: [] },
      })
      expect(response.statusCode).toBe(400)
    })
  })

  // Single-row CRUD: the surface the CRM's shipping screen drives. Its own two
  // zones are rebuilt before every test, so nothing here depends on the order of
  // the bulk-PUT tests above.
  describe('single-row shipping-rate CRUD', () => {
    beforeEach(async () => {
      await pool.query('DELETE FROM shipping_rates WHERE zone = ANY($1)', [
        [CRUD_ZONE, SOLO_ZONE],
      ])
      await pool.query(
        `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
         VALUES ($1, 0, 900), ($1, 30, 2500), ($2, 0, 1100)`,
        [CRUD_ZONE, SOLO_ZONE]
      )
    })

    const rateIdFor = async (zone, threshold) => {
      const { rows } = await pool.query(
        'SELECT id FROM shipping_rates WHERE zone = $1 AND threshold_qty = $2',
        [zone, threshold]
      )
      return rows[0].id
    }

    const tiersIn = async (zone) => {
      const { rows } = await pool.query(
        `SELECT threshold_qty, rate_cents FROM shipping_rates
          WHERE zone = $1 ORDER BY threshold_qty ASC`,
        [zone]
      )
      return rows.map((row) => ({
        threshold_qty: Number(row.threshold_qty),
        rate_cents: row.rate_cents,
      }))
    }

    describe('GET /admin/shipping-rates', () => {
      it('rejects an anonymous request with 401', async () => {
        const response = await app.inject({ method: 'GET', url: '/admin/shipping-rates' })
        expect(response.statusCode).toBe(401)
      })

      it('rejects a non-backoffice user with 403', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/shipping-rates',
          headers: { cookie: customerCookie },
        })
        expect(response.statusCode).toBe(403)
      })

      // The id is the whole point of the list: it is what PATCH and DELETE
      // address, and the quote endpoint never exposes one.
      it('lists a zone tiers ascending, each carrying its id', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/shipping-rates',
          headers: { cookie: backofficeCookie },
        })
        expect(response.statusCode).toBe(200)

        const mine = response.json().rates.filter((rate) => rate.zone === CRUD_ZONE)
        expect(mine).toHaveLength(2)
        expect(mine[0]).toMatchObject({ threshold_qty: 0, rate_cents: 900 })
        expect(mine[1]).toMatchObject({ threshold_qty: 30, rate_cents: 2500 })
        expect(typeof mine[0].id).toBe('number')
        expect(mine[0].id).not.toBe(mine[1].id)
      })

      // threshold_qty is numeric(12,2), so pg hands it back as '30.00' unless the
      // mapper coerces it — a string would land in the CRM's number input.
      it('returns threshold_qty as a number', async () => {
        const response = await app.inject({
          method: 'GET',
          url: '/admin/shipping-rates',
          headers: { cookie: backofficeCookie },
        })
        const tier = response
          .json()
          .rates.find((rate) => rate.zone === CRUD_ZONE && rate.threshold_qty === 30)
        expect(tier).toBeDefined()
        expect(typeof tier.threshold_qty).toBe('number')
      })
    })

    describe('POST /admin/shipping-rates', () => {
      it('rejects an anonymous request with 401', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/shipping-rates',
          payload: { zone: CRUD_ZONE, threshold_qty: 100, rate_cents: 7000 },
        })
        expect(response.statusCode).toBe(401)
        expect(await tiersIn(CRUD_ZONE)).toHaveLength(2)
      })

      it('rejects a non-backoffice user with 403', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/shipping-rates',
          headers: { cookie: customerCookie },
          payload: { zone: CRUD_ZONE, threshold_qty: 100, rate_cents: 7000 },
        })
        expect(response.statusCode).toBe(403)
        expect(await tiersIn(CRUD_ZONE)).toHaveLength(2)
      })

      it('creates a tier and returns 201 with its id', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/shipping-rates',
          headers: { cookie: backofficeCookie },
          payload: { zone: CRUD_ZONE, threshold_qty: 100, rate_cents: 7000 },
        })
        expect(response.statusCode).toBe(201)
        expect(response.json().rate).toMatchObject({
          zone: CRUD_ZONE,
          threshold_qty: 100,
          rate_cents: 7000,
        })
        expect(typeof response.json().rate.id).toBe('number')

        // The new tier is live for quoting, which is the reason to add one.
        const quoted = await quote(CRUD_ZONE, 120)
        expect(quoted.json()).toMatchObject({ threshold_qty: 100, rate_cents: 7000 })
      })

      // A zone with no tiers has no quote, so creating the first tier for a new
      // zone is how a zone comes into existence at all.
      it('creates the first tier of a brand-new zone', async () => {
        const newZone = 'Shipping Fresh Test Zone'
        await pool.query('DELETE FROM shipping_rates WHERE zone = $1', [newZone])
        expect((await quote(newZone, 5)).statusCode).toBe(400)

        const response = await app.inject({
          method: 'POST',
          url: '/admin/shipping-rates',
          headers: { cookie: backofficeCookie },
          payload: { zone: newZone, threshold_qty: 0, rate_cents: 4500 },
        })
        expect(response.statusCode).toBe(201)
        expect((await quote(newZone, 5)).json().rate_cents).toBe(4500)

        await pool.query('DELETE FROM shipping_rates WHERE zone = $1', [newZone])
      })

      // POST is not an upsert: the bulk PUT is the "make it so" path. A create
      // that silently overwrote a live rate would hide a mistyped threshold.
      it('refuses a duplicate (zone, threshold_qty) with 409 and leaves the rate alone', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/shipping-rates',
          headers: { cookie: backofficeCookie },
          payload: { zone: CRUD_ZONE, threshold_qty: 30, rate_cents: 1 },
        })
        expect(response.statusCode).toBe(409)
        expect(response.json().message).toContain(CRUD_ZONE)
        expect(await tiersIn(CRUD_ZONE)).toEqual([
          { threshold_qty: 0, rate_cents: 900 },
          { threshold_qty: 30, rate_cents: 2500 },
        ])
      })

      it('rejects a body missing rate_cents with 400', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/admin/shipping-rates',
          headers: { cookie: backofficeCookie },
          payload: { zone: CRUD_ZONE, threshold_qty: 100 },
        })
        expect(response.statusCode).toBe(400)
      })
    })

    describe('PATCH /admin/shipping-rates/:id', () => {
      it('rejects a non-backoffice user with 403', async () => {
        const id = await rateIdFor(CRUD_ZONE, 0)
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: customerCookie },
          payload: { rate_cents: 100 },
        })
        expect(response.statusCode).toBe(403)
        expect((await tiersIn(CRUD_ZONE))[0].rate_cents).toBe(900)
      })

      it('updates rate_cents and the quote follows', async () => {
        const id = await rateIdFor(CRUD_ZONE, 0)
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: backofficeCookie },
          payload: { rate_cents: 1350 },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json().rate).toMatchObject({
          id,
          zone: CRUD_ZONE,
          threshold_qty: 0,
          rate_cents: 1350,
        })
        expect((await quote(CRUD_ZONE, 5)).json().rate_cents).toBe(1350)
      })

      // Ajv strips unknown keys rather than rejecting them (removeAdditional),
      // so this asserts the identity key survives a body that tried to move it.
      it('ignores zone and threshold_qty in the body', async () => {
        const id = await rateIdFor(CRUD_ZONE, 30)
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: backofficeCookie },
          payload: { zone: SOLO_ZONE, threshold_qty: 999, rate_cents: 2600 },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json().rate).toMatchObject({
          zone: CRUD_ZONE,
          threshold_qty: 30,
          rate_cents: 2600,
        })
        // The other zone did not gain a tier, and this one did not move.
        expect(await tiersIn(SOLO_ZONE)).toEqual([{ threshold_qty: 0, rate_cents: 1100 }])
        expect(await tiersIn(CRUD_ZONE)).toEqual([
          { threshold_qty: 0, rate_cents: 900 },
          { threshold_qty: 30, rate_cents: 2600 },
        ])
      })

      // Which is why rate_cents is `required` and not merely one of several
      // optional fields: after the strip this body is {}, and an UPDATE with an
      // empty SET clause is invalid SQL.
      it('rejects a body with no rate_cents with 400', async () => {
        const id = await rateIdFor(CRUD_ZONE, 0)
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: backofficeCookie },
          payload: { zone: 'Somewhere Else' },
        })
        expect(response.statusCode).toBe(400)
      })

      it('returns 404 for an unknown id', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: `/admin/shipping-rates/${UNKNOWN_RATE_ID}`,
          headers: { cookie: backofficeCookie },
          payload: { rate_cents: 100 },
        })
        expect(response.statusCode).toBe(404)
      })
    })

    describe('DELETE /admin/shipping-rates/:id', () => {
      it('rejects an anonymous request with 401', async () => {
        const id = await rateIdFor(CRUD_ZONE, 30)
        const response = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${id}`,
        })
        expect(response.statusCode).toBe(401)
        expect(await tiersIn(CRUD_ZONE)).toHaveLength(2)
      })

      it('rejects a non-backoffice user with 403', async () => {
        const id = await rateIdFor(CRUD_ZONE, 30)
        const response = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: customerCookie },
        })
        expect(response.statusCode).toBe(403)
        expect(await tiersIn(CRUD_ZONE)).toHaveLength(2)
      })

      it('deletes a tier while the zone keeps another', async () => {
        const id = await rateIdFor(CRUD_ZONE, 30)
        const response = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: backofficeCookie },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ deleted: { entity: 'shipping_rate', id } })
        expect(await tiersIn(CRUD_ZONE)).toEqual([{ threshold_qty: 0, rate_cents: 900 }])

        // The zone still quotes — a qty that used to reach the deleted tier now
        // falls back to the one below it rather than failing.
        expect((await quote(CRUD_ZONE, 50)).json()).toMatchObject({
          threshold_qty: 0,
          rate_cents: 900,
        })
      })

      // The guard exists because an empty zone is not an empty screen, it is a
      // 400 from getShippingQuote — i.e. checkout down for everyone in it.
      it('refuses the last tier for a zone with 409 and keeps the zone quotable', async () => {
        const id = await rateIdFor(SOLO_ZONE, 0)
        const response = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${id}`,
          headers: { cookie: backofficeCookie },
        })
        expect(response.statusCode).toBe(409)
        const body = response.json()
        expect(body.message).toContain(SOLO_ZONE)
        expect(body.blockers).toEqual([])
        // No archived_at column on shipping_rates, so the dialog must not offer
        // "Archive instead" — nothing would happen if staff pressed it.
        expect(body.archivable).toBe(false)

        expect(await tiersIn(SOLO_ZONE)).toHaveLength(1)
        expect((await quote(SOLO_ZONE, 5)).statusCode).toBe(200)
      })

      // Emptying a zone one tier at a time is the same outage by another route,
      // so the guard has to hold on the *last* remaining tier, not on the first.
      it('refuses the second delete once a zone is down to one tier', async () => {
        const first = await rateIdFor(CRUD_ZONE, 30)
        const dropped = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${first}`,
          headers: { cookie: backofficeCookie },
        })
        expect(dropped.statusCode).toBe(200)

        const last = await rateIdFor(CRUD_ZONE, 0)
        const refused = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${last}`,
          headers: { cookie: backofficeCookie },
        })
        expect(refused.statusCode).toBe(409)
        expect(await tiersIn(CRUD_ZONE)).toHaveLength(1)
      })

      it('returns 404 with an empty blocker list for an unknown id', async () => {
        const response = await app.inject({
          method: 'DELETE',
          url: `/admin/shipping-rates/${UNKNOWN_RATE_ID}`,
          headers: { cookie: backofficeCookie },
        })
        expect(response.statusCode).toBe(404)
        expect(response.json().blockers).toEqual([])
      })
    })

    // The bulk PUT predates this story and stays the way to rewrite a whole
    // table of tiers; the only change is that its rows now carry an id too.
    it('leaves the bulk PUT upserting, with ids in its response', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/admin/shipping-rates',
        headers: { cookie: backofficeCookie },
        payload: {
          rates: [
            { zone: CRUD_ZONE, threshold_qty: 0, rate_cents: 950 },
            { zone: CRUD_ZONE, threshold_qty: 60, rate_cents: 4000 },
          ],
        },
      })
      expect(response.statusCode).toBe(200)

      const mine = response.json().rates.filter((rate) => rate.zone === CRUD_ZONE)
      expect(mine.map((rate) => rate.threshold_qty)).toEqual([0, 30, 60])
      expect(mine.every((rate) => typeof rate.id === 'number')).toBe(true)
      // Tier 0 was updated in place rather than duplicated.
      expect(mine[0].rate_cents).toBe(950)
    })
  })
})
