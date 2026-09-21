// GST figures are derived from the order total and the Xero basis, never
// stored — one function, pure, so the rounding the CRM prints is the rounding
// the invoice will carry. See src/orders/gst.js.
import { describe, it, expect } from 'vitest'
import { gstFigures, withGst, gstCents, GST_RATE } from '../src/orders/gst.js'

describe('gstFigures', () => {
  it('adds 15% on top of an exclusive total', () => {
    expect(gstFigures(66500, 'Exclusive')).toEqual({
      basis: 'Exclusive',
      rate: GST_RATE,
      gst_cents: 9975,
      total_incl_gst_cents: 76475,
    })
  })

  it('takes the 3/23 share out of an inclusive total', () => {
    const figures = gstFigures(76475, 'Inclusive')
    expect(figures.gst_cents).toBe(9975)
    expect(figures.total_incl_gst_cents).toBe(76475)
  })

  it('is zero under NoTax', () => {
    expect(gstFigures(66500, 'NoTax')).toMatchObject({ gst_cents: 0, total_incl_gst_cents: 66500 })
  })

  it('coerces the pg numeric string and treats null as nothing owed', () => {
    expect(gstFigures('1000', 'Exclusive').gst_cents).toBe(150)
    expect(gstFigures(null, 'Exclusive').gst_cents).toBe(0)
  })

  it('refuses an unknown basis rather than printing a wrong figure', () => {
    expect(() => gstFigures(100, 'Included')).toThrow(/unknown basis/)
  })
})

describe('withGst', () => {
  it('decorates an order and leaves everything else alone', () => {
    expect(withGst({ total_cents: 200 }, 'Exclusive').gst.gst_cents).toBe(30)
    expect(withGst(null, 'Exclusive')).toBeNull()
    expect(withGst({ id: 1 }, 'Exclusive')).toEqual({ id: 1 })
  })
})

describe('gstCents (the checkout write side)', () => {
  it('is 15% in whole cents, half-cents rounding up like Postgres', () => {
    expect(gstCents(10000)).toBe(1500)
    expect(gstCents(1230)).toBe(185) // 184.5 → 185
    expect(gstCents(0)).toBe(0)
    expect(gstCents('20000')).toBe(3000) // pg numeric string
  })

  it('agrees with the Exclusive read-side figure', () => {
    expect(gstCents(66500)).toBe(gstFigures(66500, 'Exclusive').gst_cents)
  })
})
