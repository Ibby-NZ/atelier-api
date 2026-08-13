// Pure planner for the purchase-order derivation. No database, no I/O, no
// config — the `src/suppliers/backfill-plan.js` posture, and for the same
// reason: the office has to be able to LOOK at what a derivation would do
// before it does it, and a planner that could write is a planner nobody trusts
// to be run twice.
//
// `POST /admin/purchase-orders/plan` hands this straight back as a dry run.
// `POST /admin/purchase-orders/generate` runs the same function and then writes
// what it returned, so the screen and the act cannot disagree about what was
// grouped — the same rule the reporting layer states for a table and its CSV.
//
// GROUPING IS BY BRAND, AND THAT IS NOT A BUG TO FIX LATER. One supplier selling
// two brands correctly produces TWO purchase orders: Rubelli sells Dominique
// Kieffer, Jim Thompson sells No.9 Thompson, and each house wants its own paper
// with its own references on it. It is also the entire reason consolidated
// supplier invoicing exists as a separate concept (W14) — one invoice arrives
// covering both, and that reconciliation is a feature rather than a grouping
// mistake.
//
// A BRAND WITH NO SUPPLIER IS REPORTED, NEVER GUESSED. `supplier_id` is derived
// from `brands.supplier_id` and there is no second candidate: no CHECK could
// catch a wrong one, because every supplier id is a valid supplier id, so a
// guess produces a well-formed purchase order addressed to the wrong house and
// the first anyone hears of it is the wrong house shipping the goods. An
// unlinked brand therefore lands in `blocked` here and is a 422 naming the brand
// at generate. Expect that on most houses today: `backfill:suppliers` has linked
// a minority of them. That is the planner working.
//
// WHAT IT DOES NOT DO: it does not decide which order lines are candidates.
// That predicate is `reserves(kind)` x `HELD_STATUSES` (both imported from
// `src/orders/order-states.js` by the module that queries), minus every line
// that already carries a live allocation — and the anti-double-order guarantee
// is the PARTIAL UNIQUE INDEX on the allocation, never this filter. See
// `src/purchasing/admin-purchase-orders.js`.

/**
 * Coerce a pg numeric (which arrives as a string) to a number.
 * `Number(null)` is 0, so a null quantity would silently become a zero-metre
 * line; it is dropped instead, which the caller sees as a missing line rather
 * than a free one.
 */
const qtyOf = (value) => (value == null ? null : Number(value))

const byName = (a, b) => String(a).localeCompare(String(b))

/**
 * Group candidate sales-order lines into the purchase orders they would become.
 *
 * Every candidate row is one sales-order line with its catalogue and supplier
 * context already resolved. Two candidates naming the same colourway inside one
 * brand become ONE purchase-order line carrying two allocations — that is the
 * ordinary case (a 40 m line covering 25 m for SO-411 and 15 m for SO-418), and
 * it is why the allocation carries a quantity at all.
 *
 * The output is deterministic: brands by name then id, lines by SKU then
 * colourway id, allocations by order-line id. Two runs over the same candidates
 * produce byte-identical plans, which is what makes a dry run worth reading.
 *
 * @param {ReadonlyArray<{
 *   order_line_id: number,
 *   order_id: number,
 *   order_number: string,
 *   qty: string|number,
 *   colourway_id: number,
 *   sku: string,
 *   product_name: string,
 *   brand_id: number,
 *   brand_name: string,
 *   brand_slug: string,
 *   supplier_id: number|null,
 *   supplier_name: string|null,
 *   currency?: string|null,
 *   agent?: string|null,
 *   incoterm?: string|null,
 *   po_email?: string|null,
 * }>} candidates
 * @returns {Readonly<{
 *   groups: ReadonlyArray<object>,
 *   blocked: ReadonlyArray<object>,
 *   candidate_lines: number,
 * }>}
 */
