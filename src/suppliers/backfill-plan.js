// Pure planner for the supplier backfill. No database, no I/O, no config.
//
// TWO SOURCES, BOTH ALREADY ON DISK. The office holds every supplier it deals
// with twice, and neither copy is a record: as free text on
// `price_list_items.supplier` (40 spellings, each derived from a price-list
// filename prefix) and as the vendored snapshot `src/seed/data/suppliers.js`
// (9 houses carrying the country, invoicing currency, freight agent, Incoterm,
// PO address and discount method someone actually wrote down). Retyping 40
// names into the CRM is the thing this planner exists to avoid.
//
// MATCH, THEN REPORT — NEVER GUESS. Two spellings become one supplier only by
// an exact match on `lower(btrim(name))` — the same normalisation
// `supplier_aliases_alias_lower_unique` applies — or by an alias saying so.
// Nothing here merges on resemblance. 'Jannelli Volpi' (the price lists, 2,516
// rows) and 'Janelli Volpi' (the snapshot) are the live example: obviously one
// house to a reader and two to a matcher, so both are planned and the pair is
// reported for a human to reconcile with an alias in the CRM. Collapsing them
// here would attach JV's tiers and its compounded chain to a spelling on a
// guess, and a wrong discount is a wrong landed cost on every metre.
//
// CURRENCY COMES FROM THE PRICE LIST, NOT THE SNAPSHOT AND NEVER THE COUNTRY.
// `suppliers.currency` is the currency the supplier INVOICES in, and a
// price-list row is a rate that was quoted in it — as close to primary evidence
// as this data gets. The snapshot fills a supplier that has no rates (it is a
// note of intent, and it disagrees with the rates for Manuel Canovas), and a
// disagreement is reported rather than resolved.
//
// The planner emits DESIRED state keyed by supplier NAME. Resolving names to
// ids, and the fill-only-what-is-NULL rule that keeps a staff edit safe, belong
// to `backfill.js`.

import { slugify } from '../seed/slugify.js'

// The converter's own filename-prefix corrections, as alias rows. This is a
// boundary copy of `SUPPLIER_OVERRIDES` in `scripts/convert-price-lists.js`,
// which does not export it; `test/suppliers-backfill.test.js` scans that file
// and asserts the two agree — the posture DISCOUNT_METHOD_ENUM already takes
// against the database CHECK. Each `alias` is the raw prefix as it appears on a
// dropped template, each `supplier` the spelling the converter writes into
// `price_list_items.supplier`.
export const SUPPLIER_ALIAS_SOURCES = Object.freeze([
  Object.freeze({ alias: 'JV', supplier: 'Jannelli Volpi' }),
  Object.freeze({ alias: 'JV DESIGN LICENSE', supplier: 'JV Design' }),
  Object.freeze({ alias: 'JWALL', supplier: 'JWall' }),
  Object.freeze({ alias: 'C&C MILANO', supplier: 'C&C Milano' }),
])

// The invoicing entities as Dynamics 365 spells them
// (`legacy_tracking_options.supplier`), aliased to the house the office already
// holds a supplier row for. Exact display names copied from the client's own
// parameter export, not a rule: each is the legal-entity form of ONE live
// supplier and nothing else (`Pierre Frey Paris` invoices Pierre Frey,
// Braquenié, Le Manach and Fadini Borghi), and resolving it is what lets the
// roll-up in `src/suppliers/supplier-rollup.js` link those houses. A target with
// no supplier row is reported (`unmatchedAliasTargets`), never created. Kept
// apart from SUPPLIER_ALIAS_SOURCES, which is a boundary copy of the converter's
// filename prefixes and is asserted equal to it.
export const D365_SUPPLIER_ALIASES = Object.freeze([
  Object.freeze({ alias: 'Pierre Frey Paris', supplier: 'Pierre Frey' }),
  Object.freeze({ alias: 'Rubelli / Dominique Kieffer', supplier: 'Rubelli' }),
  Object.freeze({ alias: 'Fabricut Inc', supplier: 'Fabricut' }),
  Object.freeze({ alias: 'Jim Thompson / The Thai Silk Co. Ltd.', supplier: 'Jim Thompson' }),
  Object.freeze({ alias: 'Liberty London', supplier: 'Liberty' }),
])

