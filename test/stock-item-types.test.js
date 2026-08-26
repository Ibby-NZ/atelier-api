import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { getLegacy, listLegacy } from '../src/legacy/legacy-read.js'
import { setLegacyOverrides } from '../src/legacy/legacy-overrides.js'
import {
  importStockItemTypes,
  parseItemTypeSheet,
  planItemTypes,
} from '../src/seed/import-stock-item-types.js'
import { buildWorkbook } from '../scripts/lib/xlsx-write.js'

// Reading a corrected category workbook back onto the D365 stock ledger, and
// the category the merged read derives from the item type it corrects.

const PREFIX = 'item-type-test'

// Fixed guids so the cleanup can name them; the ledger's key is the D365 guid.
const GUID = {
  towel: '11111111-2222-4333-8444-555555550001',
  fabric: '11111111-2222-4333-8444-555555550002',
  unmapped: '11111111-2222-4333-8444-555555550003',
  blank: '11111111-2222-4333-8444-555555550004',
}
const ABSENT_GUID = '11111111-2222-4333-8444-5555555500ff'
const FIXTURE_GUIDS = [...Object.values(GUID), ABSENT_GUID]

const HEADER = [
  'GUID', 'Range', 'Item Code', 'Name', 'Supplier', 'Item Type', 'Measure',
  'On Hand', 'Available', 'Status', 'Suggested Category', 'Category',
]

/** A category workbook carrying `[guid, itemType]` pairs, in the real shape. */
const workbookOf = (pairs, header = HEADER) =>
  buildWorkbook([
    {
      name: 'All Stock',
      rows: [
        [...header],
        ...pairs.map(([guid, itemType]) => [
          guid, `${PREFIX} range`, `${PREFIX}-CODE`, `${PREFIX} name`, 'A Supplier',
          itemType, 'P/M', 1, 1, 'Active', '', '',
        ]),
      ],
    },
  ])

const seedStock = async (pool) => {
  // What D365 says today: the two the corrected sheet moves, one whose type the
  // vocabulary has no word for, and one D365 left blank.
  const rows = [
    [GUID.towel, 'Accessories'],
    [GUID.fabric, 'Fabrics'],
    [GUID.unmapped, 'Leather'],
    [GUID.blank, null],
  ]
  for (const [guid, itemType] of rows) {
    await pool.query(
      `INSERT INTO legacy_stock_items (guid, item_code, name, item_type, source_file, raw)
       VALUES ($1, $2, $3, $4, 'item-types.xlsx', '{}'::jsonb)`,
      [guid, `${PREFIX}-${guid.slice(-4)}`, `${PREFIX} item`, itemType]
    )
  }
}

const cleanup = async (pool) => {
  await pool.query('DELETE FROM d365_overrides WHERE guid = ANY($1::uuid[])', [FIXTURE_GUIDS])
  await pool.query('DELETE FROM legacy_stock_items WHERE item_code LIKE $1', [`${PREFIX}-%`])
}

