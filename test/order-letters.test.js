// The order page's on-demand letters (24 Sep 2026) and the standing copy on
// every sales-order letter. Pure: a capture transport and a stub db, no
// database — the route is exercised in test/email.test.js.
import { describe, it, expect } from 'vitest'
import { createMailer } from '../src/email/mailer.js'
import { renderTemplate } from '../src/email/templates.js'
import { notifyOrderTransition } from '../src/email/notifications.js'
import {
  currentStatusTemplate,
  orderDetailsData,
  sendOrderLetter,
} from '../src/email/order-letters.js'
import { gstFigures } from '../src/orders/gst.js'

const COPY = 'jenettec@atelier.test'

const capture = ({ orderCopyEmail = COPY, failFor = [] } = {}) => {
  const sent = []
  const mailer = createMailer({
    transport: {
      sendMail: async (message) => {
        if (failFor.includes(message.to)) throw new Error('relay refused')
        sent.push(message)
      },
    },
    from: 'Atelier <no-reply@test.example>',
    backofficeEmail: 'orders@test.example',
    orderCopyEmail,
  })
  return { sent, mailer }
}

// resolveOrderRecipient never queries for a guest order.
const db = { query: async () => ({ rows: [] }) }

const ORDER = Object.freeze({
  order_number: 'SO-100',
  kind: 'manual',
  status: 'confirmed',
  xero_invoice_ref: 'INV-100',
  guest_email: 'client@test.example',
  user_id: null,
  sales_rep_email: 'rep@atelier.test',
  notify_emails: ['accounts@client.test'],
  client_reference: 'Smith lounge',
  customer_po_number: 'PO-7',
  subtotal_cents: 30000,
  shipping_cents: 2000,
  discount_pct: '10.00',
  // round(30000 * 0.9) + 2000
  total_cents: 29000,
  shipping_address: {
    name: 'Jo Smith',
    line1: '1 Queen St',
    line2: null,
    city: 'Auckland',
    state: null,
    postal_code: '1010',
    country: 'New Zealand',
    phone: '021 555 0100',
    instructions: 'Mark parcel: Lounge',
  },
  lines: [
    {
      sku: 'MC-MAD-02',
      product_name: 'Madina',
      colourway_name: 'Jade',
      qty: '3.00',
      unit: 'metres',
      unit_price_cents: 10000,
      cut_requirements: '2 x 1.5m',
    },
  ],
})

describe('the standing copy (ORDER_COPY_EMAIL)', () => {
  it('is copied last on every status letter, after client, rep and list', async () => {
    const { sent, mailer } = capture()
    await notifyOrderTransition(mailer, db, ORDER)
    expect(sent.map((m) => m.to)).toEqual([
      'client@test.example',
      'rep@atelier.test',
      'accounts@client.test',
      COPY,
    ])
  })

  it('gets one letter when she is also the rep', async () => {
    const { sent, mailer } = capture()
    await notifyOrderTransition(mailer, db, { ...ORDER, sales_rep_email: 'JenetteC@Atelier.test' })
    expect(sent.map((m) => m.to)).toEqual([
      'client@test.example',
      'JenetteC@Atelier.test',
      'accounts@client.test',
    ])
  })

  it('is nobody when unset — an empty ORDER_COPY_EMAIL turns it off', async () => {
    const { sent, mailer } = capture({ orderCopyEmail: '' })
    expect(mailer.orderCopyEmail).toBeNull()
    await notifyOrderTransition(mailer, db, ORDER)
    expect(sent.map((m) => m.to)).not.toContain(COPY)
    expect(sent).toHaveLength(3)
  })
})

