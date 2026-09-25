// The purchase order as a PDF (25 Sep 2026, the client: "a preview ability for
// purchase orders before sending it — generate statement creates a PDF,
// attaches that PDF and sends it as an email").
//
// ONE RENDERER, TWO DOCUMENTS, and the preview and the letter share it:
//   - `order`     — the purchase order itself (one, or every member of a bulk
//                   order), attached to Send PO and to the bulk letter;
//   - `statement` — the office asking the house for ONE invoice covering the
//                   purchase orders named, attached to the statement letter.
// The CRM's preview is this same function over the same rows, so what the
// office reads before pressing Send is what the house receives.
//
// PURE: no pool, no config, no I/O beyond pdfkit writing into memory. The
// caller loads the rows (src/purchasing/invoice-statements.js) and decides the
// finance view; this file only draws what it is handed.
//
// PRICES ARE DRAWN ONLY WHEN THE ROWS CARRY THEM. The finance-masked view
// DELETES `unit_price`, `line_cost` and `total_cost` rather than nulling them
// (src/purchasing/CLAUDE.md), so their ABSENCE means "not for this reader" and
// the price columns are left off entirely — a preview opened by a login
// without the grant says so instead of printing blanks that read as "free".
// `null` is still "nobody has priced this line", and prints as such. The copy
// the HOUSE receives is always rendered from the finance view: it quoted those
// prices.

import { PDFDocument } from 'pdfkit'

export const PDF_DOCUMENTS = Object.freeze(['order', 'statement'])

// The letterhead the CRM's packing slip carries (atelier-crm
// src/utils/orderPackingSlip.js COMPANY) — one company, one address.
export const COMPANY = Object.freeze({
  name: 'Atelier Textiles Limited',
  lines: Object.freeze(['PO Box 5017', 'Victoria Street West', 'Auckland', 'New Zealand']),
  phone: '+64 9 373 3866',
  email: 'enquiries@atelier.co.nz',
  web: 'atelier.co.nz',
})

const INK = '#33312b'
const SOFT = '#6b675e'
const RULE = '#d9d4c9'
const BAND = '#f3f0ea'

const PAGE_MARGIN = 48
const FOOTER_SPACE = 28

const NZ_DAY = new Intl.DateTimeFormat('en-NZ', {
  timeZone: 'Pacific/Auckland',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

/**
 * A timestamp as the New Zealand calendar day ("25 Sep 2026"), or null. Never
 * a slice of the ISO string: that is the UTC day, a day early for anything
 * before noon in Auckland.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
export const nzDate = (value) => {
  if (value == null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : NZ_DAY.format(date)
}

const hasPrices = (purchaseOrders) =>
  purchaseOrders.length > 0 && purchaseOrders.every((po) => Object.hasOwn(po, 'total_cost'))

/** Two to four places — `unit_price` is numeric(12,4) in the supplier's currency. */
const unitPriceText = (value) =>
  value == null
    ? 'Not priced'
    : Number(value).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 4 })

const moneyText = (value, currency = null) =>
  value == null
    ? null
    : `${Number(value).toLocaleString('en-NZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${
        currency ? ` ${currency}` : ''
      }`

const qtyText = (value) => (value == null ? '—' : String(Number(value)))

/**
 * What the document is called, on its own first line and in the file name.
 *
 * @param {'order'|'statement'} document
 * @param {number} count how many purchase orders it carries
 */
export const documentTitle = (document, count) =>
  document === 'statement'
    ? 'Statement'
    : count === 1
      ? 'Purchase order'
      : 'Purchase orders'

/**
 * The file name the letter attaches and the CRM downloads: the one PO number,
 * or the bulk number, or the supplier and the day. Only characters every mail
 * client and file system accepts.
 *
 * @param {{ document: 'order'|'statement', purchaseOrders: Array<{ po_number: string }>,
 *           reference?: string|null, supplierName?: string|null, issuedAt?: Date }} input
 * @returns {string}
 */
