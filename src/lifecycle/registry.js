// The delete/archive lifecycle registry.
//
// One frozen entry per entity the back office may hard-delete. An entry declares
// where the row lives (`table` + `idColumn`), whether a soft archive is offered
// instead (`archivable`), an optional `guard` for rules that are not "something
// else still points at this", and the dependency `probes` that decide whether a
// delete would destroy commercial history.
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
        'Ship or decline those orders first, then delete it.'
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
  // Both child edges are CASCADE, so without these probes deleting a stocked
  // house destroys its whole catalogue and returns 200.
  brand: {
    table: 'brands',
    idColumn: 'id',
    label: 'house',
    archivable: true,
    probes: [
      probe('products', 'products', 'SELECT 1 FROM products WHERE brand_id = $1'),
      probe('collections', 'collections', 'SELECT 1 FROM collections WHERE brand_id = $1'),
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
    ],
  },

  // order_lines.colourway_id is the one RESTRICT edge in the schema, so this
  // probe and the 23503 backstop agree; the probe wins because it can also
  // report how many, and because it runs before anything is destroyed.
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

  // Nothing references a rate row. Note for the screen that consumes this: a
  // deleted item comes back on the next `npm run import:pricing`, because the
  // upsert re-creates rows from the supplier's file. The confirm copy must say so.
  price_list_item: {
    table: 'price_list_items',
    idColumn: 'id',
    label: 'price-list item',
    archivable: true,
    probes: [],
  },

  // The two edges out of suppliers disagree, and only one of them would ever
  // raise: `brands.supplier_id` is RESTRICT (a house pointing at a supplier is a
  // live commercial relationship), `price_list_items.supplier_id` is SET NULL —
  // so without the second probe, deleting a supplier silently unlinks its whole
  // rate ledger and reports success. The per-brand commercial terms need no
  // probe: they CASCADE from both sides, and a terms row does not outlive the
  // relationship it describes. (Naming those tables here would also trip the
  // source scan in test/suppliers-terms.test.js, which keeps them inside
  // src/suppliers/.)
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
    ],
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
  sample_order: {
    table: 'sample_orders',
    idColumn: 'id',
    label: 'sample order',
    archivable: true,
    guard: sampleOrderGuard,
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

  // Present ONLY so setArchived can reach it — an order is never hard-deletable.
  // CASCADE would take its lines with it; the delete would not release
  // qty_reserved, permanently corrupting stock; and the row carries
  // xero_invoice_ref and stripe_session_id, which are the audit trail. Absence
  // from this registry is the normal protection (requireEntity throws on an
  // unknown name), so order_lines, webhook_events, trade applications, trade
  // accounts and every legacy_* table need no entry at all; `deletable: false`
  // exists for the one entity that has to be here for another reason.
  order: {
    table: 'orders',
    idColumn: 'id',
    label: 'order',
    archivable: true,
    deletable: false,
    probes: [],
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
