import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { ENTITIES, LEGACY_ENTITIES, listLegacy } from '../src/legacy/legacy-read.js'
import {
  MAX_CUSTOM_FIELDS,
  MAX_CUSTOM_VALUE_LENGTH,
  SYNTHETIC_COLUMNS,
} from '../src/legacy/override-schema.js'
import { importLegacyEntity } from '../src/seed/legacy-import.js'

// Back-office corrections to the D365 staging mirror. The feature's whole reason
// to exist is that a correction survives `npm run import:legacy`, so the suite
// runs the real importer rather than asserting against a response alone.

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const DOMAIN = 'legacy-ovr-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const PREFIX = 'ZZ Override Test'

const GUID = {
  alpha: 'aaaaaaaa-1111-4111-8111-111111111111',
  beta: 'aaaaaaaa-2222-4222-8222-222222222222',
  order: 'aaaaaaaa-3333-4333-8333-333333333333',
  stock: 'aaaaaaaa-4444-4444-8444-444444444444',
  price: 'aaaaaaaa-5555-4555-8555-555555555555',
  missing: 'aaaaaaaa-9999-4999-8999-999999999999',
}
const FIXTURE_GUIDS = [GUID.alpha, GUID.beta, GUID.order, GUID.stock, GUID.price]

// One fixture per read entity. Every behavioural test used to run against
// `accounts` alone, so three of the four merged projections — including both
// timestamp columns and the only multi-term ORDER BY — were never executed.
const ENTITY_FIXTURES = Object.freeze({
  accounts: { guid: GUID.alpha, column: 'name' },
  'sales-orders': { guid: GUID.order, column: 'customer' },
  stock: { guid: GUID.stock, column: 'name' },
  prices: { guid: GUID.price, column: 'description' },
})

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

const sorted = (row) => Object.fromEntries(Object.entries(row).sort())

const seed = async (pool) => {
  await pool.query(
    `INSERT INTO legacy_accounts
        (guid, name, email, main_phone, discount, credit_limit, is_customer, source_file, raw)
     VALUES ($1, $2, 'old@ztest.example', '09 111 1111', 0.1000, 5000.0000, true, 'ovr.xlsx',
             '{"Account Name":"as exported"}'::jsonb),
            ($3, $4, 'beta@ztest.example', NULL, NULL, NULL, true, 'ovr.xlsx', '{}'::jsonb)`,
    [GUID.alpha, `${PREFIX} Alpha`, GUID.beta, `${PREFIX} Beta`]
  )
  // `sales-orders` is the only read entity carrying timestamp columns, so it is
  // the only place the naive-timestamp rules can actually be exercised.
  await pool.query(
    `INSERT INTO legacy_sales_orders
        (guid, number, customer, order_date, total_incl_gst, source_file, raw)
     VALUES ($1, $2, $3, '2026-03-04 09:30:00', 146.30, 'ovr.xlsx', '{}'::jsonb)`,
    [GUID.order, `${PREFIX}-SO-1`, `${PREFIX} Alpha`]
  )
  await pool.query(
    `INSERT INTO legacy_stock_items (guid, item_code, name, stock_on_hand, source_file, raw)
     VALUES ($1, $2, $3, 12.5, 'ovr.xlsx', '{}'::jsonb)`,
    [GUID.stock, `${PREFIX}-SKU-1`, `${PREFIX} Bolt`]
  )
  await pool.query(
    `INSERT INTO legacy_product_prices (guid, code, description, wholesale_rate, source_file, raw)
     VALUES ($1, $2, $3, 42.5000, 'ovr.xlsx', '{}'::jsonb)`,
    [GUID.price, `${PREFIX}-PL-1`, `${PREFIX} Price Row`]
  )
}

const cleanup = async (pool) => {
  // A local record carries a MINTED guid and its only identifying text lives in
  // its own patch — which a bug (or a mutation test) can leave empty, at which
  // point no guid list and no patch predicate can find it again. Authorship is
  // the one handle that always holds, so the suite's own users are the primary
  // key of the cleanup; the guid list and patch predicates stay as a belt for
  // rows written directly by a test rather than through a route.
  await pool.query(
    `DELETE FROM d365_overrides
      WHERE created_by_user_id IN (SELECT id FROM users WHERE email LIKE $3)
         OR guid = ANY($1::uuid[])
         OR patch->>'name' LIKE $2 OR patch->>'customer' LIKE $2
         OR patch->>'description' LIKE $2 OR patch->>'item_code' LIKE $2`,
    [FIXTURE_GUIDS, `${PREFIX}%`, `%@${DOMAIN}`]
  )
  await pool.query('DELETE FROM legacy_accounts WHERE name LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM legacy_sales_orders WHERE number LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM legacy_stock_items WHERE item_code LIKE $1', [`${PREFIX}%`])
  await pool.query('DELETE FROM legacy_product_prices WHERE code LIKE $1', [`${PREFIX}%`])
}