// The snapshot marks its catch-all tier by label; `is_fallback` is the column
// that carries it, because two tiers claiming the unmatched case — which is the
// common case — would resolve at random. Translating the label into the flag is
// this module's job precisely so the string never reaches the schema.
export const FALLBACK_TIER_LABEL = 'All other collections'

// Columns the snapshot can fill. Frozen and in-code: the apply step builds its
// COALESCE set list from this, and a column name is never user input.
export const SUPPLIER_FILL_COLUMNS = Object.freeze([
  'short_code',
  'country',
  'currency',
  'agent',
  'incoterm',
  'po_email',
  'discount_method',
  // The averaged rate itself, not only the method — the snapshot has carried
  // it as `terms.net` since 9 Jul and the column exists to hold it. Numeric
  // rather than text, which is why the upsert types its params per column.
  'default_discount',
])

/**
 * The Postgres type of each fill column, for the unnest params the apply step
 * binds. Everything is text but the rate: an INSERT ... SELECT has no
 * assignment cast from text to numeric, so a text[] param for
 * `default_discount` fails outright rather than coercing.
 */
export const SUPPLIER_FILL_TYPES = Object.freeze({ default_discount: 'numeric' })

/** That type, or `text` — the default every other column takes. */
export const fillColumnType = (column) => SUPPLIER_FILL_TYPES[column] ?? 'text'

/** The comparison key every match in this module uses: `lower(btrim(name))`. */
export const nameKey = (name) => String(name ?? '').trim().toLowerCase()

const sluggable = (name) => {
  try {
    const slug = slugify(name)
    return slug === '' ? null : slug
  } catch {
    // A punctuation- or whitespace-only name cannot produce one, and `slug` is
    // NOT NULL. Reported, not defaulted.
    return null
  }
}

const emptyRow = (name, slug) => {
  const row = { name, slug }
  for (const column of SUPPLIER_FILL_COLUMNS) row[column] = null
  return row
}

// One currency, or null when the rows disagree. Ambiguity is reported: picking
// a winner would mis-convert every landed cost built on it.
const soleCurrency = (currencies) => {
  const values = [...new Set((currencies ?? []).filter(Boolean))]
  return values.length === 1 ? values[0] : null
}

const termsOf = (entry) => ({
  chain: Array.isArray(entry.discountChain) ? entry.discountChain : [],
  tiers: Array.isArray(entry.discountTiers) ? entry.discountTiers : [],
  hasFlat: entry.discount != null,
  hasMarkup: entry.markup != null,
})

const carriesTerms = (entry) => {
  const { chain, tiers, hasFlat, hasMarkup } = termsOf(entry)
  return chain.length > 0 || tiers.length > 0 || hasFlat || hasMarkup
}

/**
 * Plan the backfill from the two sources plus whatever the database already
 * holds. Pure: same inputs, same plan.
 *
 * @param {object} input
 * @param {object[]} input.snapshot `suppliers` from src/seed/data/suppliers.js
 * @param {{name: string, items: number, currencies: string[]}[]} input.priceListSuppliers
 * @param {{id: number, name: string, supplier_id: number|null}[]} input.brands
 * @param {{name: string, slug: string}[]} input.existingSuppliers
 * @param {{alias: string, supplier_name: string}[]} input.existingAliases
 * @param {{alias: string, supplier: string}[]} [input.aliasSources]
 * @returns {object} frozen plan
 */
