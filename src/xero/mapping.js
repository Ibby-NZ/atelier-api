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

/**
 * One order line as a Xero invoice LineItem. The description leads with the
 * design and carries the SKU and any cut requirements — the invoice is what
 * the client's accounts payable reads, so it must identify the goods without
 * a lookup.
 */
export const lineItemForOrderLine = (line, { accountCode }) => ({
  Description: [
    `${line.product_name} — ${line.sku}`,
    line.cut_requirements ? `Cut: ${line.cut_requirements}` : null,
  ]
    .filter(Boolean)
    .join('. '),
  Quantity: Number(line.qty),
  UnitAmount: centsToAmount(line.unit_price_cents),
  AccountCode: accountCode,
})

/**
 * The full ACCREC invoice payload for an admin-shaped order.
 *
 * - Shipping rides as its own line (it is a charge, not a discount, and Xero
 *   has no header-level freight field on invoices).
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
  const lineItems = order.lines.map((line) => lineItemForOrderLine(line, { accountCode }))
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
  return { invoiceId: invoice.InvoiceID, invoiceNumber: invoice.InvoiceNumber ?? null }
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
