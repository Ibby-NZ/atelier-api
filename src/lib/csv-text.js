/**
 * Byte decoding and CSV reading, shared by the supplier price-list converter and
 * by any route that accepts a spreadsheet staff saved out of Excel.
 *
 * The templates arrive from ~40 different suppliers' spreadsheets: roughly
 * two-fifths are cp1252, the rest UTF-8, and nothing declares which. So the
 * encoding is sniffed the same way the Python converter did — strict UTF-8
 * first (a cp1252 file with a high byte will fail it), then cp1252, then
 * latin-1, which cannot fail.
 *
 * cp1252 is decoded from a table rather than `TextDecoder('windows-1252')` so
 * the result does not depend on how the running Node was built against ICU.
 */

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

// cp1252 is latin-1 except for 0x80-0x9F. Five of those bytes are undefined and
// decoding them is an error, exactly as in Python.
const CP1252_HIGH = [
  0x20ac, null, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
]

const decodeCp1252 = (bytes) => {
  let text = ''
  for (const byte of bytes) {
    if (byte < 0x80 || byte > 0x9f) {
      text += String.fromCharCode(byte)
      continue
    }
    const code = CP1252_HIGH[byte - 0x80]
    if (code === null) throw new Error(`byte 0x${byte.toString(16)} is undefined in cp1252`)
    text += String.fromCharCode(code)
  }
  return text
}

/** Decode a text file of unknown encoding: utf-8 (BOM tolerated), cp1252, latin-1. */
export const decodeText = (bytes) => {
  try {
    return UTF8_STRICT.decode(bytes)
  } catch {
    /* not UTF-8 — fall through */
  }
  try {
    return decodeCp1252(bytes)
  } catch {
    return bytes.toString('latin1')
  }
}

/**
 * Yield `[lineNumber, fields]` for RFC-4180-ish CSV, matching Python's
 * `csv.reader` defaults: comma delimiter, doubled quotes, quoting only
 * recognised at the start of a field, and `\r\n` / `\n` / `\r` all ending a row.
 * A trailing newline does not produce a final empty row.
 */
export function* csvRows(text) {
  const length = text.length
  let at = 0
  let lineNumber = 0
  while (at < length) {
    const row = []
    let field = ''
    let quoted = false
    while (at < length) {
      const char = text[at]
      if (quoted) {
        if (char === '"') {
          if (text[at + 1] === '"') {
            field += '"'
            at += 2
            continue
          }
          quoted = false
          at += 1
          continue
        }
        field += char
        at += 1
        continue
      }
      if (char === '"' && field === '') {
        quoted = true
        at += 1
        continue
      }
      if (char === ',') {
        row.push(field)
        field = ''
        at += 1
        continue
      }
      if (char === '\n') {
        at += 1
        break
      }
      if (char === '\r') {
        at += 1
        if (text[at] === '\n') at += 1
        break
      }
      field += char
      at += 1
    }
    row.push(field)
    lineNumber += 1
    yield [lineNumber, row]
  }
}
