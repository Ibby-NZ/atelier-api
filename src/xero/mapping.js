// Pure translation between platform shapes and Xero shapes. No I/O, no pool,
// no fetch — this is the module the local test suite can prove without a
// database, so every money and truncation rule lives HERE and nowhere else.
//
// MONEY: the platform stores integer cents; Xero takes decimal dollars.
// cents / 100 is exact in binary for the integers we hold? No — 0.1 famously
// isn't. So the division goes through toFixed(2) and back, which is exact for
// any integer-cents input and keeps 1999 from becoming 19.990000000000002 in
// the JSON. Line totals are XERO'S job — we send Quantity and UnitAmount and
// never a computed LineAmount, so the two systems cannot disagree about
// rounding.
//
// XERO FIELD LIMITS that bite: Items.Code <= 30 chars, Items.Name <= 50,
// Contacts.Name <= 255 and UNIQUE per org. SKUs are staff-typed (no length
// rule of ours), so the item mapping truncates and says so.

export const centsToAmount = (cents) => Number((Number(cents) / 100).toFixed(2))

const truncate = (value, max) => {
  const s = String(value ?? '').trim()
  return s.length > max ? s.slice(0, max) : s
}

/** 'YYYY-MM-DD' for a Date — Xero's date-only fields take exactly this. */
export const isoDay = (date) => date.toISOString().slice(0, 10)

export const addDays = (date, days) => new Date(date.getTime() + days * 86400000)

/**
 * A platform user as a Xero Contact payload. Name is Xero's identity key
 * (unique per org), so the caller matches before creating; this shape is
 * what gets created when no match exists.
 */
export const contactForUser = ({ name, email }) => ({
  Name: truncate(name || email, 255),
  ...(email ? { EmailAddress: email } : {}),
})

const phoneBlock = (phone) =>
  phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: truncate(phone, 50) }] } : {}

const addressBlock = ({ address, city, country }) =>
  address || city || country
    ? {
        Addresses: [
          {
            AddressType: 'STREET',
            ...(address ? { AddressLine1: truncate(address, 500) } : {}),
            ...(city ? { City: truncate(city, 255) } : {}),
            ...(country ? { Country: truncate(country, 50) } : {}),
          },
        ],
      }
    : {}

/**
 * A client company (trade_accounts row) as a Xero Contact. The company is
 * the customer Xero invoices — the login is a person AT the company. The
 * STREET address is what prints on the invoice.
 */
export const contactForTradeAccount = (account) => ({
  Name: truncate(account.legacy_customer_name, 255),
  ...(account.email ? { EmailAddress: account.email } : {}),
  IsCustomer: true,
  ...phoneBlock(account.phone),
  ...addressBlock(account),
})

/**
 * A supplier as a Xero Contact flagged IsSupplier, so Xero's own Suppliers
 * list and purchases reports see it. `po_email` is the ordering address.
 */
export const contactForSupplier = (supplier) => ({
  Name: truncate(supplier.name, 255),
  ...(supplier.po_email ? { EmailAddress: supplier.po_email } : {}),
  IsSupplier: true,
  ...(supplier.currency ? { DefaultCurrency: supplier.currency } : {}),
  ...phoneBlock(supplier.phone),
  ...addressBlock(supplier),
})

const blankToNull = (value) => {
  const s = String(value ?? '').trim()
  return s ? s : null
}

/**
 * A Xero Contact (full shape, not summaryOnly) as the platform's own contact
 * fields — the pull direction. STREET address first, POBOX as fallback;
 * DEFAULT phone first, any phone as fallback. Every field null when Xero
 * holds nothing, so a caller can fill without blanking.
 */