export const planPurchaseOrders = (candidates = []) => {
  const groups = new Map()
  const blocked = new Map()

  for (const candidate of candidates) {
    const qty = qtyOf(candidate.qty)
    // A line with no quantity is not demand. Nothing produces one today
    // (`order_lines.qty` is NOT NULL), and the guard is here because
    // `Number(null)` is 0 and a zero-metre purchase-order line is indefensible.
    if (qty === null || !(qty > 0)) continue

    // The whole of invariant one, in three lines: the supplier comes from the
    // brand, and a brand that names none stops here.
    if (candidate.supplier_id == null) {
      const entry = blocked.get(candidate.brand_id) ?? {
        brand_id: candidate.brand_id,
        brand_name: candidate.brand_name,
        brand_slug: candidate.brand_slug,
        reason: 'no_supplier',
        message:
          `"${candidate.brand_name}" has no supplier linked, so there is no house ` +
          'to address a purchase order to. Link one on the house record first.',
        order_line_ids: [],
      }
      entry.order_line_ids.push(candidate.order_line_id)
      blocked.set(candidate.brand_id, entry)
      continue
    }

    const group = groups.get(candidate.brand_id) ?? {
      brand_id: candidate.brand_id,
      brand_name: candidate.brand_name,
      brand_slug: candidate.brand_slug,
      supplier_id: candidate.supplier_id,
      // The snapshot fields, carried through so the writer never re-reads the
      // supplier between planning and writing.
      supplier_name: candidate.supplier_name ?? null,
      currency: candidate.currency ?? null,
      agent: candidate.agent ?? null,
      incoterm: candidate.incoterm ?? null,
      po_email: candidate.po_email ?? null,
      lines: new Map(),
    }

    const line = group.lines.get(candidate.colourway_id) ?? {
      colourway_id: candidate.colourway_id,
      sku: candidate.sku,
      product_name: candidate.product_name,
      qty_ordered: 0,
      // Nothing in this schema can derive a purchase price for a colourway —
      // `price_list_items` is keyed (supplier, category, code) and a supplier
      // colour code has no path to a colourway. NULL is the honest answer and
      // `Number(null)` is 0, so it must stay null rather than become a zero.
      unit_price: null,
      allocations: [],
    }
    line.qty_ordered += qty
    line.allocations.push({
      order_line_id: candidate.order_line_id,
      order_id: candidate.order_id,
      order_number: candidate.order_number,
      qty,
    })

    group.lines.set(candidate.colourway_id, line)
    groups.set(candidate.brand_id, group)
  }

  const plannedGroups = [...groups.values()]
    .map((group) => {
      const lines = [...group.lines.values()]
        .map((line) =>
          Object.freeze({
            ...line,
            // Float addition over numeric(12,2) inputs can leave 0.30000000000000004.
            // The database column rounds to two places anyway; rounding here is
            // what makes the dry run read as the thing that will be written.
            qty_ordered: Math.round(line.qty_ordered * 100) / 100,
            allocations: Object.freeze(
              [...line.allocations]
                .sort((a, b) => a.order_line_id - b.order_line_id)
                .map((allocation) => Object.freeze(allocation))
            ),
          })
        )
        .sort((a, b) => byName(a.sku, b.sku) || a.colourway_id - b.colourway_id)

      return Object.freeze({
        brand_id: group.brand_id,
        brand_name: group.brand_name,
        brand_slug: group.brand_slug,
        supplier_id: group.supplier_id,
        supplier_name: group.supplier_name,
        currency: group.currency,
        agent: group.agent,
        incoterm: group.incoterm,
        po_email: group.po_email,
        lines: Object.freeze(lines),
        line_count: lines.length,
        order_count: new Set(
          lines.flatMap((line) => line.allocations.map((a) => a.order_id))
        ).size,
        total_qty:
          Math.round(lines.reduce((sum, line) => sum + line.qty_ordered, 0) * 100) / 100,
      })
    })
    .sort((a, b) => byName(a.brand_name, b.brand_name) || a.brand_id - b.brand_id)

  const blockedBrands = [...blocked.values()]
    .map((entry) => Object.freeze({ ...entry, order_line_ids: Object.freeze(entry.order_line_ids) }))
    .sort((a, b) => byName(a.brand_name, b.brand_name) || a.brand_id - b.brand_id)

  return Object.freeze({
    groups: Object.freeze(plannedGroups),
    blocked: Object.freeze(blockedBrands),
    candidate_lines: candidates.length,
  })
}