describe('reading a corrected category workbook back', () => {
  let pool

  const itemTypeOf = async (guid) => (await getLegacy(pool, 'stock', guid)).item_type
  const categoryOf = async (guid) => (await getLegacy(pool, 'stock', guid)).category

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
  })

  beforeEach(async () => {
    await cleanup(pool)
    await seedStock(pool)
  })

  afterAll(async () => {
    await cleanup(pool)
    await pool.end()
  })

  describe('the parser', () => {
    it('matches its two columns by NAME, not by position', async () => {
      // Staff sort, hide and delete columns in Excel. A file that still says
      // which row is which and what it should be called is one this can honour.
      const shuffled = ['Name', 'Item Type', 'Supplier', 'GUID']
      const workbook = buildWorkbook([
        {
          name: 'All Stock',
          rows: [shuffled, [`${PREFIX} name`, 'Towels', 'A Supplier', GUID.towel]],
        },
      ])
      const { rows } = parseItemTypeSheet(workbook)
      expect(rows).toEqual([{ row: 2, guid: GUID.towel, itemType: 'Towels' }])
    })

    it('refuses a workbook that is not a category sheet at all', () => {
      const notASheet = buildWorkbook([{ name: 'All Stock', rows: [['Alpha', 'Beta'], ['1', '2']] }])
      expect(() => parseItemTypeSheet(notASheet)).toThrow(/not a category workbook/)
    })

    it('refuses anything that is not a Buffer', () => {
      expect(() => parseItemTypeSheet('a file path')).toThrow(/Buffer/)
    })

    it('ignores a row the office did not get to', async () => {
      // A blank Item Type is "did not reach this row", which is exactly why the
      // column may be empty. It is not a correction and it is not an error.
      const { rows, skipped } = parseItemTypeSheet(
        workbookOf([[GUID.towel, ''], [GUID.fabric, 'Fabrics']])
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].guid).toBe(GUID.fabric)
      expect(skipped).toBe(1)
    })

    it('numbers rows the way Excel does, counting the header', async () => {
      const { rows } = parseItemTypeSheet(
        workbookOf([[GUID.fabric, 'Fabrics'], [GUID.towel, 'Towels']])
      )
      expect(rows.map((row) => row.row)).toEqual([2, 3])
    })
  })

  describe('the plan', () => {
    // The shape currentItemTypes returns: what the CRM shows (`effective`),
    // what D365 itself says (`staged`), and whether a correction is in force.
    const current = new Map([
      [GUID.towel, { effective: 'Accessories', staged: 'Accessories', corrected: false }],
      [GUID.fabric, { effective: 'Towels', staged: 'Fabrics', corrected: true }],
    ])

    it('splits the file four ways', () => {
      const plan = planItemTypes(
        [
          { row: 2, guid: GUID.towel, itemType: 'Towels' }, // differs -> set
          { row: 3, guid: GUID.fabric, itemType: 'Towels' }, // agrees -> unchanged
          { row: 4, guid: ABSENT_GUID, itemType: 'Towels' }, // not in the ledger
        ],
        current
      )
      expect(plan.set.map((row) => row.guid)).toEqual([GUID.towel])
      expect(plan.unchanged.map((row) => row.guid)).toEqual([GUID.fabric])
      expect(plan.missing.map((row) => row.guid)).toEqual([ABSENT_GUID])
      expect(plan.revert).toEqual([])
    })

    it('REVERTS where the sheet agrees with D365 on a corrected row', () => {
      // Without this the workbook is a one-way ratchet: the office could
      // introduce a correction through it but never withdraw one, and the file
      // would go on saying something different from the screen.
      const withStaged = new Map([
        [GUID.fabric, { effective: 'Towels', corrected: true, staged: 'Fabrics' }],
      ])
      const plan = planItemTypes([{ row: 2, guid: GUID.fabric, itemType: 'Fabrics' }], withStaged)
      expect(plan.revert.map((row) => row.guid)).toEqual([GUID.fabric])
      expect(plan.set).toEqual([])
    })
  })

  describe('applying it', () => {
    it('writes the correction as an override, never onto the staging row', async () => {
      // The import upserts every mapped column on the guid and re-runs until
      // cutover, so an UPDATE here would vanish at the next run with no error.
      await importStockItemTypes(pool, workbookOf([[GUID.towel, 'Towels']]))

      const { rows } = await pool.query(
        'SELECT item_type FROM legacy_stock_items WHERE guid = $1',
        [GUID.towel]
      )
      expect(rows[0].item_type).toBe('Accessories')
      expect(await itemTypeOf(GUID.towel)).toBe('Towels')
    })

    it('snapshots what D365 said, per key, so a later drift is reportable', async () => {
      await importStockItemTypes(pool, workbookOf([[GUID.towel, 'Towels']]))
      const { rows } = await pool.query(
        `SELECT patch, base FROM d365_overrides WHERE entity = 'stock' AND guid = $1`,
        [GUID.towel]
      )
      expect(rows[0].patch).toEqual({ item_type: 'Towels' })
      expect(rows[0].base).toEqual({ item_type: 'Accessories' })
    })

    it('is a no-op on a second run', async () => {
      // Compared against the MERGED value, not the staged one. The staging row
      // goes on saying `Accessories` for ever, so a script diffing the sheet
      // against legacy_stock_items alone would rewrite every correction, every
      // run, and report work it did not do.
      const file = workbookOf([[GUID.towel, 'Towels'], [GUID.fabric, 'Fabrics']])
      const first = await importStockItemTypes(pool, file)
      expect(first.summary).toMatchObject({ corrected: 1, unchanged: 1, reverted: 0 })

      const second = await importStockItemTypes(pool, file)
      expect(second.summary).toMatchObject({ corrected: 0, unchanged: 2, reverted: 0 })
    })

    it('withdraws a correction the sheet no longer makes', async () => {
      await importStockItemTypes(pool, workbookOf([[GUID.fabric, 'Towels']]))
      expect(await itemTypeOf(GUID.fabric)).toBe('Towels')

      const back = await importStockItemTypes(pool, workbookOf([[GUID.fabric, 'Fabrics']]))
      expect(back.summary).toMatchObject({ reverted: 1, corrected: 0 })
      expect(await itemTypeOf(GUID.fabric)).toBe('Fabrics')
      // The whole override row goes with the last key it held.
      const { rows } = await pool.query(
        `SELECT count(*)::int AS count FROM d365_overrides WHERE guid = $1`,
        [GUID.fabric]
      )
      expect(rows[0].count).toBe(0)
    })

    it('reports a guid the ledger does not have and writes nothing for it', async () => {
      const result = await importStockItemTypes(
        pool,
        workbookOf([[ABSENT_GUID, 'Towels'], [GUID.towel, 'Towels']])
      )
      expect(result.summary).toMatchObject({ missing: 1, corrected: 1 })
      const { rows } = await pool.query(
        'SELECT count(*)::int AS count FROM d365_overrides WHERE guid = $1',
        [ABSENT_GUID]
      )
      expect(rows[0].count).toBe(0)
    })

    it('writes nothing at all under --dry-run', async () => {
      const result = await importStockItemTypes(pool, workbookOf([[GUID.towel, 'Towels']]), {
        dryRun: true,
      })
      expect(result.summary.corrected).toBe(1)
      expect(await itemTypeOf(GUID.towel)).toBe('Accessories')
    })

    it('balances: every row read is accounted for', async () => {
      const result = await importStockItemTypes(
        pool,
        workbookOf([
          [GUID.towel, 'Towels'],
          [GUID.fabric, 'Fabrics'],
          [ABSENT_GUID, 'Towels'],
        ])
      )
      const { rows, corrected, reverted, unchanged, missing } = result.summary
      expect(corrected + reverted + unchanged + missing).toBe(rows)
    })

    it('refuses a workbook with no usable rows rather than reporting a clean run', async () => {
      await expect(importStockItemTypes(pool, workbookOf([]))).rejects.toThrow(/no rows/)
    })
  })

  describe('the category the read derives', () => {
    it('puts a category on a stock row from its item type', async () => {
      expect(await categoryOf(GUID.fabric)).toBe('fabric')
    })

    it('follows a correction — the category is derived from the MERGED item type', async () => {
      expect(await categoryOf(GUID.towel)).toBe('accessory')
      await importStockItemTypes(pool, workbookOf([[GUID.towel, 'Towels']]))
      expect(await categoryOf(GUID.towel)).toBe('towel')
    })

    it('is null where the vocabulary has no word for the type, and where D365 has none', async () => {
      expect(await categoryOf(GUID.unmapped)).toBeNull()
      expect(await categoryOf(GUID.blank)).toBeNull()
    })

    it('is on the LIST read as well as the detail, on both query paths', async () => {
      // The merged read has a fast path (no overrides for this entity) and a
      // slow one; the derivation is in mapRow, which both go through, and this
      // is what proves it rather than assuming.
      const before = await listLegacy(pool, 'stock', { q: `${PREFIX} item`, limit: 200 })
      expect(before.items.find((item) => item.guid === GUID.fabric).category).toBe('fabric')

      await setLegacyOverrides(pool, 'stock', GUID.towel, { set: { item_type: 'Towels' } })

      const after = await listLegacy(pool, 'stock', { q: `${PREFIX} item`, limit: 200 })
      expect(after.merged).toBe(true)
      expect(after.items.find((item) => item.guid === GUID.towel).category).toBe('towel')
    })
  })
})
