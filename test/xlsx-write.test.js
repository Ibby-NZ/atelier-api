// The writer's proof is a round trip through the reader that was already here:
// scripts/lib/xlsx.js has parsed every D365 export in this repo, so a workbook
// it can read is a workbook in the same shape as the ones Excel produced. The
// checks that a reader cannot make — schema element ORDER, the relationship
// graph, the content types — are asserted against the part text directly,
// because those are what Excel silently "repairs" (i.e. discards) rather than
// reports.
import { describe, expect, it } from 'vitest'
import { buildWorkbook, columnLetter, escapeXml, sheetName } from '../scripts/lib/xlsx-write.js'
import { openWorkbook, sharedStrings, sheetRows } from '../scripts/lib/xlsx.js'

/** Read a workbook back as `{ name: rows }`, cells as plain arrays. */
const readBack = (buffer, sheetCount) => {
  const zip = openWorkbook(buffer)
  const strings = sharedStrings(zip)
  const workbook = zip.read('xl/workbook.xml').toString('utf8')
  const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((match) => match[1])
  expect(names).toHaveLength(sheetCount)
  return Object.fromEntries(
    names.map((name, at) => {
      const read = [...sheetRows(zip, `xl/worksheets/sheet${at + 1}.xml`, strings)]
      // An empty cell is omitted from the part entirely, so a row is padded back
      // out to the header's width — the reader reports what is there, and what
      // is there for a blank Category is nothing.
      const width = Math.max(...read.map(([, cells]) => Math.max(-1, ...cells.keys()) + 1))
      const rows = read.map(([, cells]) =>
        Array.from({ length: width }, (_, column) => cells.get(column) ?? '')
      )
      return [name, rows]
    })
  )
}

const partOf = (buffer, name) => openWorkbook(buffer).read(name).toString('utf8')

describe('columnLetter', () => {
  it('counts in base 26 with no zero digit', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual([
      'A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA',
    ])
  })
})

describe('escapeXml', () => {
  it('escapes the five markup characters and nothing else', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;')
  })

  it('escapes an ampersand once, not twice', () => {
    // & -> &amp; must not then have its own & re-escaped into &amp;amp;.
    expect(escapeXml('C & C')).toBe('C &amp; C')
    expect(escapeXml('&lt;')).toBe('&amp;lt;')
  })

  it('drops the C0 controls XML forbids and keeps tab, newline and return', () => {
    expect(escapeXml('a\u0000b\u0008c\u001Fd')).toBe('abcd')
    expect(escapeXml('a\tb\nc\rd')).toBe('a\tb\nc\rd')
  })
})

describe('sheetName', () => {
  it('replaces the characters Excel forbids in a tab name', () => {
    expect(sheetName('P/L: 2026 [draft]*?\\x', new Set())).toBe('P L  2026  draft    x')
  })

  it('truncates at 31 characters', () => {
    expect(sheetName('A'.repeat(40), new Set())).toBe('A'.repeat(31))
  })

  it('uniquifies case-insensitively, because Excel does', () => {
    const taken = new Set()
    expect(sheetName('Fabric', taken)).toBe('Fabric')
    expect(sheetName('FABRIC', taken)).toBe('FABRIC (2)')
    expect(sheetName('fabric', taken)).toBe('fabric (3)')
  })

  it('keeps a uniquified long name inside the limit', () => {
    const taken = new Set()
    sheetName('B'.repeat(40), taken)
    const second = sheetName('B'.repeat(40), taken)
    expect(second).toHaveLength(31)
    expect(second.endsWith(' (2)')).toBe(true)
  })

  it('never produces an empty name', () => {
    expect(sheetName('///', new Set())).toBe('Sheet')
  })
})

