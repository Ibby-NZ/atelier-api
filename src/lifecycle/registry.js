// The delete/archive lifecycle registry.
//
// One frozen entry per entity the back office may hard-delete. An entry declares
// where the row lives (`table` + `idColumn`), whether a soft archive is offered
// instead (`archivable`), an optional `guard` for rules that are not "something
// else still points at this", the dependency `probes` that decide whether a
// delete would destroy commercial history, and an optional `beforeDelete` for
// state the DELETE's own cascade cannot unwind (see delete.js's (C2)).
//
// **Registry keys are literals used at route registration — never a path
// parameter.** `requireEntity` throws a plain Error (a 500) rather than a 404 for
// an unknown name, so a caller that ever wired `:entity` from the URL fails
// loudly instead of quietly probing which names exist.
//
// **Why probes rather than trusting the foreign keys.** Nine of the twelve FK
// edges out of these tables are CASCADE or SET NULL, so the database raises
// nothing: `DELETE FROM brands WHERE id = <a stocked house>` silently destroys
// its collections, products, colourways and inventory and reports success. SET
// NULL is worse because the damage is invisible — deleting a user SET NULLs their
// whole order history into anonymous guest orders with no `guest_email`. The
// probes are what turn those into a 409; the 23503 catch in delete.js is only a
// backstop (see the comment there).
//
// **Probes deliberately ignore `archived_at`.** An archived product still blocks
// its house. Archiving is not deletion, and skipping archived rows would let a
// delete quietly destroy the archive.
//
// Entities whose tables do not exist yet (samples, sample orders and sample
// loans) are added by the workstreams that create them. Every entry is
// validated at import time by `assertEntity` below, so a malformed probe cannot
// reach production — the server refuses to boot instead.

import { DELETABLE_SAMPLE_ORDER_STATUSES } from '../samples/sample-order-states.js'
import { DELETABLE_SAMPLE_REQUEST_STATUSES } from '../samples/sample-request-states.js'
import { DELETABLE_RESERVE_LINE_STATUSES } from '../reserves/reserve-line-states.js'
import { isDeletableOrder, holdsReservation } from '../orders/order-states.js'

// A probe body must be a bare existence select over one relation, taking the
// parent id as its only parameter. delete.js wraps it in `count(*)` + LIMIT, so
// anything else here would produce nonsense rather than an error.
const PROBE_SQL_PATTERN = /^SELECT 1 FROM [a-z_ ]/
// Relation names and identifiers are interpolated into SQL (they are code
// literals, never user input); this is the belt to that braces.
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/

// A guard's refusal. `status` is the HTTP status the route answers with;
// `message` is shown to staff verbatim. Guards never throw — like
// deleteOrExplain itself, a refusal is a return value.
const refuse = (status, message) => Object.freeze({ status, message })

/**
 * Stock cannot be deleted while it is spoken for. The reservation is held by the
 * order state machine (src/orders/admin-orders.js); dropping the row would strand
 * that demand with nothing to release it against.
 */
const inventoryGuard = async (client, colourwayId) => {
  const { rows } = await client.query(
    `SELECT qty_reserved FROM inventory WHERE colourway_id = $1`,
    [colourwayId]
  )
  // pg returns numeric as a string ('4.00'), so coerce before comparing.
  const reserved = Number(rows[0]?.qty_reserved ?? 0)
  if (reserved > 0) {
    return refuse(
      409,
      `This stock row still has ${reserved} reserved against open orders. ` +
        'Ship or cancel those orders first, then delete it.'
    )
  }
  return null
}

/**
 * A zone with no tiers left has no quote: `getShippingQuote` answers 400
 * "unknown zone" and checkout stops for every shopper in it. Deleting the last
 * tier is therefore a 409, not a silent outage.
 */
const shippingRateGuard = async (client, id) => {
  const { rows } = await client.query(
    `SELECT r.zone,
            (SELECT count(*) FROM shipping_rates s WHERE s.zone = r.zone) AS tiers
       FROM shipping_rates r
      WHERE r.id = $1`,
    [id]
  )
  const row = rows[0]
  if (row && Number(row.tiers) <= 1) {
    return refuse(
      409,
      `"${row.zone}" would be left with no shipping tiers, which stops checkout ` +
        'for that zone. Add a replacement tier first, or edit this one.'
    )
  }
  return null
}

/**
 * A sample order that was actually placed is a commercial record: a house was
 * asked for something and may already have shipped it. Only a request nobody
 * acted on (`requested`) and one abandoned before anybody did (`cancelled`) can
 * be removed without destroying that, which is the delete policy's "409 unless
 * requested or cancelled".
 *
 * The two states come from `src/samples/sample-order-states.js` — the same pure
 * module the transition routes and the CRM spend — rather than being re-typed
 * here, so widening the machine cannot leave this guard behind. That module
 * imports nothing, which is what keeps this import out of a cycle with
 * `archive.js`.
 */
