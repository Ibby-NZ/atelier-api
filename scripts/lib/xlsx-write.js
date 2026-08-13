/**
 * Minimal xlsx WRITER — the mirror of `zip.js`/`xlsx.js`, which only read.
 *
 * Same posture and the same reason: an xlsx is a plain (non-ZIP64, unencrypted)
 * archive of XML parts, Node bundles `zlib` — `deflateRawSync` and, since 20.12,
 * `crc32` — so a workbook needs no dependency. What it does need is exactness:
 * unlike the reader, which can be lenient about what it accepts, Excel refuses a
 * part whose child elements are out of schema order and reports it as "we found
 * a problem with some content", naming nothing.
 *
 * Deliberately not general. A string cell goes through the shared table and
 * stays text, so a code like "81634" or "007" stays the code and is not silently
 * turned into a number; only an actual JS number is written as a numeric cell,
 * which is what keeps a stock quantity sortable and addable. Beyond that: one
 * style over the default (a bold header row), and per sheet a frozen header, an
 * autofilter and optional list validations. That is the whole feature set the category sheets need, and each
 * piece is here because a CSV cannot carry it — which is the reason this file
 * exists rather than a fifty-first CSV.
 */
import { crc32, deflateRawSync } from 'node:zlib'

/** Excel's own limits. A name past 31 chars or a sheet past 1,048,576 rows is
 *  refused by Excel with no useful message, so both are enforced here. */
const MAX_SHEET_NAME = 31
const MAX_ROWS = 1048576
// Excel forbids these in a sheet name, plus a leading/trailing apostrophe.
const ILLEGAL_SHEET_NAME = /[[\]:*?/\\]/g
// XML 1.0 §2.2: the only C0 controls a document may carry are TAB, LF and CR.
// Staff-typed free text out of D365 has carried others, and one of them makes
// the whole workbook unreadable rather than the one cell.
// Written as escapes, never as the literal bytes: an invisible character in
// source is invisible in every diff too (the BOM rule in src/products/CLAUDE.md).
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const DOC_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml'

export const escapeXml = (value) =>
  String(value)
    .replace(ILLEGAL_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** Zero-based column index to its letters: 0 -> A, 26 -> AA. */
export const columnLetter = (index) => {
  let letters = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  }
  return letters
}

/**
 * A sheet name Excel will accept: illegal characters dropped, apostrophes
 * trimmed off the ends, truncated to 31, and made unique against the names
 * already taken — CASE-INSENSITIVELY, because Excel treats "Fabric" and "FABRIC"
 * as the same tab and refuses the workbook rather than renaming one for you.
 *
 * @param {string} name
 * @param {Set<string>} taken  lower-cased names already used; this mutates it
 */
