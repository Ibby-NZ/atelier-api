/**
 * The row-extraction harness every colour-file adapter shares.
 *
 * Eighteen supplier spreadsheets, eighteen layouts. All they have in common is
 * the shape: a workbook holds named sheets, a sheet holds a header row
 * somewhere near the top, and the rows under it are the data. Which sheets to
 * read, how the columns are named and what a row means is what an adapter
 * declares; this module is everything that does not vary.
 *
 * THE HEADER ROW IS FOUND BY MATCHING LABELS, NEVER BY INDEX. Across the
 * corpus the header lands on rows 1, 2, 3, 4, 77, 98, 104, 105 and 106: Jim
 * Thompson hangs a banner row above its, Perennials starts two blank rows in,
 * and the five US houses that share a terms-and-conditions preamble (Clarence
 * House, S Harris, Stroheim, Trend, Vervain) bury theirs a hundred rows down. A
 * fixed index is right for one file and silently wrong for the rest — it would
 * read a sentence of boilerplate as a column name and then every data row as a
 * mismatch, which reads as "the supplier changed the file" rather than as a bug
 * here.
 *
 * Built on lib/{zip,xml,xlsx}.js. No dependencies.
 */
import { openWorkbook, sharedStrings, sheetRows } from './xlsx.js'
import { elements, attribute, namespacePrefix } from './xml.js'

const WORKBOOK = 'xl/workbook.xml'
const WORKBOOK_RELS = 'xl/_rels/workbook.xml.rels'
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

// The deepest header in the corpus is Stroheim's, on row 106, under the terms
// and conditions — so the window has to be generous. The bound exists so a file
// whose header is simply absent fails in a moment instead of reading a
// 20,000-row sheet to reach the same verdict.
export const HEADER_SCAN_LIMIT = 250

const quote = (value) => JSON.stringify(String(value))

/** Lowercase a header cell and collapse its whitespace — newlines included. */
export const normaliseLabel = (cell) =>
  String(cell ?? '').toLowerCase().split(/\s+/).filter(Boolean).join(' ')

/**
 * The relationship-namespace prefix a workbook uses for its `<sheet r:id>`.
 *
 * Every file on hand writes `r:`, but the prefix is the document's to choose,
 * and this corpus already disproves the equivalent assumption about element
 * names: C&C Milano's workbook root is `<x:workbook>` where Excel's is
 * `<workbook>`. Resolving it from the declaration costs one regex.
 */
const relationshipIdAttribute = (xml) => {
  const declared = new RegExp(`xmlns:([A-Za-z0-9_.-]+)="${RELATIONSHIP_NS}"`).exec(xml)
  return `${declared ? declared[1] : 'r'}:id`
}

/**
 * Sheet display name -> zip entry path, in workbook order.
 *
 * A sheet is addressed by NAME, never by `sheet<N>.xml`: the number is the
 * order the sheets were created in rather than the order they appear in, and
 * C&C Milano's only sheet is `sheet.xml` with no number at all. The target is
 * relative to `xl/` unless it is absolute from the package root, which is the
 * form C&C Milano's writer emits.
 */
export const worksheetPaths = (zip) => {
  const xml = zip.read(WORKBOOK).toString('utf8')
  const rels = zip.read(WORKBOOK_RELS).toString('utf8')
  const idAttribute = relationshipIdAttribute(xml)

  const targets = new Map()
  for (const rel of elements(rels, `${namespacePrefix(rels)}Relationship`)) {
    targets.set(attribute(rel.head, 'Id'), attribute(rel.head, 'Target'))
  }

  const paths = new Map()
  for (const sheet of elements(xml, `${namespacePrefix(xml)}sheet`)) {
    const name = attribute(sheet.head, 'name')
    const target = targets.get(attribute(sheet.head, idAttribute))
    if (name === null || target === undefined) continue
    paths.set(name, target.startsWith('/') ? target.slice(1) : `xl/${target}`)
  }
  return paths
}

/**
 * Yield `[rowNumber, cells[]]` for a sheet, cells dense from column 0.
 *
 * `rowNumber` counts `<row>` elements from 1 — a position in the file, not the
 * spreadsheet's row label — which is what makes it a stable coordinate for a
 * `file:sheet:row` error message.
 */
