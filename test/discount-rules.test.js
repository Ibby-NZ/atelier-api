// The discount gate and the total formula (Rebecca-R2), tested with no
// database — src/orders/discounts.js is a pure leaf module, the
// order-states.js posture. The DB suite (test/order-discounts.test.js) is what
// proves `discountedTotalCents` and the SQL in `recomputeOrderMoney` agree;
// this file proves the formula and the gate say what they mean.

import { describe, it, expect } from 'vitest'

import {
  STANDARD_DISCOUNT_TIERS,
  isStandardDiscount,
  discountedTotalCents,
  checkDiscountWrite,
} from '../src/orders/discounts.js'

describe('STANDARD_DISCOUNT_TIERS', () => {
  it('is exactly the 0/5/10 the requirement names, frozen', () => {
    expect(STANDARD_DISCOUNT_TIERS).toEqual([0, 5, 10])
    expect(Object.isFrozen(STANDARD_DISCOUNT_TIERS)).toBe(true)
  })
})

describe('isStandardDiscount', () => {
  it('accepts each tier as a number', () => {
    expect(isStandardDiscount(0)).toBe(true)
    expect(isStandardDiscount(5)).toBe(true)
    expect(isStandardDiscount(10)).toBe(true)
  })

  it('accepts each tier as the pg-numeric string it round-trips as', () => {
    // numeric(5,2) comes back '5.00' — a tier must not stop being standard
    // between the write and the next read.
    expect(isStandardDiscount('0.00')).toBe(true)
    expect(isStandardDiscount('5.00')).toBe(true)
    expect(isStandardDiscount('10.00')).toBe(true)
  })

  it('refuses everything between and beyond the tiers', () => {
    expect(isStandardDiscount(7.5)).toBe(false)
    expect(isStandardDiscount('7.50')).toBe(false)
    expect(isStandardDiscount(15)).toBe(false)
    expect(isStandardDiscount(100)).toBe(false)
  })
})

describe('discountedTotalCents', () => {
  it('takes the discount off the goods and leaves shipping alone', () => {
    // 10,000 at 7.5% off is 9,250 — and the 500 freight is untouched.
    expect(discountedTotalCents(10000, 7.5, 500)).toBe(9750)
  })

  it('is the old subtotal + shipping when the discount is 0', () => {
    expect(discountedTotalCents(50200, 0, 0)).toBe(50200)
    expect(discountedTotalCents(50200, 0, 1500)).toBe(51700)
  })

  it('rounds once, over the whole subtotal, .5 up like Postgres ROUND', () => {
    // 1001 * 0.95 = 950.95 → 951, not 950.
    expect(discountedTotalCents(1001, 5, 0)).toBe(951)
    // 10 * 0.95 = 9.5 → 10: Math.round and pg ROUND both take .5 away from
    // zero for non-negative money, which is the only kind an order holds.
    expect(discountedTotalCents(10, 5, 0)).toBe(10)
  })

  it('coerces the pg-numeric strings every column arrives as', () => {
    expect(discountedTotalCents('10000', '7.50', '500')).toBe(9750)
  })

  it('empties the goods at 100%', () => {
    expect(discountedTotalCents(10000, 100, 500)).toBe(500)
  })
})

describe('checkDiscountWrite', () => {
  const attempt = (input) => () => checkDiscountWrite(input)

  it('lets any back-office user set a standard tier, reason or none', () => {
    expect(attempt({ pct: 5, reason: null, role: 'backoffice' })).not.toThrow()
    expect(attempt({ pct: 10, reason: null, role: 'backoffice' })).not.toThrow()
    // Taking the discount OFF again must never need a director.
    expect(attempt({ pct: 0, reason: null, role: 'backoffice' })).not.toThrow()
  })

  it('403s a non-standard value from a non-director, naming the rule', () => {
    try {
      checkDiscountWrite({ pct: 7.5, reason: 'negotiated', role: 'backoffice' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error.statusCode).toBe(403)
      expect(error.message).toMatch(/director/i)
      expect(error.message).toMatch(/5%/)
    }
  })

  it('422s a director override with no reason — blank and whitespace alike', () => {
    for (const reason of [null, undefined, '', '   ']) {
      try {
        checkDiscountWrite({ pct: 7.5, reason, role: 'director' })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error.statusCode).toBe(422)
        expect(error.message).toMatch(/reason/i)
      }
    }
  })

  it('lets a director set any value once the reason is recorded', () => {
    expect(
      attempt({ pct: 7.5, reason: 'Hutchinson job, agreed 12 Aug', role: 'director' })
    ).not.toThrow()
    expect(attempt({ pct: 12.25, reason: 'clearance', role: 'director' })).not.toThrow()
  })

  it('checks the ROLE, not the route guard — 403 before 422 for an outsider', () => {
    // A non-director with no reason gets the refusal that matters: it is not
    // their missing paperwork, it is their missing authority.
    try {
      checkDiscountWrite({ pct: 7.5, reason: null, role: 'backoffice' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error.statusCode).toBe(403)
    }
  })
})