// A sample request the office has SENT is a record of cuttings that left the
// building; only an untouched or declined one may be deleted outright. The
// lines cascade, so nothing points at a request from outside it.
const sampleRequestGuard = async (client, id) => {
  const { rows } = await client.query(`SELECT status FROM sample_requests WHERE id = $1`, [id])
  const status = rows[0]?.status
  if (status && !DELETABLE_SAMPLE_REQUEST_STATUSES.includes(status)) {
    return refuse(
      409,
      `This sample request is "${status}", so it is a record of cuttings that went out. ` +
        'Archive it instead to hide it without losing that.'
    )
  }
  return null
}

const sampleOrderGuard = async (client, id) => {
  const { rows } = await client.query(
    `SELECT status FROM sample_orders WHERE id = $1`,
    [id]
  )
  const status = rows[0]?.status
  if (status && !DELETABLE_SAMPLE_ORDER_STATUSES.includes(status)) {
    return refuse(
      409,
      `This sample order is "${status}", so it is a record of material a house ` +
        'was asked for. Archive it instead to hide it without losing that.'
    )
  }
  return null
}

/**
 * A reserve line stops being deletable the moment the house is involved — same
 * shape as `sampleOrderGuard`, states from the pure leaf module the CRM
 * mirrors. Cancelling is the removal that keeps the record; delete exists for
 * keying mistakes, and neither table has an archive to offer instead.
 */
const reserveLineGuard = async (client, id) => {
  const { rows } = await client.query(`SELECT status FROM reserve_lines WHERE id = $1`, [id])
  const status = rows[0]?.status
  if (status && !DELETABLE_RESERVE_LINE_STATUSES.includes(status)) {
    return refuse(
      409,
      `This line is "${status}", so it is a record of what a house was asked to ` +
        'hold or cut. Cancel it instead to close it without losing that.'
    )
  }
  return null
}

/**
 * A docket goes only when every line on it could go alone. Its lines CASCADE —
 * they are the docket's own body — so the guard is what stands between one
 * DELETE and a page of supplier history; there is no probe to write because
 * the FK points the wrong way for one and would raise nothing.
 */
const reserveRequestGuard = async (client, id) => {
  const { rows } = await client.query(
    `SELECT count(*)::int AS held
       FROM reserve_lines
      WHERE request_id = $1
        AND NOT (status = ANY($2::text[]))`,
    [id, [...DELETABLE_RESERVE_LINE_STATUSES]]
  )
  const held = rows[0]?.held ?? 0
  if (held > 0) {
    return refuse(
      409,
      `This docket has ${held} line${held === 1 ? '' : 's'} a house is already acting on. ` +
        'Cancel the lines instead — the docket closes with them.'
    )
  }
  return null
}

/**
 * An order stops being deletable the moment it becomes a financial record.
 *
 * Two different facts refuse it, and neither implies the other. A `checkout`
 * order was paid at Stripe: it carries a session id, its stock was already
 * decremented, and the row is the platform's only record of the payment — so it
 * is refused whatever its status. Everything else is refused once it is `paid`
 * or beyond (money has moved; a shipped order is what its stock decrement was
 * justified by) or once it has an invoice in Xero — `cancelled` is reachable
 * after the invoice went out, and an invoiced order is a financial record
 * whatever its status. What is left — a quote, an order before invoicing, and a
 * cancelled one nobody invoiced — destroys nothing when removed.
 *
 * The predicate lives in `src/orders/order-states.js`, the leaf module the CRM
 * mirrors, so the button and the guard cannot disagree about which orders offer
 * a Delete.
 */
const orderGuard = async (client, id) => {
  const { rows } = await client.query(
    `SELECT kind, status, xero_invoice_id FROM orders WHERE id = $1`,
    [id]
  )
  const order = rows[0]
  // The row exists — (A) locked it — so a missing row here would be a 404 the
  // caller already got.
  if (!order || isDeletableOrder(order)) return null
  if (order.kind === 'checkout') {
    return refuse(
      409,
      'This is a card checkout, so it is the record of a payment taken at ' +
        'Stripe. Archive it instead to hide it without losing that.'
    )
  }
  if (order.xero_invoice_id != null) {
    return refuse(
      409,
      'This order has an invoice in Xero, so it is a financial record. ' +
        'Archive it instead to hide it without losing the record.'
    )
  }
  return refuse(
    409,
    `This order is "${order.status}", so money has moved against it. ` +
      'Archive it instead to hide it without losing the record.'
  )
}