export function* denseRows(zip, path, strings) {
  for (const [rowNumber, cells] of sheetRows(zip, path, strings)) {
    let width = 0
    for (const index of cells.keys()) width = Math.max(width, index + 1)
    const row = []
    for (let index = 0; index < width; index += 1) row.push(cells.get(index) ?? '')
    yield [rowNumber, row]
  }
}

/** Normalised label -> the field that declared it, rejecting an empty label. */
const declaredLabels = (columns, context) => {
  const byLabel = new Map()
  for (const [field, label] of Object.entries(columns)) {
    const normalised = normaliseLabel(label)
    if (normalised === '') throw new Error(`${context}: column ${quote(field)} declares an empty label`)
    byLabel.set(normalised, field)
  }
  if (byLabel.size === 0) throw new Error(`${context}: no columns declared`)
  return byLabel
}

/**
 * Where each wanted label sits in `cells`, or null when this row is not the
 * header.
 *
 * A row that carries a wanted label TWICE and otherwise matches is an error,
 * not a near-miss: `select` would have to pick one of the two columns, and
 * picking silently is how a whole file imports off the wrong cell.
 */
const matchHeader = (cells, wanted, seen, context) => {
  const at = new Map()
  const duplicated = new Set()
  cells.forEach((cell, index) => {
    const label = normaliseLabel(cell)
    if (!wanted.has(label)) return
    seen.add(label)
    if (at.has(label)) duplicated.add(label)
    else at.set(label, index)
  })
  if (at.size !== wanted.size) return null
  if (duplicated.size > 0) {
    throw new Error(`${context}: header carries ${[...duplicated].map(quote).join(', ')} more than once`)
  }
  return at
}

/**
 * Open one declared sheet: locate its header, then hand back the rows under it.
 *
 * `spec` is an adapter's sheet declaration — `{ name, columns }`, optionally
 * `scanLimit`. `columns` maps the adapter's own field names onto the labels the
 * supplier printed, and that map is both the column map and the thing the
 * header is recognised by, so the two can never disagree.
 */
export const openSheet = (workbook, spec) => {
  const { source, zip, strings, paths } = workbook
  const context = `${source}:${spec.name}`
  const path = paths.get(spec.name)
  if (path === undefined) {
    throw new Error(
      `${context}: no such sheet; the workbook has ${[...paths.keys()].map(quote).join(', ')}`,
    )
  }

  const byLabel = declaredLabels(spec.columns, context)
  const wanted = new Set(byLabel.keys())
  const limit = spec.scanLimit ?? HEADER_SCAN_LIMIT
  const rows = denseRows(zip, path, strings)

  const seen = new Set()
  let headerRow = 0
  let found = null
  for (let scanned = 0; scanned < limit && found === null; scanned += 1) {
    const next = rows.next()
    if (next.done) break
    headerRow = next.value[0]
    found = matchHeader(next.value[1], wanted, seen, `${context}:${next.value[0]}`)
  }
  if (found === null) {
    // Naming the labels never seen ANYWHERE in the window is what distinguishes
    // a renamed column from a header that is simply further down than the bound.
    const missing = [...wanted].filter((label) => !seen.has(label))
    throw new Error(`${context}: no header row in the first ${limit} rows; `
      + (missing.length > 0
        ? `never saw ${missing.map(quote).join(', ')}`
        : `every label appears, but never all in one row`))
  }

  const columnAt = new Map([...byLabel].map(([label, field]) => [field, found.get(label)]))
  return Object.freeze({
    name: spec.name,
    headerRow,
    columnAt,
    rows,
    /** The declared fields of one data row, trimmed; an absent cell is ''. */
    select: (cells) => {
      const values = {}
      for (const [field, index] of columnAt) values[field] = String(cells[index] ?? '').trim()
      return values
    },
  })
}

/**
 * Open a workbook for extraction. `source` is the label that prefixes every
 * error this file produces — pass the file's basename, so a message reads
 * `file:sheet:row` like the price-list converter's.
 */
export const openColourWorkbook = (buffer, source) => {
  const zip = openWorkbook(buffer)
  const workbook = { source, zip, strings: sharedStrings(zip), paths: worksheetPaths(zip) }
  return Object.freeze({
    source,
    sheetNames: () => [...workbook.paths.keys()],
    open: (spec) => openSheet(workbook, spec),
  })
}
