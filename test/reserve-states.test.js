// The reserve-line state machine — pure, no database.
//
// The transition map is asserted as a LITERAL second copy, not by walking the
// exported object: the CRM mirrors this machine verbatim
// (atelier-crm/src/screens/reserveFlow.js), so a hand-edit here must fail a
// test loudly rather than drift the two apart. Same idiom the sample-order
// machine's suite uses.

import { describe, it, expect } from 'vitest'
import {
  RESERVE_LINE_STATUSES,
  INITIAL_RESERVE_LINE_STATUS,
  ALLOWED_TRANSITIONS,
  SOURCE_STATUSES,
  STATUS_STAMPS,
  DELETABLE_RESERVE_LINE_STATUSES,
  CFA_STATES,
  RESERVE_LINE_KINDS,
  requireStatus,
  requireTransition,
} from '../src/reserves/reserve-line-states.js'

describe('the vocabulary', () => {
  it('is the five wish-list states, in lifecycle order', () => {
    expect(RESERVE_LINE_STATUSES).toEqual([
      'requested',
      'confirmed',
      'arrived',
      'dispatched',
      'cancelled',
    ])
  })

  it('starts every line at requested', () => {
    expect(INITIAL_RESERVE_LINE_STATUS).toBe('requested')
  })

  it('keeps the D365 CFA vocabulary the houses reply to', () => {
    expect(CFA_STATES).toEqual(['not_required', 'required', 'ordered', 'received', 'approved'])
  })

  it('knows exactly two kinds of line', () => {
    expect(RESERVE_LINE_KINDS).toEqual(['reserve', 'cutting'])
  })
})

describe('the transitions', () => {
  it('declares exactly the moves the CRM mirrors', () => {
    expect(ALLOWED_TRANSITIONS).toEqual({
      requested: ['confirmed', 'arrived', 'cancelled'],
      confirmed: ['arrived', 'cancelled'],
      arrived: ['dispatched'],
      dispatched: [],
      cancelled: [],
    })
  })

  it('derives the inverse map rather than re-typing it', () => {
    expect(SOURCE_STATUSES).toEqual({
      requested: [],
      confirmed: ['requested'],
      arrived: ['requested', 'confirmed'],
      dispatched: ['arrived'],
      cancelled: ['requested', 'confirmed'],
    })
  })

  it('stamps every state with its own column', () => {
    expect(STATUS_STAMPS).toEqual({
      requested: 'requested_at',
      confirmed: 'confirmed_at',
      arrived: 'arrived_at',
      dispatched: 'dispatched_at',
      cancelled: 'cancelled_at',
    })
  })

  it('lets goods that turned up unannounced be marked arrived from requested', () => {
    expect(ALLOWED_TRANSITIONS.requested).toContain('arrived')
  })

  it('never cancels material that is already in the warehouse', () => {
    expect(ALLOWED_TRANSITIONS.arrived).not.toContain('cancelled')
    expect(ALLOWED_TRANSITIONS.dispatched).toEqual([])
  })
})

describe('requireTransition', () => {
  it('allows a declared move', () => {
    expect(() => requireTransition({ status: 'requested' }, 'confirmed')).not.toThrow()
    expect(() => requireTransition({ status: 'confirmed' }, 'arrived')).not.toThrow()
    expect(() => requireTransition({ status: 'arrived' }, 'dispatched')).not.toThrow()
  })

  it('409s an undeclared move, a self-move, and any move out of a terminal state', () => {
    for (const [line, target] of [
      [{ status: 'requested' }, 'dispatched'],
      [{ status: 'confirmed' }, 'confirmed'],
      [{ status: 'dispatched' }, 'arrived'],
      [{ status: 'cancelled' }, 'requested'],
    ]) {
      let caught
      try {
        requireTransition(line, target)
      } catch (error) {
        caught = error
      }
      expect(caught?.statusCode).toBe(409)
      expect(caught?.message).toContain(`"${line.status}"`)
    }
  })

  it('409s an unknown target rather than allowing it', () => {
    let caught
    try {
      requireTransition({ status: 'requested' }, 'complete')
    } catch (error) {
      caught = error
    }
    expect(caught?.statusCode).toBe(409)
  })
})

describe('requireStatus', () => {
  it('accepts a single status or a list', () => {
    expect(() => requireStatus({ status: 'requested' }, 'requested', 'edit')).not.toThrow()
    expect(() =>
      requireStatus({ status: 'confirmed' }, ['requested', 'confirmed'], 'edit')
    ).not.toThrow()
  })

  it('phrases the refusal with the action and the current status', () => {
    let caught
    try {
      requireStatus({ status: 'dispatched' }, 'requested', 'edit')
    } catch (error) {
      caught = error
    }
    expect(caught?.statusCode).toBe(409)
    expect(caught?.message).toBe('Cannot edit a reserve line in status "dispatched".')
  })
})

describe('deletability', () => {
  it('is requested-or-cancelled, the same rule sample orders follow', () => {
    expect(DELETABLE_RESERVE_LINE_STATUSES).toEqual(['requested', 'cancelled'])
  })
})
