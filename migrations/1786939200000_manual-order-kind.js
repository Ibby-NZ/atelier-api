// A fourth order kind: 'manual' — a sales order the back office keys itself.
//
// `kind` is the order's CHANNEL, not its behaviour: 'checkout' is a card sale
// taken on the storefront, 'order_request'/'backorder_request' are what a
// shopper asked the office for through the site, and 'manual' is one a staff
// member raised from a phone call, a walk-in, a bespoke enquiry — or from a
// storefront request that turned into a bigger job. Reusing 'order_request' for
// those would erase the one distinction the office wants in its lists and its
// reports, and the order NUMBER prefix (SO-) is a string convention, not a
// queryable dimension: src/reports/filters.js filters on o.kind.
//
// A manual order RESERVES stock like a request (see RESERVING_KINDS in
// src/orders/order-states.js) and is invoiced through Xero like one
// (INVOICEABLE_KINDS in src/reports/not-invoiced.js). Widening the CHECK is
// therefore only half the change — the boundary copies in src/reports/filters.js
// (ORDER_KINDS) and src/reports/not-invoiced.js must move in the same commit, or
// test/admin-reports.test.js fails: it parses this constraint's live
// pg_get_constraintdef and asserts it equals ORDER_KINDS. That failure is the
// tripwire working, not a broken test.
//
// A widening needs no backfill: every existing row already satisfies the new set.

export const up = (pgm) => {
  pgm.dropConstraint('orders', 'orders_kind_check')
  pgm.addConstraint('orders', 'orders_kind_check', {
    check: "kind IN ('checkout', 'order_request', 'backorder_request', 'manual')",
  })
}

export const down = (pgm) => {
  // Narrowing back is only safe once no manual orders exist; the DELETE is
  // deliberately absent — a down migration that destroyed sales orders would be
  // far worse than one that fails loudly on the CHECK.
  pgm.dropConstraint('orders', 'orders_kind_check')
  pgm.addConstraint('orders', 'orders_kind_check', {
    check: "kind IN ('checkout', 'order_request', 'backorder_request')",
  })
}
