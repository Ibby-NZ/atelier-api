/**
 * A scanner for the narrow slice of XML that SpreadsheetML actually emits:
 * flat, machine-generated, no DTDs, no CDATA, no namespace surprises beyond the
 * single default namespace. Node ships no XML parser and a full one is not
 * needed here — `elements()` walks tags by name with indexOf, which is what
 * keeps a 60 MB sheet2.xml tolerable.
 *
 * Text nodes are the only place `<` can appear, and it is always escaped there,
 * so tag scanning cannot be fooled by content.
 */

const NAMED_ENTITIES = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
})

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g

// XML 1.0 §2.11: a parser normalises literal CRLF and lone CR in content to LF
// before anything else sees it. A character reference (&#13;) is not literal and
// survives, which is why this runs before entity expansion, not after.
const normaliseLineEndings = (text) => (text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text)

/** Expand the XML entities an escaped text node may carry. */
export const decodeXmlText = (raw) => {
  const text = normaliseLineEndings(raw)
  if (!text.includes('&')) return text
  return text.replace(ENTITY_PATTERN, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

const ROOT_ELEMENT_PATTERN = /<([A-Za-z_][A-Za-z0-9_.-]*:)?[A-Za-z_]/

/**
 * The element-name prefix a document uses, `''` when it has none.
 *
 * SpreadsheetML is written both ways: Excel emits `<row>` in the default
 * namespace, D365's exporter emits `<x:row>`. Resolving the prefix once from the
 * root element keeps tag lookup a plain indexOf instead of a namespace-aware
 * walk, which matters on a 100 MB sheet.
 */
export const namespacePrefix = (xml) => ROOT_ELEMENT_PATTERN.exec(xml)?.[1] ?? ''

const isTagBoundary = (char) =>
  char === '>' || char === '/' || char === ' ' || char === '\t' || char === '\n' || char === '\r'

/**
 * Yield every `<tag …>` element between `start` and `end` as
 * `{ head, from, to }` — `head` is the raw attribute text, `from`/`to` bound the
 * element's inner content (equal for a self-closing tag). Same-name nesting is
 * not handled; SpreadsheetML has none.
 */
export function* elements(xml, tag, start = 0, end = xml.length) {
  const open = `<${tag}`
  const close = `</${tag}>`
  let at = start
  while (at < end) {
    const found = xml.indexOf(open, at)
    if (found === -1 || found >= end) return
    const after = found + open.length
    if (!isTagBoundary(xml[after])) {
      at = after
      continue
    }
    const headEnd = xml.indexOf('>', after)
    if (headEnd === -1) return
    if (xml[headEnd - 1] === '/') {
      yield { head: xml.slice(after, headEnd - 1), from: headEnd + 1, to: headEnd + 1 }
      at = headEnd + 1
      continue
    }
    const closeAt = xml.indexOf(close, headEnd + 1)
    const inner = closeAt === -1 ? end : closeAt
    yield { head: xml.slice(after, headEnd), from: headEnd + 1, to: inner }
    at = closeAt === -1 ? end : closeAt + close.length
  }
}

// Compiled once per attribute name: `attribute` runs a couple of million times
// on the larger exports, and rebuilding the RegExp each call dominates.
const attributePatterns = new Map()

const attributePattern = (name) => {
  const cached = attributePatterns.get(name)
  if (cached) return cached
  const pattern = new RegExp(`(?:^|\\s)${name}="([^"]*)"`)
  attributePatterns.set(name, pattern)
  return pattern
}

/** Read one attribute out of an element's `head`; null when absent. */
export const attribute = (head, name) => {
  const match = attributePattern(name).exec(head)
  return match ? decodeXmlText(match[1]) : null
}

/** Concatenate the decoded text of every `<tag>` descendant in a range. */
export const joinTagText = (xml, tag, start, end) => {
  let text = ''
  for (const node of elements(xml, tag, start, end)) {
    text += decodeXmlText(xml.slice(node.from, node.to))
  }
  return text
}
