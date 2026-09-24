// The purchasing leaf modules, exercised with NO DATABASE AT ALL.
//
// That is the point of the block rather than a convenience: `po-states.js` and
// `po-plan.js` import nothing, so the CRM can mirror the machine (W13-US-009)
// and the office can read a dry run before anything is written. A test that
// needed a pool would be evidence that portability had been lost.

import { describe, it, expect } from 'vitest'
import {
  PURCHASE_ORDER_STATUSES,
  INITIAL_PURCHASE_ORDER_STATUS,
  ALLOWED_TRANSITIONS,
  SOURCE_STATUSES,
  STATUS_STAMPS,
  LIVE_PURCHASE_ORDER_STATUSES,
  RECEIPT_STATES,
  receiptState,
  rollUpReceiptState,
  requireStatus,
  requireTransition,
  canTransition,
} from '../src/purchasing/po-states.js'
import { planPurchaseOrders } from '../src/purchasing/po-plan.js'

describe('the purchase-order machine', () => {
  it('holds only what a person did (and the two moves the platform makes for them)', () => {
    // `full` and `part` are receipt states and must never appear here: a
    // purchase order completed short is a DECISION, and storing a derived
    // "fully received" beside it gives two answers to one question.
    expect(PURCHASE_ORDER_STATUSES).toEqual([
      'draft',
      'pending_payment',
      'paid',
      'awaiting_delivery',
      'received',
      'completed',
      'cancelled',
    ])
    for (const derived of RECEIPT_STATES) {
      if (derived === 'none') continue
      expect(PURCHASE_ORDER_STATUSES).not.toContain(derived)
    }
  })

  it('starts in draft and dates every state it can reach', () => {
    expect(INITIAL_PURCHASE_ORDER_STATUS).toBe('draft')
    expect(STATUS_STAMPS.draft).toBeNull()
    for (const status of PURCHASE_ORDER_STATUSES) {
      if (status === INITIAL_PURCHASE_ORDER_STATUS) continue
      expect(typeof STATUS_STAMPS[status]).toBe('string')
    }
    // The send moment and the finish keep their columns under the new words.
    expect(STATUS_STAMPS.pending_payment).toBe('sent_at')
    expect(STATUS_STAMPS.completed).toBe('closed_at')
  })

  it('sends a draft to pending payment, and cancels only before money has left', () => {
    expect(ALLOWED_TRANSITIONS.draft).toEqual(['pending_payment', 'cancelled'])
    expect(SOURCE_STATUSES.cancelled).toEqual(['draft', 'pending_payment'])
    expect(ALLOWED_TRANSITIONS.completed).toEqual([])
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([])
    expect(LIVE_PURCHASE_ORDER_STATUSES).toEqual([
      'draft',
      'pending_payment',
      'paid',
      'awaiting_delivery',
      'received',
    ])
  })

  it('lets goods arrive before the house is paid, and payment follow', () => {
    // A supplier on account ships first: received before paid, then paid.
    expect(canTransition('pending_payment', 'received')).toBe(true)
    expect(canTransition('received', 'paid')).toBe(true)
    expect(canTransition('paid', 'awaiting_delivery')).toBe(true)
    expect(canTransition('paid', 'cancelled')).toBe(false)
  })

  it('derives SOURCE_STATUSES from the machine rather than restating it', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const target of targets) {
        expect(SOURCE_STATUSES[target]).toContain(from)
      }
    }
    // Completing a draft is a cancellation with the wrong word on it.
    expect(SOURCE_STATUSES.completed).toEqual(['paid', 'awaiting_delivery', 'received'])
    expect(SOURCE_STATUSES.paid).toEqual(['pending_payment', 'awaiting_delivery', 'received'])
  })

  it('refuses an illegal move with a 409', () => {
    expect(() => requireTransition({ status: 'draft' }, 'completed')).toThrow(/status "draft"/)
    let caught = null
    try {
      requireTransition({ status: 'cancelled' }, 'pending_payment')
    } catch (error) {
      caught = error
    }
    expect(caught?.statusCode).toBe(409)
    expect(() => requireTransition({ status: 'draft' }, 'pending_payment')).not.toThrow()
    expect(() => requireStatus({ status: 'paid' }, ['draft', 'paid'], 'edit')).not.toThrow()
  })
})

describe('receipt state is arithmetic, never a stored flag', () => {
  it.each([
    [40, 0, 'none'],
    [40, 25, 'part'],
    [40, 40, 'full'],
    // OVER-RECEIPT IS LEGITIMATE AND IS NEVER CLAMPED: suppliers over-ship rolls.
    [40, 42, 'over'],
    // A fully reversed line nets back to zero and reads `none` again — the point
    // of correcting with a negative row rather than an edit.
    [40, 0, 'none'],
    // More reversed than ever arrived is a data problem the ledger displays row
    // by row, not a fifth state.
    [40, -5, 'none'],
  ])('ordered %s received %s is %s', (ordered, received, expected) => {
    expect(receiptState(ordered, received)).toBe(expected)
  })

  it('rolls a purchase order up from its LINES, not from its totals', () => {
    // 10 received against a 5 + 5 order sums to "full" while one line is over
    // and the other is empty. That is the one thing the office needs to see.
    expect(rollUpReceiptState(['over', 'none'])).toBe('over')
    expect(rollUpReceiptState(['full', 'full'])).toBe('full')
    expect(rollUpReceiptState(['none', 'none'])).toBe('none')
    expect(rollUpReceiptState(['full', 'none'])).toBe('part')
    expect(rollUpReceiptState([])).toBe('none')
  })
})

