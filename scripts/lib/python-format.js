/**
 * Number and JSON formatting that reproduces CPython's byte-for-byte.
 *
 * These converters replaced Python scripts whose output is committed
 * (`src/seed/data/price-lists.json`) or diffed between runs, so "same data" is
 * not enough — the same bytes are. Three habits of Python's differ from JS:
 *
 *   1. `repr(115.0)` is `115.0`; `String(115)` is `115`.
 *   2. `repr` switches to exponent notation at 1e16, `String` at 1e21, and
 *      Python pads the exponent to two digits (`1e+16`, not `1e+6`).
 *   3. `json.dumps` separates with `", "` and `": "`, not `","` and `":"`.
 *
 * `format(x, 'g')` (6 significant digits, trailing zeros dropped) is a fourth,
 * used to scrub float noise out of measurement text.
 */

const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Strict float parse. Rejects everything `Number()` is loose about — `''`,
 * `'0x10'`, whitespace-only — so a malformed cell surfaces as a reported error
 * instead of a plausible-looking zero.
 */
export const parseNumber = (text) => {
  const trimmed = String(text).trim()
  if (!NUMBER_PATTERN.test(trimmed)) throw new Error(`non-numeric value "${text}"`)
  return Number(trimmed)
}

/** Python's `round(x, 4)`. */
export const round4 = (value) => Number(value.toFixed(4))

const padExponent = (exponent) =>
  `${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`

const stripTrailingZeros = (text) =>
  text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text

const plainDecimal = (digits, exponent) => {
  const pointAt = exponent + 1
  if (pointAt <= 0) return `0.${'0'.repeat(-pointAt)}${digits}`
  if (pointAt >= digits.length) return `${digits}${'0'.repeat(pointAt - digits.length)}.0`
  return `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`
}

/** Python's `repr(float)` — shortest round-trip, always with a decimal point. */
export const floatRepr = (value) => {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  const sign = value < 0 || Object.is(value, -0) ? '-' : ''
  const magnitude = Math.abs(value)
  if (magnitude === 0) return `${sign}0.0`
  const [mantissa, exponentText] = magnitude.toExponential().split('e')
  const exponent = Number(exponentText)
  if (exponent < -4 || exponent >= 16) return `${sign}${mantissa}e${padExponent(exponent)}`
  return sign + plainDecimal(mantissa.replace('.', ''), exponent)
}

/** Python's `format(x, 'g')` — 6 significant digits, trailing zeros dropped. */
export const generalFormat = (value) => {
  if (Number.isNaN(value)) return 'nan'
  if (value === Infinity) return 'inf'
  if (value === -Infinity) return '-inf'
  const sign = value < 0 || Object.is(value, -0) ? '-' : ''
  const magnitude = Math.abs(value)
  if (magnitude === 0) return `${sign}0`
  const [mantissa, exponentText] = magnitude.toExponential(5).split('e')
  const exponent = Number(exponentText)
  if (exponent < -4 || exponent >= 6) {
    return `${sign}${stripTrailingZeros(mantissa)}e${padExponent(exponent)}`
  }
  return sign + stripTrailingZeros(magnitude.toFixed(Math.max(0, 5 - exponent)))
}

// JSON.stringify already escapes exactly what json.dumps(ensure_ascii=False)
// does for a string: the quote, the backslash, and the C0 controls, with the
// same short forms. Everything else, non-ASCII included, stays raw.
const quote = (text) => JSON.stringify(text)

const entriesOf = (value) => (value instanceof Map ? [...value] : Object.entries(value))

const isMapping = (value) =>
  value instanceof Map || (typeof value === 'object' && !Array.isArray(value))

const dump = (value, indent, depth) => {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // Every number these converters emit came from a Python float, never an int.
  if (typeof value === 'number') return floatRepr(value)
  if (typeof value === 'string') return quote(value)

  const inner = indent === null ? '' : `\n${' '.repeat(indent * (depth + 1))}`
  const outer = indent === null ? '' : `\n${' '.repeat(indent * depth)}`
  const separator = indent === null ? ', ' : `,${inner}`

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => dump(item, indent, depth + 1))
    return `[${inner}${items.join(separator)}${outer}]`
  }
  if (isMapping(value)) {
    const entries = entriesOf(value)
    if (entries.length === 0) return '{}'
    const items = entries.map(([key, item]) => `${quote(key)}: ${dump(item, indent, depth + 1)}`)
    return `{${inner}${items.join(separator)}${outer}}`
  }
  throw new Error(`cannot serialise ${typeof value}`)
}

/** `json.dumps(value, ensure_ascii=False)`. */
export const dumps = (value) => dump(value, null, 0)

/** `json.dumps(value, ensure_ascii=False, indent=indent)`. */
export const dumpsIndented = (value, indent) => dump(value, indent, 0)