describe('currentStatusTemplate — what "Resend" sends', () => {
  it('re-sends the letter for where the order stands', () => {
    expect(currentStatusTemplate({ status: 'requested', kind: 'manual' })).toBe('order_confirmed')
    expect(currentStatusTemplate({ status: 'requested', kind: 'order_request' })).toBe('request_received')
    expect(currentStatusTemplate({ status: 'requested', kind: 'backorder_request' })).toBe('request_received')
    expect(currentStatusTemplate({ status: 'confirmed', kind: 'manual' })).toBe('order_invoiced')
    expect(currentStatusTemplate({ status: 'paid', kind: 'checkout' })).toBe('payment_received')
    expect(currentStatusTemplate({ status: 'shipped', kind: 'manual' })).toBe('shipped')
    expect(currentStatusTemplate({ status: 'declined', kind: 'manual' })).toBe('order_cancelled')
  })
})

describe('the order_details letter', () => {
  const render = (order) => renderTemplate('order_details', orderDetailsData(order))

  it('lists the lines, the discounted totals on the Exclusive basis and the delivery', () => {
    const { subject, text } = render({ ...ORDER, gst: gstFigures(ORDER.total_cents, 'Exclusive') })
    expect(subject).toContain('SO-100')
    expect(text).toContain('Your reference: Smith lounge')
    expect(text).toContain('Your PO number: PO-7')
    expect(text).toContain('- Madina — Jade (MC-MAD-02)')
    expect(text).toContain('3 metres at $100.00 = $300.00')
    expect(text).toContain('Cut: 2 x 1.5m')
    expect(text).toContain('Subtotal: $300.00')
    // The difference the stored total carries, not a recomputation.
    expect(text).toContain('Discount (10%): -$30.00')
    expect(text).toContain('Freight: $20.00')
    expect(text).toContain('Total excl. GST: $290.00')
    expect(text).toContain('GST (15%): $43.50')
    expect(text).toContain('Total incl. GST: $333.50 NZD')
    expect(text).toContain('Deliver to:\nJo Smith\n1 Queen St\nAuckland 1010\nNew Zealand')
    expect(text).toContain('Phone: 021 555 0100')
    expect(text).toContain('Mark parcel: Lounge')
  })

  it('states the total once on the Inclusive and NoTax bases', () => {
    const inclusive = render({ ...ORDER, gst: gstFigures(ORDER.total_cents, 'Inclusive') }).text
    expect(inclusive).toContain('Total incl. GST: $290.00 NZD')
    expect(inclusive).toContain('GST (15%) included: $37.83')
    expect(inclusive).not.toContain('excl. GST')

    const noTax = render({ ...ORDER, gst: gstFigures(ORDER.total_cents, 'NoTax') }).text
    expect(noTax).toContain('Total: $290.00 NZD')
    expect(noTax).not.toContain('GST')
  })

  it('drops what the order does not have rather than printing empty headings', () => {
    const { text } = render({
      ...ORDER,
      client_reference: null,
      customer_po_number: null,
      discount_pct: '0.00',
      shipping_cents: 0,
      total_cents: 30000,
      shipping_address: null,
      gst: gstFigures(30000, 'Exclusive'),
    })
    expect(text).not.toContain('Your reference')
    expect(text).not.toContain('Discount')
    expect(text).not.toContain('Freight')
    expect(text).not.toContain('Deliver to')
  })
})

describe('sendOrderLetter', () => {
  it('sends the details to everyone the order names plus the copy, and says who', async () => {
    const { sent, mailer } = capture()
    const result = await sendOrderLetter(mailer, db, { ...ORDER, gst: gstFigures(29000, 'Exclusive') }, 'details')
    expect(result).toEqual({
      template: 'order_details',
      sent: ['client@test.example', 'rep@atelier.test', 'accounts@client.test', COPY],
      failed: [],
    })
    expect(new Set(sent.map((m) => m.subject))).toEqual(
      new Set(['Atelier Textiles: details of order SO-100'])
    )
  })

  it('re-sends the status letter, and reports an address the relay refused', async () => {
    const { sent, mailer } = capture({ failFor: ['accounts@client.test'] })
    const result = await sendOrderLetter(mailer, db, ORDER, 'status')
    expect(result.template).toBe('order_invoiced')
    expect(result.sent).toEqual(['client@test.example', 'rep@atelier.test', COPY])
    expect(result.failed).toEqual(['accounts@client.test'])
    expect(sent[0].text).toContain('INV-100')
  })
})
