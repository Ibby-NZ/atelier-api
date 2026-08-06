import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import {
  normaliseLabel, worksheetPaths, openColourWorkbook, HEADER_SCAN_LIMIT,
} from '../scripts/lib/colour-sheet.js'
import {
  ADAPTERS, assertAdapter, assertRegistry, matchAdapter, selectAdapter, registeredPrefixes,
} from '../scripts/lib/colour-adapters/index.js'
import { openZip } from '../scripts/lib/zip.js'

// The colour-file corpus lives under incoming/, which is gitignored — it is the
// client's only copy and is mounted read-only — so nothing here reads it. Every
// fixture is a real xlsx built in memory: a genuine deflated zip with genuine
// SpreadsheetML, so the harness inflates and scans for real rather than against
// a stand-in for the format.

const localHeader = (name, method, body) => {
  const head = Buffer.alloc(30)
  head.writeUInt32LE(0x04034b50, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(method, 8)
  head.writeUInt32LE(body.length, 18)
  head.writeUInt32LE(body.length, 22)
  head.writeUInt16LE(Buffer.byteLength(name), 26)
  return Buffer.concat([head, Buffer.from(name, 'utf8'), body])
}

const centralHeader = (name, method, body, offset) => {
  const head = Buffer.alloc(46)
  head.writeUInt32LE(0x02014b50, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(20, 6)
  head.writeUInt16LE(method, 10)
  head.writeUInt32LE(body.length, 20)
  head.writeUInt32LE(body.length, 24)
  head.writeUInt16LE(Buffer.byteLength(name), 28)
  head.writeUInt32LE(offset, 42)
  return Buffer.concat([head, Buffer.from(name, 'utf8')])
}

const buildZip = (files) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const body = deflateRawSync(Buffer.from(text, 'utf8'))
    locals.push(localHeader(name, 8, body))
    centrals.push(centralHeader(name, 8, body, offset))
    offset += 30 + Buffer.byteLength(name) + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(locals.length, 8)
  end.writeUInt16LE(locals.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const SPREADSHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')

const columnRef = (index) => String.fromCharCode(65 + index)

const sheetXml = (rows) => {
  const body = rows.map((cells, rowIndex) => {
    const inner = cells.map((text, index) =>
      `<c r="${columnRef(index)}${rowIndex + 1}" t="inlineStr">`
      + `<is><t>${escapeXml(text)}</t></is></c>`).join('')
    return `<row r="${rowIndex + 1}">${inner}</row>`
  }).join('')
  return `<?xml version="1.0"?><worksheet xmlns="${SPREADSHEET_NS}">`
    + `<sheetData>${body}</sheetData></worksheet>`
}

/**
 * Build a workbook. `flavour` is 'excel' (default namespace, targets relative
 * to xl/) or 'prefixed' — the C&C Milano shape: an `x:` element prefix and an
 * absolute target with no sheet number.
 */
const buildWorkbook = (sheets, flavour = 'excel') => {
  const prefixed = flavour === 'prefixed'
  const tag = prefixed ? 'x:' : ''
  const xmlns = prefixed
    ? `xmlns:r="${RELATIONSHIP_NS}" xmlns:x="${SPREADSHEET_NS}"`
    : `xmlns="${SPREADSHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"`
  const path = (index) => (prefixed
    ? `/xl/worksheets/sheet${index === 0 ? '' : index}.xml`
    : `xl/worksheets/sheet${index + 1}.xml`)
  const target = (index) => (prefixed ? path(index) : `worksheets/sheet${index + 1}.xml`)

  const declarations = sheets.map((sheet, index) =>
    `<${tag}sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
  const relationships = sheets.map((sheet, index) =>
    `<Relationship Id="rId${index + 1}" Target="${target(index)}" `
    + `Type="${RELATIONSHIP_NS}/worksheet"/>`).join('')

  const files = {
    'xl/workbook.xml': `<?xml version="1.0"?><${tag}workbook ${xmlns}>`
      + `<${tag}sheets>${declarations}</${tag}sheets></${tag}workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?>`
      + `<Relationships xmlns="${PACKAGE_RELS_NS}">${relationships}</Relationships>`,
  }
  sheets.forEach((sheet, index) => {
    files[path(index).replace(/^\//, '')] = sheetXml(sheet.rows)
  })
  return buildZip(files)
}

const PREAMBLE = [
  ['TERMS & POLICIES'],
  [''],
  ['CLARENCE HOUSE makes no guarantee or warranty, expressed or implied.'],
  [''],
  ['MERCHANDISE RETURN POLICY'],
  ['Wallcovering is priced per yard, but is sold by the roll.'],
]

const COLOUR_ROWS = [
  ...PREAMBLE,
  ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME', 'US EXPORT NET PRICE'],
  ['CLARENCE', '6978401', 'ABREO PIPING', 'AEGEAN', '6.5'],
  ['CLARENCE', '6978402', 'ABREO PIPING', ' ANTIQUE ', '6.5'],
]

const COLUMNS = Object.freeze({
  brand: 'Brand',
  colourCode: 'Fabric Number',
  design: 'Pattern Name',
  colourName: 'Color Name',
})

const openFixture = (rows, name = 'All Colors', flavour = 'excel') =>
  openColourWorkbook(buildWorkbook([{ name, rows }], flavour), 'fixture.xlsx')

describe('colour-sheet — labels', () => {
  it('lowercases and collapses whitespace, newlines included', () => {
    expect(normaliseLabel('  US EXPORT   NET PRICE ')).toBe('us export net price')
    expect(normaliseLabel('EXPORT USD 2026 \n(per Metre)')).toBe('export usd 2026 (per metre)')
    expect(normaliseLabel('')).toBe('')
    expect(normaliseLabel(undefined)).toBe('')
  })
})

describe('colour-sheet — addressing sheets by name', () => {
  it('resolves a default-namespace workbook', () => {
    const zip = openZip(buildWorkbook([
      { name: 'Pattern Only', rows: [['a']] },
      { name: 'All Colors', rows: [['b']] },
    ]))
    expect([...worksheetPaths(zip)]).toEqual([
      ['Pattern Only', 'xl/worksheets/sheet1.xml'],
      ['All Colors', 'xl/worksheets/sheet2.xml'],
    ])
  })

  it('resolves an x:-prefixed workbook whose target is absolute and unnumbered', () => {
    // C&C Milano's writer emits <x:workbook> and /xl/worksheets/sheet.xml.
    // Matching the bare tag name finds nothing, which reads as "no sheets in
    // this workbook" rather than as a parser bug.
    const zip = openZip(buildWorkbook([{ name: 'Listino', rows: [['a']] }], 'prefixed'))
    expect([...worksheetPaths(zip)]).toEqual([['Listino', 'xl/worksheets/sheet.xml']])
  })

  it('names the sheets it does have when the declared one is absent', () => {
    const workbook = openFixture(COLOUR_ROWS, 'Pattern Only')
    expect(workbook.sheetNames()).toEqual(['Pattern Only'])
    expect(() => workbook.open({ sheet: 'All Colors', columns: COLUMNS }))
      .toThrow(/fixture\.xlsx:All Colors: no such sheet; the workbook has "Pattern Only"/)
  })
})

describe('colour-sheet — locating the header by label', () => {
  it('finds a header buried under a preamble, not at a fixed index', () => {
    const sheet = openFixture(COLOUR_ROWS).open({ sheet: 'All Colors', columns: COLUMNS })
    expect(sheet.headerRow).toBe(7)
    expect(sheet.columnAt.get('brand')).toBe(0)
    expect(sheet.columnAt.get('colourCode')).toBe(1)
    expect(sheet.columnAt.get('design')).toBe(2)
    expect(sheet.columnAt.get('colourName')).toBe(3)
  })

  it('yields only the rows under the header, and trims what it selects', () => {
    const sheet = openFixture(COLOUR_ROWS).open({ sheet: 'All Colors', columns: COLUMNS })
    const rows = [...sheet.rows].map(([rowNumber, cells]) => [rowNumber, sheet.select(cells)])
    expect(rows).toEqual([
      [8, { brand: 'CLARENCE', colourCode: '6978401', design: 'ABREO PIPING', colourName: 'AEGEAN' }],
      [9, { brand: 'CLARENCE', colourCode: '6978402', design: 'ABREO PIPING', colourName: 'ANTIQUE' }],
    ])
  })

  it('reads a cell the row stops short of as empty, not undefined', () => {
    const sheet = openFixture([
      ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME'],
      ['CLARENCE', '6978401'],
    ]).open({ sheet: 'All Colors', columns: COLUMNS })
    const [, cells] = [...sheet.rows][0]
    expect(sheet.select(cells)).toEqual({
      brand: 'CLARENCE', colourCode: '6978401', design: '', colourName: '',
    })
  })

  it('names the label it never saw when a column has been renamed', () => {
    const renamed = COLOUR_ROWS.map((row) =>
      (row[0] === 'BRAND' ? ['BRAND', 'FABRIC NUMBER', 'DESIGN NAME', 'COLOR NAME'] : row))
    expect(() => openFixture(renamed).open({ sheet: 'All Colors', columns: COLUMNS }))
      .toThrow(/no header row in the first 250 rows; never saw "pattern name"/)
  })

  it('reports a header that exists beyond the scan limit as absent', () => {
    const sheet = { sheet: 'All Colors', columns: COLUMNS, scanLimit: 3 }
    expect(() => openFixture(COLOUR_ROWS).open(sheet))
      .toThrow(/no header row in the first 3 rows/)
  })

  it('says so when every label appears but never all in one row', () => {
    const split = [
      ['BRAND', 'FABRIC NUMBER'],
      ['PATTERN NAME', 'COLOR NAME'],
    ]
    expect(() => openFixture(split).open({ sheet: 'All Colors', columns: COLUMNS }))
      .toThrow(/every label appears, but never all in one row/)
  })

  it('refuses a header carrying a declared label twice rather than picking a column', () => {
    const ambiguous = [
      ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME', 'Color Name'],
      ['CLARENCE', '6978401', 'ABREO PIPING', 'AEGEAN', 'AEGEAN BLUE'],
    ]
    expect(() => openFixture(ambiguous).open({ sheet: 'All Colors', columns: COLUMNS }))
      .toThrow(/header carries "color name" more than once/)
  })

  it('does not mistake a preamble row that repeats one label for the header', () => {
    const noisy = [
      ['BRAND', 'BRAND'],
      ...COLOUR_ROWS,
    ]
    const sheet = openFixture(noisy).open({ sheet: 'All Colors', columns: COLUMNS })
    expect(sheet.headerRow).toBe(8)
  })

  it('rejects a sheet spec that declares an empty label or no columns', () => {
    const workbook = openFixture(COLOUR_ROWS)
    expect(() => workbook.open({ sheet: 'All Colors', columns: { brand: '  ' } }))
      .toThrow(/column "brand" declares an empty label/)
    expect(() => workbook.open({ sheet: 'All Colors', columns: {} }))
      .toThrow(/no columns declared/)
  })

  it('scans far enough for the deepest header in the corpus', () => {
    // Stroheim's All Colors header sits on row 106, under the terms and
    // conditions the five US houses share. Clarence House's is on 98.
    expect(HEADER_SCAN_LIMIT).toBeGreaterThan(106)
  })
})

describe('colour-adapters — the registry contract', () => {
  const valid = Object.freeze({
    prefix: 'ClarenceHouse',
    supplier: 'Clarence House',
    sheets: [{ name: 'All Colors', columns: { design: 'Pattern Name' } }],
  })

  it('accepts a well-formed adapter and a declared refusal', () => {
    expect(assertAdapter(valid)).toBe(valid)
    const pdf = { prefix: 'de Le Cuona', unsupported: 'PDF — no extraction path' }
    expect(assertAdapter(pdf)).toBe(pdf)
  })

  it('rejects every shape a typo produces', () => {
    expect(() => assertAdapter({})).toThrow(/prefix must be a non-empty string/)
    expect(() => assertAdapter({ prefix: 'X', unsupported: '' }))
      .toThrow(/unsupported must state a reason/)
    expect(() => assertAdapter({ prefix: 'X', unsupported: 'why', sheets: [] }))
      .toThrow(/unsupported and sheets are exclusive/)
    expect(() => assertAdapter({ prefix: 'X', sheets: valid.sheets }))
      .toThrow(/supplier must be a non-empty string/)
    expect(() => assertAdapter({ prefix: 'X', supplier: 'S', sheets: [] }))
      .toThrow(/sheets must be a non-empty array/)
    expect(() => assertAdapter({ prefix: 'X', supplier: 'S', sheets: [{ columns: { a: 'A' } }] }))
      .toThrow(/every sheet needs a name/)
    expect(() => assertAdapter({ prefix: 'X', supplier: 'S', sheets: [{ name: 'S1' }] }))
      .toThrow(/sheet "S1" declares no columns/)
    expect(() => assertAdapter({
      prefix: 'X', supplier: 'S', sheets: [{ name: 'S1', columns: { a: '' } }],
    })).toThrow(/column "a" has an empty label/)
  })

  it('rejects two fields declaring the same label', () => {
    expect(() => assertAdapter({
      prefix: 'X',
      supplier: 'S',
      sheets: [{ name: 'S1', columns: { design: 'Pattern Name', name: 'PATTERN  NAME' } }],
    })).toThrow(/columns "design" and "name" both declare "pattern name"/)
  })

  it('rejects a prefix registered twice, case-insensitively', () => {
    expect(() => assertRegistry([valid, { ...valid, prefix: 'clarencehouse' }]))
      .toThrow(/adapter prefix "clarencehouse" is registered twice/)
  })

  it('validates every registered adapter at import', () => {
    expect(() => assertRegistry(ADAPTERS)).not.toThrow()
    expect(registeredPrefixes()).toEqual(ADAPTERS.map((adapter) => adapter.prefix))
  })
})

describe('colour-adapters — matching a filename', () => {
  const season = Object.freeze({
    prefix: "Jim Thompson Export Price List_USD_2026 - SS'26",
    supplier: 'Jim Thompson',
    sheets: [{ name: 'FABRIC', columns: { design: 'Article Name' } }],
  })
  const annual = Object.freeze({ ...season, prefix: 'Jim Thompson Export Price List_USD_2026' })
  const registry = assertRegistry([annual, season])

  it('returns null for a file no adapter claims, so the caller must decide', () => {
    expect(matchAdapter('Something Nobody Has Mapped 2026.xlsx')).toBeNull()
    expect(selectAdapter(registry, 'Madeaux UK Export price list.xlsx')).toBeNull()
  })

  it('matches case-insensitively', () => {
    expect(selectAdapter(registry, 'jim thompson export price list_usd_2026.xlsx')).toBe(annual)
  })

  it('lets the longest prefix win, whichever order the entries are in', () => {
    const name = "Jim Thompson Export Price List_USD_2026 - SS'26.xlsx"
    expect(selectAdapter(registry, name)).toBe(season)
    expect(selectAdapter([...registry].reverse(), name)).toBe(season)
  })
})
