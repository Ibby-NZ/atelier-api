// Pure mapping rules (src/xero/mapping.js) — no database, no network. This
// is the suite that proves the money translation, so every rounding claim
// made in the module lives here as an assertion.
import { describe, it, expect } from 'vitest'
import {
  centsToAmount,
  isoDay,
  addDays,
  contactForUser,
  lineItemForOrderLine,
  invoiceForOrder,
  itemForColourway,
  pickInvoice,
  pickContact,
  matchContact,
} from '../src/xero/mapping.js'
import { discountedTotalCents } from '../src/orders/discounts.js'

describe('centsToAmount', () => {
  it('is exact for awkward integer cents', () => {
    // 1999 / 100 in raw floating point is 19.990000000000002.
    expect(centsToAmount(1999)).toBe(19.99)
    expect(centsToAmount(1)).toBe(0.01)
    expect(centsToAmount(0)).toBe(0)
    expect(centsToAmount(123456789)).toBe(1234567.89)
  })

  it('coerces the pg-numeric string form', () => {
    expect(centsToAmount('2500')).toBe(25)
  })
})

describe('contactForUser', () => {
  it('uses the name, carrying the email', () => {
    expect(contactForUser({ name: 'Zomia Interiors', email: 'studio@zomia.example' })).toEqual({
      Name: 'Zomia Interiors',
      EmailAddress: 'studio@zomia.example',
    })
  })

  it('falls back to the email as the name and omits an absent email', () => {
    expect(contactForUser({ name: '', email: 'guest@example.com' }).Name).toBe('guest@example.com')
    expect(contactForUser({ name: 'Walk In', email: null })).toEqual({ Name: 'Walk In' })
  })
})

describe('lineItemForOrderLine', () => {
  it('describes the goods and never computes a LineAmount', () => {
    const line = lineItemForOrderLine(
      {
        product_name: 'Alpine Meadow',
        sku: 'AM-CLAY-01',
        qty: '12.50',
        unit_price_cents: 18950,
        cut_requirements: 'two drops of 3.1m',
      },
      { accountCode: '200' }
    )
    expect(line).toEqual({
      Description: 'Alpine Meadow — AM-CLAY-01. Cut: two drops of 3.1m',
      Quantity: 12.5,
      UnitAmount: 189.5,
      AccountCode: '200',
    })
    expect(line.LineAmount).toBeUndefined()
  })

  it('leaves cut requirements off when there are none', () => {
    const line = lineItemForOrderLine(
      { product_name: 'Harbour', sku: 'H-1', qty: 1, unit_price_cents: 100 },
      { accountCode: '200' }
    )
    expect(line.Description).toBe('Harbour — H-1')
  })

  it('applies the order discount as a DiscountRate, and omits it at 0', () => {
    const line = { product_name: 'Harbour', sku: 'H-1', qty: 1, unit_price_cents: 100 }
    // pg hands discount_pct back as a numeric string.
    expect(lineItemForOrderLine(line, { accountCode: '200', discountPct: '5.00' }).DiscountRate).toBe(5)
    expect(lineItemForOrderLine(line, { accountCode: '200', discountPct: 0 })).not.toHaveProperty(
      'DiscountRate'
    )
    expect(lineItemForOrderLine(line, { accountCode: '200' })).not.toHaveProperty('DiscountRate')
  })
})