export const documentFilename = ({ document, purchaseOrders = [], reference = null, supplierName = null, issuedAt = new Date() }) => {
  const safe = (text) =>
    String(text ?? '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(issuedAt)
  const subject =
    reference ??
    (purchaseOrders.length === 1 ? purchaseOrders[0].po_number : `${safe(supplierName) || 'supplier'}-${day}`)
  const stem = document === 'statement' ? `Statement-${safe(subject)}` : safe(subject)
  return `${stem || 'purchase-order'}.pdf`
}

/**
 * The total across several purchase orders, or why there is none: a sum that
 * silently skipped an unpriced order would state a figure the office cannot
 * stand behind, and adding euros to pounds states nothing.
 *
 * @param {object[]} purchaseOrders the finance view
 * @returns {{ total: number|null, currency: string|null, reason: string|null }}
 */
export const documentTotal = (purchaseOrders = []) => {
  const currencies = [...new Set(purchaseOrders.map((po) => po.currency ?? null))]
  const currency = currencies.length === 1 ? currencies[0] : null
  const unpriced = purchaseOrders.filter((po) => po.total_cost == null).length
  if (unpriced > 0) {
    return {
      total: null,
      currency,
      reason: `Not totalled — ${unpriced} purchase order${unpriced === 1 ? ' has' : 's have'} unpriced lines.`,
    }
  }
  if (currencies.length > 1) {
    return { total: null, currency: null, reason: 'Not totalled — the purchase orders are in different currencies.' }
  }
  const total = purchaseOrders.reduce((sum, po) => sum + Number(po.total_cost), 0)
  return { total: Math.round(total * 100) / 100, currency, reason: null }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const bottomOf = (doc) => doc.page.height - doc.page.margins.bottom - FOOTER_SPACE

// Room for `height` more points on this page, or a fresh page (and whatever
// the caller redraws at its head — a table repeats its header row).
const ensureRoom = (doc, height, onNewPage = null) => {
  if (doc.y + height <= bottomOf(doc)) return
  doc.addPage()
  onNewPage?.()
}

const rule = (doc, y = doc.y, color = RULE) => {
  doc
    .moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.6)
    .strokeColor(color)
    .stroke()
}

const drawLetterhead = (doc, { title, facts }) => {
  const left = doc.page.margins.left
  const right = doc.page.width - doc.page.margins.right
  const top = doc.page.margins.top

  doc.font('Helvetica-Bold').fontSize(17).fillColor(INK)
  doc.text('ATELIER', left, top, { characterSpacing: 4, lineBreak: false })
  doc.font('Helvetica').fontSize(8).fillColor(SOFT)
  doc.text('TEXTILES', left, top + 21, { characterSpacing: 3.2, lineBreak: false })
  doc.fontSize(8.5).fillColor(SOFT)
  doc.text([COMPANY.name, ...COMPANY.lines, `${COMPANY.phone} · ${COMPANY.email}`].join('\n'), left, top + 40, {
    width: 220,
    lineGap: 1.5,
  })
  const leftBottom = doc.y

  const factsX = right - 230
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
  doc.text(title, factsX, top, { width: 230, align: 'right' })
  let y = doc.y + 8
  for (const [label, value] of facts) {
    if (value == null || value === '') continue
    doc.font('Helvetica').fontSize(8.5).fillColor(SOFT)
    doc.text(label, factsX, y, { width: 90, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
    doc.text(String(value), factsX + 90, y, { width: 140, align: 'right' })
    y = doc.y + 3
  }
  doc.y = Math.max(leftBottom, y) + 16
  rule(doc)
  doc.y += 14
}

const drawParagraph = (doc, text, { size = 9.5, color = INK, gap = 10 } = {}) => {
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  doc.font('Helvetica').fontSize(size).fillColor(color)
  ensureRoom(doc, doc.heightOfString(text, { width, lineGap: 2 }))
  doc.text(text, left, doc.y, { width, lineGap: 2 })
  doc.y += gap
}

// The columns of a line table. Price columns only when the rows carry prices.
const lineColumns = (doc, prices) => {
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const fixed = prices
    ? [
        { key: 'index', label: '#', width: 20, align: 'left' },
        { key: 'sku', label: 'Our code', width: 92, align: 'left' },
        { key: 'qty', label: 'Qty', width: 44, align: 'right' },
        { key: 'unit', label: 'Unit price', width: 70, align: 'right' },
        { key: 'total', label: 'Line total', width: 76, align: 'right' },
      ]
    : [
        { key: 'index', label: '#', width: 20, align: 'left' },
        { key: 'sku', label: 'Our code', width: 110, align: 'left' },
        { key: 'qty', label: 'Qty', width: 60, align: 'right' },
      ]
  const descriptionWidth = width - fixed.reduce((sum, column) => sum + column.width, 0) - 8 * fixed.length
  const ordered = [fixed[0], fixed[1], { key: 'description', label: 'Description', width: descriptionWidth, align: 'left' }, ...fixed.slice(2)]
  let x = left
  return ordered.map((column) => {
    const placed = { ...column, x }
    x += column.width + 8
    return placed
  })
}

const drawTableHeader = (doc, columns) => {
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const y = doc.y
  doc.rect(left, y, width, 16).fill(BAND)
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(SOFT)
  for (const column of columns) {
    doc.text(column.label.toUpperCase(), column.x, y + 5, {
      width: column.width,
      align: column.align,
      characterSpacing: 0.4,
      lineBreak: false,
    })
  }
  doc.y = y + 20
}

const lineDescription = (line) =>
  [
    [line.product_name, line.colourway_name].filter(Boolean).join(' / '),
    line.supplier_code ? `Your reference: ${line.supplier_code}` : null,
    line.is_sample ? 'Sample / cutting for our library' : null,
    line.notes ? `Note: ${line.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n')

// A table that runs onto a new page repeats its header row, under a line
// saying whose rows these are.
const drawContinued = (doc, columns, continued) => {
  if (continued) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SOFT)
    doc.text(`${continued} (continued)`, doc.page.margins.left, doc.y)
    doc.y += 4
  }
  drawTableHeader(doc, columns)
}

const drawLineRow = (doc, columns, cells, continued = null) => {
  doc.font('Helvetica').fontSize(8.5)
  const heights = columns.map((column) =>
    doc.heightOfString(String(cells[column.key] ?? ''), { width: column.width, lineGap: 1.5 })
  )
  const height = Math.max(...heights) + 8
  ensureRoom(doc, height, () => drawContinued(doc, columns, continued))
  const y = doc.y
  for (const column of columns) {
    doc
      .font(['sku', 'qty', 'unit', 'total'].includes(column.key) ? 'Courier' : 'Helvetica')
      .fontSize(8.5)
      .fillColor(cells.muted?.includes(column.key) ? SOFT : INK)
    doc.text(String(cells[column.key] ?? ''), column.x, y, {
      width: column.width,
      align: column.align,
      lineGap: 1.5,
    })
  }
  doc.y = y + height - 4
  rule(doc, doc.y)
  doc.y += 4
}

const drawPurchaseOrder = (doc, po, { prices, showHeading }) => {
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const columns = lineColumns(doc, prices)

  if (showHeading) {
    ensureRoom(doc, 60)
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
    doc.text(`${po.po_number}${po.brand_name ? ` · ${po.brand_name}` : ''}`, left, doc.y, { width })
    const details = [
      po.expected_at ? `Required by ${nzDate(po.expected_at)}` : null,
      po.incoterm ? `Incoterm ${po.incoterm}` : null,
      po.currency ? `Currency ${po.currency}` : null,
    ].filter(Boolean)
    if (details.length > 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(SOFT)
      doc.text(details.join('   ·   '), left, doc.y + 2, { width })
    }
    doc.y += 8
  }

  drawTableHeader(doc, columns)
  const lines = po.lines ?? []
  if (lines.length === 0) {
    drawParagraph(doc, 'This purchase order has no lines.', { color: SOFT, size: 8.5 })
  }
  lines.forEach((line, index) => {
    drawLineRow(
      doc,
      columns,
      {
        index: String(index + 1),
        sku: line.sku ?? '',
        description: lineDescription(line),
        qty: qtyText(line.qty_ordered),
        unit: prices ? unitPriceText(line.unit_price) : '',
        total: prices ? (line.line_cost == null ? '—' : moneyText(line.line_cost)) : '',
        muted: prices && line.unit_price == null ? ['unit', 'total'] : [],
      },
      po.po_number
    )
  })

  if (prices) {
    ensureRoom(doc, 22)
    const text =
      po.total_cost == null
        ? `Not totalled — ${po.unpriced_lines} line${po.unpriced_lines === 1 ? '' : 's'} unpriced`
        : `Total ${moneyText(po.total_cost, po.currency)}`
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
    doc.text(text, left, doc.y + 4, { width, align: 'right' })
  }
  doc.y += 18
}

const drawSummary = (doc, purchaseOrders) => {
  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const columns = [
    { key: 'po', label: 'Purchase order', x: left, width: 110, align: 'left' },
    { key: 'house', label: 'House', x: left + 118, width: width - 118 - 196, align: 'left' },
    { key: 'raised', label: 'Raised', x: left + width - 190, width: 80, align: 'left' },
    { key: 'total', label: 'Total', x: left + width - 102, width: 102, align: 'right' },
  ]
  ensureRoom(doc, 60)
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
  doc.text('Summary', left, doc.y, { width })
  doc.y += 6
  drawTableHeader(doc, columns)
  for (const po of purchaseOrders) {
    drawLineRow(
      doc,
      columns,
      {
        po: po.po_number,
        house: po.brand_name ?? '',
        raised: nzDate(po.created_at) ?? '',
        total: po.total_cost == null ? 'Not priced' : moneyText(po.total_cost, po.currency),
        muted: po.total_cost == null ? ['total'] : [],
      },
      'Summary'
    )
  }
  const { total, currency, reason } = documentTotal(purchaseOrders)
  ensureRoom(doc, 22)
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
  doc.text(reason ?? `Total ${moneyText(total, currency)}`, left, doc.y + 4, { width, align: 'right' })
  doc.y += 22
}

const drawFooters = (doc, { generatedOn }) => {
  const range = doc.bufferedPageRange()
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index)
    // Writing inside the bottom margin would make pdfkit start a new page; the
    // margin is lifted for the footer and put back.
    const margin = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    const y = doc.page.height - margin - 10
    const left = doc.page.margins.left
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
    doc.font('Helvetica').fontSize(7.5).fillColor(SOFT)
    doc.text(`${COMPANY.name} · ${COMPANY.web} · ${generatedOn}`, left, y, { width, lineBreak: false })
    doc.text(`Page ${index - range.start + 1} of ${range.count}`, left, y, {
      width,
      align: 'right',
      lineBreak: false,
    })
    doc.page.margins.bottom = margin
  }
}

/**
 * Draw the document into a PDF and resolve to its bytes.
 *
 * @param {{
 *   document: 'order'|'statement',
 *   purchaseOrders: object[],      purchase orders as the read model shapes them, lines included
 *   supplierName?: string|null,    who it is addressed to (the snapshot on the paper)
 *   recipients?: string[],         the addresses it goes to, printed under the name
 *   reference?: string|null,       a bulk order's number, when it is one
 *   replyTo?: string|null,         where the statement asks the invoice to be sent
 *   issuedAt?: Date,
 * }} input
 * @returns {Promise<Buffer>}
 */
export const renderPurchaseOrderPdf = (input) =>
  new Promise((resolve, reject) => {
    const {
      document = 'order',
      purchaseOrders = [],
      supplierName = null,
      recipients = [],
      reference = null,
      replyTo = null,
      issuedAt = new Date(),
    } = input
    const prices = hasPrices(purchaseOrders)
    const title = documentTitle(document, purchaseOrders.length)
    const poNumbers = purchaseOrders.map((po) => po.po_number)
    const currencies = [...new Set(purchaseOrders.map((po) => po.currency).filter(Boolean))]

    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: `${title}${poNumbers.length ? ` — ${reference ?? poNumbers.join(', ')}` : ''}`,
        Author: COMPANY.name,
      },
    })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    try {
      drawLetterhead(doc, {
        title,
        facts: [
          ['Date', nzDate(issuedAt)],
          [reference ? 'Order' : poNumbers.length === 1 ? 'Our PO' : 'Our POs', reference ?? (poNumbers.length <= 3 ? poNumbers.join(', ') : `${poNumbers.length} purchase orders`)],
          ['Currency', currencies.length === 1 ? currencies[0] : null],
        ],
      })

      const left = doc.page.margins.left
      doc.font('Helvetica').fontSize(8).fillColor(SOFT).text('TO', left, doc.y, { characterSpacing: 0.6 })
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(supplierName ?? 'The supplier', left, doc.y + 2)
      if (recipients.length > 0) {
        doc.font('Helvetica').fontSize(8.5).fillColor(SOFT).text(recipients.join(', '), left, doc.y + 1)
      }
      doc.y += 14

      if (document === 'statement') {
        drawParagraph(
          doc,
          `Please issue ONE consolidated invoice covering the ${purchaseOrders.length === 1 ? 'purchase order' : `${purchaseOrders.length} purchase orders`} below, ` +
            'quoting our purchase-order numbers so we can match it' +
            (replyTo ? `, and send it to ${replyTo}.` : '.') +
            ' If any of them has already been invoiced, please tell us which.'
        )
      } else if (reference || purchaseOrders.length > 1) {
        drawParagraph(
          doc,
          `This order covers our purchase orders ${poNumbers.join(', ')}. Please ship and invoice against each PO number.`
        )
      }
      if (!prices) {
        drawParagraph(
          doc,
          'Prices are not shown here because this login cannot see costs. The copy the house receives carries them.',
          { size: 8.5, color: SOFT }
        )
      }

      if (document === 'statement' || purchaseOrders.length > 1) {
        if (prices) drawSummary(doc, purchaseOrders)
      }
      for (const po of purchaseOrders) {
        drawPurchaseOrder(doc, po, { prices, showHeading: true })
      }

      drawParagraph(
        doc,
        document === 'statement'
          ? 'Thank you — please contact us if anything on this statement does not match your records.'
          : `Please confirm receipt of this order with your expected dispatch date, and quote our PO number${
              poNumbers.length === 1 ? '' : 's'
            } on your invoice and packing list.`,
        { size: 9, color: SOFT }
      )

      drawFooters(doc, { generatedOn: `Issued ${nzDate(issuedAt)}` })
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
