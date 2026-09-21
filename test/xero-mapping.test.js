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
  contactForTradeAccount,
  contactForSupplier,
  contactDetailsFromXero,
  billForPurchaseOrder,
  isDeadInXero,
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
    ).toEqual({ invoiceId: 'abc', invoiceNumber: 'INV-0042', status: null })
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

describe('contactForTradeAccount / contactForSupplier', () => {
  it('shapes a company as a customer with its street address', () => {
    expect(
      contactForTradeAccount({
        legacy_customer_name: 'Zomia Interiors',
        email: 'accounts@zomia.example',
        phone: '09 555 0100',
        address: '1 Quay St',
        city: 'Auckland',
        country: 'New Zealand',
      })
    ).toEqual({
      Name: 'Zomia Interiors',
      EmailAddress: 'accounts@zomia.example',
      IsCustomer: true,
      Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '09 555 0100' }],
      Addresses: [
        { AddressType: 'STREET', AddressLine1: '1 Quay St', City: 'Auckland', Country: 'New Zealand' },
      ],
    })
  })

  it('omits what we do not hold', () => {
    expect(contactForTradeAccount({ legacy_customer_name: 'Bare Co' })).toEqual({
      Name: 'Bare Co',
      IsCustomer: true,
    })
  })

  it('shapes a supplier with IsSupplier, its ordering email and currency', () => {
    expect(
      contactForSupplier({ name: 'Maison Test', po_email: 'orders@maison.example', currency: 'EUR' })
    ).toEqual({
      Name: 'Maison Test',
      EmailAddress: 'orders@maison.example',
      IsSupplier: true,
      DefaultCurrency: 'EUR',
    })
  })
})

describe('contactDetailsFromXero', () => {
  it('reads the street address, default phone and flags', () => {
    expect(
      contactDetailsFromXero({
        ContactID: 'c-1',
        Name: 'Zomia Interiors',
        EmailAddress: 'Accounts@Zomia.Example',
        IsCustomer: true,
        IsSupplier: false,
        DefaultCurrency: 'NZD',
        Phones: [
          { PhoneType: 'MOBILE', PhoneNumber: '021 000' },
          { PhoneType: 'DEFAULT', PhoneCountryCode: '64', PhoneAreaCode: '9', PhoneNumber: '5550100' },
        ],
        Addresses: [
          { AddressType: 'POBOX', AddressLine1: 'PO Box 1' },
          { AddressType: 'STREET', AddressLine1: '1 Quay St', AddressLine2: 'Level 2', City: 'Auckland', Country: 'New Zealand' },
        ],
      })
    ).toEqual({
      xero_contact_id: 'c-1',
      name: 'Zomia Interiors',
      email: 'accounts@zomia.example',
      phone: '64 9 5550100',
      address: '1 Quay St, Level 2',
      city: 'Auckland',
      country: 'New Zealand',
      is_customer: true,
      is_supplier: false,
      currency: 'NZD',
    })
  })

  it('falls back to POBOX and any phone, and nulls what is blank', () => {
    const details = contactDetailsFromXero({
      ContactID: 'c-2',
      Name: '  ',
      Phones: [{ PhoneType: 'MOBILE', PhoneNumber: '021 000' }, { PhoneType: 'DEFAULT', PhoneNumber: '' }],
      Addresses: [{ AddressType: 'STREET' }, { AddressType: 'POBOX', AddressLine1: 'PO Box 1', City: 'Nelson' }],
    })
    expect(details).toMatchObject({
      name: null,
      email: null,
      phone: '021 000',
      address: 'PO Box 1',
      city: 'Nelson',
      country: null,
      is_customer: false,
      is_supplier: false,
    })
  })
})

describe('billForPurchaseOrder', () => {
  const purchaseOrder = {
    po_number: 'PO-000123',
    currency: 'EUR',
    sent_at: '2026-03-01T22:00:00.000Z',
    lines: [
      {
        product_name: 'Linen',
        colourway_name: 'Clay',
        sku: 'LIN-CLAY',
        qty_ordered: 12.5,
        unit_price: 48.25,
        is_sample: false,
        supplier_code: 'L-01',
      },
      {
        product_name: 'Linen',
        colourway_name: 'Moss',
        sku: 'LIN-MOSS',
        qty_ordered: 1,
        unit_price: 0.5,
        is_sample: true,
        supplier_code: null,
      },
    ],
  }

  it('builds an ACCPAY bill dated the day it went to the house, numbered by our PO', () => {
    const bill = billForPurchaseOrder(purchaseOrder, {
      contactId: 'sup-1',
      accountCode: '300',
      lineAmountTypes: 'Exclusive',
      status: 'DRAFT',
      dueDays: 30,
    })
    expect(bill).toEqual({
      Type: 'ACCPAY',
      Contact: { ContactID: 'sup-1' },
      Status: 'DRAFT',
      LineAmountTypes: 'Exclusive',
      Date: '2026-03-01',
      DueDate: '2026-03-31',
      InvoiceNumber: 'PO-000123',
      Reference: 'PO-000123',
      CurrencyCode: 'EUR',
      LineItems: [
        {
          Description: 'Linen — Clay (LIN-CLAY). Supplier code L-01',
          Quantity: 12.5,
          UnitAmount: 48.25,
          AccountCode: '300',
        },
        { Description: 'Linen — Moss (LIN-MOSS). Sample', Quantity: 1, UnitAmount: 0.5, AccountCode: '300' },
      ],
    })
  })

  it('dates an unsent order today', () => {
    const bill = billForPurchaseOrder(
      { ...purchaseOrder, sent_at: null, currency: null },
      { contactId: 'x', accountCode: '300', lineAmountTypes: 'Exclusive', status: 'DRAFT', dueDays: 0, now: () => new Date('2026-05-05T03:00:00Z') }
    )
    expect(bill.Date).toBe('2026-05-05')
    expect(bill.DueDate).toBe('2026-05-05')
    expect(bill).not.toHaveProperty('CurrencyCode')
  })
})

describe('isDeadInXero', () => {
  it('is true only for VOIDED and DELETED', () => {
    expect(isDeadInXero('VOIDED')).toBe(true)
    expect(isDeadInXero('DELETED')).toBe(true)
    expect(isDeadInXero('PAID')).toBe(false)
    expect(isDeadInXero(null)).toBe(false)
  })
})