describe('D365 override layer', () => {
  let pool
  let app
  let anonCookie
  let bossCookie // backoffice, no finance
  let moneyCookie // backoffice + can_view_finance
  let chiefCookie // director + can_view_finance
  let customerCookie

  const call = (method, url, cookie, payload) =>
    app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload === undefined ? {} : { payload }),
    })

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

    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered ONCE: /auth/register shares a 10-per-15-min-per-IP bucket, and
    // re-registering per test 429s and yields no cookie.
    const register = async (local, sql) => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: testEmail(local), password: PASSWORD, name: local },
      })
      if (sql) await pool.query(sql, [testEmail(local)])
      return sessionCookieFrom(res)
    }
    bossCookie = await register('boss', "UPDATE users SET role = 'backoffice' WHERE email = $1")
    moneyCookie = await register(
      'money',
      "UPDATE users SET role = 'backoffice', can_view_finance = true WHERE email = $1"
    )
    chiefCookie = await register(
      'chief',
      "UPDATE users SET role = 'director', can_view_finance = true WHERE email = $1"
    )
    customerCookie = await register('shopper')
    anonCookie = null
  })

  beforeEach(async () => {
    await cleanup(pool)
    await seed(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  // -------------------------------------------------------------------------
  describe('schema', () => {
    it('lives outside the legacy_ namespace', async () => {
      // Not cosmetic: three suites assert the count of live legacy_% tables
      // equals the number of LEGACY_TABLES entries, and the namespace's defining
      // property — every column upserted to EXCLUDED by the import — is the one
      // this table exists to escape.
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'd365_overrides'`
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].table_name.startsWith('legacy_')).toBe(false)
    })

    it('pins the entity CHECK to the read vocabulary, not the import one', async () => {
      // Two vocabularies are live and three of the four names differ. An override
      // row written under the import spelling would apply nothing and raise
      // nothing, so the CHECK is the tripwire — and it must not drift from
      // LEGACY_ENTITIES.
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'd365_overrides'::regclass AND conname = 'd365_overrides_entity_check'`
      )
      expect(rows).toHaveLength(1)
      const declared = [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
      expect(declared).toEqual([...LEGACY_ENTITIES].sort())
    })

    it('refuses an import-vocabulary entity name outright', async () => {
      await expect(
        pool.query(
          `INSERT INTO d365_overrides (entity, guid) VALUES ('sales_orders', $1)`,
          [GUID.alpha]
        )
      ).rejects.toThrow(/d365_overrides_entity_check/)
    })

    it('refuses at boot a declared column that shadows a synthetic one', async () => {
      // Both would be emitted, Postgres allows the duplicate output name, and the
      // driver keeps whichever came last — a staging value silently overwritten
      // by a synthetic one, or the reverse. assertEntities is the tripwire.
      for (const name of SYNTHETIC_COLUMNS) {
        expect(LEGACY_ENTITIES.some((entity) => ENTITIES[entity].columns.includes(name))).toBe(false)
      }
      expect(SYNTHETIC_COLUMNS).toContain('custom_fields')
    })

    it('allows one override row per record', async () => {
      await pool.query('INSERT INTO d365_overrides (entity, guid) VALUES ($1, $2)', ['accounts', GUID.alpha])
      await expect(
        pool.query('INSERT INTO d365_overrides (entity, guid) VALUES ($1, $2)', ['accounts', GUID.alpha])
      ).rejects.toThrow(/d365_overrides_entity_guid_key/)
    })
  })

  // -------------------------------------------------------------------------
  describe('the merged read', () => {
    it('returns the same rows on the fast and merged paths when nothing is overridden', async () => {
      // The fast path exists because the merged CTE cannot use the base table's
      // index. Two query paths can drift; this is what stops them.
      const fast = await listLegacy(pool, 'accounts', { q: PREFIX })
      const merged = await listLegacy(pool, 'accounts', { q: PREFIX, forceMerge: true })
      expect(fast.merged).toBe(false)
      expect(merged.merged).toBe(true)
      expect(merged.items.map(sorted)).toEqual(fast.items.map(sorted))
    })

    it('applies a correction and keeps every other column from D365', async () => {
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Corrected` },
      })
      expect(res.statusCode).toBe(200)
      const { record } = res.json()
      expect(record.name).toBe(`${PREFIX} Corrected`)
      expect(record.main_phone).toBe('09 111 1111')
      expect(record.overridden_fields).toEqual(['name'])
      expect(record.origin).toBe('d365')
    })

    it('searches, filters and counts on the corrected value, not the staged one', async () => {
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Renamed` },
      })
      const found = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(`${PREFIX} Renamed`)}`, bossCookie)).json()
      expect(found.meta.total).toBe(1)
      expect(found.meta.merged).toBe(true)
      expect(found.items[0].guid).toBe(GUID.alpha)

      const gone = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(`${PREFIX} Alpha`)}`, bossCookie)).json()
      expect(gone.meta.total).toBe(0)
      expect(gone.items).toEqual([])
    })

    it('can override a column TO NULL, and revert brings D365 back', async () => {
      // The regression this is here for: COALESCE(patch->>'col', t.col) makes a
      // deliberate clear indistinguishable from no override at all, so the write
      // returns 200 and the old value stays on screen. The read tests key
      // PRESENCE for exactly this.
      const cleared = (await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { email: null },
      })).json().record
      expect(cleared.email).toBeNull()
      expect(cleared.overridden_fields).toEqual(['email'])

      const restored = (await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        revert: ['email'],
      })).json().record
      expect(restored.email).toBe('old@ztest.example')
      expect(restored.overridden_fields).toEqual([])
    })

    // The module's headline claim: the merge is ONE statement, so two staff
    // correcting different fields of one record cannot lose each other's work.
    // Nothing asserted it.
    it('accumulates corrections across separate requests', async () => {
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Renamed` },
      })
      const { record } = (await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { main_phone: '09 444 4444' },
      })).json()
      expect([...record.overridden_fields].sort()).toEqual(['main_phone', 'name'])
      expect(record.name).toBe(`${PREFIX} Renamed`)
      expect(record.main_phone).toBe('09 444 4444')
    })

    it('loses neither correction when two land at once', async () => {
      // A read-modify-write in JS passes the sequential test above and fails
      // this one, which is the whole reason the merge is a single statement.
      await Promise.all([
        call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
          set: { name: `${PREFIX} Concurrent` },
        }),
        call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
          set: { main_phone: '09 555 5555' },
        }),
      ])
      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect([...record.overridden_fields].sort()).toEqual(['main_phone', 'name'])
      expect(record.name).toBe(`${PREFIX} Concurrent`)
      expect(record.main_phone).toBe('09 555 5555')
    })

    it('keeps reporting an older field stale when an unrelated field is corrected', async () => {
      // `base` is merged per written key, never reassigned wholesale. A whole
      // -record snapshot would make this third request silently retract the
      // staleness signal raised by the second.
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Ours` },
      })
      await pool.query('UPDATE legacy_accounts SET name = $2 WHERE guid = $1', [
        GUID.alpha,
        `${PREFIX} TheirsNow`,
      ])
      const midway = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(midway.record.override.stale_fields).toEqual(['name'])

      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { main_phone: '09 666 6666' },
      })
      const after = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(after.record.override.stale_fields).toEqual(['name'])
      expect(after.record.name).toBe(`${PREFIX} Ours`)
    })

    it('drops the override row once the last correction is reverted', async () => {
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, { set: { name: 'x' } })
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, { revert: ['name'] })
      const { rows } = await pool.query('SELECT 1 FROM d365_overrides WHERE guid = $1', [GUID.alpha])
      expect(rows).toHaveLength(0)
    })

    it('returns the staging row verbatim beside the corrected columns', async () => {
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Corrected` },
      })
      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.name).toBe(`${PREFIX} Corrected`)
      // `raw` is what D365 exported and is never patched — which is the point of
      // returning it beside a merged record.
      expect(record.raw['Account Name']).toBe('as exported')
      expect(record.source_file).toBe('ovr.xlsx')
      expect(record.override.fields).toEqual(['name'])
      expect(record.override.base.name).toBe(`${PREFIX} Alpha`)
      expect(record.override.updated_by.email).toBe(testEmail('boss'))
    })

    it('reports a correction D365 has since moved underneath', async () => {
      // Without this an override masks every future upstream correction to that
      // field, silently and for ever.
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Ours` },
      })
      const before = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json().record
      expect(before.override.stale_fields).toEqual([])

      await pool.query('UPDATE legacy_accounts SET name = $2 WHERE guid = $1', [
        GUID.alpha,
        `${PREFIX} Theirs`,
      ])
      const after = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json().record
      expect(after.override.stale_fields).toEqual(['name'])
      expect(after.name).toBe(`${PREFIX} Ours`)
    })

    it('does not 500 an entire listing on a value written outside the API', async () => {
      // PG14 has no pg_input_is_valid, so the read's safe-cast functions are the
      // backstop. One bad row must degrade to the staged value, not take every
      // page of the entity down for every user.
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, moneyCookie, {
        set: { credit_limit: 1234 },
      })
      await pool.query(
        `UPDATE d365_overrides SET patch = patch || '{"credit_limit":"not-a-number"}'::jsonb
          WHERE guid = $1`,
        [GUID.alpha]
      )
      const res = await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)
      expect(res.statusCode).toBe(200)
      const row = res.json().items.find((item) => item.guid === GUID.alpha)
      expect(row.credit_limit).toBe(5000)
    })
  })

  // -------------------------------------------------------------------------
  describe('validation', () => {
    const rejects = [
      ['an unknown column', { set: { nope: 'x' } }],
      ['the record guid', { set: { guid: GUID.beta } }],
      ['a non-numeric number', { set: { discount: 'abc' } }],
      ['the text "null"', { set: { name: 'null' } }],
      // The route schema deliberately does not type the values (a union there
      // makes Ajv coerce a deliberate null into ''), so a non-scalar has to be
      // refused by the module — and named, not stripped.
      ['an object value', { set: { name: { nested: true } } }],
      ['an array value', { set: { name: ['a'] } }],
      ['setting and reverting one column', { set: { name: 'x' }, revert: ['name'] }],
      ['reverting an unknown column', { revert: ['nope'] }],
    ]
    for (const [label, body] of rejects) {
      it(`refuses ${label} with a 422`, async () => {
        const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, moneyCookie, body)
        expect(res.statusCode).toBe(422)
        expect(res.json().message).toBeTruthy()
      })
    }

    // These cases MUST target sales-orders: `accounts` has no timestamp column in
    // its read projection at all, so aiming them at `last_sales_contact` made all
    // three pass as "unknown column" and left NAIVE_TIMESTAMP, castProbeSql's
    // timestamp probe, proveCastable's 22007/22008 mapping and
    // d365_override_timestamp with no coverage whatever. Each asserts the REASON
    // in the message, so a case can never again pass on the wrong refusal.
    it('accepts a naive local timestamp', async () => {
      const res = await call('PATCH', `/admin/legacy/sales-orders/${GUID.order}`, bossCookie, {
        set: { order_date: '2026-05-06 14:00:00' },
      })
      expect(res.statusCode).toBe(200)
      expect(new Date(res.json().record.order_date).getHours()).toBe(14)
    })

    it('refuses a timestamp carrying a zone, naming the reason', async () => {
      // Postgres DISCARDS an offset on a ::timestamp cast rather than applying
      // it, so accepting what toISOString() produces would move every corrected
      // date by the NZ offset and re-sort a list ordered on it.
      const res = await call('PATCH', `/admin/legacy/sales-orders/${GUID.order}`, bossCookie, {
        set: { order_date: '2026-01-02T03:04:05.000Z' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().message).toMatch(/local timestamp/i)
    })

    it('refuses a date the regex admits but Postgres will not parse', async () => {
      // The shape check cannot see this one — it is the database's own parser,
      // run at write time, that refuses it. Reaching this branch is the only
      // proof castProbeSql/proveCastable do anything.
      const res = await call('PATCH', `/admin/legacy/sales-orders/${GUID.order}`, bossCookie, {
        set: { order_date: '2026-02-31' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().message).toMatch(/rejected by the database/i)
    })

    it('refuses an impossible date before it can reach the read path', async () => {
      await call('PATCH', `/admin/legacy/sales-orders/${GUID.order}`, bossCookie, {
        set: { order_date: '2026-02-31' },
      })
      const { rows } = await pool.query('SELECT 1 FROM d365_overrides WHERE guid = $1', [GUID.order])
      expect(rows).toHaveLength(0)
      // And the listing it would have broken still answers.
      expect((await call('GET', '/admin/legacy/sales-orders', bossCookie)).statusCode).toBe(200)
    })

    it('400s an empty patch body', async () => {
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {})
      expect(res.statusCode).toBe(400)
    })

    it('400s a patch whose set object is empty', async () => {
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, { set: {} })
      expect(res.statusCode).toBe(400)
    })

    it('404s a record that does not exist', async () => {
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.missing}`, bossCookie, {
        set: { name: 'x' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('keeps a value the schema would otherwise strip', async () => {
      // `set` is typed rather than closed: with additionalProperties:false Ajv's
      // removeAdditional would strip every key and the handler would answer 200
      // having written nothing.
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, moneyCookie, {
        set: { name: `${PREFIX} Kept`, is_customer: false, discount: 0.42 },
      })
      expect(res.statusCode).toBe(200)
      const { record } = res.json()
      expect(record.name).toBe(`${PREFIX} Kept`)
      expect(record.is_customer).toBe(false)
      expect(record.discount).toBe(0.42)
    })
  })

  // -------------------------------------------------------------------------
  describe('records raised here', () => {
    const create = (cookie = chiefCookie) =>
      call('POST', '/admin/legacy/accounts', cookie, {
        values: { name: `${PREFIX} Local Ltd`, email: 'local@ztest.example' },
      })

    it('creates a record D365 does not have', async () => {
      const res = await create()
      expect(res.statusCode).toBe(201)
      const { record } = res.json()
      expect(record.origin).toBe('local')
      expect(record.name).toBe(`${PREFIX} Local Ltd`)
      // There is no export behind it, so there is nothing to show as provenance.
      expect(record.raw).toBeNull()
      expect(record.source_file).toBeNull()
    })

    it('lists it beside the staged records, with no guid appearing twice', async () => {
      const { record } = (await create()).json()
      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      const guids = list.items.map((item) => item.guid)
      expect(guids).toContain(record.guid)
      expect(new Set(guids).size).toBe(guids.length)
      expect(list.meta.total).toBe(guids.length)
    })

    it('is readable and correctable through its own detail route', async () => {
      const { record } = (await create()).json()
      const detail = await call('GET', `/admin/legacy/accounts/${record.guid}`, bossCookie)
      expect(detail.statusCode).toBe(200)
      const patched = await call('PATCH', `/admin/legacy/accounts/${record.guid}`, bossCookie, {
        set: { main_phone: '09 222 2222' },
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json().record.main_phone).toBe('09 222 2222')
    })

    it('400s a create with no values', async () => {
      const res = await call('POST', '/admin/legacy/accounts', chiefCookie, { values: {} })
      expect(res.statusCode).toBe(400)
    })

    it('422s a create whose every value is null', async () => {
      // One key satisfies minProperties, so counting keys is not enough: this
      // would otherwise raise a record with every column null.
      const res = await call('POST', '/admin/legacy/accounts', chiefCookie, {
        values: { name: null },
      })
      expect(res.statusCode).toBe(422)
    })

    it('refuses a revert that would empty it, and leaves it intact', async () => {
      // Otherwise the row survives with an empty patch, emits a guid with every
      // column null into the list, counts toward meta.total, and no further
      // revert can remove it.
      const { record } = (await create()).json()
      const res = await call('PATCH', `/admin/legacy/accounts/${record.guid}`, bossCookie, {
        revert: ['name', 'email'],
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().message).toMatch(/locally raised/i)

      const after = (await call('GET', `/admin/legacy/accounts/${record.guid}`, bossCookie)).json()
      expect(after.record.name).toBe(`${PREFIX} Local Ltd`)

      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      expect(list.items.every((item) => item.name !== null)).toBe(true)
    })

    it('still allows reverting some of its fields', async () => {
      const { record } = (await create()).json()
      const res = await call('PATCH', `/admin/legacy/accounts/${record.guid}`, bossCookie, {
        revert: ['email'],
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().record.email).toBeNull()
      expect(res.json().record.name).toBe(`${PREFIX} Local Ltd`)
    })
  })

  // -------------------------------------------------------------------------
  describe('custom fields', () => {
    // Fields D365 has no column for at all. They live in `d365_overrides.extras`,
    // NOT in `patch`: patch's keys are D365 column names and are what
    // overridden_fields, base and stale_fields are all keyed on, so a custom key
    // there would be reported as an overridden D365 field and would be snapshotted
    // against a column that does not exist.
    const setCustom = (custom, guid = GUID.alpha, cookie = bossCookie) =>
      call('PATCH', `/admin/legacy/accounts/${guid}`, cookie, { custom })

    it('is an empty object on a record nobody has touched, on both query paths', async () => {
      // The fast path skips the merged CTE entirely, so without a default in
      // mapRow the key would appear and disappear depending on whether anyone had
      // ever corrected the entity.
      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      expect(list.meta.merged).toBe(false)
      expect(list.items[0].custom_fields).toEqual({})

      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.custom_fields).toEqual({})
    })

    it('attaches a field D365 does not have, and reads it back everywhere', async () => {
      const res = await setCustom({ site_contact: 'Ana', install_week: 12, on_hold: false })
      expect(res.statusCode).toBe(200)
      expect(res.json().record.custom_fields).toEqual({
        site_contact: 'Ana',
        install_week: 12,
        on_hold: false,
      })

      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      const row = list.items.find((item) => item.guid === GUID.alpha)
      expect(row.custom_fields.site_contact).toBe('Ana')

      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.custom_fields.install_week).toBe(12)
    })

    it('never reports a custom key as an overridden D365 field', async () => {
      // The reason extras is its own column. overridden_fields, base and
      // stale_fields are the D365 columns' vocabulary and must stay that way.
      await setCustom({ site_contact: 'Ana' })
      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.overridden_fields).toEqual([])
      expect(record.override.fields).toEqual([])
      expect(record.override.base).toEqual({})
      expect(record.override.stale_fields).toEqual([])
      // And the D365 columns are untouched.
      expect(record.name).toBe(`${PREFIX} Alpha`)
    })

    it('accumulates across separate requests and loses neither of two at once', async () => {
      await setCustom({ site_contact: 'Ana' })
      await setCustom({ install_week: 12 })
      await Promise.all([setCustom({ courier: 'NZ Post' }), setCustom({ po_ref: 'PO-9' })])

      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.custom_fields).toEqual({
        site_contact: 'Ana',
        install_week: 12,
        courier: 'NZ Post',
        po_ref: 'PO-9',
      })
    })

    it('distinguishes an empty value from a removed field', async () => {
      // Same semantics as set/revert on a D365 column, so there is one rule.
      await setCustom({ site_contact: 'Ana', courier: 'NZ Post' })
      const cleared = (await setCustom({ site_contact: null })).json().record
      expect(cleared.custom_fields).toEqual({ site_contact: null, courier: 'NZ Post' })

      const removed = (await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        revert_custom: ['site_contact'],
      })).json().record
      expect(removed.custom_fields).toEqual({ courier: 'NZ Post' })
    })

    it('keeps the custom fields when the last column correction is reverted', async () => {
      // dropEmptyOverride deletes an override row whose patch is empty. Without
      // its extras guard this revert silently destroys every custom field beside
      // the correction.
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Ours` },
        custom: { site_contact: 'Ana' },
      })
      const after = (await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        revert: ['name'],
      })).json().record
      expect(after.name).toBe(`${PREFIX} Alpha`)
      expect(after.custom_fields).toEqual({ site_contact: 'Ana' })
    })

    it('drops the override row once the last custom field goes too', async () => {
      await setCustom({ site_contact: 'Ana' })
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        revert_custom: ['site_contact'],
      })
      const { rows } = await pool.query('SELECT 1 FROM d365_overrides WHERE guid = $1', [GUID.alpha])
      expect(rows).toHaveLength(0)
    })

    it('survives the import, which is the whole point of storing it here', async () => {
      await setCustom({ site_contact: 'Ana' })
      await importLegacyEntity(pool, 'accounts', [
        { guid: GUID.alpha, name: `${PREFIX} FromD365`, source_file: 'refresh.xlsx', raw: {} },
      ])
      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.custom_fields).toEqual({ site_contact: 'Ana' })
      expect(record.name).toBe(`${PREFIX} FromD365`)
    })

    it('is clerical work: backoffice needs no finance access for it', async () => {
      // touchesCommercial classifies by declared column name and cannot classify
      // a free-form key, so the finance gate deliberately does not reach here.
      // A custom field carries only what a staff member typed.
      const res = await setCustom({ margin_note: 'chased Tuesday' })
      expect(res.statusCode).toBe(200)
    })

    it('accepts a patch that carries nothing but custom fields', async () => {
      const res = await setCustom({ site_contact: 'Ana' })
      expect(res.statusCode).toBe(200)
    })

    it('raises a local record carrying custom fields', async () => {
      const res = await call('POST', '/admin/legacy/accounts', chiefCookie, {
        values: { name: `${PREFIX} Local Ltd` },
        custom: { site_contact: 'Ana' },
      })
      expect(res.statusCode).toBe(201)
      const { record } = res.json()
      expect(record.origin).toBe('local')
      expect(record.custom_fields).toEqual({ site_contact: 'Ana' })
    })

    it('422s a create identified only by custom fields', async () => {
      // Search and filters run over declared columns, so such a record is a blank
      // row in the list that nothing can find — the phantom the null-values rule
      // already refuses, arriving by another door.
      const res = await call('POST', '/admin/legacy/accounts', chiefCookie, {
        values: { name: null },
        custom: { site_contact: 'Ana' },
      })
      expect(res.statusCode).toBe(422)
    })

    describe('validation', () => {
      const REFUSALS = [
        ['a key shadowing a D365 column', { custom: { credit_limit: 1 } }, /credit_limit/],
        ['a key shadowing the record guid', { custom: { guid: 'x' } }, /guid/],
        ['an upper-case key', { custom: { SiteContact: 'Ana' } }, /SiteContact/],
        ['a key with a space', { custom: { 'site contact': 'Ana' } }, /site contact/],
        ['a key starting with a digit', { custom: { '1st_contact': 'Ana' } }, /1st_contact/],
        ['an object value', { custom: { site_contact: { name: 'Ana' } } }, /site_contact/],
        ['an array value', { custom: { site_contact: ['Ana'] } }, /site_contact/],
        ['an over-long value', { custom: { note: 'x'.repeat(MAX_CUSTOM_VALUE_LENGTH + 1) } }, /note/],
        [
          'more fields than the cap',
          {
            custom: Object.fromEntries(
              Array.from({ length: MAX_CUSTOM_FIELDS + 1 }, (_, i) => [`f_${i}`, 'x'])
            ),
          },
          new RegExp(String(MAX_CUSTOM_FIELDS)),
        ],
        ['a key set and reverted at once', { custom: { a_note: 'x' }, revert_custom: ['a_note'] }, /a_note/],
        ['a revert of a key that is not a custom key', { revert_custom: ['Not A Key'] }, /Not A Key/],
      ]

      for (const [label, body, reason] of REFUSALS) {
        it(`refuses ${label} with a 422 naming it`, async () => {
          const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, body)
          expect(res.statusCode).toBe(422)
          // Assert the REASON, or a case passes on the wrong refusal.
          expect(res.json().message).toMatch(reason)
          const { rows } = await pool.query('SELECT 1 FROM d365_overrides WHERE guid = $1', [GUID.alpha])
          expect(rows).toHaveLength(0)
        })
      }

      it('caps the fields per RECORD, not per request, and rolls the write back', async () => {
        // The cap is meaningless per request: the merge is
        // `extras || EXCLUDED.extras`, so fifty fields at a time twice over is a
        // hundred on the record. The request carrying the fifty-first may be
        // carrying exactly one.
        const fill = Object.fromEntries(
          Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) => [`f_${i}`, 'x'])
        )
        expect((await setCustom(fill)).statusCode).toBe(200)

        const res = await setCustom({ one_too_many: 'x' })
        expect(res.statusCode).toBe(422)
        expect(res.json().message).toMatch(new RegExp(String(MAX_CUSTOM_FIELDS)))

        const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
        expect(Object.keys(record.custom_fields)).toHaveLength(MAX_CUSTOM_FIELDS)
        expect(record.custom_fields.one_too_many).toBeUndefined()
      })

      it('lets a replacement in at the cap, since the total does not move', async () => {
        const fill = Object.fromEntries(
          Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) => [`f_${i}`, 'x'])
        )
        await setCustom(fill)
        const res = await setCustom({ f_0: 'corrected' })
        expect(res.statusCode).toBe(200)
        expect(res.json().record.custom_fields.f_0).toBe('corrected')
      })

      it('400s a patch whose custom object is empty', async () => {
        const res = await setCustom({})
        expect(res.statusCode).toBe(400)
      })

      it('keeps a null the schema would otherwise coerce to an empty string', async () => {
        // Ajv runs coerceTypes, so a union type on the values would deliver '' for
        // a deliberate null. The type check lives in override-schema.js instead.
        const { record } = (await setCustom({ site_contact: null })).json()
        expect(record.custom_fields.site_contact).toBeNull()
      })
    })
  })

  // -------------------------------------------------------------------------
  describe('every entity, not just accounts', () => {
    // Three of the four merged projections were never executed by any test —
    // including both timestamp columns and the only multi-term ORDER BY.
    for (const [entity, fixture] of Object.entries(ENTITY_FIXTURES)) {
      it(`merges a correction on ${entity}`, async () => {
        const value = `${PREFIX} Merged ${entity}`
        const patched = await call(`PATCH`, `/admin/legacy/${entity}/${fixture.guid}`, bossCookie, {
          set: { [fixture.column]: value },
        })
        expect(patched.statusCode).toBe(200)
        expect(patched.json().record[fixture.column]).toBe(value)

        const list = (await call('GET', `/admin/legacy/${entity}?q=${encodeURIComponent(value)}`, bossCookie)).json()
        expect(list.meta.merged).toBe(true)
        expect(list.meta.total).toBe(1)
        expect(list.items[0].guid).toBe(fixture.guid)

        const detail = (await call('GET', `/admin/legacy/${entity}/${fixture.guid}`, bossCookie)).json()
        expect(detail.record[fixture.column]).toBe(value)
        expect(detail.record.override.fields).toEqual([fixture.column])
      })

      it(`attaches a custom field to ${entity}`, async () => {
        const patched = await call('PATCH', `/admin/legacy/${entity}/${fixture.guid}`, bossCookie, {
          custom: { site_contact: `Ana ${entity}` },
        })
        expect(patched.statusCode).toBe(200)
        expect(patched.json().record.custom_fields).toEqual({ site_contact: `Ana ${entity}` })

        const detail = (await call('GET', `/admin/legacy/${entity}/${fixture.guid}`, bossCookie)).json()
        expect(detail.record.custom_fields.site_contact).toBe(`Ana ${entity}`)
        expect(detail.record.overridden_fields).toEqual([])
      })

      it(`orders and counts ${entity} identically on both query paths`, async () => {
        const fast = await listLegacy(pool, entity, { q: PREFIX })
        const merged = await listLegacy(pool, entity, { q: PREFIX, forceMerge: true })
        expect(fast.merged).toBe(false)
        expect(merged.total).toBe(fast.total)
        expect(merged.items.map((item) => item.guid)).toEqual(fast.items.map((item) => item.guid))
        expect(merged.items.map(sorted)).toEqual(fast.items.map(sorted))
      })
    }
  })

  // -------------------------------------------------------------------------
  describe('suppression', () => {
    it('hides a record and says what that did and did not do', async () => {
      const res = await call('DELETE', `/admin/legacy/accounts/${GUID.alpha}`, chiefCookie)
      expect(res.statusCode).toBe(200)
      expect(res.json().deleted).toEqual({ entity: 'accounts', guid: GUID.alpha })
      expect(res.json().warning).toMatch(/staged record is untouched/i)

      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      expect(list.items.map((item) => item.guid)).not.toContain(GUID.alpha)
      expect(list.meta.total).toBe(1)
    })

    it('leaves the staging row entirely alone', async () => {
      await call('DELETE', `/admin/legacy/accounts/${GUID.alpha}`, chiefCookie)
      const { rows } = await pool.query('SELECT name FROM legacy_accounts WHERE guid = $1', [GUID.alpha])
      expect(rows[0].name).toBe(`${PREFIX} Alpha`)
    })

    it('surfaces a suppressed record, flagged, when asked for', async () => {
      await call('DELETE', `/admin/legacy/accounts/${GUID.alpha}`, chiefCookie)
      const list = (await call(
        'GET',
        `/admin/legacy/accounts?include_archived=true&q=${encodeURIComponent(PREFIX)}`,
        bossCookie
      )).json()
      const row = list.items.find((item) => item.guid === GUID.alpha)
      expect(row.archived_at).not.toBeNull()
    })

    it('restores it', async () => {
      await call('DELETE', `/admin/legacy/accounts/${GUID.alpha}`, chiefCookie)
      const res = await call('POST', `/admin/legacy/accounts/${GUID.alpha}/restore`, chiefCookie)
      expect(res.statusCode).toBe(200)
      expect(res.json().record.archived_at).toBeNull()
      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      expect(list.items.map((item) => item.guid)).toContain(GUID.alpha)
    })

    it('works on a record nobody has ever corrected', async () => {
      // The common case, and the one an UPDATE would answer with rowCount 0.
      const before = await pool.query('SELECT 1 FROM d365_overrides WHERE guid = $1', [GUID.beta])
      expect(before.rows).toHaveLength(0)
      expect((await call('DELETE', `/admin/legacy/accounts/${GUID.beta}`, chiefCookie)).statusCode).toBe(200)
    })

    it('404s an unknown record', async () => {
      const res = await call('DELETE', `/admin/legacy/accounts/${GUID.missing}`, chiefCookie)
      expect(res.statusCode).toBe(404)
    })
  })

  // -------------------------------------------------------------------------
  describe('surviving the import', () => {
    // The invariant the whole feature exists for. importLegacyEntity upserts
    // every mapped column to EXCLUDED, so a correction stored on the staging row
    // would vanish here with no error at all.
    const reimport = (fields) =>
      importLegacyEntity(pool, 'accounts', [
        {
          guid: GUID.alpha,
          name: `${PREFIX} FromD365`,
          email: 'fresh@ztest.example',
          discount: 0.9,
          source_file: 'refresh.xlsx',
          raw: { 'Account Name': 'refreshed' },
          ...fields,
        },
      ])

    it('keeps a correction and still refreshes everything else', async () => {
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { name: `${PREFIX} Ours`, email: null },
      })
      await reimport()

      const { record } = (await call('GET', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie)).json()
      expect(record.name).toBe(`${PREFIX} Ours`)
      expect(record.email).toBeNull()
      // Not overridden, so the import owns it.
      expect(record.discount).toBe(0.9)
      // And the row underneath really was rewritten.
      const { rows } = await pool.query('SELECT name FROM legacy_accounts WHERE guid = $1', [GUID.alpha])
      expect(rows[0].name).toBe(`${PREFIX} FromD365`)
    })

    it('keeps a suppression', async () => {
      await call('DELETE', `/admin/legacy/accounts/${GUID.alpha}`, chiefCookie)
      await reimport()
      const list = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      expect(list.items.map((item) => item.guid)).not.toContain(GUID.alpha)
    })

    it('leaves a locally raised record alone', async () => {
      const { record } = (await call('POST', '/admin/legacy/accounts', chiefCookie, {
        values: { name: `${PREFIX} Local Ltd` },
      })).json()
      await reimport()
      const after = await call('GET', `/admin/legacy/accounts/${record.guid}`, bossCookie)
      expect(after.statusCode).toBe(200)
      expect(after.json().record.name).toBe(`${PREFIX} Local Ltd`)
    })

    it('applies a correction written before its record had landed', async () => {
      // An override for a guid with no staging row is inert, not an error — the
      // import order is not something the office controls.
      await pool.query(
        `INSERT INTO d365_overrides (entity, guid, patch) VALUES ('accounts', $1, $2::jsonb)`,
        [GUID.missing, JSON.stringify({ name: `${PREFIX} Waiting` })]
      )
      const before = (await call('GET', `/admin/legacy/accounts?q=${encodeURIComponent(PREFIX)}`, bossCookie)).json()
      expect(before.items.map((item) => item.guid)).not.toContain(GUID.missing)

      await importLegacyEntity(pool, 'accounts', [
        { guid: GUID.missing, name: `${PREFIX} Landed`, source_file: 'late.xlsx', raw: {} },
      ])
      const after = (await call('GET', `/admin/legacy/accounts/${GUID.missing}`, bossCookie)).json()
      expect(after.record.name).toBe(`${PREFIX} Waiting`)

      await pool.query('DELETE FROM d365_overrides WHERE guid = $1', [GUID.missing])
      await pool.query('DELETE FROM legacy_accounts WHERE guid = $1', [GUID.missing])
    })
  })

  // -------------------------------------------------------------------------
  describe('guards', () => {
    // Every payload here is schema-VALID: Fastify validates before it runs a
    // preHandler, so a malformed body asserts a 400 and passes with the guard
    // deleted.
    const WRITES = [
      ['POST', '/admin/legacy/accounts', { values: { name: 'x' } }],
      ['PATCH', `/admin/legacy/accounts/${GUID.alpha}`, { set: { name: 'x' } }],
      ['DELETE', `/admin/legacy/accounts/${GUID.alpha}`, undefined],
      ['POST', `/admin/legacy/accounts/${GUID.alpha}/restore`, undefined],
    ]

    for (const [method, url, payload] of WRITES) {
      it(`401s an anonymous ${method} ${url}`, async () => {
        expect((await call(method, url, anonCookie, payload)).statusCode).toBe(401)
      })
      it(`403s a customer ${method} ${url}`, async () => {
        expect((await call(method, url, customerCookie, payload)).statusCode).toBe(403)
      })
    }

    const DIRECTOR_ONLY = WRITES.filter(([method]) => method !== 'PATCH')
    for (const [method, url, payload] of DIRECTOR_ONLY) {
      it(`403s backoffice on the director-only ${method} ${url}`, async () => {
        expect((await call(method, url, bossCookie, payload)).statusCode).toBe(403)
      })
    }

    it('lets backoffice correct a clerical column', async () => {
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { main_phone: '09 333 3333' },
      })
      expect(res.statusCode).toBe(200)
    })

    it('refuses backoffice a commercial column without finance access', async () => {
      // `backoffice` covers the showroom as well as the accounts desk — which is
      // why can_view_finance exists as a second, explicit, revocable permission.
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        set: { credit_limit: 999999 },
      })
      expect(res.statusCode).toBe(403)
      const { rows } = await pool.query('SELECT 1 FROM d365_overrides WHERE guid = $1', [GUID.alpha])
      expect(rows).toHaveLength(0)
    })

    it('refuses a REVERT of a commercial column without finance access too', async () => {
      await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, moneyCookie, {
        set: { credit_limit: 42 },
      })
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, bossCookie, {
        revert: ['credit_limit'],
      })
      expect(res.statusCode).toBe(403)
    })

    it('allows a commercial column with finance access', async () => {
      const res = await call('PATCH', `/admin/legacy/accounts/${GUID.alpha}`, moneyCookie, {
        set: { credit_limit: 999999 },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().record.credit_limit).toBe(999999)
    })
  })
})
