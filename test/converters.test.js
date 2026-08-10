import { describe, it, expect } from 'vitest'
import { deflateRawSync } from 'node:zlib'
import { openZip } from '../scripts/lib/zip.js'
import { namespacePrefix, decodeXmlText, elements, attribute, joinTagText } from '../scripts/lib/xml.js'
import { sharedStrings, sheetRows, excelDate, excelTimestamp } from '../scripts/lib/xlsx.js'
import { decodeText, csvRows } from '../scripts/lib/text.js'
import {
  parseNumber, round4, floatRepr, generalFormat, dumps, dumpsIndented,
} from '../scripts/lib/python-format.js'

// These converters replaced Python scripts and are pinned to byte-identical
// output — src/seed/data/price-lists.json is committed, so a formatting drift
// is an 8 MB diff. Everything here is pure: no database, no fixtures on disk.

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

/** Build a real zip in memory: deflated members, so zip.js inflates for real. */
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

describe('python-format', () => {
  it('writes floats the way repr() does', () => {
    expect(floatRepr(115)).toBe('115.0')
    expect(floatRepr(20.76)).toBe('20.76')
    expect(floatRepr(0)).toBe('0.0')
    expect(floatRepr(-0.5)).toBe('-0.5')
    expect(floatRepr(0.0001)).toBe('0.0001')
    expect(floatRepr(1e15)).toBe('1000000000000000.0')
  })

  it('switches to a two-digit exponent where Python does, not where JS does', () => {
    expect(floatRepr(1e16)).toBe('1e+16')
    expect(floatRepr(1.5e16)).toBe('1.5e+16')
    expect(floatRepr(0.00001)).toBe('1e-05')
  })

  it("formats measurements the way format(x, 'g') does", () => {
    expect(generalFormat(round4(256.60000000000002))).toBe('256.6')
    expect(generalFormat(round4(140))).toBe('140')
    expect(generalFormat(round4(0.53))).toBe('0.53')
    expect(generalFormat(0)).toBe('0')
    expect(generalFormat(1234567)).toBe('1.23457e+06')
  })

  it('rejects what float() rejects but Number() accepts', () => {
    expect(parseNumber(' 65.5 ')).toBe(65.5)
    expect(parseNumber('1e3')).toBe(1000)
    expect(() => parseNumber('')).toThrow()
    expect(() => parseNumber('   ')).toThrow()
    expect(() => parseNumber('0x10')).toThrow()
    expect(() => parseNumber('12m')).toThrow()
  })

  it('separates like json.dumps, not like JSON.stringify', () => {
    expect(dumps({ code: 'A1', rate: 65, hidden: null })).toBe('{"code": "A1", "rate": 65.0, "hidden": null}')
    expect(dumps([1, 2])).toBe('[1.0, 2.0]')
    expect(dumps({ text: 'a "b" \\ c\nd' })).toBe('{"text": "a \\"b\\" \\\\ c\\nd"}')
    expect(dumps({ accent: 'Café' })).toBe('{"accent": "Café"}')
  })

  it('indents like json.dumps(indent=0): newlines, no spaces', () => {
    expect(dumpsIndented([{ a: 1, raw: {} }], 0)).toBe('[\n{\n"a": 1.0,\n"raw": {}\n}\n]')
  })

  it('keeps Map insertion order, which is how record key order is guaranteed', () => {
    const record = new Map([['source_file', 'x.xlsx'], ['guid', 'g']])
    record.set('source_file', 'y.xlsx')
    expect(dumps(record)).toBe('{"source_file": "y.xlsx", "guid": "g"}')
  })
})

