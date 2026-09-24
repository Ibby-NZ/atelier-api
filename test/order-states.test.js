// The sales-order state machine (src/orders/order-states.js), exercised with
// NO DATABASE — except the one case that proves the leaf and the live CHECK
// hold the same vocabulary, which is the tripwire for widening one without the
// other.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import {
  ORDER_STATUSES,
  ALLOWED_TRANSITIONS,
  PRICED_ENTRY_STATUSES,
  HELD_STATUSES,
  DELETABLE_ORDER_STATUSES,
  INVOICEABLE_STATUSES,
  LINE_EDIT_STATUSES,
  DELIVERY_EDIT_STATUSES,
  canTransition,
  requireTransition,
  isDeletableOrder,
  holdsReservation,
  reservationState,
} from '../src/orders/order-states.js'
import { ORDER_STATUSES as REEXPORTED } from '../src/orders/admin-orders.js'

describe('the sales-order machine', () => {
  it('lists a transition entry for every status, and nothing else', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort())
  })

  it('only ever moves to a status in the vocabulary, never to itself', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of targets) {
        expect(ORDER_STATUSES).toContain(to)
        expect(to).not.toBe(from)
      }
    }
  })

  it('makes cancelled and refunded dead ends', () => {
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([])
    expect(ALLOWED_TRANSITIONS.refunded).toEqual([])
  })

  it('lets a paid order only ship or refund', () => {
    expect([...ALLOWED_TRANSITIONS.paid].sort()).toEqual(['refunded', 'shipped'])
    expect(canTransition('paid', 'cancelled')).toBe(false)
  })

  it('lets the office skip the quote, and raise a back order before quoting', () => {
    expect(canTransition('quote_requested', 'processing')).toBe(true)
    expect(canTransition('quote_requested', 'back_order')).toBe(true)
    expect(canTransition('quote_rejected', 'quote_sent')).toBe(true)
    expect(canTransition('quote_sent', 'quote_requested')).toBe(true)
  })

  it('409s a move the machine does not list, naming both ends', () => {
    expect(() => requireTransition({ status: 'quote_requested' }, 'shipped')).toThrow(
      'Cannot move an order from "quote_requested" to "shipped".'
    )
    let caught = null
    try {
      requireTransition({ status: 'cancelled' }, 'quote_sent')
    } catch (error) {
      caught = error
    }
    expect(caught?.statusCode).toBe(409)
    expect(() => requireTransition({ status: 'paid' }, 'shipped')).not.toThrow()
  })

  it('gates the three money-stating statuses on pricing', () => {
    expect([...PRICED_ENTRY_STATUSES].sort()).toEqual(['paid', 'pending_payment', 'quote_sent'])
  })

  it('keeps every derived set inside the vocabulary', () => {
    for (const set of [
      HELD_STATUSES,
      DELETABLE_ORDER_STATUSES,
      INVOICEABLE_STATUSES,
      LINE_EDIT_STATUSES,
      DELIVERY_EDIT_STATUSES,
    ]) {
      for (const status of set) expect(ORDER_STATUSES).toContain(status)
    }
  })

  it('holds stock everywhere but the four statuses that settled it', () => {
    for (const settled of ['shipped', 'completed', 'cancelled', 'refunded']) {
      expect(HELD_STATUSES).not.toContain(settled)
    }
    // A rejected quote still holds until the office cancels or re-quotes it.
    expect(HELD_STATUSES).toContain('quote_rejected')
    expect(HELD_STATUSES).toContain('paid')
  })

  it('freezes lines once paid but keeps the address open until shipped', () => {
    expect(LINE_EDIT_STATUSES).not.toContain('paid')
    expect(DELIVERY_EDIT_STATUSES).toContain('paid')
    expect(DELIVERY_EDIT_STATUSES).not.toContain('shipped')
  })

  it('does not treat an unaccepted quote as awaiting an invoice', () => {
    for (const quote of ['quote_requested', 'quote_sent', 'quote_rejected']) {
      expect(INVOICEABLE_STATUSES).not.toContain(quote)
    }
    expect(INVOICEABLE_STATUSES).toContain('quote_accepted')
    expect(INVOICEABLE_STATUSES).not.toContain('cancelled')
  })

  it('deletes a quote or a cancelled order, never a paid, checkout or invoiced one', () => {
    expect(isDeletableOrder({ kind: 'manual', status: 'quote_requested' })).toBe(true)
    expect(isDeletableOrder({ kind: 'manual', status: 'cancelled' })).toBe(true)
    expect(isDeletableOrder({ kind: 'manual', status: 'paid' })).toBe(false)
    expect(isDeletableOrder({ kind: 'manual', status: 'shipped' })).toBe(false)
    expect(isDeletableOrder({ kind: 'checkout', status: 'cancelled' })).toBe(false)
    // cancelled is reachable after an invoice went out — still a record.
    expect(
      isDeletableOrder({ kind: 'manual', status: 'cancelled', xero_invoice_id: 'inv-1' })
    ).toBe(false)
  })

  it('holds a reservation only for a reserving kind in a held status', () => {
    expect(holdsReservation({ kind: 'order_request', status: 'back_order' })).toBe(true)
    expect(holdsReservation({ kind: 'checkout', status: 'paid' })).toBe(false)
    expect(holdsReservation({ kind: 'manual', status: 'cancelled' })).toBe(false)
  })

  it('names the reservation state per status', () => {
    expect(reservationState('manual', 'quote_sent')).toBe('held')
    expect(reservationState('manual', 'completed')).toBe('converted')
    expect(reservationState('manual', 'refunded')).toBe('released')
    expect(reservationState('checkout', 'paid')).toBe('none')
  })

  it('is re-exported from admin-orders.js for its existing importers', () => {
    expect(REEXPORTED).toBe(ORDER_STATUSES)
  })
})

describe('the live orders_status_check', () => {
  let pool

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  it('agrees with ORDER_STATUSES on the vocabulary', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'orders_status_check'`
    )
    const inTheCheck = [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
    expect(new Set(inTheCheck)).toEqual(new Set(ORDER_STATUSES))
  })
})
