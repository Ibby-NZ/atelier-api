import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import {
  normaliseLabel, worksheetPaths, openColourWorkbook, HEADER_SCAN_LIMIT,
} from '../scripts/lib/colour-sheet.js'
import {
  ADAPTERS, assertAdapter, assertRegistry, matchAdapter, selectAdapter, registeredPrefixes,
} from '../scripts/lib/colour-adapters/index.js'
import { colourways, sheetColourways } from '../scripts/lib/colour-adapters/records.js'
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
    expect(() => workbook.open({ name: 'All Colors', columns: COLUMNS }))
      .toThrow(/fixture\.xlsx:All Colors: no such sheet; the workbook has "Pattern Only"/)
  })
})

describe('colour-sheet — locating the header by label', () => {
  it('finds a header buried under a preamble, not at a fixed index', () => {
    const sheet = openFixture(COLOUR_ROWS).open({ name: 'All Colors', columns: COLUMNS })
    expect(sheet.headerRow).toBe(7)
    expect(sheet.columnAt.get('brand')).toBe(0)
    expect(sheet.columnAt.get('colourCode')).toBe(1)
    expect(sheet.columnAt.get('design')).toBe(2)
    expect(sheet.columnAt.get('colourName')).toBe(3)
  })

  it('yields only the rows under the header, and trims what it selects', () => {
    const sheet = openFixture(COLOUR_ROWS).open({ name: 'All Colors', columns: COLUMNS })
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
    ]).open({ name: 'All Colors', columns: COLUMNS })
    const [, cells] = [...sheet.rows][0]
    expect(sheet.select(cells)).toEqual({
      brand: 'CLARENCE', colourCode: '6978401', design: '', colourName: '',
    })
  })

  it('names the label it never saw when a column has been renamed', () => {
    const renamed = COLOUR_ROWS.map((row) =>
      (row[0] === 'BRAND' ? ['BRAND', 'FABRIC NUMBER', 'DESIGN NAME', 'COLOR NAME'] : row))
    expect(() => openFixture(renamed).open({ name: 'All Colors', columns: COLUMNS }))
      .toThrow(/no header row in the first 250 rows; never saw "pattern name"/)
  })

  it('reports a header that exists beyond the scan limit as absent', () => {
    const sheet = { name: 'All Colors', columns: COLUMNS, scanLimit: 3 }
    expect(() => openFixture(COLOUR_ROWS).open(sheet))
      .toThrow(/no header row in the first 3 rows/)
  })

  it('says so when every label appears but never all in one row', () => {
    const split = [
      ['BRAND', 'FABRIC NUMBER'],
      ['PATTERN NAME', 'COLOR NAME'],
    ]
    expect(() => openFixture(split).open({ name: 'All Colors', columns: COLUMNS }))
      .toThrow(/every label appears, but never all in one row/)
  })

  it('refuses a header carrying a declared label twice rather than picking a column', () => {
    const ambiguous = [
      ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME', 'Color Name'],
      ['CLARENCE', '6978401', 'ABREO PIPING', 'AEGEAN', 'AEGEAN BLUE'],
    ]
    expect(() => openFixture(ambiguous).open({ name: 'All Colors', columns: COLUMNS }))
      .toThrow(/header carries "color name" more than once/)
  })

  it('does not mistake a preamble row that repeats one label for the header', () => {
    const noisy = [
      ['BRAND', 'BRAND'],
      ...COLOUR_ROWS,
    ]
    const sheet = openFixture(noisy).open({ name: 'All Colors', columns: COLUMNS })
    expect(sheet.headerRow).toBe(8)
  })

  it('rejects a sheet spec that declares an empty label or no columns', () => {
    const workbook = openFixture(COLOUR_ROWS)
    expect(() => workbook.open({ name: 'All Colors', columns: { brand: '  ' } }))
      .toThrow(/column "brand" declares an empty label/)
    expect(() => workbook.open({ name: 'All Colors', columns: {} }))
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
    sheets: [{ name: 'All Colors', brand: 'Clarence House', columns: COLUMNS }],
  })
  const sheetOf = (fields) => ({
    prefix: 'X', supplier: 'S', sheets: [{ name: 'S1', brand: 'B', ...fields }],
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
      .toThrow(/sheet "S1" must name a brand/)
    expect(() => assertAdapter(sheetOf({}))).toThrow(/sheet "S1" declares no columns/)
    expect(() => assertAdapter(sheetOf({ columns: { a: '' } })))
      .toThrow(/column "a" has an empty label/)
    expect(() => assertAdapter(sheetOf({ columns: COLUMNS, row: 'not a function' })))
      .toThrow(/sheet "S1": row must be a function/)
  })

  it('rejects two fields declaring the same label', () => {
    expect(() => assertAdapter(sheetOf({
      columns: { design: 'Pattern Name', name: 'PATTERN  NAME' },
    }))).toThrow(/columns "design" and "name" both declare "pattern name"/)
  })

  it('makes a sheet without a row mapper declare exactly the record it yields', () => {
    // No mapper means the selected cells ARE the record, so a column naming
    // something a record does not carry silently yields nothing, and a missing
    // one silently yields a blank field.
    expect(() => assertAdapter(sheetOf({ columns: { ...COLUMNS, price: 'Net Price' } })))
      .toThrow(/no row mapper, so column\(s\) "price" name nothing a record carries/)
    expect(() => assertAdapter(sheetOf({ columns: { design: 'Pattern Name' } })))
      .toThrow(/no row mapper and declares no "colourCode", "colourName"/)
    // With one, a sheet may select whatever the mapper needs.
    expect(() => assertAdapter(sheetOf({
      columns: { description: 'Description' }, row: () => ({}),
    }))).not.toThrow()
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
    sheets: [{
      name: 'FABRIC',
      brand: 'Jim Thompson',
      columns: {
        design: 'Article Name', colourCode: 'Article Code', colourName: 'Colour',
      },
    }],
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

// ---------------------------------------------------------------------------
// The adapters, against the real layouts.
//
// Every fixture below is a file's own header row and its first data rows,
// transcribed cell for cell from the drop — trailing spaces, embedded newlines
// and all — because `incoming/` is the client's only copy and no test may read
// it. Columns to the right of the last one an adapter declares are dropped so
// the fixture stays readable; a column that matters keeps its own cell.
// ---------------------------------------------------------------------------

/** An expected record, so a fixture only has to name the fields that vary. */
const colourway = (fields) => ({
  brand: '', design: '', designCode: '', colourCode: '', colourName: '', ...fields,
})

/**
 * Every record ONE of an adapter's declared sheets yields, for the cases worth
 * pinning below its first three rows. The spec comes off the registry, so the
 * declaration under test is the one the converter uses.
 */
const sheetRecords = (file, name, rows) => {
  const spec = matchAdapter(file).sheets.find((sheet) => sheet.name === name)
  const workbook = openColourWorkbook(buildWorkbook([{ name, rows }]), file)
  return [...sheetColourways(workbook.open(spec), spec, file)].map(([, record]) => record)
}

/** The first `limit` records each declared sheet yields, keyed by sheet name. */
const firstRecords = (file, sheets, limit = 3) => {
  const adapter = matchAdapter(file)
  expect(adapter, `no adapter claims ${file}`).not.toBeNull()
  const workbook = openColourWorkbook(buildWorkbook(sheets), file)
  const found = new Map()
  for (const { sheet, record } of colourways(workbook, adapter)) {
    const seen = found.get(sheet) ?? []
    if (seen.length < limit) found.set(sheet, [...seen, record])
  }
  return found
}

describe('colour-adapters — Jean Monro', () => {
  const FILE = 'Jean Monro Ltd Distributor 2026.xlsx'
  const SHEETS = [
    {
      name: 'JM',
      rows: [
        ['CODE', '', '', 'DESCRIPTION', 'name', 'Colour', 'PRICE 2026'],
        ['JM-1409', 'JM', '1409', 'AGATA, celery ', 'AGATA', 'celery', '73.5'],
        ['JM-1406', 'JM', '1406', 'AGATA, damson ', 'AGATA', 'damson', '73.5'],
        ['JM-1407', 'JM', '1407', 'AGATA, dove ', 'AGATA', 'dove', '73.5'],
      ],
    },
    {
      name: 'NH',
      rows: [
        ['CODE', '', '', '', 'name', 'DESCRIPTION', 'PRICE 2026'],
        ['NH-AFTERALLTOO-1', 'NH-', 'AFTERALLTOO', '-1', 'New-mown Green', 'New-mown Green', '64'],
        ['NH-AFTERALLTOO-2', 'NH-', 'AFTERALLTOO', '-2', 'Haystack Yellow ', 'Haystack Yellow ', '64'],
        ['NH-AFTERALLTOO-3', 'NH-', 'AFTERALLTOO', '-3', 'Pomegranate Red ', 'Pomegranate Red', '64'],
      ],
    },
    {
      name: 'RSC',
      rows: [
        ['CODE', '', '', '', 'DESCRIPTION', '', 'name', 'Price 2026'],
        ['RSC-2001-1', 'RSC-', '2001', '-1', 'BERNARDO PAISLEY, aubergine', 'BERNARDO PAISLEY', 'aubergine', '84'],
        ['RSC-2001-2', 'RSC-', '2001', '-2', 'BERNARDO PAISLEY campari', 'BERNARDO PAISLEY', 'campari', '84'],
        ['RSC-2001-3', 'RSC-', '2001', '-3', 'BERNARDO PAISLEY byzantium', 'BERNARDO PAISLEY', 'byzantium', '84'],
      ],
    },
  ]

  it('maps the first three rows of each of its three sheets', () => {
    const found = firstRecords(FILE, SHEETS)
    expect(found.get('JM')).toEqual([
      colourway({ brand: 'Jean Monro', design: 'AGATA', colourCode: 'JM-1409', colourName: 'celery' }),
      colourway({ brand: 'Jean Monro', design: 'AGATA', colourCode: 'JM-1406', colourName: 'damson' }),
      colourway({ brand: 'Jean Monro', design: 'AGATA', colourCode: 'JM-1407', colourName: 'dove' }),
    ])
    // NH's `name` is the colour, not the design — the design is derived from
    // the code, and `designCode` is what the price list calls the design.
    expect(found.get('NH')).toEqual([
      colourway({
        brand: 'Nicky Haslam',
        design: 'AFTERALLTOO',
        designCode: 'NH-AFTERALLTOO',
        colourCode: 'NH-AFTERALLTOO-1',
        colourName: 'New-mown Green',
      }),
      colourway({
        brand: 'Nicky Haslam',
        design: 'AFTERALLTOO',
        designCode: 'NH-AFTERALLTOO',
        colourCode: 'NH-AFTERALLTOO-2',
        colourName: 'Haystack Yellow',
      }),
      colourway({
        brand: 'Nicky Haslam',
        design: 'AFTERALLTOO',
        designCode: 'NH-AFTERALLTOO',
        colourCode: 'NH-AFTERALLTOO-3',
        colourName: 'Pomegranate Red',
      }),
    ])
    expect(found.get('RSC')).toEqual([
      colourway({ brand: 'RSC', design: 'BERNARDO PAISLEY', colourCode: 'RSC-2001-1', colourName: 'aubergine' }),
      colourway({ brand: 'RSC', design: 'BERNARDO PAISLEY', colourCode: 'RSC-2001-2', colourName: 'campari' }),
      colourway({ brand: 'RSC', design: 'BERNARDO PAISLEY', colourCode: 'RSC-2001-3', colourName: 'byzantium' }),
    ])
  })

  it('reads NH rows whose split columns the file left blank', () => {
    // The outdoor and wallpaper rows stop filling in the three unlabelled cells
    // the code was split across, which is why the design comes off the code.
    expect(sheetRecords(FILE, 'NH', [
      ['CODE', '', '', '', 'name', 'DESCRIPTION', 'PRICE 2026'],
      ['NH-ODSEAFERN-1', '', '', '', '', 'New-mown Green (Outdoor)', '87'],
      ['NHP-BAL-01', '', '', '', '', 'New-mown Green *made to order', '94'],
      ['NH-ZEPHYR', 'NH-', 'ZEPHYR', '-1', 'Multi *CFA recommended* ', 'Multi *CFA recommended*', '64'],
    ])).toEqual([
      colourway({
        brand: 'Nicky Haslam',
        design: 'ODSEAFERN',
        designCode: 'NH-ODSEAFERN',
        colourCode: 'NH-ODSEAFERN-1',
        colourName: 'New-mown Green (Outdoor)',
      }),
      colourway({
        brand: 'Nicky Haslam',
        design: 'BAL',
        designCode: 'NHP-BAL',
        colourCode: 'NHP-BAL-01',
        colourName: 'New-mown Green *made to order',
      }),
      // No colour suffix at all, so the whole remainder is the design.
      colourway({
        brand: 'Nicky Haslam',
        design: 'ZEPHYR',
        designCode: 'NH-ZEPHYR',
        colourCode: 'NH-ZEPHYR',
        colourName: 'Multi *CFA recommended*',
      }),
    ])
  })

  it('cuts an RSC design at the colour, whatever follows it', () => {
    const found = sheetRecords(FILE, 'RSC', [
      ['CODE', '', '', '', 'DESCRIPTION', '', 'name', 'Price 2026'],
      ['RSC-2206-01', 'RSC-', '2206', '-1', 'BOTANICAL LEAF, Archive, ', 'BOTANICAL LEAF', 'Archive', '60'],
      ['RSC-2208-01', 'RSC-', '2208', '1', 'KANPUR, Archive, *cut by repeat* NB 124cm usable width when joining- cut in 16cm to match', 'KANPUR', 'Archive', '61.5'],
      ['RSC-1260', 'RSC-', '1260', '', 'OTTOLINE porcelain', 'OTTOLINE', 'porcelain', '66'],
    ])
    expect(found.map((record) => record.design)).toEqual(['BOTANICAL LEAF', 'KANPUR', 'OTTOLINE'])
    expect(found.map((record) => record.colourCode)).toEqual(['RSC-2206-01', 'RSC-2208-01', 'RSC-1260'])
  })
})

describe('colour-adapters — Madeaux', () => {
  const FILE = 'Madeaux UK Export price list.xlsx'
  const HEADER = ['Design Name', 'Colours', 'Trade/m\nEx VAT', 'Export/m', 'Composition & Colours', 'Width CM']
  const sheet = (rows) => [{ name: 'UK Export', rows }]

  it('expands one design row into its colourways', () => {
    const found = firstRecords(FILE, sheet([
      ['FABRICS', '', '', '', '', ''],
      HEADER,
      ['', '', '', '', '', ''],
      ['ALLEGRIA', '01 - 03', '78', '54.599999999999994',
        '100% Linen\nColours: 01 Stone, 02 Straw, 03 Marine', '129.5'],
      ['ANTHEA', '01, 02,\n06, 07, 09', '114', '79.8',
        '100% Silk\nColours: 01 Saffron, 02 Mauve, 06 Blue,\n07 Olive, 09 Dove', '130'],
    ]))
    expect(found.get('UK Export')).toEqual([
      colourway({ brand: 'Madeaux', design: 'ALLEGRIA', colourCode: '01', colourName: 'Stone' }),
      colourway({ brand: 'Madeaux', design: 'ALLEGRIA', colourCode: '02', colourName: 'Straw' }),
      colourway({ brand: 'Madeaux', design: 'ALLEGRIA', colourCode: '03', colourName: 'Marine' }),
    ])
  })

  it('declines the banners, notes and repeated headers between its sections', () => {
    const found = firstRecords(FILE, sheet([
      ['FABRICS', '', '', '', '', ''],
      HEADER,
      ['TRIMMINGS', '', 'Trade/m\nEx VAT', 'Export/m', 'Composition', 'Measurements'],
      ['LINEN RUCHE', '01 Charcoal', '28.5', '19.95', '99% LI/1% PL', 'Total Fringe Depth - 38mm/1.5"'],
      ['MINIMUM ORDER FOR ALL TRIMMINGS IS 5 METRES/5 YARDS', '', '', '', '', ''],
      ['WALLPAPERS', '', '', '', '', ''],
      HEADER,
      ['HAREBELL                         ', '02 - 03', '152', '106.39999999999999',
        'Non-Woven Paper\n02 Bluegrass, 03 Willow', '10m x 52cm'],
      ['AVIARY                               \n*MATCHING FABRIC\nAVAILABLE TO ORDER',
        '01 - 02', '179', '125.3', 'Non-Woven Paper\nColours: 01 Morning Light, 02 Moss & Clay', '10m x 70cm'],
    ]), 5)
    expect(found.get('UK Export')).toEqual([
      // The trimmings name their colour in the `Colours` cell, not the composition.
      colourway({ brand: 'Madeaux', design: 'LINEN RUCHE', colourCode: '01', colourName: 'Charcoal' }),
      // No "Colours:" lead-in on this one, and a design cell padded to the right.
      colourway({ brand: 'Madeaux', design: 'HAREBELL', colourCode: '02', colourName: 'Bluegrass' }),
      colourway({ brand: 'Madeaux', design: 'HAREBELL', colourCode: '03', colourName: 'Willow' }),
      // The design name has an annotation hung under it.
      colourway({ brand: 'Madeaux', design: 'AVIARY', colourCode: '01', colourName: 'Morning Light' }),
      colourway({ brand: 'Madeaux', design: 'AVIARY', colourCode: '02', colourName: 'Moss & Clay' }),
    ])
  })

  it('reads a colour range as a range, never as a colour called "- 03"', () => {
    // The `Colours` cell is only read when the composition names none, and a
    // range there must not be mistaken for one.
    expect(() => firstRecords(FILE, sheet([
      ['Design Name', 'Colours', 'Trade/m', 'Export/m', 'Composition & Colours', 'Width CM'],
      ['ALLEGRIA', '01 - 03', '78', '54.6', '100% Linen', '129.5'],
    ]))).toThrow(/UK Export:2: no colours in "100% Linen" or "01 - 03"/)
  })
})

describe('colour-adapters — Liberty', () => {
  const FILE = 'Liberty All collections T3 GBP- 2026.xlsx'
  const COLLECTION = 'ART COLOURS BOOK 1: DRY PLAINS'
  const SECOND_HEADER = ['COLLECTION', 'FABRIC NAME', 'COLOUR', 'CODE', 'FABRIC TYPE', 'PRICE £ EX VAT']

  it('maps the first three rows of both of its overlapping sheets', () => {
    const found = firstRecords(FILE, [
      {
        name: 'Sheet1 (2)',
        rows: [
          ['FABRICS', '-', '-', '-', '-', '-'],
          SECOND_HEADER,
          [COLLECTION, 'BENMORE', 'SLIPPER', '08322201L', 'BENMORE', '33'],
          [COLLECTION, 'BENMORE', 'RED LAC', '08322201E', 'BENMORE', '33'],
          [COLLECTION, 'BENMORE', 'YARROW', '08322201G', 'BENMORE', '33'],
        ],
      },
      {
        name: 'Sheet1',
        rows: [
          ['', 'FABRICS', '-', '-', '-', '-', ''],
          ['TYPE', 'COLLECTION', 'FABRIC NAME', 'COLOUR', 'CODE', 'FABRIC TYPE', 'DISTRIBUTOR PRICE'],
          ['FABRIC', COLLECTION, 'BENMORE', 'ARTICHOKE', '08322201Y', 'BENMORE', '33'],
          ['FABRIC', COLLECTION, 'BENMORE', 'BLUE JAY', '08322201R', 'BENMORE', '33'],
          ['FABRIC', COLLECTION, 'BENMORE', 'BUNTING', '08322201B', 'BENMORE', '33'],
        ],
      },
    ])
    const liberty = (colourName, colourCode) =>
      colourway({ brand: 'Liberty London', design: 'BENMORE', colourCode, colourName })
    expect(found.get('Sheet1 (2)')).toEqual([
      liberty('SLIPPER', '08322201L'), liberty('RED LAC', '08322201E'), liberty('YARROW', '08322201G'),
    ])
    expect(found.get('Sheet1')).toEqual([
      liberty('ARTICHOKE', '08322201Y'), liberty('BLUE JAY', '08322201R'), liberty('BUNTING', '08322201B'),
    ])
  })

  it('skips the header each sheet repeats halfway down', () => {
    const found = sheetRecords(FILE, 'Sheet1 (2)', [
      SECOND_HEADER,
      [COLLECTION, 'BENMORE', 'SLIPPER', '08322201L', 'BENMORE', '33'],
      SECOND_HEADER,
      [COLLECTION, 'BENMORE', 'RED LAC', '08322201E', 'BENMORE', '33'],
    ])
    expect(found.map((record) => record.colourName)).toEqual(['SLIPPER', 'RED LAC'])
  })
})

describe('colour-adapters — Maria Flora', () => {
  const FILE = 'Maria Flora - Filippo Uecher Atelier Textile CRM Textiles Wallcovering 07-26_Mariaflora.xlsx'
  // The real sheet carries eighteen columns; the twelve of specification
  // between the colour and the brand are dropped here.
  const HEADER = ['Product Name', 'Item Number (pattern + Color)', 'Color Code',
    'Color (if applicable)', 'Composition', 'Brand']

  it('maps the first three rows and spells the house as the catalogue does', () => {
    const found = firstRecords(FILE, [{
      name: 'Foglio1',
      rows: [
        HEADER,
        ['Abaca', '60656', '11', 'Linen', '100% Solution-Dyed Acrylic', 'Mariaflora'],
        ['Abaca', '60656', '20', 'Beige', '100% Solution-Dyed Acrylic', 'Mariaflora'],
        ['Abaca', '60656', '170', 'Grey', '100% Solution-Dyed Acrylic', 'Mariaflora'],
      ],
    }])
    const abaca = (colourCode, colourName) => colourway({
      brand: 'Maria Flora', design: 'Abaca', designCode: '60656', colourCode, colourName,
    })
    expect(found.get('Foglio1')).toEqual([
      abaca('11', 'Linen'), abaca('20', 'Beige'), abaca('170', 'Grey'),
    ])
  })

  it('files the second house in the file under its own name', () => {
    const found = firstRecords(FILE, [{
      name: 'Foglio1',
      rows: [
        HEADER,
        ['Medici', '1001', '01', 'Avorio', '100% Linen', 'Filippo Uecher'],
        // A spelling nobody has mapped passes through raw, for the import to
        // report — this file must never invent a house.
        ['Something', '9999', '02', 'Blue', '100% Linen', 'Maison Nobody Knows'],
      ],
    }])
    expect(found.get('Foglio1').map((record) => record.brand))
      .toEqual(['Filippo Uecher', 'Maison Nobody Knows'])
  })
})

describe('colour-adapters — Perennials', () => {
  it('maps the first three rows of the fabrics file, both sheets', () => {
    const found = firstRecords('Perennials Fabrics Price Guide_Spring26 _USA.xlsx', [
      {
        name: 'Fabrics',
        rows: [
          ['', '', '', '', ''],
          [],
          ['SPRING 2026 FABRIC PRICING AND SPECIFICATIONS: USA', '', '', '', '', ''],
          ['Quality', 'Item Number', 'Quality Description', 'Colorway', 'Designer', 'Limited\nAvailability'],
          ['70', '70-28', "Hi 'n Dri ", 'Blanca', '•', 'no'],
          ['70', '70-84', "Hi 'n Dri ", 'Smoke', '•', 'no'],
          ['70', '70-124', "Hi 'n Dri ", 'Sea Salt', '•', 'no'],
        ],
      },
      {
        // The sheet's real name ends in a space, and a sheet is addressed by
        // name — so the adapter declares it with the space.
        name: 'Trims ',
        rows: [
          [],
          [],
          ['Item Number', 'Quality', 'Colorway', 'Description', 'Minimum', 'Net \nPrice'],
          ['BC-01', 'Big Cord', 'Pistachio', '100% Solution-dyed Acrylic; 3/16 in braided cord', '2 yds', '22'],
          ['BC-06', 'Big Cord', 'Outta The Blue', '100% Solution-dyed Acrylic; 3/16 in braided cord', '2 yds', '22'],
          ['BC-07 ', 'Big Cord', 'Moss', '100% Solution-dyed Acrylic; 3/16 in braided cord', '2 yds', '22'],
        ],
      },
    ])
    const fabric = (colourCode, colourName) => colourway({
      brand: 'Perennials', design: "Hi 'n Dri", designCode: '70', colourCode, colourName,
    })
    expect(found.get('Fabrics')).toEqual([
      fabric('70-28', 'Blanca'), fabric('70-84', 'Smoke'), fabric('70-124', 'Sea Salt'),
    ])
    const trim = (colourCode, colourName) =>
      colourway({ brand: 'Perennials', design: 'Big Cord', colourCode, colourName })
    expect(found.get('Trims ')).toEqual([
      trim('BC-01', 'Pistachio'), trim('BC-06', 'Outta The Blue'), trim('BC-07', 'Moss'),
    ])
  })

  it('maps the first three rows of the wallcoverings file from ALL SKUS', () => {
    const found = firstRecords('Perennials Wallcoverings Price Guide_Spring26_USA.xlsx', [{
      name: 'ALL SKUS',
      rows: [
        ['', '', '', '', '', ''],
        ['', '', '', '', '', ''],
        ['Type', 'Collection', 'Item Number', 'Design', 'Colorway', 'Designer'],
        ['Patterns & Murals', '2024 Summer', 'PD100-191', 'ARIGATO', 'SALT & PEPPER', 'STUDIO'],
        ['Patterns & Murals', '2024 Summer', 'PD100-224', 'ARIGATO', 'CHALK', 'STUDIO'],
        ['Patterns & Murals', '2024 Summer', 'PD100-42', 'ARIGATO', 'PATINA', 'STUDIO'],
      ],
    }])
    const paper = (colourCode, colourName) =>
      colourway({ brand: 'Perennials', design: 'ARIGATO', colourCode, colourName })
    expect(found.get('ALL SKUS')).toEqual([
      paper('PD100-191', 'SALT & PEPPER'), paper('PD100-224', 'CHALK'), paper('PD100-42', 'PATINA'),
    ])
  })

  it('declares only the sheets that hold stock', () => {
    // The wallcoverings file reprints all four of its type sheets in ALL SKUS,
    // so declaring them too would emit every wallcovering twice; the fabrics
    // file's two sheets are disjoint and both are read.
    const wallcoverings = matchAdapter('Perennials Wallcoverings Price Guide_Spring26_USA.xlsx')
    expect(wallcoverings.sheets.map((spec) => spec.name)).toEqual(['ALL SKUS'])
    const fabrics = matchAdapter('Perennials Fabrics Price Guide_Spring26 _USA.xlsx')
    expect(fabrics.sheets.map((spec) => spec.name)).toEqual(['Fabrics', 'Trims '])
  })
})

describe('colour-adapters — what every adapter shares', () => {
  const SPEC = Object.freeze({
    name: 'All Colors',
    brand: 'Clarence House',
    columns: COLUMNS,
  })

  it('skips a blank row without asking the mapper about it', () => {
    const sheet = openFixture([
      ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME'],
      [],
      ['CLARENCE', '6978401', 'ABREO PIPING', 'AEGEAN'],
    ]).open(SPEC)
    const found = [...sheetColourways(sheet, { ...SPEC, row: (values) => values })]
    expect(found).toEqual([[3, colourway({
      brand: 'CLARENCE', design: 'ABREO PIPING', colourCode: '6978401', colourName: 'AEGEAN',
    })]])
  })

  it('falls back to the sheet\'s house when the row names none', () => {
    const spec = {
      ...SPEC,
      columns: {
        colourCode: 'Fabric Number', design: 'Pattern Name', colourName: 'Color Name',
      },
    }
    const sheet = openFixture(COLOUR_ROWS).open(spec)
    expect([...sheetColourways(sheet, spec)][0][1].brand).toBe('Clarence House')
  })

  it('adds file:sheet:row to whatever a mapper throws', () => {
    const sheet = openFixture(COLOUR_ROWS).open(SPEC)
    const spec = { ...SPEC, row: () => { throw new Error('nothing to map') } }
    expect(() => [...sheetColourways(sheet, spec, 'fixture.xlsx')])
      .toThrow('fixture.xlsx:All Colors:8: nothing to map')
  })
})