export const contactDetailsFromXero = (contact) => {
  const addresses = contact?.Addresses ?? []
  const filled = (a) => a && (a.AddressLine1 || a.City)
  const address =
    addresses.find((a) => a?.AddressType === 'STREET' && filled(a)) ??
    addresses.find((a) => a?.AddressType === 'POBOX' && filled(a)) ??
    null
  const phones = contact?.Phones ?? []
  const phone =
    phones.find((p) => p?.PhoneType === 'DEFAULT' && p.PhoneNumber) ??
    phones.find((p) => p?.PhoneNumber) ??
    null
  const lines = [address?.AddressLine1, address?.AddressLine2, address?.AddressLine3, address?.AddressLine4]
  return {
    xero_contact_id: contact?.ContactID ?? null,
    name: blankToNull(contact?.Name),
    email: blankToNull(contact?.EmailAddress)?.toLowerCase() ?? null,
    phone: phone
      ? blankToNull([phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(' '))
      : null,
    address: blankToNull(lines.map(blankToNull).filter(Boolean).join(', ')),
    city: blankToNull(address?.City),
    country: blankToNull(address?.Country),
    is_customer: contact?.IsCustomer === true,
    is_supplier: contact?.IsSupplier === true,
    currency: blankToNull(contact?.DefaultCurrency),
  }
}

/**
 * One order line as a Xero invoice LineItem. The description leads with the
 * design and carries the SKU and any cut requirements — the invoice is what
 * the client's accounts payable reads, so it must identify the goods without
 * a lookup.
 *
 * `discountPct` is `orders.discount_pct`, applied as Xero's own per-line
 * DiscountRate (ACCREC supports it) so the invoice total agrees with
 * `total_cents` — it used to be ignored, and a discounted order invoiced at
 * full price. Xero rounds each line to the cent where `recomputeOrderMoney`
 * rounds the discounted subtotal once, so the two can differ by at most half
 * a cent per goods line; the invoice is the legal figure. Omitted at 0 so an
 * undiscounted line is byte-identical to before.
 */
export const lineItemForOrderLine = (line, { accountCode, discountPct = 0 }) => ({
  Description: [
    `${line.product_name} — ${line.sku}`,
    line.cut_requirements ? `Cut: ${line.cut_requirements}` : null,
  ]
    .filter(Boolean)
    .join('. '),
  Quantity: Number(line.qty),
  UnitAmount: centsToAmount(line.unit_price_cents),
  AccountCode: accountCode,
  ...(Number(discountPct) > 0 ? { DiscountRate: Number(discountPct) } : {}),
})

/**
 * The full ACCREC invoice payload for an admin-shaped order.
 *
 * - Shipping rides as its own line (it is a charge, not a discount, and Xero
 *   has no header-level freight field on invoices). The order discount is
 *   off the goods only (`src/orders/discounts.js`), so the freight line never
 *   carries a DiscountRate.
 * - Reference carries the CLIENT'S number — customer_po_number is the PO they
 *   issued to us, which is exactly what a Reference is for on their remittance;
 *   client_reference is the fallback.
 * - Date/DueDate are explicit because an AUTHORISED invoice must carry both;
 *   `now` is injected so tests don't race midnight.
 */
export const invoiceForOrder = (
  order,
  { contactId, accountCode, lineAmountTypes, status, dueDays, now = () => new Date() }
) => {
  const lineItems = order.lines.map((line) =>
    lineItemForOrderLine(line, { accountCode, discountPct: order.discount_pct })
  )
  const shippingCents = Number(order.shipping_cents ?? 0)
  if (shippingCents > 0) {
    lineItems.push({
      Description: `Freight & handling${order.shipping_zone ? ` (${order.shipping_zone})` : ''}`,
      Quantity: 1,
      UnitAmount: centsToAmount(shippingCents),
      AccountCode: accountCode,
    })
  }
  const today = now()
  return {
    Type: 'ACCREC',
    Contact: { ContactID: contactId },
    LineItems: lineItems,
    Status: status,
    LineAmountTypes: lineAmountTypes,
    Date: isoDay(today),
    DueDate: isoDay(addDays(today, dueDays)),
    ...(order.customer_po_number || order.client_reference
      ? { Reference: order.customer_po_number || order.client_reference }
      : {}),
  }
}

/**
 * The ACCPAY bill for a purchase order (finance-shaped: lines carry
 * `unit_price`, decimal dollars in the house's currency, NOT cents — see
 * src/purchasing/CLAUDE.md). InvoiceNumber is OUR po_number so the bill is
 * findable in Xero before the house's own invoice number replaces it; the
 * Reference carries it too, because InvoiceNumber is the field the
 * accountant overwrites. Date is the day it was sent to the house.
 */
export const billForPurchaseOrder = (
  purchaseOrder,
  { contactId, accountCode, lineAmountTypes, status, dueDays, now = () => new Date() }
) => {
  const sent = purchaseOrder.sent_at ? new Date(purchaseOrder.sent_at) : now()
  return {
    Type: 'ACCPAY',
    Contact: { ContactID: contactId },
    LineItems: purchaseOrder.lines.map((line) => ({
      Description: [
        `${line.product_name} — ${line.colourway_name} (${line.sku})`,
        line.is_sample ? 'Sample' : null,
        line.supplier_code ? `Supplier code ${line.supplier_code}` : null,
      ]
        .filter(Boolean)
        .join('. '),
      Quantity: Number(line.qty_ordered),
      UnitAmount: Number(Number(line.unit_price).toFixed(4)),
      AccountCode: accountCode,
    })),
    Status: status,
    LineAmountTypes: lineAmountTypes,
    Date: isoDay(sent),
    DueDate: isoDay(addDays(sent, dueDays)),
    InvoiceNumber: purchaseOrder.po_number,
    Reference: purchaseOrder.po_number,
    ...(purchaseOrder.currency ? { CurrencyCode: purchaseOrder.currency } : {}),
  }
}

/** Xero's own status words for an ACCREC/ACCPAY invoice, as the pull reads them. */
export const XERO_INVOICE_STATUSES = Object.freeze([
  'DRAFT',
  'SUBMITTED',
  'AUTHORISED',
  'PAID',
  'VOIDED',
  'DELETED',
])

/** A pushed document whose Xero copy is dead — a fresh push is allowed. */
export const isDeadInXero = (status) => status === 'VOIDED' || status === 'DELETED'

/**
 * A Payment against a pushed invoice — what marks it PAID in Xero. `amount`
 * is the invoice's own AmountDue (read back from Xero, never recomputed here,
 * so rounding between our cents and Xero's tax lines can never leave one cent
 * outstanding). `accountCode` must be a BANK account: Xero refuses a payment
 * into a revenue account.
 */
export const paymentForInvoice = ({ invoiceId, accountCode, amount, now = () => new Date() }) => ({
  Invoice: { InvoiceID: invoiceId },
  Account: { Code: accountCode },
  Date: isoDay(now()),
  Amount: amount,
})

/**
 * What the sync stores off a GET /Invoices/:id answer for a bill: Xero's own
 * Status and the day it was fully paid (null until it is).
 */
export const billStateFrom = (invoice) => ({
  status: invoice?.Status ?? null,
  paidAt: invoice?.FullyPaidOnDate ? xeroDate(invoice.FullyPaidOnDate) : null,
})

// Xero's JSON dates are `/Date(1700000000000+0000)/`; ISO also accepted.
const xeroDate = (value) => {
  const ms = /\/Date\((\d+)/.exec(String(value))?.[1]
  const date = ms ? new Date(Number(ms)) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/**
 * A colourway row (joined to its product) as a Xero Item. Code is the SKU —
 * POST /Items upserts on Code, which is what makes the item sync idempotent
 * with no directory fetch.
 */
export const itemForColourway = ({ sku, product_name, colourway_name }) => ({
  Code: truncate(sku, 30),
  Name: truncate(`${product_name} — ${colourway_name}`, 50),
  IsSold: true,
})

/** The created invoice's identifiers out of a POST /Invoices response body. */
export const pickInvoice = (body) => {
  const invoice = body?.Invoices?.[0]
  if (!invoice?.InvoiceID) return null
  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber ?? null,
    status: invoice.Status ?? null,
  }
}

/** The created/updated contact id out of a POST /Contacts response body. */
export const pickContact = (body) => body?.Contacts?.[0]?.ContactID ?? null

/**
 * Exact-match a contact out of a search result: email first (people renames
 * don't move it), then case-insensitive name. Returns a ContactID or null.
 */
export const matchContact = (contacts, { email, name }) => {
  const lower = (v) => String(v ?? '').trim().toLowerCase()
  const wantEmail = lower(email)
  const wantName = lower(name)
  const byEmail = wantEmail
    ? (contacts ?? []).find((c) => lower(c.EmailAddress) === wantEmail)
    : null
  if (byEmail?.ContactID) return byEmail.ContactID
  const byName = wantName ? (contacts ?? []).find((c) => lower(c.Name) === wantName) : null
  return byName?.ContactID ?? null
}