describe('xml scanning', () => {
  it('resolves the element prefix D365 uses and Excel does not', () => {
    expect(namespacePrefix('<?xml version="1.0"?><x:worksheet><x:row/></x:worksheet>')).toBe('x:')
    expect(namespacePrefix('<?xml version="1.0"?><worksheet><row/></worksheet>')).toBe('')
  })

  it('normalises literal CRLF in content but keeps a character reference', () => {
    expect(decodeXmlText('one\r\ntwo\rthree')).toBe('one\ntwo\nthree')
    expect(decodeXmlText('a&#13;b')).toBe('a\rb')
    expect(decodeXmlText('A &amp; B &lt;x&gt; &#65;')).toBe('A & B <x> A')
  })

  it('walks elements without being fooled by a longer tag name', () => {
    const xml = '<sheetData><rowBreaks/><row r="1"><c r="A1"><v>7</v></c></row></sheetData>'
    const rows = [...elements(xml, 'row')]
    expect(rows).toHaveLength(1)
    expect(attribute(rows[0].head, 'r')).toBe('1')
    expect(joinTagText(xml, 'v', rows[0].from, rows[0].to)).toBe('7')
  })
})

describe('xlsx reading', () => {
  const workbook = buildZip({
    'xl/sharedStrings.xml':
      '<?xml version="1.0"?><x:sst xmlns:x="urn:x"><x:si><x:t>Code</x:t></x:si>'
      + '<x:si><x:r><x:t>Cafe</x:t></x:r><x:r><x:t>́ au lait</x:t></x:r></x:si></x:sst>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><x:worksheet xmlns:x="urn:x"><x:sheetData>'
      + '<x:row><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="C1" t="inlineStr"><x:is><x:t>Inline</x:t></x:is></x:c></x:row>'
      + '<x:row><x:c r="A2" t="s"><x:v>1</x:v></x:c><x:c r="B2"><x:v>45870.5</x:v></x:c></x:row>'
      + '</x:sheetData></x:worksheet>',
  })

  it('reads shared strings, inline strings and sparse columns', () => {
    const zip = openZip(workbook)
    const strings = sharedStrings(zip)
    expect(strings[0]).toBe('Code')
    const rows = [...sheetRows(zip, 'xl/worksheets/sheet1.xml', strings)]
    expect(rows).toHaveLength(2)
    expect(rows[0][1].get(0)).toBe('Code')
    expect(rows[0][1].has(1)).toBe(false) // the gap is absent, not empty
    expect(rows[0][1].get(2)).toBe('Inline')
    expect(rows[1][1].get(1)).toBe('45870.5')
  })

  it('rejects an archive it cannot read rather than returning wrong bytes', () => {
    expect(() => openZip(Buffer.alloc(64))).toThrow(/not a zip archive/)
  })

  it('converts Excel serials against the 1899-12-30 epoch', () => {
    expect(excelDate(2)).toBe('1900-01-01')
    expect(excelDate(45870)).toBe('2025-08-01')
    expect(excelTimestamp(45870.5)).toBe('2025-08-01 12:00:00')
    expect(excelTimestamp(45870.13327546296)).toBe('2025-08-01 03:11:55')
  })
})

describe('text decoding and CSV', () => {
  it('prefers UTF-8, strips the BOM, and falls back to cp1252', () => {
    expect(decodeText(Buffer.from('﻿Café', 'utf8'))).toBe('Café')
    // 0x92 is a right single quote in cp1252 and invalid UTF-8.
    expect(decodeText(Buffer.from([0x4f, 0x92, 0x73]))).toBe('O’s')
  })

  it('reads quoted fields, embedded separators and every line ending', () => {
    const rows = [...csvRows('a,"b,1","say ""hi"""\r\nc,d,e\nf,g,h')]
    expect(rows).toEqual([
      [1, ['a', 'b,1', 'say "hi"']],
      [2, ['c', 'd', 'e']],
      [3, ['f', 'g', 'h']],
    ])
  })

  it('does not invent a final empty row for a trailing newline', () => {
    expect([...csvRows('a,b\n')]).toEqual([[1, ['a', 'b']]])
    expect([...csvRows('a,b\n\n')]).toEqual([[1, ['a', 'b']], [2, ['']]])
    expect([...csvRows('')]).toEqual([])
  })
})
