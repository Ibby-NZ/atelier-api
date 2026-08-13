/**
 * Supplier invoices — the header (W14-US-001).
 *
 * ONE SUPPLIER SENDS ONE INVOICE COVERING MANY PURCHASE ORDERS, every two to
 * four weeks. That sentence is the whole of this table, and it is the reason
 * this is a separate entity rather than a column on `purchase_orders`: W13
 * groups purchase orders by BRAND, one supplier sells several brands, so there
 * are always more purchase orders than there are invoices to pay for them.
 *
 * `supplier_id` IS ACCEPTED FROM THE CALLER HERE, and that is not a
 * contradiction of `purchase_orders`, where it is derived and never accepted.
 * A purchase order is addressed to a house Atelier chose by picking a BRAND, so
 * the supplier is a derivation with a right answer the client cannot see. An
 * invoice ARRIVES from a supplier; the supplier is the primary fact on the
 * paper and there is nothing to derive it from. The rule that replaces the
 * derivation is invariant 2 — an invoice's supplier must equal every allocated
 * purchase order's supplier — and it lives in `src/purchasing/supplier-invoices.js`
 * as a 422 naming the purchase order, because saying it in SQL needs two chained
 * composite foreign keys to express one sentence.
 *
 * `(supplier_id, lower(btrim(invoice_number)))` IS UNIQUE, NOT
 * `invoice_number` ALONE. An invoice number is unique to the supplier that
 * issued it and nowhere else — two maisons both numbering from 1001 is the
 * ordinary case, and a global unique would refuse the second one's paperwork
 * outright. It is `lower(btrim(...))` because the number is TYPED BY A HUMAN off
 * a piece of paper, so ` inv-2291 ` and `INV-2291` are the same invoice keyed
 * twice, which is exactly the duplicate this constraint exists to catch. Same
 * posture as `supplier_aliases`'s `lower(btrim(alias))`.
 *
 * MONEY IS `numeric(12,4)` AND THERE IS NO CENTS COLUMN, here or on the join.
 * The reasoning is `1787544000000_purchase-orders.js`'s, unchanged: a supplier
 * invoice is FOREIGN, FRACTIONAL AND UNCONVERTED, and cents is the storefront's
 * type for a domestic sale that has already been converted. `fx_rate` is
 * recorded RAW AND UNINTERPRETED — nothing in this API converts anything with
 * it — because the FX basis (invoice date, payment date, or the rate the bank
 * actually gave) is still owed by the client (A9). A column that holds the
 * number the office wrote down is honest; arithmetic on it would not be.
 *
 * `SUM(allocations.amount)` IS DELIBERATELY NOT CONSTRAINED AGAINST
 * `total_amount`, AND NO CHECK MAY EVER BE ADDED. The unreconciled difference IS
 * the product: the screen exists to show a person how much of a £48,000 invoice
 * they have accounted for so far. A CHECK would refuse the half-done state the
 * whole feature is for, and it could not be written anyway — an aggregate is
 * over a set and a CHECK sees one row. `unallocated_amount` is DERIVED at read
 * time and stored nowhere, the same rule W13 applies to a received quantity.
 *
 * FREIGHT AND DUTY ARE RECORDED AND NEVER APPORTIONED (ADR 006). They are the
 * ACTUAL charges for the consignment; `shipping_rates` is a FORWARD ESTIMATE for
 * a customer, and the two are both correct and describe different things.
 * Nothing here derives a landed cost, pushes a non-line charge down onto a
 * purchase-order line, or writes back to a rate, a price or a sell figure — the
 * rule for doing so is owed by the client, and "it kept the information, didn't
 * change anything" is the client's own description of what they want.
 *
 * `status` IS A JUDGEMENT A PERSON MAKES, not arithmetic — the same split
 * `purchase_orders.status` draws against its derived receipt state. `matched`
 * means somebody looked at the variance and accepted it; it does NOT mean
 * `SUM(amount) = total_amount`, and it must never be computed. `disputed` is
 * where an invoice sits while the office is arguing with the house, which is a
 * fact no sum can discover. There is no state machine module beside this one
 * (W13 has `po-states.js`) because there are no illegal moves here: an invoice
 * can go back to `disputed` from `matched` the moment somebody spots something,
 * and inventing a spine would only be a rule to fight later.
 *
 * THERE IS NO `archived_at`, matching `purchase_orders`: the lifecycle registry
 * entry says `archivable: false` and `test/lifecycle-registry.test.js` asserts
 * the two agree. An invoice that has been dealt with is `matched` and filtered
 * off a list by its status, which also says WHY — a second vocabulary for "take
 * it off my screen" is how two lists start disagreeing about what is open.
 *
 * `supplier_id` IS RESTRICT for the reason `purchase_orders.supplier_id` is: an
 * invoice is the evidence of a live commercial relationship, and SET NULL would
 * leave a bill from nobody. The registry's `supplier` entry gains a probe so the
 * refusal counts the invoices rather than dying on a bare 23503.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('supplier_invoices', {
    id: 'id',
    supplier_id: {
      type: 'integer',
      notNull: true,
      references: 'suppliers',
      onDelete: 'RESTRICT',
    },
    // The house's own number for the bill, typed off the paper. See the header
    // for why it is unique per SUPPLIER and not globally.
    invoice_number: {
      type: 'text',
      notNull: true,
      check: "btrim(invoice_number) <> ''",
    },
    // The date on the paper, not the date it was keyed — `created_at` is that.
    // `date`, not `timestamptz`: an invoice is dated to the day, and a timestamp
    // would invite a timezone to move it across a period boundary. This is the
    // column the matching search (US-005) ranges over.
    invoice_date: { type: 'date', notNull: true },
    // The snapshot, as `purchase_orders` takes one: an invoice is a document
    // from a house at a moment, and re-pointing or renaming the supplier record
    // next year must not rewrite whose paper this was. `supplier_id` stays
    // beside them as the link a report rolls up on.
    supplier_name: { type: 'text', notNull: true },
    // Nullable exactly as `suppliers.currency` is — blank means nobody has
    // recorded which currency this house invoices in, and the country is the
    // wrong answer to guess with.
    currency: { type: 'text' },
    // What the house is asking for, in their currency. NOT NULL: an invoice
    // with no total is not an invoice. `>= 0` rather than `> 0`, the
    // `unit_price` rule — a zero-value replacement consignment is real.
    total_amount: {
      type: 'numeric(12,4)',
      notNull: true,
      check: 'total_amount >= 0',
    },
    // The ACTUAL freight for this consignment (FR-155). Recorded, never
    // apportioned and never written back to a rate — see the header.
    freight_amount: {
      type: 'numeric(12,4)',
      check: 'freight_amount IS NULL OR freight_amount >= 0',
    },
    // Duty, same posture. NULL is "not stated on this invoice"; 0 is "stated as
    // nil". `Number(null)` is 0, so every read of either goes through
    // `value == null ? null : Number(value)`.
    duty_amount: {
      type: 'numeric(12,4)',
      check: 'duty_amount IS NULL OR duty_amount >= 0',
    },
    // Raw and uninterpreted. Six decimal places because a rate is a rate, not
    // money: 0.548210 NZD/EUR loses its last two digits at scale 4.
    fx_rate: {
      type: 'numeric(12,6)',
      check: 'fx_rate IS NULL OR fx_rate > 0',
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'received',
      check: "status IN ('received', 'matched', 'disputed')",
    },
    notes: { type: 'text' },
    // Who entered it (FR-163). SET NULL — the document outlives the account.
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // The duplicate-paperwork guard. An expression index, so it has to be spelled
  // rather than declared on the column.
  pgm.createIndex('supplier_invoices', ['supplier_id', 'lower(btrim(invoice_number))'], {
    name: 'supplier_invoices_supplier_number_unique',
    unique: true,
  })

  // The list filters (FR-160): supplier, status and a date range.
  pgm.createIndex('supplier_invoices', 'supplier_id')
  pgm.createIndex('supplier_invoices', 'status')
  pgm.createIndex('supplier_invoices', 'invoice_date')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('supplier_invoices')
}
