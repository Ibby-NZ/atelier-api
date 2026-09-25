// The purchase-order PDF (25 Sep 2026) — the document the CRM previews before
// Send and the letters attach. Run with NO DATABASE: the renderer is handed
// rows and draws them, which is what lets the preview and the letter share it.

import { describe, it, expect } from 'vitest'
import {
  documentFilename,
  documentTitle,
  documentTotal,
  nzDate,
  renderPurchaseOrderPdf,
} from '../src/purchasing/po-pdf.js'

const line = (id, extra = {}) => ({
  id,
  sku: `PF-${1000 + id}`,
  product_name: 'Galata Linen Velvet',
  colourway_name: 'Ivory',
  qty_ordered: 12.5,
  unit_price: 48.25,
  line_cost: 603.13,
  is_sample: false,
  supplier_code: null,
  notes: null,
  ...extra,
})

const purchaseOrder = (id, lineCount, extra = {}) => ({
  id,
  po_number: `PO-${String(1000 + id).padStart(6, '0')}`,
  brand_name: 'Pierre Frey',
  supplier_name: 'Pierre Frey Paris',
  currency: 'EUR',
  incoterm: 'EXW',
  expected_at: '2026-10-15T00:00:00+13:00',
  created_at: '2026-09-24T22:00:00Z',
  po_email: 'orders@house.example',
  notify_emails: [],
  total_cost: Math.round(603.13 * lineCount * 100) / 100,
  unpriced_lines: 0,
  lines: Array.from({ length: lineCount }, (_, index) => line(index + 1)),
  ...extra,
})

// The finance-masked read model DELETES the money keys rather than nulling them.
const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))
const masked = (po) => ({
  ...without(po, ['total_cost', 'unpriced_lines', 'total_freight']),
  lines: po.lines.map((line) => without(line, ['unit_price', 'line_cost', 'freight_per_unit', 'freight_cost'])),
})

// Page objects are dictionaries outside the compressed content streams, so the
// count survives compression.
const pageCount = (buffer) => (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length

describe('the purchase-order PDF', () => {
  it('draws a purchase order as a PDF', async () => {
    const pdf = await renderPurchaseOrderPdf({
      document: 'order',
      purchaseOrders: [purchaseOrder(1, 3)],
      supplierName: 'Pierre Frey Paris',
      recipients: ['orders@house.example'],
    })
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pageCount(pdf)).toBe(1)
  })

  it('runs a long statement onto further pages', async () => {
    const pdf = await renderPurchaseOrderPdf({
      document: 'statement',
      purchaseOrders: [purchaseOrder(1, 3), purchaseOrder(2, 60, { brand_name: 'Le Manach' })],
      supplierName: 'Pierre Frey Paris',
      replyTo: 'office@atelier.example',
    })
    expect(pageCount(pdf)).toBeGreaterThan(1)
  })

  it('draws the masked view without prices rather than failing', async () => {
    const pdf = await renderPurchaseOrderPdf({
      document: 'order',
      purchaseOrders: [masked(purchaseOrder(1, 2))],
      supplierName: 'Pierre Frey Paris',
    })
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('draws a purchase order with no lines', async () => {
    const pdf = await renderPurchaseOrderPdf({
      document: 'order',
      purchaseOrders: [purchaseOrder(1, 0, { total_cost: 0 })],
    })
    expect(pageCount(pdf)).toBe(1)
  })
})

describe('what the document is called', () => {
  it('names the one PO, the bulk order, or the supplier and the day', () => {
    const issuedAt = new Date('2026-09-24T22:00:00Z') // 25 Sep in Auckland
    expect(documentFilename({ document: 'order', purchaseOrders: [purchaseOrder(1, 1)] })).toBe('PO-001001.pdf')
    expect(
      documentFilename({ document: 'order', purchaseOrders: [purchaseOrder(1, 1), purchaseOrder(2, 1)], reference: 'BULK-000004' })
    ).toBe('BULK-000004.pdf')
    expect(
      documentFilename({
        document: 'statement',
        purchaseOrders: [purchaseOrder(1, 1), purchaseOrder(2, 1)],
        supplierName: 'C&C Milano / Fadini',
        issuedAt,
      })
    ).toBe('Statement-C-C-Milano-Fadini-2026-09-25.pdf')
    expect(documentTitle('order', 1)).toBe('Purchase order')
    expect(documentTitle('order', 2)).toBe('Purchase orders')
    expect(documentTitle('statement', 1)).toBe('Statement')
  })

  it('dates on the New Zealand calendar day', () => {
    expect(nzDate('2026-09-24T22:00:00Z')).toMatch(/^25 Sept? 2026$/)
    expect(nzDate(null)).toBeNull()
    expect(nzDate('not a date')).toBeNull()
  })
})

describe('the total across several purchase orders', () => {
  it('adds them in one currency', () => {
    expect(documentTotal([purchaseOrder(1, 1), purchaseOrder(2, 2)])).toEqual({
      total: 1809.39,
      currency: 'EUR',
      reason: null,
    })
  })

  // A sum that skipped the unpriced order would state a figure nobody can
  // stand behind; euros and pounds do not add.
  it('refuses to total an unpriced order or two currencies, and says why', () => {
    const unpriced = documentTotal([purchaseOrder(1, 1), purchaseOrder(2, 1, { total_cost: null, unpriced_lines: 1 })])
    expect(unpriced.total).toBeNull()
    expect(unpriced.reason).toMatch(/unpriced/)
    const mixed = documentTotal([purchaseOrder(1, 1), purchaseOrder(2, 1, { currency: 'GBP' })])
    expect(mixed.total).toBeNull()
    expect(mixed.reason).toMatch(/currencies/)
  })
})
