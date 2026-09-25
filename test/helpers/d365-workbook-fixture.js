// A Dynamics 365 "dynamic worksheet" export, built in memory for tests.
//
// The real exports are client data and live in the gitignored `incoming/`,
// which no test may read. This writes the same envelope the reader depends on:
//
//   xl/worksheets/sheet.xml   A1 = '<entity>:<signature>:<logical>=<Display>&...'
//   xl/worksheets/sheet2.xml  row 1 display names, then the data grid
//
// with every text cell INLINE (`t="inlineStr"`), exactly as the tracking-option
// exports arrive — they carry no sharedStrings.xml at all. Stored, not
// deflated: the reader takes both and a fixture has no reason to compress.

import { crc32 } from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50

const zip = (files) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const column = (index) => String.fromCharCode(65 + index)

const cell = (ref, value) =>
  typeof value === 'number'
    ? `<x:c r="${ref}"><x:v>${value}</x:v></x:c>`
    : `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${escape(value)}</x:t></x:is></x:c>`

const sheet = (rows) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>' +
  rows
    .map(
      (row, r) =>
        `<x:row r="${r + 1}">` +
        row
          .map((value, c) => (value == null || value === '' ? '' : cell(`${column(c)}${r + 1}`, value)))
          .join('') +
        '</x:row>'
    )
    .join('') +
  '</x:sheetData></x:worksheet>'

/** The tracking-option view's columns, in the order the client's export has them. */
export const TRACKING_OPTION_COLUMNS = Object.freeze([
  ['fulmxero_trackingoptionid', '(Do Not Modify) Tracking Option'],
  ['checksumLogicalName', '(Do Not Modify) Row Checksum'],
  ['modifiedon', '(Do Not Modify) Modified On'],
  ['fulmxero_trackingcategoryid', 'Tracking Category'],
  ['fulmxero_name', 'Name'],
  ['fulmxero_supplierid', 'Supplier'],
  ['fulmxero_dutyratea', 'Duty Rate A (%)'],
  ['fulmxero_dutyrateb', 'Duty Rate B (%)'],
  ['fulmxero_dutyratec', 'Duty Rate C (%)'],
  ['fulmxero_clearance', 'Clearance'],
  ['fulmxero_freight', 'Freight'],
  ['fulmxero_discount', 'Discount (%)'],
  ['atelier_trademarkup', 'Trade Markup (%)'],
  ['fulmar_minqtytoavoidsurcharge', 'Min Qty to avoid surcharge'],
  ['fulmar_surchargeperunit', 'Surcharge $ per unit'],
  ['statecode', 'Status'],
])

/**
 * A workbook for `entity` with the given data rows (arrays in column order).
 *
 * @param {(string|number|null)[][]} rows
 * @param {{ entity?: string, columns?: [string, string][] }} [options]
 * @returns {Buffer}
 */
export const d365Workbook = (rows, { entity = 'fulmxero_trackingoption', columns = TRACKING_OPTION_COLUMNS } = {}) => {
  const map = columns.map(([logical, display]) => `${logical}=${encodeURIComponent(display)}`).join('&')
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="utf-8"?><Types/>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="utf-8"?><workbook/>',
    'xl/worksheets/sheet.xml': sheet([[`${entity}:c2lnbmF0dXJl:${map}`], ['Active', 'Inactive']]),
    'xl/worksheets/sheet2.xml': sheet([columns.map(([, display]) => display), ...rows]),
  })
}

/**
 * One Range row in TRACKING_OPTION_COLUMNS order.
 *
 * @param {string} guid
 * @param {string} name
 * @param {object} [values] duty [a, b, c], clearance, freight, discount, markup, minQty, surcharge, supplier, status, category
 */
export const trackingRow = (guid, name, values = {}) => {
  const {
    category = 'Range',
    supplier = null,
    duty = [5, 5, 5],
    clearance = 10,
    freight = null,
    discount = null,
    markup = null,
    minQty = null,
    surcharge = null,
    status = 'Active',
  } = values
  return [
    guid,
    'checksum==',
    45902.0016898148,
    category,
    name,
    supplier,
    duty[0],
    duty[1],
    duty[2],
    clearance,
    freight,
    discount,
    markup,
    minQty,
    surcharge,
    status,
  ]
}
