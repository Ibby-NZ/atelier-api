// Two statements every report that touches W21's dimensions has to make, in the
// payload rather than in a screen's footnote (US-005, US-006 · FR-279, FR-285).
//
// The CSV is the copy that leaves the building, and a file that says nothing
// about what it covers is read as covering everything — the argument
// `src/reports/product-performance.js` already makes for its own coverage
// block. These two are the same discipline applied to the two facts a reader
// cannot see and that each make a figure mean something else.
//
// 1. THE NEW DIMENSIONS ANSWER FOR LIVE PLATFORM ORDERS ONLY, AND THE PLATFORM
//    HAS BEEN TAKING THEM FOR WEEKS. All four D365 transaction entities are
//    staged HEADER-ONLY — sales orders, sales invoices, purchase orders and
//    purchase invoices carry roll-up totals and no SKU, quantity or unit price,
//    and there is no export path for the detail rows. So no historic sale is
//    attributable to a product, a brand code or a range AT ANY GRAIN: a house
//    Atelier sold for years reads as nil against both new dimensions, and a
//    range that pre-dates the platform reads as nil however much of it was
//    sold. This is the constraint that makes a range report look broken when it
//    is merely young, and a report that silently looks empty is worse than one
//    that says why.
//
//    The counts beside the note are what turn that from a caveat into a
//    measurement: a population where 0 of 40 lines carry a range is a backfill
//    that has not run, not a quarter with no trade. Both dimensions are
//    NULLABLE and start empty — `src/products/reporting-codes-plan.js` finds no
//    defensible source for a brand code at all, so that column is filled from
//    the CRM one house at a time and its coverage will read 0 for a while.
//
// 2. A STOCK FIGURE STATES WHICH SOURCE IT CAME FROM, BECAUSE THE TWO STAGED
//    SOURCES DISAGREE BY 2.65x. `legacy_stock_items.stock_on_hand` totals
//    5,332.8 over 368 non-zero rows (and its own `xero_stock_on_hand` broadly
//    agrees at 5,421.8) while `legacy_item_locations.total_stock_on_hand`
//    totals 14,157.9 over 780. One of the two is not what "on hand" means, and
//    it cannot even be diagnosed until the client re-exports Item Locations
//    with the item's code — the table's `item` column is a display-name lookup
//    and stock-item names are not unique (7,611 items over 6,315 names), so the
//    two cannot be reconciled row by row today.
//
//    Nothing here picks a winner. Every stock figure this API reports says
//    which table it was read out of, so a reader who has heard both numbers can
//    tell which one they are looking at.

/**
 * The three places a stock quantity can come from. Frozen and in-code: a source
 * is a code literal like a lifecycle registry key, never anything a caller can
 * name.
 */
export const STOCK_SOURCES = Object.freeze({
  inventory: Object.freeze({
    key: 'inventory',
    label: 'live platform inventory',
    table: 'inventory',
    columns: Object.freeze(['qty_available', 'qty_reserved']),
    staged: false,
  }),
  legacy_stock_items: Object.freeze({
    key: 'legacy_stock_items',
    label: 'D365 stock items (staged)',
    table: 'legacy_stock_items',
    columns: Object.freeze(['stock_on_hand']),
    staged: true,
  }),
  legacy_item_locations: Object.freeze({
    key: 'legacy_item_locations',
    label: 'D365 item locations (staged)',
    table: 'legacy_item_locations',
    columns: Object.freeze(['total_stock_on_hand']),
    staged: true,
  }),
})

/** What is unreconciled, stated once so no report paraphrases it. */
export const STOCK_SOURCE_DISAGREEMENT =
  'The two staged D365 stock figures disagree by 2.65× — `legacy_stock_items.stock_on_hand` ' +
  'totals 5,332.8 against `legacy_item_locations.total_stock_on_hand` at 14,157.9 — so one of ' +
  'them is not what “on hand” means. Item Locations cannot be joined back to a stock item ' +
  '(its `item` column is a display name and stock-item names repeat), so the disagreement is ' +
  'not diagnosable until that view is re-exported carrying the item code. Neither figure is ' +
  'used by this report and neither has been picked over the other.'

/**
 * The provenance statement a report attaches to its stock figures.
 *
 * @param {string} key one of STOCK_SOURCES
 * @returns {Readonly<object>}
 */
export const stockSource = (key) => {
  const source = STOCK_SOURCES[key]
  if (!source) {
    // A code literal, exactly like a lifecycle registry entity: a caller can
    // never reach this, so an unknown one is a bug and a plain Error (a 500).
    throw new Error(`Unknown stock source: ${key}`)
  }
  return Object.freeze({
    source: source.key,
    label: source.label,
    table: source.table,
    columns: source.columns,
    // Said on every figure, not only on the staged ones: "this came from the
    // platform's own ledger" is the half of the statement that answers the
    // question a reader who has heard 14,157.9 is actually asking.
    reconciled_with_d365: false,
    disagreement: STOCK_SOURCE_DISAGREEMENT,
  })
}

export const DIMENSION_COVERAGE_NOTE =
  'Brand code and range are reporting dimensions carried on the live catalogue, so they answer ' +
  'for live platform orders only. Atelier’s historic Dynamics 365 transactions are staged ' +
  'header-only — no export carries line items — so no sale from before the platform opened is ' +
  'attributable to a product, a brand code or a range at any grain, and the platform has been ' +
  'taking orders for weeks rather than years. Both columns are nullable and are filled by ' +
  'hand or by the reporting-codes backfill: the counts above say how much of THIS population ' +
  'carries each one, so an empty report can be told from an unfilled column.'

/**
 * What this population can answer about the two new dimensions.
 *
 * `rows` is the population's own row count at whatever grain the report
 * aggregates, so the fraction is read against the report's own table rather
 * than against the catalogue.
 *
 * @param {{ rows?: number, with_brand_code?: number, with_range?: number }} counts
 * @returns {Readonly<object>}
 */
export const dimensionCoverage = ({ rows = 0, with_brand_code = 0, with_range = 0 } = {}) =>
  Object.freeze({
    rows: Number(rows),
    brand_code: Number(with_brand_code),
    range: Number(with_range),
    historic_sales: 'header-only — not attributable to a product, brand code or range',
    note: DIMENSION_COVERAGE_NOTE,
  })