/**
 * Hand an order's reservation back BEFORE its lines cascade away.
 *
 * `order_lines.order_id` is CASCADE, so the lines are gone the instant the
 * DELETE runs and there is nothing left to release `inventory.qty_reserved`
 * against — the stock stays spoken for by an order that no longer exists, with
 * no error and nothing to point at. This is the whole reason `beforeDelete`
 * exists (delete.js's (C2)).
 *
 * `holdsReservation` is what stops a double release: a shipped order converted
 * its reservation into a real decrement and a cancelled one already handed it
 * back, so releasing again would inflate availability. (Shipped is unreachable
 * here anyway — the guard refuses it — but the predicate is the rule, not the
 * guard's side effect.) A colourway with no inventory row reserved nothing, so
 * the join simply matches nothing.
 *
 * The quantity is SUMMED PER COLOURWAY first, for the reason `ORDER_DEMAND` in
 * src/orders/admin-orders.js states: two lines may name one colourway, and
 * `UPDATE … FROM order_lines` would then release only one of them, stranding
 * the rest of the reservation for good. Same shape as the two statements in
 * `settleReservation` (src/orders/admin-orders.js), deliberately — this is the
 * third of the three whole-order inventory moves and they must agree.
 */
const releaseOrderReservation = async (client, id) => {
  const { rows } = await client.query(
    `SELECT kind, status FROM orders WHERE id = $1`,
    [id]
  )
  if (!rows[0] || !holdsReservation(rows[0])) return
  await client.query(
    `UPDATE inventory i
        SET qty_reserved = i.qty_reserved - demand.qty
       FROM (SELECT colourway_id, SUM(qty) AS qty
               FROM order_lines
              WHERE order_id = $1
              GROUP BY colourway_id) AS demand
      WHERE i.colourway_id = demand.colourway_id`,
    [id]
  )
}

/**
 * Self-delete is a 403, not a 409: nothing is referencing the row, the caller is
 * simply not allowed. It mirrors the existing self-protection rules in
 * src/routes/admin-users.js (you cannot change your own role or archive
 * yourself), which live in handlers because they need `request.user` — here it
 * arrives as `ctx.user`.
 */
const userGuard = async (_client, id, ctx) => {
  if (ctx?.user?.id === id) {
    return refuse(
      403,
      'You cannot delete your own account. Ask another director to do it.'
    )
  }
  return null
}

/**
 * Validate one registry entry and throw with a precise message if it is wrong.
 * Exported so tests can run it over synthetic entries — the real registry is
 * validated at import time, which means an invalid entry cannot be observed by a
 * test any other way.
 *
 * @param {string} name
 * @param {object} entity
 * @returns {object} the same entity, for chaining
 */
export const assertEntity = (name, entity) => {
  const bad = (message) => {
    throw new Error(`Lifecycle entity "${name}": ${message}`)
  }
  if (!IDENTIFIER_PATTERN.test(name)) bad('name must be lower_snake_case.')
  if (!IDENTIFIER_PATTERN.test(entity.table ?? '')) bad('table must be lower_snake_case.')
  if (!IDENTIFIER_PATTERN.test(entity.idColumn ?? '')) {
    bad('idColumn must be lower_snake_case.')
  }
  if (typeof entity.archivable !== 'boolean') bad('archivable must be a boolean.')
  if (entity.deletable !== undefined && typeof entity.deletable !== 'boolean') {
    bad('deletable must be a boolean when present.')
  }
  if (typeof entity.label !== 'string' || entity.label === '') {
    bad('label must be a non-empty string.')
  }
  if (entity.guard !== undefined && typeof entity.guard !== 'function') {
    bad('guard must be a function when present.')
  }
  if (entity.beforeDelete !== undefined && typeof entity.beforeDelete !== 'function') {
    bad('beforeDelete must be a function when present.')
  }
  if (!Array.isArray(entity.probes)) bad('probes must be an array.')

  const seen = new Set()
  for (const probe of entity.probes) {
    if (!IDENTIFIER_PATTERN.test(probe.relation ?? '')) {
      bad(`probe relation "${probe.relation}" must be lower_snake_case.`)
    }
    // The relation keys the one-round-trip UNION ALL, so a duplicate would make
    // two probes indistinguishable in the result.
    if (seen.has(probe.relation)) bad(`probe relation "${probe.relation}" is declared twice.`)
    seen.add(probe.relation)
    if (typeof probe.label !== 'string' || probe.label === '') {
      bad(`probe "${probe.relation}" needs a non-empty label.`)
    }
    if (!PROBE_SQL_PATTERN.test(probe.sql ?? '')) {
      bad(`probe "${probe.relation}" sql must start "SELECT 1 FROM <relation>".`)
    }
    const placeholders = probe.sql.match(/\$\d+/g) ?? []
    if (placeholders.length !== 1 || placeholders[0] !== '$1') {
      bad(`probe "${probe.relation}" sql must use exactly one placeholder, $1.`)
    }
  }
  return entity
}

