import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  importColourways, prepareColourwayImport, validateColourwayRows, colourwayKeys, colourwayName,
  NO_DESIGN, NO_COLOUR_CODE,
} from '../src/seed/colourways-import.js'
import {
  normaliseLabel, worksheetPaths, openColourWorkbook, HEADER_SCAN_LIMIT,
} from '../scripts/lib/colour-sheet.js'
import {
  ADAPTERS, assertAdapter, assertRegistry, matchAdapter, selectAdapter, registeredPrefixes,
} from '../scripts/lib/colour-adapters/index.js'
import {
  colourways, sheetColourways, sheetReadings, skip,
  BLANK_ROW, REPEATED_HEADER, UNSTATED,
} from '../scripts/lib/colour-adapters/records.js'
import { readSheet, readColourFile, readRateSheet } from '../scripts/lib/colour-adapters/reading.js'
import {
  colourwayRow, collectColourways, serialiseColourways, rowSource,
} from '../scripts/lib/colour-adapters/output.js'
import {
  assertRateSheet, stated, NO_RATE, ZERO_RATE,
} from '../scripts/lib/colour-adapters/rates.js'
import {
  RATE_HEADER, RATE_TEMPLATE, assertTemplateHeader, rateCells, collectRates,
  serialiseRates, verifyRates,
} from '../scripts/lib/colour-adapters/rate-template.js'
import { matchTemplate } from '../scripts/lib/price-template.js'
import { csvRows } from '../scripts/lib/text.js'
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
 * declaration under test is the one the converter uses — and a file whose other
 * sheets are not in the fixture (Jannelli & Volpi declares nine) is read one
 * sheet at a time through here.
 */
const sheetRecords = (file, name, rows, flavour = 'excel') => {
  const spec = matchAdapter(file).sheets.find((sheet) => sheet.name === name)
  const workbook = openColourWorkbook(buildWorkbook([{ name, rows }], flavour), file)
  return [...sheetColourways(workbook.open(spec), spec, file)].map(([, record]) => record)
}

/** The same, counted: rows in, colourways out, and what was declined and why. */
const sheetReading = (file, name, rows, flavour = 'excel') => {
  const spec = matchAdapter(file).sheets.find((sheet) => sheet.name === name)
  return readSheet(openColourWorkbook(buildWorkbook([{ name, rows }], flavour), file), spec)
}

