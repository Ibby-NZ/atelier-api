import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SAMPLE_STATUSES,
  getSample,
  getSampleByBarcode,
  listSampleLoans,
  listSamples,
} from '../src/samples/admin-samples.js'

// Fixtures are prefix-namespaced and cleaned up by prefix. The pattern is
// anchored on `${PREFIX}%` with no separator, so it matches every name this
// suite writes rather than only the ones it inserts.
const PREFIX = 'w4-read-test'

// The columns the order state machine's reservation arithmetic owns, and the
// table in a SQL position. A read model may say "inventory" in prose; it may not
// query it.
const STOCK_QUANTITY_COLUMNS = /qty_available|qty_reserved/
const INVENTORY_IN_SQL = /(?:INTO|FROM|JOIN|UPDATE)\s+inventory\b/i

const DAY_MS = 86_400_000
const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString()

const runMigrations = (databaseUrl) =>
  runner({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  })

const insertShowroom = (pool, name) =>
  pool
    .query(`INSERT INTO showrooms (name) VALUES ($1) RETURNING id`, [name])
    .then(({ rows }) => rows[0].id)

const insertSupplier = (pool, { name, slug }) =>
  pool
    .query(`INSERT INTO suppliers (name, slug) VALUES ($1, $2) RETURNING id`, [name, slug])
    .then(({ rows }) => rows[0].id)

const insertColourway = async (pool, { slug, sku, design }) => {
  const brand = await pool.query(
    `INSERT INTO brands (name, slug, currency, trade_only)
     VALUES ($1, $2, 'NZD', false) RETURNING id`,
    [`${PREFIX} house ${slug}`, slug]
  )
  const product = await pool.query(
    `INSERT INTO products (brand_id, name, slug, product_type, currency)
     VALUES ($1, $2, $3, 'fabric', 'NZD') RETURNING id`,
    [brand.rows[0].id, design, `${slug}-design`]
  )
  const colourway = await pool.query(
    `INSERT INTO colourways (product_id, name, sku) VALUES ($1, $2, $3) RETURNING id`,
    [product.rows[0].id, `${PREFIX} colour`, sku]
  )
  return colourway.rows[0].id
}

const insertSample = (pool, { barcode, ...rest }) =>
  pool
    .query(
      `INSERT INTO samples (barcode, label, colourway_id, supplier_id, showroom_id,
                            sample_type, location, status, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'in_library'), $9)
       RETURNING id`,
      [
        barcode,
        rest.label ?? null,
        rest.colourwayId ?? null,
        rest.supplierId ?? null,
        rest.showroomId ?? null,
        rest.sampleType ?? null,
        rest.location ?? null,
        rest.status ?? null,
        rest.archivedAt ?? null,
      ]
    )
    .then(({ rows }) => rows[0].id)

const openLoan = (pool, sampleId, holderName, extra = {}) =>
  pool
    .query(
      `INSERT INTO sample_loans (sample_id, holder_name, due_back_at, out_at)
       VALUES ($1, $2, $3, COALESCE($4, now())) RETURNING id`,
      [sampleId, holderName, extra.dueBackAt ?? null, extra.outAt ?? null]
    )
    .then(({ rows }) => rows[0].id)

const closeLoan = (pool, id) =>
  pool.query(`UPDATE sample_loans SET returned_at = now() WHERE id = $1`, [id])

const cleanup = async (pool) => {
  // Loans first (sample_id is RESTRICT), then samples ahead of brands, whose
  // cascade cannot get past samples.colourway_id — also RESTRICT.
  await pool.query(
    `DELETE FROM sample_loans WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM brands WHERE slug LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM suppliers WHERE slug LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM showrooms WHERE name LIKE $1`, [`${PREFIX}%`])
}

/**
 * A pool that records every statement and answers plausibly. `listSamples` reads
 * `rows[0].total` from its count query, so one shape serves both queries.
 */
const recordingPool = (statements) => ({
  query: async (text) => {
    statements.push(text)
    return { rows: [{ total: 0, id: 1, open_loan_id: null }] }
  },
})