export const planSupplierBackfill = ({
  snapshot = [],
  priceListSuppliers = [],
  brands = [],
  existingSuppliers = [],
  existingAliases = [],
  aliasSources = SUPPLIER_ALIAS_SOURCES,
}) => {
  const reports = {
    unmatchedPriceListSuppliers: [],
    unmatchedSnapshotSuppliers: [],
    priceListSuppliersWithoutSnapshot: [],
    unmatchedAliasTargets: [],
    unmatchedBrands: [],
    brandsLinkedElsewhere: [],
    currencyConflicts: [],
    ambiguousCurrencies: [],
    slugConflicts: [],
    tierSetsWithoutFallback: [],
    invalidTerms: [],
  }

  // Everything the database can already resolve. An alias a human added in the
  // CRM is what stops a later run creating a second row for a spelling they
  // have already merged.
  const canonicalByKey = new Map(existingSuppliers.map((row) => [nameKey(row.name), row.name]))
  for (const row of existingAliases) {
    const key = nameKey(row.alias)
    if (!canonicalByKey.has(key)) canonicalByKey.set(key, row.supplier_name)
  }
  const existingSlugByKey = new Map(existingSuppliers.map((row) => [nameKey(row.name), row.slug]))
  const slugHolders = new Map(existingSuppliers.map((row) => [row.slug, row.name]))

  // Desired rows keyed by canonical name — existing suppliers included, so the
  // upsert can fill their NULL columns from the snapshot on a later run.
  const planned = new Map()

  /** @returns {string|null} the canonical name this spelling resolves to */
  const plan = (name) => {
    const key = nameKey(name)
    const canonical = canonicalByKey.get(key)
    if (canonical) {
      const canonicalKey = nameKey(canonical)
      if (!planned.has(canonicalKey)) {
        // The stored slug, never a recomputed one — a rename is a correction,
        // not a new supplier, and the slug is the key other rows address.
        const slug = existingSlugByKey.get(canonicalKey) ?? sluggable(canonical)
        if (slug === null) {
          reports.slugConflicts.push({ supplier: canonical, slug: null, held_by: null })
          return null
        }
        planned.set(canonicalKey, emptyRow(canonical, slug))
      }
      return canonical
    }
    if (planned.has(key)) return planned.get(key).name

    const slug = sluggable(name)
    if (slug === null) {
      reports.slugConflicts.push({ supplier: name, slug: null, held_by: null })
      return null
    }
    if (slugHolders.has(slug)) {
      // Two spellings competing for one slug are almost certainly one house,
      // but "almost certainly" is a guess. The second is skipped, the pair
      // reported, and a human merges them with an alias.
      reports.slugConflicts.push({ supplier: name, slug, held_by: slugHolders.get(slug) })
      return null
    }
    slugHolders.set(slug, name)
    planned.set(key, emptyRow(name, slug))
    return name
  }

  // Contribute a value only where the plan has not claimed the field yet. The
  // price list's currency is applied explicitly below rather than by ordering.
  const enrich = (canonical, values) => {
    const row = planned.get(nameKey(canonical))
    if (!row) return
    for (const [column, value] of Object.entries(values)) {
      if (value != null && row[column] == null) row[column] = value
    }
  }

  // --- Source 1: the office snapshot (metadata-rich, so it plans first) ------
  const snapshotKeys = new Set()
  for (const supplier of snapshot) {
    const canonical = plan(supplier.name)
    if (!canonical) continue
    snapshotKeys.add(nameKey(supplier.name))
    enrich(canonical, {
      short_code: supplier.short ?? null,
      country: supplier.country ?? null,
      currency: supplier.currency ?? null,
      agent: supplier.agent ?? null,
      incoterm: supplier.incoterm ?? null,
      po_email: supplier.poEmail ?? null,
      discount_method: supplier.terms?.method ?? null,
      // `net` is the averaged supplier-level rate; null on the houses excluded
      // from averaging (JV), whose terms are planned brand by brand below.
      default_discount: supplier.terms?.net ?? null,
    })
  }

  // --- Source 2: the distinct free-text names on the rate ledger -------------
  const matches = []
  const priceListKeys = new Set()
  for (const entry of priceListSuppliers) {
    const key = nameKey(entry.name)
    priceListKeys.add(key)
    const canonical = plan(entry.name)
    if (!canonical) {
      reports.unmatchedPriceListSuppliers.push({
        supplier: entry.name,
        items: entry.items ?? 0,
        reason: 'no usable slug — reconcile the name in the CRM, then re-run',
      })
      continue
    }

    const currencies = entry.currencies ?? []
    const currency = soleCurrency(currencies)
    if (currency === null && currencies.length > 1) {
      reports.ambiguousCurrencies.push({ supplier: entry.name, currencies: [...currencies] })
    }

    const row = planned.get(nameKey(canonical))
    if (row && currency) {
      // The rate ledger wins: it is evidence of an invoice where the snapshot
      // is a note of intent. A disagreement is reported, never reconciled.
      if (row.currency && row.currency !== currency) {
        reports.currencyConflicts.push({
          supplier: canonical,
          price_list: currency,
          snapshot: row.currency,
        })
      }
      row.currency = currency
    }

    if (!snapshotKeys.has(key)) reports.priceListSuppliersWithoutSnapshot.push(entry.name)
    matches.push({ key, supplier: entry.name, supplier_name: canonical })
  }

  for (const supplier of snapshot) {
    if (!priceListKeys.has(nameKey(supplier.name))) {
      reports.unmatchedSnapshotSuppliers.push(supplier.name)
    }
  }

  // --- Aliases: the converter's filename-prefix corrections ------------------
  const aliases = []
  const seenAliases = new Set(existingAliases.map((row) => nameKey(row.alias)))
  for (const { alias, supplier } of aliasSources) {
    const key = nameKey(supplier)
    const canonical = canonicalByKey.get(key) ?? planned.get(key)?.name ?? null
    if (!canonical) {
      // The spelling the override points at is in neither source, so there is
      // nothing to alias to. Creating the supplier from a converter constant
      // would invent a house nobody holds a rate for.
      reports.unmatchedAliasTargets.push({ alias, supplier })
      continue
    }
    const aliasKey = nameKey(alias)
    if (seenAliases.has(aliasKey)) continue
    seenAliases.add(aliasKey)
    aliases.push({ alias, supplier_name: canonical })
  }

  // --- Brand links and per-brand commercial terms ----------------------------
  const brandByKey = new Map(brands.map((row) => [nameKey(row.name), row]))
  const brandLinks = []
  const brandTerms = []

  for (const supplier of snapshot) {
    const key = nameKey(supplier.name)
    const canonical = canonicalByKey.get(key) ?? planned.get(key)?.name ?? null
    if (!canonical) continue

    for (const entry of supplier.brands ?? []) {
      const brand = brandByKey.get(nameKey(entry.name))
      if (!brand) {
        // The snapshot names houses that were never catalogued (JV's stable is
        // the whole of it). Reported so a human either creates the house or
        // corrects the spelling; inventing a brand row here would put a maison
        // on the storefront that Atelier holds nothing from.
        reports.unmatchedBrands.push({ supplier: canonical, brand: entry.name })
        continue
      }
      if (brand.supplier_id == null) {
        brandLinks.push({ brand_id: brand.id, supplier_name: canonical })
      } else {
        // Already linked, by an earlier run or by staff. Left alone and
        // reported — a house's supplier is a commercial decision, not ours.
        reports.brandsLinkedElsewhere.push({ brand: brand.name, supplier: canonical })
      }

      if (!carriesTerms(entry)) continue
      const { chain, tiers, hasFlat } = termsOf(entry)
      if (hasFlat && chain.length > 0) {
        // `supplier_brand_terms_discount_shape_check` refuses both, rightly:
        // two rates and no rule for which wins is not a term.
        reports.invalidTerms.push({
          supplier: canonical,
          brand: entry.name,
          reason: 'carries both a flat discount and a chain',
        })
        continue
      }
      if (tiers.length > 0 && !tiers.some((tier) => tier.label === FALLBACK_TIER_LABEL)) {
        reports.tierSetsWithoutFallback.push({ supplier: canonical, brand: entry.name })
      }
      brandTerms.push({
        supplier_name: canonical,
        brand_id: brand.id,
        brand_name: brand.name,
        discount: hasFlat ? entry.discount : null,
        discount_chain: [...chain],
        markup: entry.markup ?? null,
        indicative: entry.indicative === true || supplier.indicativeDefaults === true,
        note: entry.note ?? null,
        tiers: tiers.map((tier) => ({
          label: tier.label,
          pct: tier.pct,
          is_fallback: tier.label === FALLBACK_TIER_LABEL,
        })),
      })
    }
  }

  return Object.freeze({
    suppliers: [...planned.values()],
    aliases,
    matches,
    brandLinks,
    brandTerms,
    reports,
  })
}