/** The first `limit` records each declared sheet yields, keyed by sheet name. */
const firstRecords = (file, sheets, limit = 3, flavour = 'excel') => {
  const adapter = matchAdapter(file)
  expect(adapter, `no adapter claims ${file}`).not.toBeNull()
  const workbook = openColourWorkbook(buildWorkbook(sheets, flavour), file)
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

describe('colour-adapters — Colefax Group', () => {
  const FILE = 'Colefax Group 2026 pricelist Colefax Larsen Manuel Canovas Jane Churchill.xlsx'
  const HEADER = ['Brand', 'Stock-Number', 'Design', 'Colourway', 'General-Prod-Type']
  const sheet = (rows) => [{ name: 'Export Prices', rows }]

  it('files a row under the house its brand letter names, and splits the stock number', () => {
    const found = firstRecords(FILE, sheet([
      HEADER,
      ['C', '01020/01', 'Bowood', 'Green/Grey', 'PRT'],
      ['J', 'J0025-01', 'Asta', 'Oyster', 'WVE'],
      ['L', 'L001W-01', 'Hoku WC', 'Natural', 'WPR'],
      ['M', '01286/01', 'Pav de Bidaine', 'Original', 'PRT'],
    ]), 4)
    expect(found.get('Export Prices')).toEqual([
      colourway({
        brand: 'Colefax & Fowler',
        design: 'Bowood',
        designCode: '01020',
        colourCode: '01020/01',
        colourName: 'Green/Grey',
      }),
      colourway({
        brand: 'Jane Churchill',
        design: 'Asta',
        designCode: 'J0025',
        colourCode: 'J0025-01',
        colourName: 'Oyster',
      }),
      colourway({
        brand: 'Larsen',
        design: 'Hoku WC',
        designCode: 'L001W',
        colourCode: 'L001W-01',
        colourName: 'Natural',
      }),
      colourway({
        brand: 'Manuel Canovas',
        design: 'Pav de Bidaine',
        designCode: '01286',
        colourCode: '01286/01',
        colourName: 'Original',
      }),
    ])
  })

  it('refuses a letter no house is declared for rather than inventing a brand', () => {
    // A letter is a code, not a spelling, so it cannot pass through raw the way
    // an unmapped house name does — that would file stock under a house "X".
    expect(() => firstRecords(FILE, sheet([HEADER, ['X', 'X0001-01', 'Verdure', 'Blue', 'PRT']])))
      .toThrow(/Export Prices:2: brand letter "X" is not one of C, J, L, M/)
  })
})

describe('colour-adapters — Jannelli & Volpi', () => {
  const FILE = 'JV_EXPORT DEALER_SET_TV8_1 JUN 2026_agg 19062026.xlsx'
  const HEADER = ['BRAND', 'COLLECTION', 'FAM', 'ITEM', 'DESIGN', 'SALES UNIT']

  it('carries the item code with no colour name, because the file names none', () => {
    // 6570 and 6571 are two colourways of RIBBON GRASS and the file says
    // nothing about how they differ. The price list agrees — it repeats the
    // design as its description — so no colour name is invented here.
    expect(sheetRecords(FILE, 'JANNELLI&VOLPI', [
      HEADER,
      ['JANNELLI&VOLPI', 'JV ALABASTER  ***COLLECTION***', 'J27', '6570', 'RIBBON GRASS', 'Roll'],
      ['JANNELLI&VOLPI', 'JV ALABASTER  ***COLLECTION***', 'J27', '6571', 'RIBBON GRASS', 'Roll'],
    ])).toEqual([
      colourway({ brand: 'JANNELLI&VOLPI', design: 'RIBBON GRASS', colourCode: '6570' }),
      colourway({ brand: 'JANNELLI&VOLPI', design: 'RIBBON GRASS', colourCode: '6571' }),
    ])
  })

  it('spells the two houses the catalogue has, and leaves the six it has not', () => {
    expect(sheetRecords(FILE, 'ARMANI CASA', [
      HEADER,
      ['ARMANI CASA', 'PRECIOUS FIBRES 1', 'GA1', '9000', 'NABUCCO', 'Linear meter'],
    ])[0].brand).toBe('Armani Casa')
    expect(sheetRecords(FILE, 'MISSONI', [
      HEADER,
      ['MISSONI WALLCOVERINGS', 'MISSONI HOME 1', 'M1A', '10000', 'ANEMONES', 'Roll'],
    ])[0].brand).toBe('Missoni Home')
    // Both spellings of one house are emitted as found: choosing between them
    // is naming a house, and neither is in the catalogue to be named after.
    expect(sheetRecords(FILE, 'DESIGN LICENCE', [
      HEADER,
      ['DESIGN LICENSE', 'COMPOSITION a tribute to Kandinsky', 'AD3', '24000', 'COMPOSIZIONE', 'Roll'],
      ['DESIGN LICENCE', 'COMPOSITION a tribute to Kandinsky', 'AD3', '24001', 'COMPOSIZIONE', 'Roll'],
    ]).map((record) => record.brand)).toEqual(['DESIGN LICENSE', 'DESIGN LICENCE'])
  })

  it('declines a sample and a substrate row, and fails a coded row with no design', () => {
    // Sample books and cards carry item codes and design names like any other
    // row; the sales unit is the only thing that distinguishes them.
    expect(sheetRecords(FILE, 'ARMANI CASA', [
      HEADER,
      ['ARMANI CASA', 'PRECIOUS FIBERS 3', 'ZI2', 'CA700', 'SAMPLE CARD GA7 9700 w. 44 x h. 34', 'Card'],
      ['ARMANI CASA', 'PRECIOUS FIBRES 1', 'GA1', '9001', 'FUKUE', 'Linear meter'],
    ])).toEqual([colourway({ brand: 'Armani Casa', design: 'FUKUE', colourCode: '9001' })])
    // The CO.DE sheet prices its substrates by the metre and gives them no item
    // code at all — nothing can be filed under a code that is not there.
    expect(sheetRecords(FILE, 'CO.DE', [
      HEADER,
      ['CO.DE', 'CO.DE 01|CO.DE 02| CO.DE 03| CO.DE 04', 'C1A', '', 'BASIC', 'Linear meter'],
      ['CO.DE', 'FABULA', 'C1A', 'D0001', 'MELOGRANO', 'Roll'],
    ])).toEqual([colourway({ brand: 'CO.DE', design: 'MELOGRANO', colourCode: 'D0001' })])
    expect(() => sheetRecords(FILE, 'JWALL', [
      HEADER,
      ['JWALL', 'PRIMUS RELOADED ', 'W01', '50000', '', 'Roll'],
    ])).toThrow(/JWALL:2: item "50000" names no design/)
  })

  it('declares the nine sheets that hold stock, not the accessories sheet', () => {
    // ACCESSORIES is the tenth sheet and a different layout (ART,
    // DESCRIPTION/USE AND CONSUMPTION) holding display and marketing items.
    const names = matchAdapter(FILE).sheets.map((spec) => spec.name)
    expect(names).toEqual([
      'JANNELLI&VOLPI', 'ALTAGAMMA MODERN LIVING', 'JV Contract', 'DESIGN LICENCE', 'JWALL',
      'ARMANI CASA', 'MISSONI', 'CO.DE', 'JV FABRICS',
    ])
    expect(names).not.toContain('ACCESSORIES')
  })
})

describe('colour-adapters — Pierre Frey', () => {
  const FILE = 'Pierre Frey DISTRIBUTOR - 2026 FABRIC  WPP IN DETAILS '
    + '- Pierre Frey Boussac Fadini Borghi Le Manach Braquenie.xlsx'
  const HEADER = ['Ref Pattern', 'Name', 'Ref SKU available', 'Name SKU available',
    'Number of SKU available', 'Unit', 'Brand', 'Type of product']
  const sheet = (rows) => [{ name: '2026-29-01-PF-FICHIER DETAILLE', rows }]

  it('cuts the colour out of the SKU name and keeps the pattern reference', () => {
    const found = firstRecords(FILE, sheet([
      HEADER,
      ['B063A', 'LES BLEUETS -', 'B063A001', 'LES BLEUETS FD CREME 1', '1', 'M', 'Braquenié', 'Tissu'],
      ['B080A', 'LE GRAND CORAIL', 'B080A004', 'LE GRAND CORAIL BLEU BLC 04', '4', 'M', 'Braquenié', 'Tissu'],
      ['B080A', 'LE GRAND CORAIL', 'B080A003', 'LE GRAND CORAIL JAUNE 3', '4', 'M', 'Braquenié', 'Tissu'],
    ]))
    expect(found.get('2026-29-01-PF-FICHIER DETAILLE')).toEqual([
      // The design cell ends in the separator it would have joined a variant on.
      colourway({
        brand: 'Braquenié',
        design: 'LES BLEUETS',
        designCode: 'B063A',
        colourCode: 'B063A001',
        colourName: 'FD CREME 1',
      }),
      colourway({
        brand: 'Braquenié',
        design: 'LE GRAND CORAIL',
        designCode: 'B080A',
        colourCode: 'B080A004',
        colourName: 'BLEU BLC 04',
      }),
      colourway({
        brand: 'Braquenié',
        design: 'LE GRAND CORAIL',
        designCode: 'B080A',
        colourCode: 'B080A003',
        colourName: 'JAUNE 3',
      }),
    ])
  })

  it('keeps an abbreviated SKU name whole rather than cutting it at a guess', () => {
    const found = firstRecords(FILE, sheet([
      HEADER,
      ['B080C', 'LE GRAND CORAIL - Rayure 2 chemins', 'B080C004', 'GR CORAIL RAY 2CH BLEU BL 4',
        '2', 'M', 'Braquenié', 'Tissu'],
      // The SKU name IS the design: the supplier named no colour, so neither
      // does the record.
      ['F3512', 'MADAME DE SEVIGNE', 'F3512001', 'MADAME DE SEVIGNE', '1', 'M', 'Pierre Frey', 'Tissu'],
    ]))
    expect(found.get('2026-29-01-PF-FICHIER DETAILLE').map((record) => record.colourName))
      .toEqual(['GR CORAIL RAY 2CH BLEU BL 4', ''])
  })

  it('passes the house the catalogue has no row for through raw', () => {
    const found = firstRecords(FILE, sheet([
      HEADER,
      ['L1688', 'EGLANTINES', 'L1688001', 'EGLANTINES ROUGE 1', '1', 'M', 'Le Manach', 'Tissu'],
      ['B063A', 'LES BLEUETS -', 'B063A001', 'LES BLEUETS FD CREME 1', '1', 'M', 'Fadini Borghi', 'Tissu'],
    ]))
    expect(found.get('2026-29-01-PF-FICHIER DETAILLE').map((record) => record.brand))
      .toEqual(['Le Manach', 'Fadini Borghi'])
  })
})

describe('colour-adapters — Jim Thompson', () => {
  const ANNUAL = 'Jim Thompson Export Price List_USD_2026.xlsx'
  const SEASON = "Jim Thompson Export Price List_USD_2026 - SS'26.xlsx"

  it('reads the code list of the annual drop, where the colour names live', () => {
    const found = firstRecords(ANNUAL, [{
      name: 'CODE LIST',
      rows: [
        ['NO.', 'BRAND', 'ARTICLE CODE', 'ARTICLE NAME', 'OFFICIAL COLOUR NAME', 'TYPE OF PRODUCT',
          'YEAR OF LAUNCH', 'COLLECTION'],
        ['1', 'JIM THOMPSON', 'JT013998001', 'WOODLAND VOYAGE', 'TERRACOTTA', 'FABRIC', '2026',
          'ORIENTAL ODYSSEY'],
        ['2', 'JIM THOMPSON', 'JT013998002', 'WOODLAND VOYAGE', 'SEPIA', 'FABRIC', '2026',
          'ORIENTAL ODYSSEY'],
        ['3', 'NO.9 THOMPSON', 'JT013999001', 'FOREST DREAMING', 'PEARL', 'FABRIC', '2026',
          'ORIENTAL ODYSSEY'],
      ],
    }])
    expect(found.get('CODE LIST')).toEqual([
      colourway({
        brand: 'Jim Thompson',
        design: 'WOODLAND VOYAGE',
        designCode: 'JT013998',
        colourCode: 'JT013998001',
        colourName: 'TERRACOTTA',
      }),
      colourway({
        brand: 'Jim Thompson',
        design: 'WOODLAND VOYAGE',
        designCode: 'JT013998',
        colourCode: 'JT013998002',
        colourName: 'SEPIA',
      }),
      colourway({
        brand: 'No.9 Thompson',
        design: 'FOREST DREAMING',
        designCode: 'JT013999',
        colourCode: 'JT013999001',
        colourName: 'PEARL',
      }),
    ])
  })

  it('reads the spring drop, whose code list orders the same labels differently', () => {
    // ARTICLE NAME precedes ARTICLE CODE here and follows it in the annual —
    // one column map by label serves both, an index map would swap them.
    const found = firstRecords(SEASON, [{
      name: 'CODE LIST 2026',
      rows: [
        ['NO.', 'BRAND', 'ARTICLE NAME', 'ARTICLE CODE', 'OFFICIAL COLOUR NAME', 'TYPE OF PRODUCT',
          'YEAR OF LAUNCH', 'COLLECTION'],
        ['1', 'JIM THOMPSON', 'WOODLAND VOYAGE', 'JT013998001', 'TERRACOTTA', 'FABRIC', '2026',
          'ORIENTAL ODYSSEY'],
        // Neither of these two houses is in the catalogue, so both stay as the
        // file spells them.
        ['22', 'BILL BENSLEY X JIM THOMPSON', 'WILD PANGOLIN', 'JT104021001', 'JUNGLE', 'FABRIC',
          '2026', 'BILL BENSLEY'],
        ['23', 'FOX LINTON', 'AVEBURY', 'FLTR0001003', 'CHALK', 'THROW', '2026', 'FOX LINTON'],
      ],
    }])
    expect(found.get('CODE LIST 2026').map((record) => [record.brand, record.designCode])).toEqual([
      ['Jim Thompson', 'JT013998'],
      ['BILL BENSLEY X JIM THOMPSON', 'JT104021'],
      ['FOX LINTON', 'FLTR0001'],
    ])
  })

  it('claims each drop with its own adapter, the longer prefix winning', () => {
    expect(matchAdapter(SEASON).sheets.map((spec) => spec.name)).toEqual(['CODE LIST 2026'])
    expect(matchAdapter(ANNUAL).sheets.map((spec) => spec.name)).toEqual(['CODE LIST'])
  })
})

describe('colour-adapters — the five Fabricut houses', () => {
  const HEADER = ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME', 'BOOK/COLLECTION NAME',
    'PRODUCT CATEGORY']

  it('finds a header a hundred rows under the terms, and splits the fabric number', () => {
    const found = firstRecords('ClarenceHouse 2026 Price List.xlsx', [{
      name: 'All Colors',
      rows: [
        ...PREAMBLE,
        HEADER,
        ['CLARENCE', '6978401', 'ABREO PIPING', 'AEGEAN', 'KALEIDOSCOPE TRIMMINGS', 'TRM'],
        ['CLARENCE', '6978402', 'ABREO PIPING', 'ANTIQUE', 'KALEIDOSCOPE TRIMMINGS', 'TRM'],
        ['CLARENCE', '6978403', 'ABREO PIPING', 'AQUA', 'KALEIDOSCOPE TRIMMINGS', 'TRM'],
      ],
    }])
    const abreo = (colourCode, colourName) => colourway({
      brand: 'Clarence House',
      design: 'ABREO PIPING',
      designCode: '69784',
      colourCode,
      colourName,
    })
    expect(found.get('All Colors')).toEqual([
      abreo('6978401', 'AEGEAN'), abreo('6978402', 'ANTIQUE'), abreo('6978403', 'AQUA'),
    ])
  })

  it('spells each house as the catalogue does, whatever the export writes', () => {
    const first = (file, brand) => firstRecords(file, [{
      name: 'All Colors',
      rows: [HEADER, [brand, '2204201', 'A LA CARTE', 'PAINT', 'PARADIGM', 'FAB']],
    }]).get('All Colors')[0].brand
    expect(first('S Harris 2026 Price List.xlsx', 'S.HARRIS')).toBe('S. Harris')
    expect(first('Stroheim 2026 Price List.xlsx', 'STROHEIM')).toBe('Stroheim')
    expect(first('Trend 2026 Price List.xlsx', 'TREND')).toBe('Trend')
    expect(first('Vervain 2026 Price List.xlsx', 'VERVAIN')).toBe('Vervain')
    // A sixth spelling in a Fabricut export passes through for the import to
    // report; the five files carry one house each today, but the house comes
    // off the row so a mixed export cannot be misfiled.
    expect(first('Trend 2026 Price List.xlsx', 'FABRICUT')).toBe('FABRICUT')
  })

  it('declares All Colors only — Pattern Only has no colour column at all', () => {
    for (const file of ['ClarenceHouse 2026 Price List.xlsx', 'S Harris 2026 Price List.xlsx',
      'Stroheim 2026 Price List.xlsx', 'Trend 2026 Price List.xlsx', 'Vervain 2026 Price List.xlsx']) {
      expect(matchAdapter(file).sheets.map((spec) => spec.name)).toEqual(['All Colors'])
    }
  })
})