const probe = (relation, label, sql) => Object.freeze({ relation, label, sql })

const defineEntities = (entities) => {
  for (const [name, entity] of Object.entries(entities)) {
    assertEntity(name, entity)
    Object.freeze(entity.probes)
    Object.freeze(entity)
  }
  return Object.freeze(entities)
}

/**
 * Every entity a DELETE route may be registered for.
 *
 * `label` is the singular noun used in the refusal message staff read; a probe's
 * `label` is the plural noun used in the blocker line beside its count.
 */
export const LIFECYCLE_ENTITIES = defineEntities({
  // All three child edges are CASCADE, so without these probes deleting a
  // stocked house destroys its whole catalogue and returns 200. The terms probe
  // is not redundant with the first two: a house can carry negotiated
  // commercial terms while holding zero products and zero collections — 17 of
  // the 41 seeded houses are represented-only — and such a brand sailed past
  // the catalogue probes while the CASCADE took its supplier_brand_terms row
  // (and every discount tier under it) silently. Naming the table here is
  // allow-listed by test/suppliers-terms.test.js's source scan: a probe is a
  // read-only existence check protecting the terms, not a path that serves
  // them.
  brand: {
    table: 'brands',
    idColumn: 'id',
    label: 'house',
    archivable: true,
    probes: [
      probe('products', 'products', 'SELECT 1 FROM products WHERE brand_id = $1'),
      probe('collections', 'collections', 'SELECT 1 FROM collections WHERE brand_id = $1'),
      probe(
        'supplier_brand_terms',
        'supplier terms',
        'SELECT 1 FROM supplier_brand_terms WHERE brand_id = $1'
      ),
      // purchase_orders.brand_id is RESTRICT (W13): a house that has been
      // ordered from is a live commercial relationship and the paper sent to it
      // is the evidence. The database would refuse anyway; the probe is what
      // reports HOW MANY and runs before anything is destroyed.
      probe(
        'purchase_orders',
        'purchase orders',
        'SELECT 1 FROM purchase_orders WHERE brand_id = $1'
      ),
    ],
  },

  // products.collection_id is SET NULL: without this probe the delete succeeds
  // and silently uncollects every product in it, with nothing logged.
  collection: {
    table: 'collections',
    idColumn: 'id',
    label: 'collection',
    archivable: true,
    probes: [
      probe('products', 'products', 'SELECT 1 FROM products WHERE collection_id = $1'),
    ],
  },

  // The one entity here keyed by a text slug, because the slug IS the value the
  // three referencing columns store (migration 1791379200000).
  //
  // All three edges are RESTRICT, so unlike almost every other entry in this
  // registry the database would refuse the delete on its own. The probes are
  // still what the office reads: a bare 23503 says "still referenced" and names
  // one constraint, while a blocker list says which of the three and how many.
  // Not archivable — the table has no `archived_at`, and a category nobody may
  // choose while every product still carries it is a vocabulary with a hole in
  // it.
  category: {
    table: 'product_categories',
    idColumn: 'slug',
    label: 'category',
    archivable: false,
    probes: [
      probe('products', 'products', 'SELECT 1 FROM products WHERE category = $1'),
      probe(
        'price_list_items',
        'price list lines',
        'SELECT 1 FROM price_list_items WHERE category = $1'
      ),
      probe(
        'supplier_freight_rates',
        'freight rates',
        'SELECT 1 FROM supplier_freight_rates WHERE category = $1'
      ),
    ],
  },

  // A product cascades to its colourways, and a colourway carries the order-line
  // history and the stock row. Probing through the colourways is what makes the
  // grandchildren visible.
  product: {
    table: 'products',
    idColumn: 'id',
    label: 'product',
    archivable: true,
    probes: [
      probe(
        'order_lines',
        'order lines',
        `SELECT 1 FROM order_lines ol
            JOIN colourways c ON c.id = ol.colourway_id
           WHERE c.product_id = $1`
      ),
      probe(
        'inventory',
        'colourways holding stock',
        `SELECT 1 FROM inventory i
            JOIN colourways c ON c.id = i.colourway_id
           WHERE c.product_id = $1
             AND (i.qty_available > 0 OR i.qty_reserved > 0)`
      ),
      // samples.colourway_id and sample_orders.colourway_id are both RESTRICT,
      // so without these two the delete dies mid-cascade on a bare 23503 and
      // the refusal reads "related records" instead of naming the samples cut
      // from this design. Through the colourway join, same shape as order_lines.
      probe(
        'samples',
        'samples',
        `SELECT 1 FROM samples s
            JOIN colourways c ON c.id = s.colourway_id
           WHERE c.product_id = $1`
      ),
      probe(
        'sample_orders',
        'sample orders',
        `SELECT 1 FROM sample_orders so
            JOIN colourways c ON c.id = so.colourway_id
           WHERE c.product_id = $1`
      ),
      // `product_price_history.product_id` is RESTRICT for the same reason the
      // price-list side is: with CASCADE, deleting a design would destroy the
      // record of every price it was ever sold at, silently. Direct edge, no
      // colourway join — a price is the product's.
      probe(
        'product_price_history',
        'recorded price changes',
        'SELECT 1 FROM product_price_history WHERE product_id = $1'
      ),
      // purchase_order_lines.colourway_id is RESTRICT (W13), same shape and
      // same reason as order_lines above: a purchase order is a commercial
      // record and must survive a catalogue tidy-up.
      probe(
        'purchase_order_lines',
        'purchase-order lines',
        `SELECT 1 FROM purchase_order_lines pol
            JOIN colourways c ON c.id = pol.colourway_id
           WHERE c.product_id = $1`
      ),
    ],
  },

  // order_lines.colourway_id, samples.colourway_id and
  // sample_orders.colourway_id are the RESTRICT edges here, so these probes and
  // the 23503 backstop agree; the probes win because they can also report how
  // many, and because they run before anything is destroyed.
  colourway: {
    table: 'colourways',
    idColumn: 'id',
    label: 'colourway',
    archivable: true,
    probes: [
      probe(
        'order_lines',
        'order lines',
        'SELECT 1 FROM order_lines WHERE colourway_id = $1'
      ),
      probe(
        'inventory',
        'units of stock on hand',
        `SELECT 1 FROM inventory
           WHERE colourway_id = $1
             AND (qty_available > 0 OR qty_reserved > 0)`
      ),
      probe('samples', 'samples', 'SELECT 1 FROM samples WHERE colourway_id = $1'),
      probe(
        'sample_orders',
        'sample orders',
        'SELECT 1 FROM sample_orders WHERE colourway_id = $1'
      ),
      probe(
        'purchase_order_lines',
        'purchase-order lines',
        'SELECT 1 FROM purchase_order_lines WHERE colourway_id = $1'
      ),
    ],
  },

  // Addressed by colourway_id, not the row's own id — inventory is one row per
  // colourway (colourway_id is unique) and that is how /admin/inventory and the
  // order state machine already refer to stock. No archived_at column, so a
  // blocked delete has no soft alternative to offer.
  inventory: {
    table: 'inventory',
    idColumn: 'colourway_id',
    label: 'stock row',
    archivable: false,
    guard: inventoryGuard,
    probes: [],
  },

  // This entity's FIRST probe, and the FK behind it is load-bearing.
  // `price_list_item_price_history.price_list_item_id` is ON DELETE RESTRICT
  // rather than CASCADE precisely because a CASCADE would destroy the recorded
  // rate history — the thing W17 exists to preserve — silently, and the next
  // `npm run import:pricing` would re-create the row looking new. So an item
  // whose rate has ever MOVED is refused, and REIMPORT_WARNING's success
  // envelope is unreachable for it. An item that has only ever been imported at
  // one rate has no history and still deletes: capture is on UPDATE only (see
  // migrations/1788667200000_price-history-triggers.js).
  price_list_item: {
    table: 'price_list_items',
    idColumn: 'id',
    label: 'price-list item',
    archivable: true,
    probes: [
      probe(
        'price_list_item_price_history',
        'recorded rate changes',
        'SELECT 1 FROM price_list_item_price_history WHERE price_list_item_id = $1'
      ),
    ],
  },

  // The two edges out of suppliers disagree, and only one of them would ever
  // raise: `brands.supplier_id` is RESTRICT (a house pointing at a supplier is a
  // live commercial relationship), `price_list_items.supplier_id` is SET NULL —
  // so without the second probe, deleting a supplier silently unlinks its whole
  // rate ledger and reports success. The per-brand commercial terms need no
  // probe on THIS side: the brands probe already refuses any supplier with a
  // linked house, and a terms row cannot exist without one (brand_id NOT NULL),
  // so the terms are unreachable while the supplier is deletable. The BRAND
  // side is the reachable path, probed on the brand entity above.
  supplier: {
    table: 'suppliers',
    idColumn: 'id',
    label: 'supplier',
    archivable: true,
    probes: [
      probe('brands', 'houses', 'SELECT 1 FROM brands WHERE supplier_id = $1'),
      probe(
        'price_list_items',
        'price-list items',
        'SELECT 1 FROM price_list_items WHERE supplier_id = $1'
      ),
      // purchase_orders.supplier_id is RESTRICT (W13). The `brands` probe above
      // does NOT cover it: a purchase order snapshots the house it was
      // addressed to and outlives the brand link being changed, so a supplier
      // can carry purchase orders while pointing at no live house.
      probe(
        'purchase_orders',
        'purchase orders',
        'SELECT 1 FROM purchase_orders WHERE supplier_id = $1'
      ),
      // supplier_invoices.supplier_id is RESTRICT (W14), and it is NOT covered
      // by the purchase-orders probe above: an invoice is entered against the
      // house that sent it and can be keyed before anything has been ordered,
      // so a supplier can carry a bill and no purchase order at all.
      probe(
        'supplier_invoices',
        'supplier invoices',
        'SELECT 1 FROM supplier_invoices WHERE supplier_id = $1'
      ),
    ],
  },

  // A house's negotiated terms. `supplier_discount_tiers.supplier_brand_term_id`
  // is CASCADE, so a bare DELETE takes every tier under the row and reports
  // success — the office deletes what it reads as one flat rate and silently
  // loses the three rates that actually applied. The probe is what makes it
  // explain itself instead. Not archivable: the table has no `archived_at`, and
  // a set of terms is either on file or absent (same shape as shipping_rate).
  supplier_brand_term: {
    table: 'supplier_brand_terms',
    idColumn: 'id',
    label: 'set of terms',
    archivable: false,
    probes: [
      probe(
        'supplier_discount_tiers',
        'discount tiers',
        'SELECT 1 FROM supplier_discount_tiers WHERE supplier_brand_term_id = $1'
      ),
    ],
  },

  // Only `product_discount_tiers` references a tier, and it CASCADEs (a
  // product whose tier goes falls back to category matching), so there is no
  // probe to write. It is registered
  // rather than deleted with a bare statement so the DELETE route answers the
  // same envelope every other one does, and so the 404 comes from the same place.
  supplier_discount_tier: {
    table: 'supplier_discount_tiers',
    idColumn: 'id',
    label: 'discount tier',
    archivable: false,
    probes: [],
  },

  // Three SET NULL edges out of users, all of them commercial record: orders
  // would become anonymous guest orders with no guest_email, and the business
  // record behind a trade application would lose its applicant.
  user: {
    table: 'users',
    idColumn: 'id',
    label: 'account',
    archivable: true,
    guard: userGuard,
    probes: [
      probe('orders', 'orders', 'SELECT 1 FROM orders WHERE user_id = $1'),
      probe(
        'trade_applications',
        'trade applications',
        'SELECT 1 FROM trade_applications WHERE user_id = $1'
      ),
      probe(
        'contact_enquiries',
        'contact enquiries',
        'SELECT 1 FROM contact_enquiries WHERE user_id = $1'
      ),
    ],
  },

  // The submitted trade-account form. Nothing references it, so there is no
  // probe to write — it is registered so the DELETE route answers the shared
  // envelope, and because it is the only way to clear the `user` probe above:
  // a declined applicant's archived login cannot be deleted while its form is
  // on file, and the same email cannot be signed up again while the login
  // exists, so without this route that address was stuck for ever. Not
  // archivable: the table has no `archived_at`, and the account's own archive
  // is the reversible "no" (the CRM's Decline).
  trade_application: {
    table: 'trade_applications',
    idColumn: 'id',
    label: 'trade application',
    archivable: false,
    probes: [],
  },

  // The two edges out of a showroom differ, and the SET NULL one is why the
  // probes are here at all. `sample_orders.showroom_id` is NOT NULL and
  // RESTRICT, so the database would refuse that half loudly; `samples.showroom_id`
  // is SET NULL, so without a probe deleting a showroom silently un-homes every
  // sample that stood in it and answers 200. Same shape as `supplier`, and for
  // the same reason.
  showroom: {
    table: 'showrooms',
    idColumn: 'id',
    label: 'showroom',
    archivable: true,
    probes: [
      probe('samples', 'samples', 'SELECT 1 FROM samples WHERE showroom_id = $1'),
      probe(
        'sample_orders',
        'sample orders',
        'SELECT 1 FROM sample_orders WHERE showroom_id = $1'
      ),
    ],
  },

  // A sample's loans ARE the register: who had what, when, and whether it came
  // back. `sample_loans.sample_id` is RESTRICT, so the database would refuse this
  // one anyway — the probe still wins, because it reports HOW MANY movements are
  // in the way and it runs before anything is destroyed. That is the house order
  // (probe first, 23503 only as the backstop), and it is what lets the refusal
  // offer archiving instead: `samples.archived_at` exists, and a sample with
  // history is a row that must stop appearing without ceasing to exist.
  sample: {
    table: 'samples',
    idColumn: 'id',
    label: 'sample',
    archivable: true,
    probes: [
      probe('sample_loans', 'loans', 'SELECT 1 FROM sample_loans WHERE sample_id = $1'),
    ],
  },

  // Nothing in the schema references a sample order, so there is no probe to
  // write and the FKs all point the other way — which is exactly why the rule
  // here is a GUARD. "Is this row still a record of something" is a question
  // about the row's own state, not about what points at it, and no foreign key
  // can express it.
  sample_request: {
    table: 'sample_requests',
    idColumn: 'id',
    label: 'sample request',
    archivable: true,
    guard: sampleRequestGuard,
    probes: [],
  },

  sample_order: {
    table: 'sample_orders',
    idColumn: 'id',
    label: 'sample order',
    archivable: true,
    guard: sampleOrderGuard,
    probes: [],
  },

  // Neither reserves table has `archived_at` — `cancelled` is the removal that
  // keeps the record — so both say `archivable: false` and the CRM's blocked
  // dialog correctly offers Cancel alone. The line's probe-shaped question
  // ("did a cutting get generated from this?") is deliberately NOT a probe:
  // `source_line_id` is SET NULL, and a generated cutting outliving its
  // drafting-mistake parent is the intended outcome, not a blocked one.
  reserve_line: {
    table: 'reserve_lines',
    idColumn: 'id',
    label: 'reserve line',
    archivable: false,
    guard: reserveLineGuard,
    probes: [],
  },

  reserve_request: {
    table: 'reserve_requests',
    idColumn: 'id',
    label: 'reserve docket',
    archivable: false,
    guard: reserveRequestGuard,
    probes: [],
  },

  // No archived_at column: a rate tier is either priced or absent.
  shipping_rate: {
    table: 'shipping_rates',
    idColumn: 'id',
    label: 'shipping rate',
    archivable: false,
    guard: shippingRateGuard,
    probes: [],
  },

  contact_enquiry: {
    table: 'contact_enquiries',
    idColumn: 'id',
    label: 'enquiry',
    archivable: true,
    probes: [],
  },

  // An order is deletable only while it is not yet a financial record — a
  // mis-keyed sales order, a request nobody priced, a declined one. `orderGuard`
  // draws that line (checkout ever, paid/shipped always: Stripe session,
  // xero_invoice_ref, a stock decrement already taken); everything it refuses
  // archives instead, which is why this stays `archivable: true`.
  //
  // The two dangers a bare `DELETE FROM orders` carries are both handled above
  // rather than by the schema. Its lines CASCADE, so the reservation must be
  // released BEFORE the delete or the stock is spoken for by an order that no
  // longer exists — that is `releaseOrderReservation`, and it is the reason
  // `beforeDelete` exists at all. And an order that has been invoiced or shipped
  // is the audit trail, which is what the guard protects.
  //
  // THE FOURTH BLOCKER (W13-US-008). `purchase_order_line_allocations.order_line_id`
  // is RESTRICT, so an order that has already been ordered FROM A SUPPLIER is no
  // longer a mis-key anyone can delete — somebody's money is committed against
  // it at a house. The probe reaches it through `order_lines`, the same shape
  // the `product` entry uses to see its grandchildren, and it counts RELEASED
  // allocations too: a cancelled purchase order still records that this order
  // was once bought against, and deleting the order would destroy the other half
  // of that record.
  //
  // Without the probe the delete would still be refused — the cascade to
  // `order_lines` dies on the RESTRICT edge — but as a bare 23503 reading
  // "related records", after `beforeDelete` had already handed the reservation
  // back inside the same transaction. `CONSTRAINT_BLOCKERS` in delete.js names
  // the constraint as well, for the lost race.
  //
  // `order_lines`, `webhook_events`, `purchase_order_receipts`, trade
  // applications, trade accounts and every legacy_* table still need no entry —
  // absence from this registry is the normal protection, since requireEntity
  // throws on an unknown name.
  order: {
    table: 'orders',
    idColumn: 'id',
    label: 'order',
    archivable: true,
    guard: orderGuard,
    beforeDelete: releaseOrderReservation,
    probes: [
      probe(
        'purchase_order_line_allocations',
        'supplier purchase-order allocations',
        `SELECT 1 FROM purchase_order_line_allocations a
            JOIN order_lines ol ON ol.id = a.order_line_id
           WHERE ol.order_id = $1`
      ),
    ],
  },

  // A purchase order is deletable only while nothing hangs off it (FR-147): a
  // mis-keyed draft, a derivation somebody ran twice. Its LINES cascade — they
  // are the document's own body — but a receipt is a record of goods that
  // physically arrived and an allocation is a claim against a sales order, and
  // both refuse.
  //
  // `archivable: false`, and there is no `archived_at` column to match
  // (`test/lifecycle-registry.test.js` asserts the two agree). `cancelled` and
  // `closed` already take a finished purchase order off every list AND say why,
  // which `archived_at` cannot; a second vocabulary for "take it off my screen"
  // is how two lists start disagreeing about what is open.
  //
  // `purchase_order_receipt` has NO ENTRY HERE AT ALL and must not get one. The
  // ledger is append-only — a mistake is reversed by a negative row — and
  // absence from this registry is what makes a DELETE route against it
  // impossible to register rather than merely refused.
  purchase_order: {
    table: 'purchase_orders',
    idColumn: 'id',
    label: 'purchase order',
    archivable: false,
    probes: [
      probe(
        'purchase_order_receipts',
        'goods receipts',
        `SELECT 1 FROM purchase_order_receipts r
            JOIN purchase_order_lines l ON l.id = r.purchase_order_line_id
           WHERE l.purchase_order_id = $1`
      ),
      probe(
        'purchase_order_line_allocations',
        'sales-order allocations',
        `SELECT 1 FROM purchase_order_line_allocations a
            JOIN purchase_order_lines l ON l.id = a.purchase_order_line_id
           WHERE l.purchase_order_id = $1`
      ),
      // THE THIRD BLOCKER (W14-US-002). A purchase order that has been INVOICED
      // is on somebody's ledger: `supplier_invoice_allocations.purchase_order_id`
      // is RESTRICT, so the database would refuse anyway, and the probe is what
      // reports it as a named blocker before anything is destroyed. The way out
      // is to detach it from the invoice first, which is a deliberate act
      // rather than a cascade.
      probe(
        'supplier_invoice_allocations',
        'supplier invoices',
        'SELECT 1 FROM supplier_invoice_allocations WHERE purchase_order_id = $1'
      ),
    ],
  },

  // A supplier invoice is deletable only while nothing is attached to it
  // (FR-159): a bill keyed twice, or one entered against the wrong house.
  // `supplier_invoice_allocations.supplier_invoice_id` is RESTRICT, so the
  // probe and the database agree; the probe wins because it reports HOW MANY
  // purchase orders are in the way and runs before anything is destroyed.
  //
  // `archivable: false`, and there is no `archived_at` column to match
  // (`test/lifecycle-registry.test.js` asserts the two agree) — the same
  // argument `purchase_order` makes. `matched` and `disputed` already take an
  // invoice off the list somebody is working through AND say why, which
  // `archived_at` cannot.
  //
  // Detaching is deliberately NOT reachable from here. It is its own route
  // (`DELETE /admin/supplier-invoices/:id/allocations/:poId`), because taking a
  // purchase order off a bill is a commercial decision about that purchase
  // order and not a step in tidying an invoice away.
  supplier_invoice: {
    table: 'supplier_invoices',
    idColumn: 'id',
    label: 'supplier invoice',
    archivable: false,
    probes: [
      probe(
        'supplier_invoice_allocations',
        'purchase orders',
        'SELECT 1 FROM supplier_invoice_allocations WHERE supplier_invoice_id = $1'
      ),
    ],
  },
})