describe('buildWorkbook', () => {
  const sheets = [
    {
      name: 'All Products',
      rows: [
        ['GUID', 'Code', 'Category'],
        ['g-1', '00815', ''],
        ['g-2', 'C & C "quoted", <tagged>', ''],
        ['g-3', '  padded  ', ''],
      ],
      widths: [38, 22, 14],
      validations: [{ ref: 'C2:C4', values: ['fabric', 'wallpaper'], title: 'No', message: 'Pick one' }],
    },
    { name: 'MADEAUX', rows: [['GUID', 'Code', 'Category'], ['g-9', 'ALLEGRIA', '']] },
  ]

  it('round-trips every cell through the reader', () => {
    const book = readBack(buildWorkbook(sheets), 2)
    expect(book['All Products'][0]).toEqual(['GUID', 'Code', 'Category'])
    expect(book['All Products'][2]).toEqual(['g-2', 'C & C "quoted", <tagged>', ''])
    expect(book.MADEAUX[1]).toEqual(['g-9', 'ALLEGRIA', ''])
  })

  it('keeps a code that looks numeric as text, leading zeros and all', () => {
    const buffer = buildWorkbook(sheets)
    expect(readBack(buffer, 2)['All Products'][1][1]).toBe('00815')
    // Every cell is a shared string; nothing is written as a number, which is
    // what stops Excel showing 815 (or a date) where the office typed a code.
    expect(partOf(buffer, 'xl/worksheets/sheet1.xml')).not.toMatch(/<c [^>]*t="(n|d)"/)
  })

  it('writes a JS number as a numeric cell, so a quantity sorts and totals', () => {
    const buffer = buildWorkbook([{ name: 'Stock', rows: [['Code', 'On Hand'], ['00815', 10], ['81634', 2]] }])
    const xml = partOf(buffer, 'xl/worksheets/sheet1.xml')
    // The quantity is bare in <v>; the code beside it is a shared string, which
    // is the whole distinction — 10 must sort above 2, "00815" must keep its
    // zeros. A text "10" would sort BELOW "2".
    expect(xml).toContain('<c r="B2"><v>10</v></c>')
    expect(xml).toMatch(/<c r="A2" t="s">/)
    expect(readBack(buffer, 1).Stock[1]).toEqual(['00815', '10'])
  })

  it('leaves an absent figure empty rather than writing a zero', () => {
    // null is "D365 has not set this", which is not the same statement as 0.
    const xml = partOf(buildWorkbook([{ name: 'Stock', rows: [['Code', 'On Hand'], ['a', null]] }]), 'xl/worksheets/sheet1.xml')
    expect(xml).toContain('<row r="2">')
    expect(xml).not.toContain('r="B2"')
  })

  it('refuses a non-finite number instead of writing a cell Excel cannot read', () => {
    expect(() => buildWorkbook([{ name: 'S', rows: [['n'], [Number.NaN]] }])).toThrow(/non-finite/)
    expect(() => buildWorkbook([{ name: 'S', rows: [['n'], [Infinity]] }])).toThrow(/non-finite/)
  })

  it('preserves surrounding whitespace', () => {
    expect(readBack(buildWorkbook(sheets), 2)['All Products'][3][1]).toBe('  padded  ')
  })

  it('interns each distinct string once and counts every reference', () => {
    const repeated = [
      { name: 'A', rows: [['x', 'x'], ['y', 'x']] },
      { name: 'B', rows: [['x', 'y']] },
    ]
    const table = partOf(buildWorkbook(repeated), 'xl/sharedStrings.xml')
    expect(table).toMatch(/count="6"/)
    expect(table).toMatch(/uniqueCount="2"/)
  })

  it('orders the worksheet children as the schema requires', () => {
    const xml = partOf(buildWorkbook(sheets), 'xl/worksheets/sheet1.xml')
    const at = (tag) => xml.indexOf(tag)
    expect(at('<dimension')).toBeGreaterThan(-1)
    expect(at('<sheetViews>')).toBeGreaterThan(at('<dimension'))
    expect(at('<cols>')).toBeGreaterThan(at('<sheetViews>'))
    expect(at('<sheetData>')).toBeGreaterThan(at('<cols>'))
    expect(at('<autoFilter')).toBeGreaterThan(at('<sheetData>'))
    expect(at('<dataValidations')).toBeGreaterThan(at('<autoFilter'))
  })

  it('wires every sheet into the content types and the relationships', () => {
    const buffer = buildWorkbook(sheets)
    const types = partOf(buffer, '[Content_Types].xml')
    const rels = partOf(buffer, 'xl/_rels/workbook.xml.rels')
    for (const at of [1, 2]) {
      expect(types).toContain(`/xl/worksheets/sheet${at}.xml`)
      expect(rels).toContain(`Target="worksheets/sheet${at}.xml"`)
      expect(openWorkbook(buffer).has(`xl/worksheets/sheet${at}.xml`)).toBe(true)
    }
    expect(rels).toContain('Target="styles.xml"')
    expect(rels).toContain('Target="sharedStrings.xml"')
    // r:id -> Relationship Id, which is what decides WHICH tab holds what.
    expect(partOf(buffer, 'xl/workbook.xml')).toContain('r:id="rId1"')
  })

  it('carries the dropdown and freezes the header', () => {
    const xml = partOf(buildWorkbook(sheets), 'xl/worksheets/sheet1.xml')
    expect(xml).toContain('<formula1>"fabric,wallpaper"</formula1>')
    expect(xml).toContain('sqref="C2:C4"')
    expect(xml).toContain('state="frozen"')
  })

  it('renames a tab that collides and leaves the rows on the right one', () => {
    const book = readBack(
      buildWorkbook([
        { name: 'JV Design', rows: [['a']] },
        { name: 'JV DESIGN', rows: [['b']] },
      ]),
      2
    )
    expect(Object.keys(book)).toEqual(['JV Design', 'JV DESIGN (2)'])
    expect(book['JV DESIGN (2)'][0]).toEqual(['b'])
  })

  it('refuses a workbook with no sheets', () => {
    expect(() => buildWorkbook([])).toThrow(/at least one sheet/)
  })
})