describe('invoiceForOrder', () => {
  const now = () => new Date('2026-08-24T02:00:00Z')
  const base = {
    lines: [{ product_name: 'Harbour', sku: 'H-1', qty: 10, unit_price_cents: 5000 }],
    shipping_cents: 0,
  }
  const opts = {
    contactId: 'contact-1',
    accountCode: '200',
    lineAmountTypes: 'Exclusive',
    status: 'AUTHORISED',
    dueDays: 30,
    now,
  }

  it('builds an AUTHORISED ACCREC with explicit Date and DueDate', () => {
    const invoice = invoiceForOrder(base, opts)
    expect(invoice.Type).toBe('ACCREC')
    expect(invoice.Contact).toEqual({ ContactID: 'contact-1' })
    expect(invoice.Status).toBe('AUTHORISED')
    expect(invoice.LineAmountTypes).toBe('Exclusive')
    expect(invoice.Date).toBe('2026-08-24')
    expect(invoice.DueDate).toBe('2026-09-23')
    expect(invoice.LineItems).toHaveLength(1)
  })

  it('adds shipping as its own line only when charged', () => {
    const invoice = invoiceForOrder(
      { ...base, shipping_cents: 1500, shipping_zone: 'south-island' },
      opts
    )
    expect(invoice.LineItems).toHaveLength(2)
    expect(invoice.LineItems[1]).toEqual({
      Description: 'Freight & handling (south-island)',
      Quantity: 1,
      UnitAmount: 15,
      AccountCode: '200',
    })
    expect(invoiceForOrder(base, opts).LineItems).toHaveLength(1)
  })

  // A discounted order used to invoice at full price: the mapping ignored
  // `discount_pct`. The discount is off the goods, never the freight, and on a
  // fixture where no rounding can intervene Xero's arithmetic must land on
  // exactly the platform's `total_cents`.
  it('discounts every goods line but never the freight line', () => {
    const invoice = invoiceForOrder(
      { ...base, discount_pct: '10.00', shipping_cents: 1500 },
      opts
    )
    const [goods, freight] = invoice.LineItems
    expect(goods.DiscountRate).toBe(10)
    expect(freight.DiscountRate).toBeUndefined()
    const xeroTotal =
      goods.Quantity * goods.UnitAmount * (1 - goods.DiscountRate / 100) +
      freight.Quantity * freight.UnitAmount
    expect(xeroTotal).toBe(discountedTotalCents(50000, 10, 1500) / 100)
  })

  it("carries the client's PO number as the Reference, falling back to their reference", () => {
    expect(invoiceForOrder({ ...base, customer_po_number: 'PO-77' }, opts).Reference).toBe('PO-77')
    expect(invoiceForOrder({ ...base, client_reference: 'Job 12' }, opts).Reference).toBe('Job 12')
    expect(
      invoiceForOrder({ ...base, customer_po_number: 'PO-77', client_reference: 'Job 12' }, opts)
        .Reference
    ).toBe('PO-77')
    expect(invoiceForOrder(base, opts).Reference).toBeUndefined()
  })
})

describe('itemForColourway', () => {
  it('keys on the SKU and truncates to Xero limits', () => {
    const item = itemForColourway({
      sku: 'A'.repeat(40),
      product_name: 'P'.repeat(40),
      colourway_name: 'C'.repeat(40),
    })
    expect(item.Code).toHaveLength(30)
    expect(item.Name).toHaveLength(50)
    expect(item.IsSold).toBe(true)
  })
})

describe('response picking', () => {
  it('picks the invoice id and number', () => {
    expect(
      pickInvoice({ Invoices: [{ InvoiceID: 'abc', InvoiceNumber: 'INV-0042' }] })
    ).toEqual({ invoiceId: 'abc', invoiceNumber: 'INV-0042' })
    expect(pickInvoice({ Invoices: [] })).toBeNull()
    expect(pickInvoice(null)).toBeNull()
  })

  it('picks the contact id', () => {
    expect(pickContact({ Contacts: [{ ContactID: 'c-1' }] })).toBe('c-1')
    expect(pickContact({})).toBeNull()
  })
})

describe('matchContact', () => {
  const contacts = [
    { ContactID: 'by-email', Name: 'Different Name', EmailAddress: 'Studio@Zomia.example' },
    { ContactID: 'by-name', Name: 'Zomia Interiors', EmailAddress: 'other@example.com' },
  ]

  it('prefers the email match over the name match, case-insensitively', () => {
    expect(
      matchContact(contacts, { email: 'studio@zomia.example', name: 'Zomia Interiors' })
    ).toBe('by-email')
  })

  it('falls back to an exact name match and otherwise null', () => {
    expect(matchContact(contacts, { email: 'none@example.com', name: 'zomia interiors' })).toBe(
      'by-name'
    )
    expect(matchContact(contacts, { email: 'none@example.com', name: 'Nobody' })).toBeNull()
    expect(matchContact([], { email: 'a@b.c', name: 'x' })).toBeNull()
  })
})

describe('date helpers', () => {
  it('formats a day and adds days across a month boundary', () => {
    const day = new Date('2026-01-31T12:00:00Z')
    expect(isoDay(day)).toBe('2026-01-31')
    expect(isoDay(addDays(day, 1))).toBe('2026-02-01')
  })
})