describe('the grouping planner', () => {
  const candidate = (overrides = {}) => ({
    order_line_id: 1,
    order_id: 10,
    order_number: 'SO-0001',
    qty: '10.00',
    colourway_id: 100,
    sku: 'AAA-1',
    product_name: 'Design',
    brand_id: 5,
    brand_name: 'Alpha House',
    brand_slug: 'alpha-house',
    supplier_id: 50,
    supplier_name: 'Alpha Supplier',
    currency: 'EUR',
    agent: 'Agent A',
    incoterm: 'FOB',
    po_email: 'orders@alpha.test',
    ...overrides,
  })

  it('groups by BRAND, so one supplier selling two brands makes two orders', () => {
    // Not a bug to fix later — it is the whole reason consolidated supplier
    // invoicing (W14) exists as a separate concept.
    const plan = planPurchaseOrders([
      candidate({ order_line_id: 1, brand_id: 5, brand_name: 'Alpha House' }),
      candidate({
        order_line_id: 2,
        brand_id: 6,
        brand_name: 'Beta House',
        brand_slug: 'beta-house',
        colourway_id: 200,
        sku: 'BBB-1',
        // Same supplier as Alpha.
        supplier_id: 50,
      }),
    ])
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups.map((group) => group.supplier_id)).toEqual([50, 50])
    expect(plan.groups.map((group) => group.brand_name)).toEqual([
      'Alpha House',
      'Beta House',
    ])
  })

  it('merges two sales orders for one colourway into one line with two allocations', () => {
    // The ordinary case: 40 m bought because SO-411 wants 25 and SO-418 wants 15.
    // Without a quantity on the allocation the line cannot say which is whose,
    // and a short delivery has no basis on which to be split.
    const plan = planPurchaseOrders([
      candidate({ order_line_id: 1, order_id: 41, order_number: 'SO-411', qty: '25.00' }),
      candidate({ order_line_id: 2, order_id: 42, order_number: 'SO-418', qty: '15.00' }),
    ])
    expect(plan.groups).toHaveLength(1)
    const [line] = plan.groups[0].lines
    expect(line.qty_ordered).toBe(40)
    expect(line.allocations.map((a) => [a.order_number, a.qty])).toEqual([
      ['SO-411', 25],
      ['SO-418', 15],
    ])
    expect(plan.groups[0].order_count).toBe(2)
  })

  it('blocks a brand with no supplier and names it, never guessing one', () => {
    // A client-chosen supplier produces no constraint violation of any kind — it
    // silently addresses the order to the wrong house.
    const plan = planPurchaseOrders([
      candidate({ order_line_id: 1 }),
      candidate({
        order_line_id: 2,
        brand_id: 9,
        brand_name: 'Unlinked House',
        brand_slug: 'unlinked-house',
        colourway_id: 300,
        supplier_id: null,
        supplier_name: null,
      }),
    ])
    expect(plan.groups).toHaveLength(1)
    expect(plan.blocked).toHaveLength(1)
    expect(plan.blocked[0]).toMatchObject({
      brand_id: 9,
      reason: 'no_supplier',
      order_line_ids: [2],
    })
    expect(plan.blocked[0].message).toContain('Unlinked House')
  })

  it('leaves unit_price NULL, because nothing can derive one', () => {
    // `price_list_items` is keyed (supplier, category, code) and a supplier
    // colour code has no path to a colourway. `Number(null)` is 0, and a zero
    // purchase price reads as "the house is giving it to us".
    const [line] = planPurchaseOrders([candidate()]).groups[0].lines
    expect(line.unit_price).toBeNull()
    expect(line.unit_price).not.toBe(0)
  })

  it('snapshots the supplier terms onto the group', () => {
    const [group] = planPurchaseOrders([candidate()]).groups
    expect(group).toMatchObject({
      supplier_name: 'Alpha Supplier',
      currency: 'EUR',
      agent: 'Agent A',
      incoterm: 'FOB',
      po_email: 'orders@alpha.test',
    })
  })

  it('is deterministic, so a dry run reads as the thing that will be written', () => {
    const candidates = [
      candidate({ order_line_id: 3, colourway_id: 102, sku: 'ZZZ-1' }),
      candidate({ order_line_id: 1, colourway_id: 100, sku: 'AAA-1' }),
      candidate({ order_line_id: 2, colourway_id: 101, sku: 'MMM-1' }),
    ]
    const first = planPurchaseOrders(candidates)
    const second = planPurchaseOrders([...candidates].reverse())
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first.groups[0].lines.map((line) => line.sku)).toEqual([
      'AAA-1',
      'MMM-1',
      'ZZZ-1',
    ])
  })

  it('drops a line with no quantity rather than planning a zero-metre buy', () => {
    expect(planPurchaseOrders([candidate({ qty: null })]).groups).toEqual([])
    expect(planPurchaseOrders([]).groups).toEqual([])
  })
})