describe('colour-adapters — C & C Milano', () => {
  const FILE = 'C&C Milano 2026 Pricelist.xlsx'
  const HEADER = ['Tipo/type', 'Modello', 'Bar1', 'Col-1', 'Prezzo', 'InEsaurimento']
  // Rows 2 to 4 of the real sheet translate the header rather than holding
  // stock, and each prints its product type out where a data row numbers it.
  const DICTIONARY = [
    ['1 - Tessuti / Fabrics', 'Name', 'Item#', 'Description', 'Price',
      '* During this year will be discontinued'],
    ['2 - Carta / Wallpaper', 'Nom', 'Patron', 'Description', 'Prix',
      '* Coleurs en voie de suppression'],
    ['3 - Passamaneria / Trim', 'Produkt Name', 'Artikel', 'Beschreibung', 'Preis',
      '* Auslaufende Farben'],
  ]

  it('reads the fabrics through the x:-prefixed workbook the supplier writes', () => {
    const found = firstRecords(FILE, [{
      name: 'Listino',
      rows: [
        HEADER,
        ...DICTIONARY,
        ['1', 'AGUILERA', '232119', 'Milk', '49', 'No'],
        ['1', 'AGUILERA', '232120', 'Natural', '49', 'No'],
        ['1', 'AGUILERA', '232121', 'Camel', '49', 'No'],
      ],
    }], 3, 'prefixed')
    const aguilera = (colourCode, colourName) =>
      colourway({ brand: 'C & C Milano', design: 'AGUILERA', colourCode, colourName })
    expect(found.get('Listino')).toEqual([
      aguilera('232119', 'Milk'), aguilera('232120', 'Natural'), aguilera('232121', 'Camel'),
    ])
  })

  it('declines the sample cuttings, which are the only rows with no colour', () => {
    expect(sheetRecords(FILE, 'Listino', [
      HEADER,
      ['0', 'Camp. AGUILERA', '232374', '', '15', 'No'],
      ['2', 'ALBA', '231954', 'Ivory', '55', 'No'],
    ], 'prefixed')).toEqual([
      colourway({ brand: 'C & C Milano', design: 'ALBA', colourCode: '231954', colourName: 'Ivory' }),
    ])
  })

  it('fails a stock row with no item number rather than filing it under nothing', () => {
    expect(() => sheetRecords(FILE, 'Listino', [
      HEADER,
      ['1', 'AGUILERA', '', 'Milk', '49', 'No'],
    ], 'prefixed')).toThrow(/Listino:2: type 1 row has no design or item number/)
  })
})