/** Every registered entity name, for tests and route registration. */
export const LIFECYCLE_ENTITY_NAMES = Object.freeze(Object.keys(LIFECYCLE_ENTITIES))

/**
 * Look an entity up by name. Throws a plain Error — not an httpError — because
 * an unknown name is a wiring mistake, not something a request can ask for.
 *
 * @param {string} entityName
 * @returns {object}
 */
export const requireEntity = (entityName) => {
  const entity = LIFECYCLE_ENTITIES[entityName]
  if (!entity) {
    throw new Error(
      `Unknown lifecycle entity "${entityName}". ` +
        `Known: ${LIFECYCLE_ENTITY_NAMES.join(', ')}.`
    )
  }
  return entity
}

/**
 * Look an entity up for a hard delete. Same contract as `requireEntity`, and
 * additionally refuses an entity marked `deletable: false` — those are in the
 * registry so `setArchived` can reach them, and a DELETE route registered
 * against one would be a wiring mistake that no request should be able to make.
 *
 * @param {string} entityName
 * @returns {object}
 */
export const requireDeletableEntity = (entityName) => {
  const entity = requireEntity(entityName)
  if (entity.deletable === false) {
    throw new Error(
      `Lifecycle entity "${entityName}" is never hard-deletable; archive it instead.`
    )
  }
  return entity
}