describe('samples read models', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  beforeEach(async () => {
    await cleanup(pool)
  })

  describe('listSamples', () => {
    it('lists live samples and hides archived ones until asked', async () => {
      await insertSample(pool, { barcode: `${PREFIX}-0001` })
      await insertSample(pool, { barcode: `${PREFIX}-0002`, archivedAt: new Date().toISOString() })

      const live = await listSamples(pool, { q: PREFIX })
      expect(live.total).toBe(1)
      expect(live.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0001`])

      const all = await listSamples(pool, { q: PREFIX, includeArchived: true })
      expect(all.total).toBe(2)
      expect(all.samples.map((row) => row.barcode)).toEqual([
        `${PREFIX}-0001`,
        `${PREFIX}-0002`,
      ])
    })

    it('filters by status, and status is not archiving', async () => {
      // `retired` is a statement about the physical object; archiving is the
      // removal of the row. A retired sample is still a live row.
      await insertSample(pool, { barcode: `${PREFIX}-0010`, status: 'in_library' })
      await insertSample(pool, { barcode: `${PREFIX}-0011`, status: 'retired' })
      await insertSample(pool, { barcode: `${PREFIX}-0012`, status: 'missing' })

      const retired = await listSamples(pool, { q: PREFIX, status: 'retired' })
      expect(retired.total).toBe(1)
      expect(retired.samples[0].barcode).toBe(`${PREFIX}-0011`)
      expect(retired.samples[0].archived_at).toBeNull()
    })

    it('filters by showroom and by supplier', async () => {
      const showroom = await insertShowroom(pool, `${PREFIX} Ponsonby`)
      const other = await insertShowroom(pool, `${PREFIX} Wellington`)
      const supplier = await insertSupplier(pool, {
        name: `${PREFIX} Rubelli`,
        slug: `${PREFIX}-rubelli`,
      })

      await insertSample(pool, {
        barcode: `${PREFIX}-0020`,
        showroomId: showroom,
        supplierId: supplier,
      })
      await insertSample(pool, { barcode: `${PREFIX}-0021`, showroomId: other })
      await insertSample(pool, { barcode: `${PREFIX}-0022` })

      const byShowroom = await listSamples(pool, { q: PREFIX, showroomId: showroom })
      expect(byShowroom.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0020`])
      expect(byShowroom.samples[0].showroom_name).toBe(`${PREFIX} Ponsonby`)

      const bySupplier = await listSamples(pool, { q: PREFIX, supplierId: supplier })
      expect(bySupplier.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0020`])
      expect(bySupplier.samples[0].supplier_name).toBe(`${PREFIX} Rubelli`)
    })

    it('searches the tag, the shelf and the design', async () => {
      const colourwayId = await insertColourway(pool, {
        slug: `${PREFIX}-pf`,
        sku: `${PREFIX}-SKU-991`,
        design: `${PREFIX} Atlas`,
      })
      await insertSample(pool, {
        barcode: `${PREFIX}-0030`,
        colourwayId,
        label: 'Atlas hanger',
        location: 'Bay 4',
      })
      await insertSample(pool, { barcode: `${PREFIX}-0031`, label: 'Something else' })

      for (const term of ['Atlas hanger', 'Bay 4', `${PREFIX} Atlas`, `${PREFIX}-SKU-991`]) {
        const found = await listSamples(pool, { q: term })
        expect(found.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0030`])
      }
    })

    it('escapes LIKE wildcards in the search term', async () => {
      await insertSample(pool, { barcode: `${PREFIX}-100%pct` })
      await insertSample(pool, { barcode: `${PREFIX}-100xpct` })

      const found = await listSamples(pool, { q: '100%pct' })
      expect(found.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-100%pct`])
    })

    it('ignores a blank search term rather than matching nothing', async () => {
      await insertSample(pool, { barcode: `${PREFIX}-0040`, label: `${PREFIX} label` })
      const found = await listSamples(pool, { q: '   ' })
      expect(found.total).toBeGreaterThan(0)
    })

    it('pages, and meta.total is the filtered total', async () => {
      for (const suffix of ['0050', '0051', '0052']) {
        await insertSample(pool, { barcode: `${PREFIX}-${suffix}` })
      }

      const first = await listSamples(pool, { q: PREFIX, page: 1, limit: 2 })
      expect(first.total).toBe(3)
      expect(first.samples.map((row) => row.barcode)).toEqual([
        `${PREFIX}-0050`,
        `${PREFIX}-0051`,
      ])

      const second = await listSamples(pool, { q: PREFIX, page: 2, limit: 2 })
      expect(second.total).toBe(3)
      expect(second.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0052`])
    })

    it('clamps an over-large limit and falls back to the defaults', async () => {
      await insertSample(pool, { barcode: `${PREFIX}-0060` })
      // The module clamps because it is also called directly; the route spends
      // MAX_LIMIT as its schema maximum, so an over-large limit is a 400 there.
      const clamped = await listSamples(pool, { q: PREFIX, limit: MAX_LIMIT + 500 })
      expect(clamped.samples).toHaveLength(1)
      const defaulted = await listSamples(pool, { q: PREFIX, page: 0, limit: -3 })
      expect(defaulted.samples).toHaveLength(1)
      expect(DEFAULT_LIMIT).toBeLessThanOrEqual(MAX_LIMIT)
    })

    it('embeds the open loan and counts every movement', async () => {
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0070`, status: 'out' })
      const closed = await openLoan(pool, sampleId, 'First borrower')
      await closeLoan(pool, closed)
      await openLoan(pool, sampleId, 'Ana at the counter', { dueBackAt: daysFromNow(7) })

      const { samples } = await listSamples(pool, { q: `${PREFIX}-0070` })
      expect(samples).toHaveLength(1)
      expect(samples[0].loan_count).toBe(2)
      expect(samples[0].open_loan).toMatchObject({ holder_name: 'Ana at the counter' })
      expect(samples[0].open_loan.due_back_at).toBeInstanceOf(Date)
      expect(samples[0].overdue).toBe(false)
    })

    it('embeds no open loan for a sample that is back, and still counts its history', async () => {
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0071` })
      const loanId = await openLoan(pool, sampleId, 'Returned it')
      await closeLoan(pool, loanId)

      const { samples } = await listSamples(pool, { q: `${PREFIX}-0071` })
      expect(samples[0].open_loan).toBeNull()
      expect(samples[0].loan_count).toBe(1)
      expect(samples[0].overdue).toBe(false)
    })

    it('derives overdue from the open loan and never from a stored flag', async () => {
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0080`, status: 'out' })
      const loanId = await openLoan(pool, sampleId, 'Late borrower', {
        dueBackAt: daysFromNow(3),
      })

      const before = await listSamples(pool, { q: `${PREFIX}-0080` })
      expect(before.samples[0].overdue).toBe(false)
      const stampBefore = before.samples[0].updated_at

      // Nothing about the SAMPLE changes — only the loan's due date moves into
      // the past. A stored boolean would still read false here.
      await pool.query(`UPDATE sample_loans SET due_back_at = $1 WHERE id = $2`, [
        daysFromNow(-1),
        loanId,
      ])

      const after = await listSamples(pool, { q: `${PREFIX}-0080` })
      expect(after.samples[0].overdue).toBe(true)
      expect(after.samples[0].updated_at).toEqual(stampBefore)
    })

    it('is not overdue when the loan carries no due date', async () => {
      // Plenty of samples go out with no date agreed; inventing one would make
      // them late on a deadline nobody set.
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0081`, status: 'out' })
      await openLoan(pool, sampleId, 'No date agreed')

      const { samples } = await listSamples(pool, { q: `${PREFIX}-0081` })
      expect(samples[0].open_loan.due_back_at).toBeNull()
      expect(samples[0].overdue).toBe(false)
    })

    it('is not overdue once a late sample is back', async () => {
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0082` })
      const loanId = await openLoan(pool, sampleId, 'Was late', { dueBackAt: daysFromNow(-9) })
      await closeLoan(pool, loanId)

      const { samples } = await listSamples(pool, { q: `${PREFIX}-0082` })
      expect(samples[0].overdue).toBe(false)
    })

    it('filters on overdue in both directions', async () => {
      const late = await insertSample(pool, { barcode: `${PREFIX}-0090`, status: 'out' })
      await openLoan(pool, late, 'Late borrower', { dueBackAt: daysFromNow(-2) })
      const onTime = await insertSample(pool, { barcode: `${PREFIX}-0091`, status: 'out' })
      await openLoan(pool, onTime, 'On time', { dueBackAt: daysFromNow(5) })
      await insertSample(pool, { barcode: `${PREFIX}-0092` })

      const overdue = await listSamples(pool, { q: PREFIX, overdue: true })
      expect(overdue.total).toBe(1)
      expect(overdue.samples.map((row) => row.barcode)).toEqual([`${PREFIX}-0090`])

      // False is "not late back" — out on time, or on the shelf.
      const notOverdue = await listSamples(pool, { q: PREFIX, overdue: false })
      expect(notOverdue.total).toBe(2)
      expect(notOverdue.samples.map((row) => row.barcode)).toEqual([
        `${PREFIX}-0091`,
        `${PREFIX}-0092`,
      ])

      const unfiltered = await listSamples(pool, { q: PREFIX })
      expect(unfiltered.total).toBe(3)
    })

    it('carries the design, the house and the showroom on every row', async () => {
      // Nothing on a sample row names its parents, and the point of the register
      // is not knowing which design the object in your hand belongs to.
      const showroomId = await insertShowroom(pool, `${PREFIX} Parnell`)
      const colourwayId = await insertColourway(pool, {
        slug: `${PREFIX}-ctx`,
        sku: `${PREFIX}-SKU-100`,
        design: `${PREFIX} Cappuccino`,
      })
      await insertSample(pool, { barcode: `${PREFIX}-0100`, colourwayId, showroomId })

      const { samples } = await listSamples(pool, { q: `${PREFIX}-0100` })
      expect(samples[0]).toMatchObject({
        colourway_name: `${PREFIX} colour`,
        colourway_sku: `${PREFIX}-SKU-100`,
        product_name: `${PREFIX} Cappuccino`,
        brand_name: `${PREFIX} house ${PREFIX}-ctx`,
        showroom_name: `${PREFIX} Parnell`,
      })
    })

    it('reads a sample carrying no catalogue link', async () => {
      // Plenty of samples predate the catalogue or come from a house Atelier
      // does not stock; `label` is what identifies those.
      await insertSample(pool, { barcode: `${PREFIX}-0101`, label: 'Unbranded memo' })
      const { samples } = await listSamples(pool, { q: `${PREFIX}-0101` })
      expect(samples[0]).toMatchObject({
        colourway_id: null,
        colourway_name: null,
        product_name: null,
        brand_name: null,
        label: 'Unbranded memo',
      })
    })

    it('counts a row once however many loans it has had', async () => {
      // The open-loan join is safe to share with the count query only because
      // `sample_loans_open_unique` holds it to one row.
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0110` })
      for (const holder of ['One', 'Two', 'Three']) {
        const id = await openLoan(pool, sampleId, holder)
        await closeLoan(pool, id)
      }
      const { samples, total } = await listSamples(pool, { q: `${PREFIX}-0110` })
      expect(total).toBe(1)
      expect(samples).toHaveLength(1)
      expect(samples[0].loan_count).toBe(3)
    })
  })

  describe('getSample and getSampleByBarcode', () => {
    it('returns the row with its history, newest movement first', async () => {
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0200`, status: 'out' })
      const closed = await openLoan(pool, sampleId, 'Older borrower', {
        outAt: daysFromNow(-30),
      })
      await closeLoan(pool, closed)
      await openLoan(pool, sampleId, 'Current borrower', { dueBackAt: daysFromNow(-1) })

      const sample = await getSample(pool, sampleId)
      expect(sample.barcode).toBe(`${PREFIX}-0200`)
      expect(sample.overdue).toBe(true)
      expect(sample.loans.map((loan) => loan.holder_name)).toEqual([
        'Current borrower',
        'Older borrower',
      ])
      expect(sample.loans[0].overdue).toBe(true)
      expect(sample.loans[1].overdue).toBe(false)
      expect(sample.loans[1].returned_at).toBeInstanceOf(Date)
    })

    it('returns null for an unknown id and an unknown barcode', async () => {
      expect(await getSample(pool, 987_654_321)).toBeNull()
      expect(await getSampleByBarcode(pool, `${PREFIX}-nothing-here`)).toBeNull()
    })

    it('does not filter archived rows', async () => {
      const sampleId = await insertSample(pool, {
        barcode: `${PREFIX}-0210`,
        archivedAt: new Date().toISOString(),
      })
      const byId = await getSample(pool, sampleId)
      expect(byId.archived_at).toBeInstanceOf(Date)
      const byBarcode = await getSampleByBarcode(pool, `${PREFIX}-0210`)
      expect(byBarcode.id).toBe(sampleId)
    })

    it('matches a barcode exactly, never as a prefix or a pattern', async () => {
      // The scanner needs one deterministic answer, 200 or 404 — never a
      // filtered list.
      const exact = await insertSample(pool, { barcode: `${PREFIX}-0220` })
      await insertSample(pool, { barcode: `${PREFIX}-02201` })

      const found = await getSampleByBarcode(pool, `${PREFIX}-0220`)
      expect(found.id).toBe(exact)
      expect(await getSampleByBarcode(pool, `${PREFIX}-022`)).toBeNull()
      expect(await getSampleByBarcode(pool, `${PREFIX}-0220%`)).toBeNull()
    })

    it('lists the loans of a sample that has none', async () => {
      const sampleId = await insertSample(pool, { barcode: `${PREFIX}-0230` })
      expect(await listSampleLoans(pool, sampleId)).toEqual([])
      const sample = await getSample(pool, sampleId)
      expect(sample.loans).toEqual([])
      expect(sample.open_loan).toBeNull()
      expect(sample.loan_count).toBe(0)
    })
  })

  describe('invariants', () => {
    it('agrees with the live status CHECK constraint', async () => {
      const { rows } = await pool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'samples_status_check'`
      )
      expect(rows).toHaveLength(1)
      const inConstraint = [...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])
      expect(inConstraint.length).toBeGreaterThan(0)
      expect([...inConstraint].sort()).toEqual([...SAMPLE_STATUSES].sort())
    })

    it('issues no statement that reads or writes stock', async () => {
      // The static counterpart is the source scan in test/samples-schema.test.js;
      // this is the runtime one, over the SQL these read models actually send.
      const statements = []
      const stub = recordingPool(statements)
      await listSamples(stub, { q: 'anything', overdue: true, includeArchived: true })
      await getSample(stub, 1)
      await getSampleByBarcode(stub, 'barcode')
      await listSampleLoans(stub, 1)

      // A recorder that captured nothing would pass every check below vacuously.
      expect(statements.length).toBeGreaterThan(0)
      const offending = statements.filter(
        (sql) => STOCK_QUANTITY_COLUMNS.test(sql) || INVENTORY_IN_SQL.test(sql)
      )
      expect(offending).toEqual([])
    })

    it('binds every filter value rather than interpolating it', async () => {
      const statements = []
      const stub = recordingPool(statements)
      await listSamples(stub, {
        q: "'; DROP TABLE samples; --",
        status: 'out',
        showroomId: 7,
        supplierId: 9,
      })
      expect(statements.length).toBe(2)
      for (const sql of statements) {
        expect(sql).not.toContain('DROP TABLE')
      }
    })
  })
})