describe('colour-adapters — the corpus', () => {
  // The eighteen drops as the client named them. No test may read incoming/ —
  // this asserts the registry claims each name, not that the file is there.
  const CORPUS = Object.freeze([
    'C&C Milano 2026 Pricelist.xlsx',
    'ClarenceHouse 2026 Price List.xlsx',
    'Colefax Group 2026 pricelist Colefax Larsen Manuel Canovas Jane Churchill.xlsx',
    'JV_EXPORT DEALER_SET_TV8_1 JUN 2026_agg 19062026.xlsx',
    'Jean Monro Ltd Distributor 2026.xlsx',
    "Jim Thompson Export Price List_USD_2026 - SS'26.xlsx",
    'Jim Thompson Export Price List_USD_2026.xlsx',
    'Liberty All collections T3 GBP- 2026.xlsx',
    'Madeaux UK Export price list.xlsx',
    'Maria Flora - Filippo Uecher Atelier Textile CRM Textiles Wallcovering 07-26_Mariaflora.xlsx',
    'Perennials Fabrics Price Guide_Spring26 _USA.xlsx',
    'Perennials Wallcoverings Price Guide_Spring26_USA.xlsx',
    'Pierre Frey DISTRIBUTOR - 2026 FABRIC  WPP IN DETAILS '
      + '- Pierre Frey Boussac Fadini Borghi Le Manach Braquenie.xlsx',
    'S Harris 2026 Price List.xlsx',
    'Stroheim 2026 Price List.xlsx',
    'Trend 2026 Price List.xlsx',
    'Vervain 2026 Price List.xlsx',
    'de Le Cuona March 2026 pricelist.pdf',
  ])

  it('claims every drop, so no file is left to fail the run as unknown', () => {
    const unclaimed = CORPUS.filter((name) => matchAdapter(name) === null)
    expect(unclaimed).toEqual([])
  })

  it('reports the PDF as a declared refusal, which is not the same as unknown', () => {
    const pdf = matchAdapter('de Le Cuona March 2026 pricelist.pdf')
    expect(pdf.unsupported).toMatch(/PDF/)
    expect(pdf.sheets).toBeUndefined()
    expect(matchAdapter('de Le Cuona March 2027 pricelist.xlsx')).toBe(pdf)
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

describe('colour-adapters — declining a row states why', () => {
  const SPEC = Object.freeze({ name: 'All Colors', brand: 'Clarence House', columns: COLUMNS })
  const readings = (rows, row) => {
    const spec = { ...SPEC, row }
    return [...sheetReadings(openFixture(rows).open(SPEC), spec, 'fixture.xlsx')]
  }

  it('carries the reason a mapper declined the row', () => {
    const found = readings(COLOUR_ROWS, (values) =>
      (values.colourName === 'AEGEAN' ? skip('sample cutting') : values))
    expect(found.map((reading) => reading.skip ?? reading.record.colourName))
      .toEqual(['sample cutting', 'ANTIQUE'])
  })

  it('refuses a decline with no reason to state', () => {
    // The summary counts by reason, so an empty one would report rows the file
    // cannot account for.
    expect(() => skip('  ')).toThrow(/a declined row must state a reason/)
  })

  it('owns the two skips no adapter should have to declare', () => {
    const found = readings([
      ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME'],
      [],
      ['BRAND', 'FABRIC NUMBER', 'PATTERN NAME', 'COLOR NAME'],
      ['CLARENCE', '6978401', 'ABREO PIPING', 'AEGEAN'],
    ], (values) => values)
    expect(found.map((reading) => reading.skip)).toEqual([BLANK_ROW, REPEATED_HEADER, undefined])
  })

  it('counts a reasonless decline rather than absorbing it', () => {
    // A mapper that returns nothing at all is still declining a row; bucketing
    // it is what keeps rows-in equal to records-out plus skips plus errors.
    expect(readings(COLOUR_ROWS, () => null).map((reading) => reading.skip))
      .toEqual([UNSTATED, UNSTATED])
    expect(readings(COLOUR_ROWS, () => []).map((reading) => reading.skip))
      .toEqual([UNSTATED, UNSTATED])
  })

  it('reads on past a row it could not map, so every bad row is reported', () => {
    // The strict view stops at the first; the reading view collects them all,
    // because a supplier who changed one thing usually changed several.
    const found = readings(COLOUR_ROWS, (values) => {
      if (values.colourName === '') throw new Error('no colour')
      throw new Error(`cannot map ${values.colourCode}`)
    })
    expect(found.map((reading) => reading.error)).toEqual([
      'fixture.xlsx:All Colors:8: cannot map 6978401',
      'fixture.xlsx:All Colors:9: cannot map 6978402',
    ])
  })

  it('states a reason on every decline the registry makes', () => {
    // Each of these is a real non-stock row mixed into a stock sheet. None may
    // reach the catalogue, and none may be confused with a row that failed.
    const milano = sheetReading('C&C Milano 2026 Pricelist.xlsx', 'Listino', [
      ['Tipo/type', 'Modello', 'Bar1', 'Col-1'],
      ['1 - Tessuti / Fabrics', 'Name', 'Item#', 'Description'],
      ['0', 'Camp. AGUILERA', '232374', ''],
      ['1', 'AGUILERA', '232119', 'Milk'],
    ], 'prefixed')
    expect(milano.skips).toEqual([['header translation', 1], ['sample cutting', 1]])
    expect(milano.records).toBe(1)

    const volpi = sheetReading('JV_EXPORT DEALER_SET_TV8_1 JUN 2026_agg 19062026.xlsx', 'CO.DE', [
      ['BRAND', 'COLLECTION', 'FAM', 'ITEM', 'DESIGN', 'SALES UNIT'],
      ['CO.DE', 'CO.DE 01', 'C1A', 'CA700', 'SAMPLE CARD', 'Card'],
      ['CO.DE', 'CO.DE 01', 'C1A', '', 'BASIC', 'Linear meter'],
      ['CO.DE', 'FABULA', 'C1A', 'D0001', 'MELOGRANO', 'Roll'],
    ])
    expect(volpi.skips).toEqual([
      ['sample, sold by the unit', 1], ['substrate price, no item code', 1],
    ])

    const madeaux = sheetReading('Madeaux UK Export price list.xlsx', 'UK Export', [
      ['Design Name', 'Colours', 'Composition & Colours'],
      ['WALLPAPERS', '', ''],
      ['ALLEGRIA', '01', '100% Linen\nColours: 01 Stone'],
    ])
    expect(madeaux.skips).toEqual([['section banner or note', 1]])
  })

})

describe('colour-files — reading a whole file', () => {
  const FILE = 'Madeaux UK Export price list.xlsx'
  const HEADER = ['Design Name', 'Colours', 'Trade/m', 'Export/m', 'Composition & Colours', 'Width CM']

  it('counts rows in, colourways out and skips by reason, per sheet', () => {
    // One row is worth three colourways here and a banner is worth none, which
    // is exactly why the two counts are reported separately.
    const reading = sheetReading(FILE, 'UK Export', [
      HEADER,
      ['WALLPAPERS', '', '', '', '', ''],
      ['ALLEGRIA', '01 - 03', '78', '54.6',
        '100% Linen\nColours: 01 Stone, 02 Straw, 03 Marine', '129.5'],
      [],
    ])
    expect(reading.name).toBe('UK Export')
    expect(reading.headerRow).toBe(1)
    expect(reading.rows).toBe(3)
    expect(reading.records).toBe(3)
    expect(reading.skips).toEqual([['section banner or note', 1], [BLANK_ROW, 1]])
    expect(reading.errors).toEqual([])
    expect(reading.entries.map((entry) => entry.rowNumber)).toEqual([3, 3, 3])
  })

  it('collects a file\'s bad rows without throwing, so the caller lists them all', () => {
    const workbook = openColourWorkbook(buildWorkbook([{
      name: 'UK Export',
      rows: [
        HEADER,
        ['ALLEGRIA', '01 - 03', '78', '54.6', '100% Linen', '129.5'],
        ['ANTHEA', '01 - 05', '78', '54.6', '100% Silk', '130'],
      ],
    }]), FILE)
    const reading = readColourFile(workbook, matchAdapter(FILE))
    expect(reading.errors).toEqual([
      `${FILE}:UK Export:2: no colours in "100% Linen" or "01 - 03"`,
      `${FILE}:UK Export:3: no colours in "100% Silk" or "01 - 05"`,
    ])
    expect(reading.supplier).toBe('Madeaux')
  })

  it('records a sheet that will not open and still reads the others', () => {
    // One renamed column must not hide the other eight sheets — a nine-sheet
    // file reported one sheet at a time is a file fixed one release at a time.
    const jv = 'JV_EXPORT DEALER_SET_TV8_1 JUN 2026_agg 19062026.xlsx'
    const columns = ['BRAND', 'COLLECTION', 'FAM', 'ITEM', 'DESIGN', 'SALES UNIT']
    const sheets = matchAdapter(jv).sheets.map((spec) => ({
      name: spec.name,
      rows: spec.name === 'JWALL'
        ? [['BRAND', 'COLLECTION', 'FAM', 'CODE', 'DESIGN', 'SALES UNIT']]
        : [columns, ['JV', 'C', 'F', '6570', 'RIBBON GRASS', 'Roll']],
    }))
    const reading = readColourFile(openColourWorkbook(buildWorkbook(sheets), jv), matchAdapter(jv))
    expect(reading.errors).toEqual([
      `${jv}:JWALL: no header row in the first 250 rows; never saw "item"`,
    ])
    expect(reading.sheets).toHaveLength(8)
    expect(reading.entries).toHaveLength(8)
  })
})

describe('colour-files — the normalised output', () => {
  const entry = (fields) => ({
    sheet: 'All Colors',
    rowNumber: 8,
    record: {
      brand: 'Clarence House',
      design: 'ABREO PIPING',
      designCode: '69784',
      colourCode: '6978401',
      colourName: 'AEGEAN',
      ...fields,
    },
  })

  it('writes snake_case fields and keeps the coordinate the row came from', () => {
    // Provenance is the one thing that cannot be recovered later: a row that
    // turns out to be wrong is a row somebody has to find in a spreadsheet.
    const row = colourwayRow('ClarenceHouse 2026 Price List.xlsx', 'Clarence House', entry())
    expect(row).toEqual({
      supplier: 'Clarence House',
      brand: 'Clarence House',
      design: 'ABREO PIPING',
      design_code: '69784',
      colour_code: '6978401',
      colour_name: 'AEGEAN',
      source_file: 'ClarenceHouse 2026 Price List.xlsx',
      source_sheet: 'All Colors',
      source_row: 8,
    })
    expect(rowSource(row)).toBe('ClarenceHouse 2026 Price List.xlsx:All Colors:8')
  })

  it('drops an exact repeat from another file, keeping the first', () => {
    // Jim Thompson's spring drop is a strict subset of its annual one and
    // Liberty's two sheets overlap; the same colourway must land once.
    const first = colourwayRow('Jim Thompson Export Price List_USD_2026.xlsx', 'Jim Thompson', entry())
    const again = colourwayRow("Jim Thompson Export Price List_USD_2026 - SS'26.xlsx", 'Jim Thompson',
      { ...entry(), sheet: 'CODE LIST 2026', rowNumber: 4 })
    const { records, duplicates, clashes } = collectColourways([first, again])
    expect(records).toEqual([first])
    expect(duplicates).toBe(1)
    expect(clashes).toEqual([])
  })

  it('keeps both rows when one colour code carries two names, and reports it', () => {
    // Madeaux reprints a design in a second section as "Bluegrass" for "Blue
    // Grass". Choosing between them names a colourway, which is the import's
    // decision on a key nothing has ratified yet — not this file's.
    const first = colourwayRow('Madeaux UK Export price list.xlsx', 'Madeaux',
      entry({ colourName: 'Blue Grass' }))
    const second = colourwayRow('Madeaux UK Export price list.xlsx', 'Madeaux',
      { ...entry({ colourName: 'Bluegrass' }), rowNumber: 136 })
    const { records, duplicates, clashes } = collectColourways([first, second])
    expect(records).toEqual([first, second])
    expect(duplicates).toBe(0)
    expect(clashes).toEqual([{ row: second, earlier: first }])
  })

  it('writes one record per line, and nothing but records', () => {
    const rows = [colourwayRow('f.xlsx', 'S', entry()), colourwayRow('f.xlsx', 'S', entry({
      colourCode: '6978402', colourName: 'ANTIQUE',
    }))]
    const text = serialiseColourways(rows)
    expect(text.split('\n')).toHaveLength(5)
    expect(JSON.parse(text)).toEqual(rows)
    expect(JSON.parse(serialiseColourways([]))).toEqual([])
  })
})

// The 2026 rates these files carry, emitted in the office's universal pricing
// template. `RATE` below is one S. Harris row as the reader produces it, and is
// what most of these assertions are built from.
const RATE = Object.freeze({
  supplier: 'S Harris',
  brand: 'S. Harris',
  code: '22042',
  description: 'A LA CARTE',
  productRange: 'PARADIGM',
  itemType: 'Fabrics',
  packType: 'p/y',
  contents: '75% Viscose',
  width: '57',
  repeat: '28.62',
  verticalRepeat: '41.25',
  patternMatch: '',
  wholesale: '75.2',
  currency: 'US Dollar',
  dateEffective: '02/02/2026',
  dutyRate: '',
  freightRate: '',
  dutyPercent: '',
  sourceFile: 'S Harris 2026 Price List.xlsx',
  sourceSheet: 'All Colors',
  sourceRow: 105,
})

/** Every rate ONE declared rate sheet yields, off the registry's own spec. */
const ratesOf = (file, name, rows, flavour = 'excel') => {
  const adapter = matchAdapter(file)
  const spec = adapter.rateSheets.find((sheet) => sheet.name === name)
  expect(spec, `${file} declares no rate sheet ${name}`).toBeDefined()
  const workbook = openColourWorkbook(buildWorkbook([{ name, rows }], flavour), file)
  return readRateSheet(workbook, spec, adapter.supplier)
}

/** One rate as its template cells, keyed by column, so a failure reads plainly. */
const cellsByColumn = (rate) =>
  Object.fromEntries(RATE_HEADER.map((label, index) => [label, rateCells(rate)[index]]))

describe('colour-rates — the emitted shape IS the pricing template', () => {
  it('matches a registered template exactly, and it is v3', () => {
    expect(RATE_TEMPLATE.version).toBe('v3')
    expect(matchTemplate([...RATE_HEADER])).toBe(RATE_TEMPLATE)
    expect(RATE_HEADER).toHaveLength(17)
  })

  it('fails at import if the header ever stops matching a template', () => {
    expect(() => assertTemplateHeader(['Date Effective', 'Code']))
      .toThrow(/matches no registered price template/)
  })

  it('writes each field into its own column, and nothing into the three no file fills', () => {
    expect(cellsByColumn(RATE)).toEqual({
      'Date Effective': '02/02/2026',
      // v3 has ONE brand column and the house goes in it. The book this row
      // came out of ("PARADIGM") has no column in the template the client
      // ratified, so it is read and not written — see rate-template.js.
      Brand: 'S. Harris',
      Code: '22042',
      Description: 'A LA CARTE',
      'Item Type': 'Fabrics',
      Unit: 'p/y',
      Contents: '75% Viscose',
      Width: '57',
      'Horizontal Repeat': '28.62',
      'Vertical Repeat': '41.25',
      'Pattern Match': '',
      // Nothing is invented into these three. The broker's duty table and the
      // freight class table are still owed, and a placeholder written here
      // would be indistinguishable from a rate a supplier quoted.
      'Duty Rate': '',
      'Wholesale Rate': '75.2',
      Currency: 'US Dollar',
      'Freight Rate': '',
      Supplier: 'S Harris',
      'Duty Percent': '',
    })
  })

  it('quotes a cell that carries a comma, a quote or a newline', () => {
    const awkward = { ...RATE, description: 'A LA CARTE, "PAINT"', contents: 'Linen\nCotton' }
    const lines = serialiseRates([awkward]).split('\r\n')
    expect(lines[0]).toBe(RATE_HEADER.join(','))
    expect(lines[1]).toContain('"A LA CARTE, ""PAINT"""')
    expect(lines[1]).toContain('"Linen\nCotton"')
  })

  it("round-trips through the office's own converter, cell for cell", () => {
    // The strongest thing this story can assert: what the converter writes is
    // read back by lib/price-template.js itself, not by a copy of its rules.
    const rows = [...csvRows(serialiseRates([RATE]))]
    const template = matchTemplate(rows[0][1])
    expect(template.version).toBe('v3')
    const errors = []
    const skipped = []
    const item = template.map(rows[1][1], {
      lineNumber: 2,
      source: 'rates.csv',
      supplier: null,
      fileCategory: null,
      isXlsx: false,
      errors,
      skipped,
    })
    expect(errors).toEqual([])
    expect(item).toMatchObject({
      supplier: 'S Harris',
      category: 'fabric',
      code: '22042',
      unit: 'yard',
      currency: 'USD',
      wholesale_rate: 75.2,
      date_effective: '2026-02-02',
      product_range: 'S. Harris',
      duty_class: null,
      freight_class: null,
      duty_percent: null,
      template_version: 'v3',
    })
  })

  it('proves every emitted row maps, and names the one that does not', () => {
    expect(verifyRates([RATE])).toEqual([])
    // A pack outside the shared vocabulary can only be built by hand — the
    // registry rejects a sheet that declares one — and this is the check that
    // would catch it before the office met it.
    expect(verifyRates([{ ...RATE, packType: 'p/bolt' }]))
      .toEqual(['S Harris 2026 Price List.xlsx:All Colors:105: unmappable pack type "p/bolt"'])
  })
})

describe('colour-rates — what a rate sheet must declare', () => {
  const sheet = (fields) => ({
    name: 'All Colors', brand: 'S. Harris', currency: 'US Dollar', ...fields,
  })
  const columns = { wholesale: 'US Export Net Price' }
  const at = 'adapter "X"'

  it('accepts a sheet whose constants are all in the shared vocabularies', () => {
    const valid = sheet({ itemType: 'Fabrics', packType: 'p/y', columns })
    expect(assertRateSheet(valid, at)).toBe(valid)
  })

  it('rejects a constant the price template would refuse', () => {
    expect(() => assertRateSheet(sheet({ currency: 'Kina', columns }), at))
      .toThrow(/declares currency "Kina", which no template cell may say/)
    expect(() => assertRateSheet(sheet({ itemType: 'Rugs', columns }), at))
      .toThrow(/declares item type "Rugs", which maps to no category/)
    expect(() => assertRateSheet(sheet({ packType: 'p/bolt', columns }), at))
      .toThrow(/declares pack type "p\/bolt", which maps to no unit/)
  })

  it('rejects a sheet that could not produce a rate at all', () => {
    expect(() => assertRateSheet(sheet({ columns: {} }), at)).toThrow(/declares no columns/)
    expect(() => assertRateSheet(sheet({ columns: { code: 'Code' } }), at))
      .toThrow(/declares no "wholesale" column/)
    expect(() => assertRateSheet(sheet({
      columns: { ...columns, price: 'US EXPORT NET PRICE' },
    }), at)).toThrow(/both declare "us export net price"/)
    expect(() => assertRateSheet(sheet({
      columns: { ...columns, unit: 'Unit of Measure' },
    }), at)).toThrow(/no row mapper, so column\(s\) "unit" name nothing a rate carries/)
    expect(() => assertRateSheet(sheet({ columns, row: 'not a function' }), at))
      .toThrow(/row must be a function/)
  })

  it('holds for every rate sheet in the registry', () => {
    const declared = ADAPTERS.filter((adapter) => adapter.rateSheets !== undefined)
    expect(declared.length).toBeGreaterThan(10)
    for (const adapter of declared) {
      for (const spec of adapter.rateSheets) {
        expect(() => assertRateSheet(spec, adapter.prefix)).not.toThrow()
      }
    }
  })
})

describe('colour-rates — a row with no usable rate is skipped and counted', () => {
  const FILE = 'Jean Monro Ltd Distributor 2026.xlsx'
  const ROWS = [
    ['CODE', 'DESCRIPTION', 'PRICE 2026', 'COMPOSITION', 'WIDTH CM', 'VERT REPEAT CM',
      'HORI REPEAT CM', 'UNIT OF MEASURE', 'TYPE'],
    ['JM-1409', 'AGATA, celery', '73.5', '88LI 12NY', '140', '11.5', '22.86', 'METRE', 'FABRIC'],
    // Nothing stated, "N/A" and a zero are three ways of saying the same thing,
    // and none of them may reach the ledger as a rate of nothing.
    ['JM-1410', 'AGATA, dove', '', '88LI 12NY', '140', '11.5', '22.86', 'METRE', 'FABRIC'],
    ['JM-1411', 'AGATA, ash', 'N/A', '88LI 12NY', '140', '11.5', '22.86', 'METRE', 'FABRIC'],
    ['JM-1412', 'AGATA, slate', '0', '88LI 12NY', '140', '11.5', '22.86', 'METRE', 'FABRIC'],
  ]

  it('counts each kind of unpriced row by name and emits none of them', () => {
    const reading = ratesOf(FILE, 'JM', ROWS)
    expect(reading.rows).toBe(4)
    expect(reading.records).toBe(1)
    expect(reading.entries[0].code).toBe('JM-1409')
    expect(Object.fromEntries(reading.skips)).toEqual({ [NO_RATE]: 2, [ZERO_RATE]: 1 })
    // Exhaustive, which is what makes the summary worth reading at all.
    expect(reading.rows).toBe(reading.records + 3 + reading.errors.length)
  })

  it('treats a rate that is not a number as a row it cannot map, not as a decline', () => {
    const rows = ROWS.map((row) => (row[0] === 'JM-1410' ? [row[0], row[1], 'POA', ...row.slice(3)] : row))
    const reading = ratesOf(FILE, 'JM', rows)
    expect(reading.errors).toEqual([`${FILE}:JM:3: unusable rate "POA"`])
  })

  it('reads "N/A" in any cell as the supplier stating nothing', () => {
    expect(stated('N/A')).toBe('')
    expect(stated(' n/a ')).toBe('')
    expect(stated('-')).toBe('')
    expect(stated(' 140 ')).toBe('140')
  })
})

describe('colour-rates — one row per ledger key', () => {
  const rate = (fields) => ({ ...RATE, ...fields })

  it('drops an exact repeat', () => {
    const { records, duplicates, collapsed, conflicts } = collectRates([RATE, rate({})])
    expect(records).toEqual([RATE])
    expect(duplicates).toBe(1)
    expect(collapsed).toBe(0)
    expect(conflicts).toEqual([])
  })

  it("collapses a design's colourway rows onto its rate", () => {
    // Same key, same money, a cell belonging to the colourway differs. The
    // ledger holds one row per key, so both cannot be written. (The differing
    // cell has to be one v3 still WRITES — a row differing only in the book it
    // came out of is now an exact repeat, because v3 has no column for a book.)
    const { records, duplicates, collapsed } = collectRates([
      RATE, rate({ contents: '75% Viscose, 25% Linen', sourceRow: 106 }),
    ])
    expect(records).toEqual([RATE])
    expect(duplicates).toBe(0)
    expect(collapsed).toBe(1)
  })

  it('writes NO rate for a code the file prices two ways', () => {
    const { records, conflicts } = collectRates([RATE, rate({ wholesale: '80.4', sourceRow: 106 })])
    expect(records).toEqual([])
    expect(conflicts).toEqual([
      'S Harris 22042: 75.2 US Dollar per p/y from 02/02/2026 at '
      + 'S Harris 2026 Price List.xlsx:All Colors:105 vs '
      + '80.4 US Dollar per p/y from 02/02/2026 at S Harris 2026 Price List.xlsx:All Colors:106',
    ])
  })

  it('keeps two codes that differ only by category apart', () => {
    const trimming = rate({ itemType: 'Trimmings', wholesale: '9' })
    const { records, conflicts } = collectRates([RATE, trimming])
    expect(records).toEqual([RATE, trimming])
    expect(conflicts).toEqual([])
  })
})

describe('colour-rates — the adapters', () => {
  it('prices Jean Monro by the colourway and Nicky Haslam by the design', () => {
    // The price list keys "Jean Monro" on JM-1409, one row per colourway, and
    // "Nicky Haslam" on NH-AFTERALLTOO, one per design — and files the second
    // house as a supplier of its own, which is why the rate says so.
    const FILE = 'Jean Monro Ltd Distributor 2026.xlsx'
    const jm = ratesOf(FILE, 'JM', [
      ['CODE', 'DESCRIPTION', 'PRICE 2026', 'COMPOSITION', 'WIDTH CM', 'VERT REPEAT CM',
        'HORI REPEAT CM', 'UNIT OF MEASURE', 'TYPE'],
      ['JM-1409', 'AGATA, celery', '73.5', '88LI 12NY', '140', '11.5', '22.86', 'METRE', 'FABRIC'],
      ['JM-2001', 'ALTHEA, rose', '96', '100CO', '68', '32', '', 'ROLL', 'WALLPAPER'],
    ])
    expect(jm.entries.map((entry) => [entry.supplier, entry.code, entry.itemType, entry.packType]))
      .toEqual([
        ['Jean Monro', 'JM-1409', 'Fabrics', 'p/m'],
        ['Jean Monro', 'JM-2001', 'Wallpaper', 'p/roll'],
      ])
    const nh = ratesOf(FILE, 'NH', [
      ['CODE', 'DESCRIPTION', 'PRICE 2026', 'COMPOSITION', 'WIDTH CM', 'VERT REPEAT CM',
        'HORI REPEAT CM', 'UNIT OF MEASURE', 'TYPE'],
      ['NH-AFTERALLTOO-1', 'New-mown Green', '64', '100LI', '138', '3.4', '', 'METRE', 'FABRIC'],
      ['NH-AFTERALLTOO-2', 'Haystack Yellow', '64', '100LI', '138', '3.4', '', 'METRE', 'FABRIC'],
    ])
    // The description has to be the design's too: the row's own would be the
    // colour, which differs on every row and would turn one rate into six.
    expect(nh.entries.map((entry) => [entry.supplier, entry.code, entry.description])).toEqual([
      ['Nicky Haslam', 'NH-AFTERALLTOO', 'AFTERALLTOO'],
      ['Nicky Haslam', 'NH-AFTERALLTOO', 'AFTERALLTOO'],
    ])
    expect(collectRates(nh.entries).records).toHaveLength(1)
  })

  it("takes Liberty's distributor price and declares nothing past the width", () => {
    // The wallpaper section reprints the header with `ROLL DIMENSIONS` inserted
    // after the width, so every later cell is shifted by one — a composition
    // read at the wrong index would be a repeat filed as a fibre content.
    const reading = ratesOf('Liberty All collections T3 GBP- 2026.xlsx', 'Sheet1', [
      ['TYPE', 'COLLECTION', 'FABRIC NAME', 'COLOUR', 'CODE', 'FABRIC TYPE', 'DISTRIBUTOR PRICE',
        'WIDTH cm / inch', 'VERT REPEAT cm / inch'],
      ['FABRIC', 'ART COLOURS', 'BENMORE', 'SLIPPER', '08322201L', 'BENMORE', '33',
        "143 cm/56.2''", 'N/A'],
      ['', 'WALLPAPER', '-', '-', '-', '-', '-', '-', '-'],
      ['', 'COLLECTION', 'WALLPAPER NAME', 'COLOUR', 'CODE', 'PAPER TYPE', 'DISTRIBUTOR PRICE',
        'WIDTH cm / Inch', 'ROLL DIMENSIONS'],
      ['WALLPAPER', 'BOTANICAL ATLAS', 'BERRY TREE', 'INK', '07282201D', 'NON-WOVEN', '39',
        '52 cm/ 20.5"', '52 cm x 10.05 Mt'],
    ])
    expect(reading.entries.map((entry) =>
      [entry.code, entry.itemType, entry.packType, entry.wholesale])).toEqual([
      ['08322201', 'Fabrics', 'p/m', '33'],
      ['07282201', 'Wallpaper', 'p/roll', '39'],
    ])
    expect(Object.fromEntries(reading.skips)).toEqual({
      'section banner': 1,
      "a section's own header row": 1,
    })
  })

  it("reads Madeaux's sections out of the row, and declines its two-rate cell", () => {
    const reading = ratesOf('Madeaux UK Export price list.xlsx', 'UK Export', [
      ['FABRICS'],
      ['Design Name', 'Colours', 'Trade/m\nEx VAT', 'Export/m', 'Composition & Colours',
        'Width CM', 'Repeat CM'],
      ['ALLEGRIA', '01 - 03', '78', '54.6', '100% Linen\nColours: 01 Stone, 02 Straw', '129.5',
        '84V x 42H'],
      ['LINEN RUCHE', '01 Charcoal', '28.5', '19.95', '99% LI/1% PL', 'Fringe 38mm'],
      ['WALLPAPERS'],
      ['Design Name', 'Colours', 'Trade/ Roll\nEx VAT', 'Export/ Roll', 'Composition & Colours',
        'Roll Length & Width', 'Repeat (CM)'],
      ['ACANTHE', '01 - 02', '156', '109.2', 'Non-Woven Paper\nColours: 01 Jadeite', '10m x 52cm',
        '47.4V x 52H'],
      ['AUDREY GRASSCLOTH', '01 - 05', '£50/m\n£500/roll', '£35/m\n£350/roll',
        'Grasscloth\nColours: 01 Pigeon', '10m x 85cm', '1H'],
    ])
    expect(reading.entries.map((entry) =>
      [entry.code, entry.itemType, entry.packType, entry.wholesale])).toEqual([
      ['ALLEGRIA', 'Fabrics', 'p/m', '54.6'],
      // A composition naming no colours is a trimming; the three of them put
      // their colour in the `Colours` cell instead.
      ['LINEN RUCHE', 'Trimmings', 'p/m', '19.95'],
      ['ACANTHE', 'Wallpaper', 'p/roll', '109.2'],
    ])
    expect(Object.fromEntries(reading.skips)).toEqual({
      'section banner or note': 1,
      "a section's own header row": 1,
      'two rates stated in one cell': 1,
    })
  })

  it("reads Jim Thompson's rates off the sheets its colour names are not on", () => {
    const FILE = 'Jim Thompson Export Price List_USD_2026.xlsx'
    const fabric = ratesOf(FILE, 'FABRIC', [
      ['ARTICLE CODE', 'ARTICLE NAME', 'BRAND', 'EXPORT USD 2026 (PER METRE)', 'SELLING UNIT',
        'CONTENTS', 'PATTERN REPEAT'],
      ['JT013998001', 'WOODLAND VOYAGE', 'JIM THOMPSON', '39', 'METRE', '100% LINEN',
        'STRAIGHT MATCH'],
      ['FL010101001', 'KEMPSFORD', 'FOX LINTON', '256', 'METRE', '100% WOOL', ''],
      ['JT099001001', 'PANEL SET', 'JIM THOMPSON', '', 'PRICE PER SET (1 SET = 2 PANELS)', '', ''],
      ['', 'PTO = Print to Order'],
    ])
    expect(fabric.entries.map((entry) => [entry.supplier, entry.code, entry.wholesale])).toEqual([
      ['Jim Thompson', 'JT013998', '39'],
      // The price list files Fox Linton as a supplier of its own.
      ['Fox Linton', 'FL010101', '256'],
    ])
    expect(Object.fromEntries(fabric.skips)).toEqual({
      'sold as a set of panels, which no template pack type covers': 1,
      'note under the table': 1,
    })

    const wallpaper = ratesOf(FILE, 'WALLPAPER', [
      ['ARTICLE CODE', 'ARTICLE NAME', 'BRAND', 'EXPORT USD 2026 (BY METRE)',
        'EXPORT USD BY 2026 (SELLING UNIT)', 'SELLING UNIT', 'GROUND/SUBSTRATE', 'PATTERN MATCH',
        'WIDTH (CM)'],
      ['JT021099001', 'WOODLAND VOYAGE', 'JIM THOMPSON', '33', '33',
        'PRICE PER METRE: 3 METRES MINIMUM', 'NON-WOVEN', 'STRAIGHT MATCH', '150'],
      ['JT021100001', 'ARAN MURAL', 'JIM THOMPSON', '183', '29.04',
        'PRICE PER ROLL (6.3m - 2 Panels)', 'NON-WOVEN', 'STRAIGHT MATCH', '150'],
    ])
    // A roll row is priced by the selling unit, a metre row by the metre.
    expect(wallpaper.entries.map((entry) => [entry.code, entry.packType, entry.wholesale]))
      .toEqual([['JT021099', 'p/m', '33'], ['JT021100', 'p/roll', '29.04']])

    const throws = ratesOf(FILE, 'THROWS', [
      ['ARTICLE CODE', 'ARTICLE NAME', 'BRAND', 'CONTENT', 'SIZE', 'EXPORT USD 2026'],
      ['FLTR0001001', 'KEMPSFORD THROW', 'FOX LINTON', '100% Merino Wool', '130cm x 220cm',
        '249.2'],
      ['FLTR0001003', 'KEMPSFORD THROW', 'FOX LINTON', '100% Merino Wool', '130cm x 220cm', ''],
    ])
    expect(throws.entries.map((entry) => [entry.code, entry.itemType, entry.packType]))
      .toEqual([['FLTR0001', 'Accessories', 'p/p']])
    expect(Object.fromEntries(throws.skips)).toEqual({ [NO_RATE]: 1 })
  })

  it("files each of Colefax's four houses under its own supplier", () => {
    const reading = ratesOf(
      'Colefax Group 2026 pricelist Colefax Larsen Manuel Canovas Jane Churchill.xlsx',
      'Export Prices',
      [
        ['Brand', 'Stock-Number', 'Design', 'General-Prod-Type', 'Width', 'Fibre Content',
          'Pattern-Book-Description', 'Distributors GBP (FF)'],
        ['C', '01020/01', 'Bowood', 'PRT', '135', 'Cotton 100%', 'Jardine', '41.1'],
        ['J', 'J0025-01', 'Asta', 'WVE', '140', 'Linen 100%', 'Marlowe', '28.7'],
        ['L', 'L001W-01', 'Limelight', 'WPR', '68', 'Paper', 'Larsen Wall', '38.8'],
        ['M', '01286-01', 'Pav de Bidaine', 'TRM', '', 'Cotton', 'Canovas', '65.9'],
      ],
    )
    expect(reading.entries.map((entry) =>
      [entry.supplier, entry.code, entry.itemType, entry.packType])).toEqual([
      ['Colefax & Fowler', '01020', 'Fabrics', 'p/m'],
      ['Jane Churchill', 'J0025', 'Fabrics', 'p/m'],
      ['Larsen', 'L001W', 'Wallpaper', 'p/roll'],
      ['Manuel Canovas', '01286', 'Trimmings', 'p/m'],
    ])
  })

  it('declines a Jannelli & Volpi sample by the unit it is sold in', () => {
    const reading = ratesOf('JV_EXPORT DEALER_SET_TV8_1 JUN 2026_agg 19062026.xlsx',
      'JANNELLI&VOLPI', [
        ['BRAND', 'COLLECTION', 'FAM', 'ITEM', 'DESIGN', 'SALES UNIT', 'DEALER PRICE 1 JUN 2026',
          'COMPOSITION/SUPPORT', 'WIDTH/MT', 'PATTERN REPEAT cm', 'MATCH'],
        ['JANNELLI&VOLPI', 'JV ALABASTER', 'J27', '6570', 'RIBBON GRASS', 'Roll', '65.92',
          'Vinyl on paper', '0.7', '0', 'Free match'],
        ['JANNELLI&VOLPI', 'JV MURALS', 'J28', '7000', 'GIARDINO', 'Mural - cm 408 L x 300 H',
          '327.8', 'Vinyl', '4.08', '0', 'Free match'],
        ['JANNELLI&VOLPI', 'JV ALABASTER', 'J27', 'JVBOOK', 'SAMPLE BOOK', 'Book', '22', 'Paper',
          '', '', ''],
      ])
    expect(reading.entries.map((entry) => [entry.code, entry.packType, entry.dateEffective]))
      .toEqual([
        ['6570', 'p/roll', '01/06/2026'],
        // A mural is one piece, which is what the office's own JV rows say.
        ['7000', 'p/p', '01/06/2026'],
      ])
    expect(Object.fromEntries(reading.skips))
      .toEqual({ 'sold by "Book", which no template pack type covers': 1 })
  })

  it("reads Pierre Frey's five houses and its French units", () => {
    const reading = ratesOf(
      'Pierre Frey DISTRIBUTOR - 2026 FABRIC  WPP IN DETAILS '
      + '- Pierre Frey Boussac Fadini Borghi Le Manach Braquenie.xlsx',
      '2026-29-01-PF-FICHIER DETAILLE',
      [
        ['Ref Pattern', 'Name', 'Unit', 'Brand', 'Type of product', 'USABLEWIDTH (cm)',
          'Pattern repeat H (cm)', 'Pattern repeat V (cm)', 'COMPOSITION FR',
          'DISTRIBUTOR € EXW'],
        ['B063A', 'LES BLEUETS -', 'M', 'Braquenié', 'Tissu', '130', '0', '49', 'Coton 100%',
          '111'],
        ['F0556', 'CROISE', 'RL', 'Pierre Frey', 'Papier Peint', '90', '0', '0', 'Papier', '65'],
        ['BP348', 'LES ARCADES', 'Pa', 'Le Manach', 'Papier Peint', '130', '0', '0', 'Papier',
          '589'],
      ],
    )
    expect(reading.entries.map((entry) =>
      [entry.supplier, entry.brand, entry.code, entry.itemType, entry.packType])).toEqual([
      // The office spells this house without its accent; the Brand column keeps
      // the file's own spelling, which is what the two columns are for.
      ['Braquenie', 'Braquenié', 'B063A', 'Fabrics', 'p/m'],
      ['Pierre Frey', 'Pierre Frey', 'F0556', 'Wallpaper', 'p/roll'],
      ['Le Manach', 'Le Manach', 'BP348', 'Wallpaper', 'p/p'],
    ])
  })

  it("follows Perennials' own \"Sold by the\" cell", () => {
    const reading = ratesOf('Perennials Wallcoverings Price Guide_Spring26_USA.xlsx', 'ALL SKUS', [
      ['Type', 'Collection', 'Item Number', 'Design', 'Colorway', 'Net  Price\nper Yard',
        'Roll Length', 'Sold by the', 'Net Price per Roll', 'Width', 'Vertical\nRepeat',
        'Horizontal\nRepeat', 'Match'],
      ['Patterns & Murals', '2024 Summer', 'PD100-191', 'ARIGATO', 'SALT & PEPPER', '34', '9 YDS',
        'ROLL', '306', '27"', '25.25"', '', 'STRAIGHT'],
      ['Textures', '2024 Summer', 'TX200-01', 'SISAL', 'BONE', '48', '', 'YARD', '', '36"', '',
        '', ''],
    ])
    expect(reading.entries.map((entry) => [entry.code, entry.packType, entry.wholesale]))
      .toEqual([['PD100-191', 'p/roll', '306'], ['TX200-01', 'p/y', '48']])
  })

  it('gives C & C Milano its pack from the type its dictionary rows explain', () => {
    const reading = ratesOf('C&C Milano 2026 Pricelist.xlsx', 'Listino', [
      ['Tipo/type', 'Modello', 'Bar1', 'Col-1', 'Prezzo', 'Altezza', 'Composizione', 'RapOrdito',
        'RapTrama'],
      ['1 - Tessuti / Fabrics', 'Name', 'Item#', 'Description', 'Price', 'Width', 'Composition',
        'Vertical Repeat', 'Horizontal Repeat'],
      ['1', 'AGUILERA', '232119', 'BIANCO', '49', '140', '70% Recycled cotton', '0', '0'],
      ['2', 'CARTA', '300100', 'AVORIO', '96', '70', 'Paper', '0', '0'],
      ['0', 'Camp. AGUILERA', '900001', '', '12', '', '', '', ''],
    ], 'prefixed')
    expect(reading.entries.map((entry) => [entry.code, entry.itemType, entry.packType])).toEqual([
      ['232119', 'Fabrics', 'p/m'],
      ['300100', 'Wallpaper', 'p/roll'],
    ])
    expect(Object.fromEntries(reading.skips))
      .toEqual({ 'header translation': 1, 'sample cutting': 1 })
  })
})

// ---------------------------------------------------------------------------
// The importer (US-006). The rows below are the normalised file's own shape —
// what scripts/convert-colour-files.js writes — so nothing here reads incoming/
// either. The database tests use the same real local Postgres every other suite
// does; fixtures are namespaced by slug prefix and cleaned up by it.

const HOUSE = 'W8 Import Test House'
const HOUSE_SLUG = 'w8-import-test-house'
const FIXTURE_PREFIX = 'w8-import-test-'
const PRODUCT_SLUG = 'w8-import-test-house-alpha-weave'
const CATALOGUE_BRAND = { id: 7, name: HOUSE, slug: HOUSE_SLUG, currency: 'GBP' }

const importRow = (overrides = {}) => ({
  supplier: 'W8 Import Test Supplier',
  brand: HOUSE,
  design: 'ALPHA WEAVE',
  design_code: 'AW1',
  colour_code: '01',
  colour_name: 'Stone',
  source_file: 'w8-import-test.xlsx',
  source_sheet: 'Sheet1',
  source_row: 2,
  ...overrides,
})

describe('colourway import — planning', () => {
  it('keys a row on the catalogue spelling of the house, not the supplier ones', () => {
    const keys = colourwayKeys(CATALOGUE_BRAND, importRow({ brand: 'w8 IMPORT test HOUSE' }))
    expect(keys).toEqual({
      productSlug: PRODUCT_SLUG,
      sku: 'W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-01',
    })
  })

  it('declines a row it cannot key, naming the kind of row', () => {
    // Liberty prints one such row: design, colour code and name are all "-".
    expect(colourwayKeys(CATALOGUE_BRAND, importRow({ design: '-' })).reason).toBe(NO_DESIGN)
    expect(colourwayKeys(CATALOGUE_BRAND, importRow({ colour_code: '' })).reason)
      .toBe(NO_COLOUR_CODE)
  })

  it('shows the supplier colour code where the file names no colour', () => {
    expect(colourwayName(importRow({ colour_name: '' }))).toBe('01')
    expect(colourwayName(importRow({ colour_name: '  Stone ' }))).toBe('Stone')
  })

  it('reports a house the catalogue does not hold and imports none of its rows', () => {
    const plan = prepareColourwayImport([
      importRow(),
      importRow({ brand: 'FOX LINTON', colour_code: '02', source_row: 3 }),
      importRow({ brand: 'FOX LINTON', colour_code: '03', source_row: 4 }),
    ], [CATALOGUE_BRAND])
    expect(plan.colourways).toHaveLength(1)
    expect(plan.unknownBrands).toEqual([
      { brand: 'FOX LINTON', rows: 2, first: 'w8-import-test.xlsx:Sheet1:3' },
    ])
    expect(plan.skipped).toBe(2)
  })

  it('collapses a repeat that differs only in the supplier casing', () => {
    // Liberty's two sheets write one colourway "Deco Scallop"/"Pewter" and
    // "DECO SCALLOP"/"PEWTER" — 28 of the corpus's 35 repeated SKUs are this.
    const plan = prepareColourwayImport([
      importRow({ design: 'Deco Scallop', colour_name: 'Pewter' }),
      importRow({ design: 'DECO SCALLOP', colour_name: 'PEWTER', source_row: 9 }),
    ], [CATALOGUE_BRAND])
    expect(plan.colourways).toHaveLength(1)
    expect(plan.colourways[0].name).toBe('Pewter')
    expect(plan.duplicates).toBe(1)
    expect(plan.conflicts).toEqual([])
  })

  it('reports a colour code carrying two different names and keeps the first', () => {
    const plan = prepareColourwayImport([
      importRow({ colour_name: 'Blue Grass' }),
      importRow({ colour_name: 'Bluegrass', source_row: 40 }),
    ], [CATALOGUE_BRAND])
    expect(plan.colourways).toHaveLength(1)
    expect(plan.duplicates).toBe(0)
    expect(plan.conflicts).toEqual([{
      sku: 'W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-01',
      kept: {
        sku: 'W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-01',
        name: 'Blue Grass',
        productSlug: PRODUCT_SLUG,
        source: 'w8-import-test.xlsx:Sheet1:2',
      },
      dropped: { name: 'Bluegrass', source: 'w8-import-test.xlsx:Sheet1:40' },
    }])
  })

  it('accounts for every row: colourways + skips + repeats = rows in', () => {
    const plan = prepareColourwayImport([
      importRow(),
      importRow({ colour_code: '02', source_row: 3 }),
      importRow({ brand: 'RSC', source_row: 4 }),
      importRow({ design: '-', source_row: 5 }),
      importRow({ source_row: 6 }),
    ], [CATALOGUE_BRAND])
    expect(plan.colourways.length + plan.skipped + plan.duplicates + plan.conflicts.length)
      .toBe(plan.rows)
    expect(plan.skips).toEqual([
      { reason: NO_DESIGN, rows: 1, first: 'w8-import-test.xlsx:Sheet1:5' },
    ])
    expect(plan.products).toHaveLength(1)
  })

  it('rejects a malformed batch, naming the row and its coordinate', () => {
    expect(() => validateColourwayRows({})).toThrow(/must be an array/)
    expect(() => validateColourwayRows([importRow(), null]))
      .toThrow(/colourway row 1: invalid row/)
    expect(() => validateColourwayRows([importRow({ colour_name: undefined })]))
      .toThrow(/w8-import-test.xlsx:Sheet1:2\): invalid colour_name/)
    expect(() => validateColourwayRows([importRow({ brand: '  ' })]))
      .toThrow(/invalid brand \(expected a non-empty string\)/)
    expect(() => validateColourwayRows([importRow({ source_row: 0 })]))
      .toThrow(/invalid source_row/)
  })
})

describe('colourway import — statements', () => {
  // A stub pool logging SQL, the same instrument test/lifecycle-delete.test.js
  // uses for statement order. Two things only a stub can assert: that the whole
  // import is one transaction, and that it never touches price_list_items.
  const stubPool = () => {
    const statements = []
    const client = {
      query: async (text, params) => {
        statements.push(text.trim().split('\n')[0].trim())
        if (/FROM brands/.test(text)) return { rows: [CATALOGUE_BRAND] }
        if (/FROM products WHERE slug/.test(text)) {
          return { rows: params[0].map((slug, i) => ({ id: i + 1, slug, product_type: 'fabric' })) }
        }
        if (/INTO colourways/.test(text)) {
          return { rows: params[2].map((sku, i) => ({ id: i + 1, sku })) }
        }
        return { rows: [], rowCount: 0 }
      },
      release: () => {},
    }
    return { pool: { connect: async () => client }, statements }
  }

  it('runs one transaction and never reads or writes price_list_items', async () => {
    const { pool, statements } = stubPool()
    await importColourways(pool, [importRow(), importRow({ colour_code: '02', source_row: 3 })])
    expect(statements[0]).toBe('BEGIN')
    expect(statements.at(-1)).toBe('COMMIT')
    // The supplier's colour code is NOT the price list's code — the D365 item
    // code's numeric part is the colour code and does not match it — so no
    // statement here may reach that table.
    expect(statements.filter((sql) => /price_list/i.test(sql))).toEqual([])
  })

  it('takes no connection at all when the batch is malformed', async () => {
    const { pool, statements } = stubPool()
    await expect(importColourways(pool, [importRow({ source_row: 'two' })])).rejects
      .toThrow(/invalid source_row/)
    expect(statements).toEqual([])
  })
})

describe('colourway import — database', () => {
  let pool

  const cleanup = async () => {
    await pool.query('DELETE FROM brands WHERE slug LIKE $1', [`${FIXTURE_PREFIX}%`])
  }

  const catalogue = async () => {
    const { rows } = await pool.query(
      `SELECT p.slug, p.name, p.product_type, p.show_on_website, p.currency,
              c.sku, c.name AS colour, c.hex_tones, c.image_url,
              i.qty_available, i.qty_reserved, i.unit
       FROM products p
       JOIN colourways c ON c.product_id = p.id
       LEFT JOIN inventory i ON i.colourway_id = c.id
       WHERE p.slug LIKE $1
       ORDER BY c.sku`,
      [`${FIXTURE_PREFIX}%`]
    )
    return rows
  }

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
    await cleanup()
    await pool.query(
      `INSERT INTO brands (name, slug, currency, is_international, trade_only)
       VALUES ($1, $2, 'GBP', true, false)`,
      [HOUSE, HOUSE_SLUG]
    )
  })

  afterAll(async () => {
    await cleanup()
    await pool.end()
  })

  it('lands a row as a product, a colourway and a zeroed stock row', async () => {
    const summary = await importColourways(pool, [
      importRow(),
      importRow({ colour_code: '02', colour_name: '', source_row: 3 }),
    ])
    expect(summary).toMatchObject({
      rows: 2, products: 1, colourways: 2, brands: 1, skipped: 0, inventoryCreated: 2,
    })
    expect(await catalogue()).toEqual([
      {
        slug: PRODUCT_SLUG,
        name: 'ALPHA WEAVE',
        product_type: 'fabric',
        // Never published by an import: a design reaches the storefront when
        // somebody in the CRM says so.
        show_on_website: false,
        currency: 'GBP',
        sku: 'W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-01',
        colour: 'Stone',
        hex_tones: null,
        image_url: null,
        qty_available: '0.00',
        qty_reserved: '0.00',
        unit: 'metres',
      },
      {
        slug: PRODUCT_SLUG,
        name: 'ALPHA WEAVE',
        product_type: 'fabric',
        show_on_website: false,
        currency: 'GBP',
        sku: 'W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-02',
        // The file names no colour, so the catalogue shows the code the
        // supplier identifies it by rather than a name nobody wrote.
        colour: '02',
        hex_tones: null,
        image_url: null,
        qty_available: '0.00',
        qty_reserved: '0.00',
        unit: 'metres',
      },
    ])
    // The range is the house.
    const { rows } = await pool.query('SELECT product_range FROM products WHERE slug = $1', [PRODUCT_SLUG])
    expect(rows).toEqual([{ product_range: HOUSE }])
  })

  it('changes nothing on a re-import', async () => {
    const rows = [importRow(), importRow({ colour_code: '02', colour_name: '', source_row: 3 })]
    await importColourways(pool, rows)
    const before = await catalogue()
    const summary = await importColourways(pool, rows)
    expect(await catalogue()).toEqual(before)
    // Stock is DO NOTHING, so a re-run creates none — which is what proves the
    // second run wrote nothing rather than rewriting the same values.
    expect(summary.inventoryCreated).toBe(0)
    expect(summary.colourways).toBe(2)
  })

  it('leaves an operator edit alone', async () => {
    await importColourways(pool, [importRow()])
    await pool.query(
      `UPDATE products SET show_on_website = true, name = 'Alpha Weave', lead_time = '6 weeks'
       WHERE slug = $1`,
      [PRODUCT_SLUG]
    )
    await pool.query(
      `UPDATE colourways SET image_url = 'https://example.test/stone.jpg', hex_tones = $2
       WHERE sku = $1`,
      ['W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-01', JSON.stringify(['#cccccc'])]
    )
    await importColourways(pool, [importRow()])
    const { rows } = await pool.query(
      `SELECT p.name, p.show_on_website, p.lead_time, c.image_url, c.hex_tones
       FROM products p JOIN colourways c ON c.product_id = p.id
       WHERE c.sku = $1`,
      ['W8-IMPORT-TEST-HOUSE-ALPHA-WEAVE-01']
    )
    expect(rows[0]).toEqual({
      // The product is INSERT … DO NOTHING: this file knows a design's name and
      // nothing else, so re-importing must not re-capitalise a house-styled name
      // or take a published design off the storefront.
      name: 'Alpha Weave',
      show_on_website: true,
      lead_time: '6 weeks',
      image_url: 'https://example.test/stone.jpg',
      hex_tones: ['#cccccc'],
    })
  })

  it('never creates a house, and imports nothing under one it cannot find', async () => {
    const summary = await importColourways(pool, [
      importRow({ brand: 'RSC', design: 'BERNARDO PAISLEY', source_row: 11 }),
    ])
    expect(summary.colourways).toBe(0)
    expect(summary.unknownBrands).toEqual([
      { brand: 'RSC', rows: 1, first: 'w8-import-test.xlsx:Sheet1:11' },
    ])
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM brands WHERE slug = $1', ['rsc']
    )
    expect(rows[0].n).toBe(0)
  })

  it('rejects the whole batch before any SQL when one row is malformed', async () => {
    const before = await catalogue()
    await expect(importColourways(pool, [
      importRow({ design: 'BETA WEAVE', source_row: 20 }),
      importRow({ design: 'BETA WEAVE', colour_code: null, source_row: 21 }),
    ])).rejects.toThrow(/colourway row 1 .*invalid colour_code/)
    expect(await catalogue()).toEqual(before)
  })

  it('takes an existing product type, so a finished good stocks in units', async () => {
    const { rows: brand } = await pool.query('SELECT id FROM brands WHERE slug = $1', [HOUSE_SLUG])
    await pool.query(
      `INSERT INTO products (brand_id, name, slug, product_type, currency)
       VALUES ($1, 'GAMMA THROW', $2, 'finished_good', 'GBP')`,
      [brand[0].id, 'w8-import-test-house-gamma-throw']
    )
    await importColourways(pool, [
      importRow({ design: 'GAMMA THROW', colour_code: '77', source_row: 30 }),
    ])
    const { rows } = await pool.query(
      `SELECT p.product_type, i.unit FROM products p
       JOIN colourways c ON c.product_id = p.id
       JOIN inventory i ON i.colourway_id = c.id
       WHERE c.sku = $1`,
      ['W8-IMPORT-TEST-HOUSE-GAMMA-THROW-77']
    )
    expect(rows[0]).toEqual({ product_type: 'finished_good', unit: 'units' })
  })
})