export const sheetName = (name, taken) => {
  const cleaned = String(name).replace(ILLEGAL_SHEET_NAME, ' ').replace(/^'+|'+$/g, '').trim()
  const base = (cleaned || 'Sheet').slice(0, MAX_SHEET_NAME)
  let candidate = base
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    const suffix = ` (${n})`
    candidate = base.slice(0, MAX_SHEET_NAME - suffix.length) + suffix
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/** The shared-string table: one entry per distinct string, cells hold its index.
 *  Every sheet here repeats the whole catalogue once, so this is not a
 *  micro-optimisation — it is what keeps the workbook openable. */
const createStringTable = () => {
  const index = new Map()
  const order = []
  let references = 0
  return {
    /** @param {unknown} value @returns {number} */
    intern(value) {
      const text = value === null || value === undefined ? '' : String(value)
      references += 1
      const existing = index.get(text)
      if (existing !== undefined) return existing
      const at = order.length
      index.set(text, at)
      order.push(text)
      return at
    },
    toXml() {
      // xml:space="preserve" or Excel eats a leading/trailing space in a value.
      const items = order.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
      return `${XML_DECLARATION}<sst xmlns="${SHEET_NS}" count="${references}" uniqueCount="${order.length}">${items.join('')}</sst>`
    },
  }
}

/**
 * One worksheet part.
 *
 * CT_Worksheet's children are a SEQUENCE, not a choice: sheetViews, cols,
 * sheetData, autoFilter, dataValidations — in that order. Emitting autoFilter
 * before sheetData produces a file Excel repairs by discarding content, which
 * looks exactly like a data bug and is not one.
 */
const worksheetXml = (sheet, strings) => {
  const rows = sheet.rows
  if (rows.length > MAX_ROWS) {
    throw new Error(`sheet "${sheet.name}" has ${rows.length} rows; Excel holds ${MAX_ROWS}`)
  }
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  const lastColumn = columnLetter(Math.max(0, width - 1))
  const dimension = `A1:${lastColumn}${Math.max(1, rows.length)}`

  const body = rows.map((row, rowIndex) => {
    const number = rowIndex + 1
    const cells = row.map((value, columnIndex) => {
      const reference = `${columnLetter(columnIndex)}${number}`
      // An empty cell is omitted entirely rather than written blank: it is the
      // same value to a reader and it is a third of this file's bytes.
      if (value === null || value === undefined || value === '') {
        return rowIndex === 0 ? `<c r="${reference}" s="1"/>` : ''
      }
      const style = rowIndex === 0 ? ' s="1"' : ''
      // A JS number becomes a NUMERIC cell; everything else stays text. The
      // caller decides by what it passes, which is the only way to keep a
      // quantity sortable and addable while a code like "00815" or "81634" —
      // a string here — stays the code rather than becoming 815.
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new Error(`cell ${reference} is ${value}; a sheet cannot hold a non-finite number`)
        }
        return `<c r="${reference}"${style}><v>${value}</v></c>`
      }
      return `<c r="${reference}"${style} t="s"><v>${strings.intern(value)}</v></c>`
    })
    return `<row r="${number}">${cells.join('')}</row>`
  })

  // The header stays on screen and the filter arrows sit on it. Both are what a
  // 19,000-row sheet is unusable without, and neither survives a CSV.
  const frozen =
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
  const cols = sheet.widths
    ? `<cols>${sheet.widths
        .map((wide, at) => `<col min="${at + 1}" max="${at + 1}" width="${wide}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''
  const filter = rows.length > 1 ? `<autoFilter ref="${dimension}"/>` : ''
  const validations = (sheet.validations ?? []).filter((rule) => rule.values.length > 0)
  const dataValidations = validations.length
    ? `<dataValidations count="${validations.length}">${validations
        .map(
          (rule) =>
            `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" errorTitle="${escapeXml(rule.title ?? 'Not a category')}" error="${escapeXml(rule.message ?? '')}" sqref="${escapeXml(rule.ref)}"><formula1>"${escapeXml(rule.values.join(','))}"</formula1></dataValidation>`
        )
        .join('')}</dataValidations>`
    : ''

  return `${XML_DECLARATION}<worksheet xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><dimension ref="${dimension}"/>${frozen}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body.join('')}</sheetData>${filter}${dataValidations}</worksheet>`
}

// Two fills and one border are not decoration: the ECMA-376 defaults require
// index 0 and 1 of `fills` to be `none` and `gray125`, and Excel repairs a
// styles part missing them. xf 0 is the default cell, xf 1 the bold header.
const STYLES_XML = `${XML_DECLARATION}<styleSheet xmlns="${SHEET_NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`

const contentTypesXml = (count) =>
  `${XML_DECLARATION}<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${DOC_TYPE}.sheet.main+xml"/>${Array.from(
    { length: count },
    (_, at) =>
      `<Override PartName="/xl/worksheets/sheet${at + 1}.xml" ContentType="${DOC_TYPE}.worksheet+xml"/>`
  ).join(
    ''
  )}<Override PartName="/xl/styles.xml" ContentType="${DOC_TYPE}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${DOC_TYPE}.sharedStrings+xml"/></Types>`

const ROOT_RELS = `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`

// ---------------------------------------------------------------------------
// The ZIP container. Stored fixed at the 1980-01-01 DOS epoch so the same rows
// produce the same bytes — the byte-identity gate the pricing pipeline uses to
// prove a converter change altered nothing works only if nothing else moves.
// ---------------------------------------------------------------------------

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const DEFLATED = 8
const DOS_EPOCH_DATE = 0x0021 // 1980-01-01
const DOS_EPOCH_TIME = 0x0000
const ZIP64_LIMIT = 0xffffffff

