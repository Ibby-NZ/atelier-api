// The supplier roster migration (1 Oct 2026): run with fixture suppliers.
//   - a supplier that is really a house merges into the one that invoices it:
//     price lines and aliases move, its name becomes an alias, it is archived
//   - a house the list files under two suppliers gets "also invoiced by"
//   - a non-textile contact is archived only where nothing points at it
//   - contacts land once, as the list spells them; a blank country fills
//   - a re-run changes nothing; the real migration is a no-op without the roster
//
// Real Postgres, prefixed fixtures.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  CONTACTS,
  MERGES,
  NOT_SUPPLIERS,
  rosterSpec,
  rosterSql,
} from '../migrations/1792790400000_supplier-roster.js'

const P = 'ZZ Roster'
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-')

const runMigrations = (databaseUrl) =>
  runner({ databaseUrl, dir: 'migrations', direction: 'up', migrationsTable: 'pgmigrations', log: () => {} })

describe('the supplier roster', () => {
  let pool
  const id = {}

  const cleanup = async () => {
    await pool.query(`DELETE FROM price_list_items WHERE supplier LIKE $1`, [`${P}%`])
    await pool.query(`DELETE FROM brands WHERE name LIKE $1`, [`${P}%`])
    await pool.query(`DELETE FROM suppliers WHERE name LIKE $1`, [`${P}%`])
  }
  const supplier = async (name, extra = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (name, slug, country, po_email) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, slug(name), extra.country ?? null, extra.po_email ?? null]
    )
    return rows[0].id
  }
  const house = async (name, supplierId) => {
    const { rows } = await pool.query(
      `INSERT INTO brands (name, slug, currency, trade_only, supplier_id) VALUES ($1, $2, 'USD', true, $3) RETURNING id`,
      [name, slug(name), supplierId]
    )
    return rows[0].id
  }
  const spec = () =>
    rosterSpec({
      houses: { [slug(`${P} Trend`)]: `${P} Fabricut`, [slug(`${P} Stroheim`)]: `${P} Fabricut` },
      also: [[slug(`${P} Stroheim`), `${P} Jim Thompson`]],
      merges: { [`${P} Trend`]: `${P} Fabricut` },
      notSuppliers: [`${P} Xero`, `${P} Busy Contact`],
      contacts: [
        { supplier: `${P} Fabricut`, country: 'United States', people: [['Kelli Morgan', 'Kelli.Morgan@fabricut.com']] },
        { supplier: `${P} Fine`, country: 'Austria', people: [['Katharina Farzam', 'Katharina.Farzam@fine.a']] },
      ],
    })

  beforeAll(async () => {
    const config = loadConfig()
    await runMigrations(config.databaseUrl)
    pool = createPool(config.databaseUrl)
    await cleanup()
    id.fabricut = await supplier(`${P} Fabricut`)
    id.trendSupplier = await supplier(`${P} Trend`, { country: 'United States', po_email: 'orders@trend.test' })
    id.jt = await supplier(`${P} Jim Thompson`)
    id.fine = await supplier(`${P} Fine`)
    id.xero = await supplier(`${P} Xero`)
    id.busy = await supplier(`${P} Busy Contact`)
    // The house-named supplier currently invoices its own house.
    id.trend = await house(`${P} Trend`, id.trendSupplier)
    id.stroheim = await house(`${P} Stroheim`, id.fabricut)
    // A non-textile contact something still points at is kept.
    await house(`${P} Busy House`, id.busy)
    await pool.query(`INSERT INTO supplier_aliases (supplier_id, alias) VALUES ($1, $2)`, [id.trendSupplier, `${P} TREND PL`])
    await pool.query(
      `INSERT INTO price_list_items (supplier, product_range, category, code, code_normalized, unit, wholesale_rate, currency, supplier_id, source_file)
       VALUES ($1, $1, 'fabric', 'T1', 't1', 'yard', 10, 'USD', $2, 'fixture')`,
      [`${P} Trend`, id.trendSupplier]
    )
  })

  afterAll(async () => {
    await pool.query(`DELETE FROM supplier_aliases WHERE alias LIKE $1`, [`${P}%`])
    await cleanup()
    await pool.end()
  })

  it('merges the house-named supplier, links the houses, adds also-invoiced-by, archives, and adds contacts once', async () => {
    await pool.query(rosterSql(spec(), { guard: false }))

    const trendSupplier = (await pool.query(`SELECT name, archived_at IS NOT NULL AS archived FROM suppliers WHERE id = $1`, [id.trendSupplier])).rows[0]
    expect(trendSupplier).toEqual({ name: `${P} Trend (merged into ${P} Fabricut)`, archived: true })
    const houses = (await pool.query(`SELECT name, supplier_id FROM brands WHERE id = ANY($1::int[]) ORDER BY name`, [[id.trend, id.stroheim]])).rows
    expect(houses.map((row) => row.supplier_id)).toEqual([id.fabricut, id.fabricut])
    // The price list stays the house's (its text), under the supplier that invoices it.
    expect((await pool.query(`SELECT supplier, supplier_id FROM price_list_items WHERE supplier = $1`, [`${P} Trend`])).rows)
      .toEqual([{ supplier: `${P} Trend`, supplier_id: id.fabricut }])
    // Its aliases, and its own name, now resolve to Fabricut.
    const aliases = (await pool.query(`SELECT alias FROM supplier_aliases WHERE supplier_id = $1 ORDER BY alias`, [id.fabricut])).rows.map((row) => row.alias)
    expect(aliases.sort()).toEqual([`${P} TREND PL`, `${P} Trend`].sort())
    // The target's blanks came from the merged row.
    expect((await pool.query(`SELECT country, po_email FROM suppliers WHERE id = $1`, [id.fabricut])).rows[0]).toEqual({ country: 'United States', po_email: 'orders@trend.test' })

    expect((await pool.query(`SELECT supplier_id FROM brand_additional_suppliers WHERE brand_id = $1`, [id.stroheim])).rows).toEqual([{ supplier_id: id.jt }])

    const archived = (await pool.query(`SELECT name FROM suppliers WHERE id = ANY($1::int[]) AND archived_at IS NOT NULL`, [[id.xero, id.busy]])).rows
    expect(archived).toEqual([{ name: `${P} Xero` }])

    const contacts = (await pool.query(`SELECT supplier_id, name, email FROM supplier_contacts WHERE supplier_id = ANY($1::int[]) ORDER BY name`, [[id.fabricut, id.fine]])).rows
    expect(contacts).toEqual([
      { supplier_id: id.fine, name: 'Katharina Farzam', email: 'Katharina.Farzam@fine.a' },
      { supplier_id: id.fabricut, name: 'Kelli Morgan', email: 'Kelli.Morgan@fabricut.com' },
    ])
    expect((await pool.query(`SELECT country FROM suppliers WHERE id = $1`, [id.fine])).rows[0].country).toBe('Austria')

    // A second run changes nothing.
    await pool.query(rosterSql(spec(), { guard: false }))
    expect((await pool.query(`SELECT count(*)::int AS n FROM supplier_contacts WHERE supplier_id = ANY($1::int[])`, [[id.fabricut, id.fine]])).rows[0].n).toBe(2)
    expect((await pool.query(`SELECT count(*)::int AS n FROM brand_additional_suppliers WHERE brand_id = $1`, [id.stroheim])).rows[0].n).toBe(1)
  })

  it('is a no-op, guarded, on a database without the roster', async () => {
    // The fixtures are prefixed, so the live names the guard looks for are absent
    // on a fresh test database; where they are present, the guard lets it run.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM suppliers WHERE lower(name) IN ('fabricut', 'pierre frey')`)
    if (rows[0].n === 2) return
    const before = (await pool.query(`SELECT count(*)::int AS n FROM supplier_contacts`)).rows[0].n
    await pool.query(rosterSql(rosterSpec()))
    expect((await pool.query(`SELECT count(*)::int AS n FROM supplier_contacts`)).rows[0].n).toBe(before)
  })

  it('the second ruling creates Inter-weave and merges Rubelli into Rubelli Venezia, only where the roster is', async () => {
    const { SPEC, CREATE_INTERWEAVE } = await import('../migrations/1792876800000_supplier-roster-rubelli-interweave.js')
    expect(SPEC.merges).toEqual([{ from: 'Rubelli', into: 'Rubelli Venezia' }])
    expect(SPEC.contacts).toEqual([
      { supplier: 'Inter-weave', country: 'New Zealand', name: 'Customer service', email: 'customerservice@inter-weave.co.nz', role: null },
    ])
    // Guarded like the roster: nothing is created where Fabricut and Pierre Frey are absent.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM suppliers WHERE lower(name) IN ('fabricut', 'pierre frey')`)
    if (rows[0].n === 2) return
    await pool.query(CREATE_INTERWEAVE)
    expect((await pool.query(`SELECT 1 FROM suppliers WHERE lower(name) = 'inter-weave'`)).rows).toHaveLength(0)
  })

  it('names every merge target and contact supplier the list keeps, and never merges a list supplier away', () => {
    const kept = new Set(Object.values(MERGES).map((name) => name.toLowerCase()))
    for (const from of Object.keys(MERGES)) expect(kept.has(from.toLowerCase())).toBe(false)
    for (const { supplier } of CONTACTS) expect(Object.keys(MERGES).map((name) => name.toLowerCase())).not.toContain(supplier.toLowerCase())
    expect(NOT_SUPPLIERS).toHaveLength(18)
  })
})
