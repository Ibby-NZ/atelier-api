/**
 * The colour-file adapter registry, keyed by FILENAME PREFIX.
 *
 * Per-supplier adapters, not one universal parser: eighteen files, eighteen
 * layouts — several carry more than one brand, one spans ten sheets, headers
 * sit on different rows, and one is a PDF with no extraction path at all. Each
 * entry declares the sheets to read and, per sheet, the column map;
 * lib/colour-sheet.js finds the header row by matching those labels, so the map
 * and the recognition rule are the same declaration and cannot disagree.
 *
 * An entry may instead declare itself `unsupported` with a reason. That is NOT
 * the same as an unknown file: a declared refusal is a decision someone made
 * and recorded, while an unknown filename is a file nobody has looked at yet
 * and must fail the run. Neither is ever silently skipped.
 *
 * `assertRegistry` runs at import over every entry, so a malformed adapter
 * stops the converter starting rather than surfacing as a mis-mapped column
 * several thousand rows into a file.
 */
import { normaliseLabel } from '../colour-sheet.js'

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const assertSheet = (sheet, at) => {
  if (!isText(sheet?.name)) throw new Error(`${at}: every sheet needs a name`)
  const entries = Object.entries(sheet.columns ?? {})
  if (entries.length === 0) throw new Error(`${at}: sheet "${sheet.name}" declares no columns`)
  const byLabel = new Map()
  for (const [field, label] of entries) {
    if (!isText(label)) {
      throw new Error(`${at}: sheet "${sheet.name}" column "${field}" has an empty label`)
    }
    const normalised = normaliseLabel(label)
    const earlier = byLabel.get(normalised)
    // Two fields onto one label is a typo far more often than an intention, and
    // it is invisible afterwards: both fields simply carry the same cell.
    if (earlier !== undefined) {
      throw new Error(`${at}: sheet "${sheet.name}" columns "${earlier}" and "${field}" `
        + `both declare "${normalised}"`)
    }
    byLabel.set(normalised, field)
  }
}

/** Validate one entry's shape. Throws with the offending prefix named. */
export const assertAdapter = (adapter) => {
  if (!isText(adapter?.prefix)) throw new Error('adapter: prefix must be a non-empty string')
  const at = `adapter "${adapter.prefix}"`
  if (adapter.unsupported !== undefined) {
    if (!isText(adapter.unsupported)) throw new Error(`${at}: unsupported must state a reason`)
    if (adapter.sheets !== undefined) throw new Error(`${at}: unsupported and sheets are exclusive`)
    return adapter
  }
  if (!isText(adapter.supplier)) throw new Error(`${at}: supplier must be a non-empty string`)
  if (!Array.isArray(adapter.sheets) || adapter.sheets.length === 0) {
    throw new Error(`${at}: sheets must be a non-empty array`)
  }
  for (const sheet of adapter.sheets) assertSheet(sheet, at)
  return adapter
}

/**
 * Validate the whole registry. Prefixes are unique case-insensitively, because
 * that is how `matchAdapter` compares them — two entries differing only in case
 * would make which one wins depend on array order.
 */
export const assertRegistry = (adapters) => {
  const seen = new Set()
  for (const adapter of adapters) {
    assertAdapter(adapter)
    const prefix = adapter.prefix.toLowerCase()
    if (seen.has(prefix)) throw new Error(`adapter prefix "${adapter.prefix}" is registered twice`)
    seen.add(prefix)
  }
  return adapters
}

// Adapters land here as US-002 (single-sheet, single-brand) and US-003
// (multi-sheet, multi-brand, and the PDF's `unsupported` declaration) add them,
// one module per layout family. Until then every drop is an unknown file and
// the converter says so and exits non-zero, which is the honest state: nothing
// has been mapped yet.
export const ADAPTERS = assertRegistry(Object.freeze([]))

/**
 * The adapter in `adapters` claiming `filename`, or null.
 *
 * The LONGEST matching prefix wins, so a supplier whose seasonal drop needs its
 * own layout (`Jim Thompson … 2026` and `Jim Thompson … 2026 - SS'26`) can have
 * both entries without the shorter one shadowing the longer. Pure, and taking
 * the registry as an argument, so the rule is testable while ADAPTERS is still
 * being filled in.
 */
export const selectAdapter = (adapters, filename) => {
  const name = String(filename).toLowerCase()
  let best = null
  for (const adapter of adapters) {
    const prefix = adapter.prefix.toLowerCase()
    if (!name.startsWith(prefix)) continue
    if (best === null || prefix.length > best.prefix.length) best = adapter
  }
  return best
}

/** The registered adapter for a filename, or null when none is registered. */
export const matchAdapter = (filename) => selectAdapter(ADAPTERS, filename)

/** Every registered prefix, so a file nothing matched can say what does match. */
export const registeredPrefixes = () => ADAPTERS.map((adapter) => adapter.prefix)