const zipEntry = (name, contents) => {
  const data = Buffer.from(contents, 'utf8')
  const compressed = deflateRawSync(data, { level: 9 })
  return { name: Buffer.from(name, 'utf8'), crc: crc32(data), size: data.length, compressed }
}

/**
 * A ZIP archive of the given parts. Non-ZIP64 by construction: an entry or a
 * total past 4 GB throws rather than writing a truncated size field, which is a
 * corrupt archive that reads fine until it does not.
 *
 * @param {{name: Buffer, crc: number, size: number, compressed: Buffer}[]} entries
 * @returns {Buffer}
 */
const zipArchive = (entries) => {
  const locals = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    if (entry.size > ZIP64_LIMIT || offset > ZIP64_LIMIT) {
      throw new Error('workbook exceeds 4 GB; ZIP64 is not supported')
    }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_SIGNATURE, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0x0800, 6) // flags: UTF-8 file names
    header.writeUInt16LE(DEFLATED, 8)
    header.writeUInt16LE(DOS_EPOCH_TIME, 10)
    header.writeUInt16LE(DOS_EPOCH_DATE, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.compressed.length, 18)
    header.writeUInt32LE(entry.size, 22)
    header.writeUInt16LE(entry.name.length, 26)
    header.writeUInt16LE(0, 28) // extra field length
    locals.push(header, entry.name, entry.compressed)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(0x0800, 8)
    record.writeUInt16LE(DEFLATED, 10)
    record.writeUInt16LE(DOS_EPOCH_TIME, 12)
    record.writeUInt16LE(DOS_EPOCH_DATE, 14)
    record.writeUInt32LE(entry.crc, 16)
    record.writeUInt32LE(entry.compressed.length, 20)
    record.writeUInt32LE(entry.size, 24)
    record.writeUInt16LE(entry.name.length, 28)
    record.writeUInt32LE(0, 38) // external attributes
    record.writeUInt32LE(offset, 42)
    central.push(record, entry.name)

    offset += 30 + entry.name.length + entry.compressed.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(EOCD_SIGNATURE, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, directory, end])
}

/**
 * A workbook as bytes.
 *
 * ROW 1 OF EVERY SHEET IS THE HEADER: it is emitted bold, frozen, and carries
 * the filter arrows. Nothing here inspects it otherwise — the header contract
 * belongs to the caller, as it does for the CSV sheets.
 *
 * @param {{name: string, rows: unknown[][], widths?: number[],
 *          validations?: {ref: string, values: string[], title?: string, message?: string}[]}[]} sheets
 * @returns {Buffer}
 */
export const buildWorkbook = (sheets) => {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('a workbook needs at least one sheet')
  }
  const taken = new Set()
  const named = sheets.map((sheet) => ({ ...sheet, name: sheetName(sheet.name, taken) }))

  const strings = createStringTable()
  // The parts are built before the string table is serialised: interning happens
  // as each sheet is written, so sharedStrings.xml must come last.
  const worksheets = named.map((sheet) => worksheetXml(sheet, strings))

  const sheetTags = named
    .map((sheet, at) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${at + 1}" r:id="rId${at + 1}"/>`)
    .join('')
  const workbook = `${XML_DECLARATION}<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${sheetTags}</sheets></workbook>`

  const relationships = named
    .map(
      (_, at) =>
        `<Relationship Id="rId${at + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${at + 1}.xml"/>`
    )
    .join('')
  const workbookRels = `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_REL_NS}">${relationships}<Relationship Id="rId${named.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/><Relationship Id="rId${named.length + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`

  return zipArchive([
    zipEntry('[Content_Types].xml', contentTypesXml(named.length)),
    zipEntry('_rels/.rels', ROOT_RELS),
    zipEntry('xl/workbook.xml', workbook),
    zipEntry('xl/_rels/workbook.xml.rels', workbookRels),
    zipEntry('xl/styles.xml', STYLES_XML),
    ...worksheets.map((xml, at) => zipEntry(`xl/worksheets/sheet${at + 1}.xml`, xml)),
    zipEntry('xl/sharedStrings.xml', strings.toXml()),
  ])
}
