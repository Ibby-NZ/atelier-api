// Atelier operational + canonical demo data (the spine of the prototype).
// Real catalogue (brands/collections/products + real images) comes from ./realCatalogue.
// This layer maps the demo's recurring entities onto REAL Atelier brands & designs and
// defines orders, the pricing waterfall, samples, reporting, CRM, journal, etc.
// All monetary figures are INDICATIVE.

import { brands as realBrands, collections as realCollections, products as realProducts } from './realCatalogue.js'
import { canonical, tradeUnit, nzd, pricingInputs } from './pricing.js'
import { fxTable, nzdMultiplier, FX_SET_ON } from './fx.js'
import { supplierByName } from './suppliers.js'
import { applyDiscountChain, chainLabel } from './discounts.js'
import { fabricutDesigns } from './fabricutDesigns.js'

export const brands = realBrands
export const collections = realCollections
export const products = realProducts

// ---- asset + lookup helpers -------------------------------------------------
export const asset = (file) => ((import.meta.env && import.meta.env.BASE_URL) || '/') + 'img/' + file
export const findProduct = (sub) => realProducts.find(p => p.name.toLowerCase().includes(sub.toLowerCase())) || null
export const findCollection = (sub) => realCollections.find(c => c.name.toLowerCase().includes(sub.toLowerCase())) || null
export const brandOf = (name) => realBrands.find(b => b.name === name) || { name, currency: 'EUR', country: '' }
const pimg = (sub) => { const p = findProduct(sub); return p ? { img: p.img, src: p.src } : { img: null, src: null } }

// ---- people / geography -----------------------------------------------------
export const team = ['Jenette', 'Rebecca', 'Charlotte', 'Liz']
export const regions = ['Auckland', 'Waikato / BoP', 'Wellington', 'Canterbury', 'Otago / Queenstown']

// `tier` (Discount Logic · D3): Tier 1 clients receive −10%, Tier 2 clients −5%. The tier drives
// the automatic volume discount on qualifying orders (see salesOrder.volumeDiscount).
export const clients = [
  { name: 'McKenzie & Willis', city: 'Christchurch', region: 'Canterbury', type: 'Trade', tier: 1, note: 'Receives price lists in Excel' },
  { name: 'Marlow & Finch Interiors', city: 'Ponsonby, Auckland', region: 'Auckland', type: 'Trade', tier: 1, designer: 'Olivia Marlow', project: 'Hāwera — Master Suite' },
  { name: 'Indigo House Studio', city: 'Wellington', region: 'Wellington', type: 'Trade', tier: 2 },
  { name: 'Coast & Co Design', city: 'Queenstown', region: 'Otago / Queenstown', type: 'Trade', tier: 2 },
  { name: 'Maker Interiors', city: 'Auckland', region: 'Auckland', type: 'Trade', tier: 2 },
]

// Tier → discount rate (D3). Kept next to the clients so pricing and CRM read one definition.
export const clientTiers = {
  1: { label: 'Tier 1', pct: pricingInputs.tiers[0].pct },
  2: { label: 'Tier 2', pct: pricingInputs.tiers[1].pct },
}
export const featuredClient = clients[1]

// ---- hero design (Pricing / Product / Catalogue centrepiece) ----------------
// Maps the demo's "Lumen Velvet" hero onto REAL Pierre Frey · Atlas.
export const hero = {
  brand: 'Pierre Frey', country: 'France', currency: 'EUR',
  design: 'Atlas',
  composition: '48% Viscose · 33% Cotton · 19% Linen',
  width: '140 cm', application: 'Upholstery & Drapery', rubs: '40,000',
  // Technical product fields (15 Jul template expansion) — indicative.
  repeat: '64 cm', verticalRepeat: '64 cm', patternMatch: 'Straight',
  priceBand: 'NZ$420 / m', status: 'In stock',
  story: brandOf('Pierre Frey').story,
  ...pimg('Atlas'),
  colourways: [
    { name: 'Natural', sku: 'PF-ATL-01', tone: ['#E9DEC9', '#C7B189'], real: true },
    { name: 'Flax', sku: 'PF-ATL-02', tone: ['#E2D2A8', '#B79B63'] },
    { name: 'Sienna', sku: 'PF-ATL-03', tone: ['#C98A5E', '#8A4E2E'] },
    { name: 'Indigo', sku: 'PF-ATL-04', tone: ['#5C6B86', '#2C3A55'], real: true },
    { name: 'Slate', sku: 'PF-ATL-05', tone: ['#9A9A92', '#5A5C57'] },
    { name: 'Noir', sku: 'PF-ATL-06', tone: ['#3A352F', '#1C1815'] },
  ],
  selected: 3, // Indigo
}

// The recurring "Clay" shortage / overdue-sample item → REAL Larsen · Wright · Clay.
export const clayItem = {
  brand: 'Larsen', design: 'Wright', colourway: 'Clay', sku: 'LAR-WRT-03',
  composition: '65% Cotton · 27% Polyamide · 8% Polyester', application: 'Upholstery',
  tone: ['#B7917A', '#7C5645'], ...pimg('Wright Black'),
}

// ---- catalogue designs (Catalogue & Colourways screen) ----------------------
const cw = (names) => names.map((n, i) => ({ name: n.name, sku: n.sku, tone: n.tone, real: n.real }))
export const designs = [
  {
    brand: 'Pierre Frey', supplier: 'Pierre Frey', design: 'Atlas', currency: 'EUR',
    composition: '48% Viscose / 33% Cotton / 19% Linen', width: '140cm', application: 'Upholstery', rubs: '40,000',
    priceBand: 'NZ$420 / m', status: 'In stock', statusTone: 'sage', ...pimg('Atlas'),
    // duty/retailMarkup (P3/P6): variable and optional per product; inHouse (P5): Atelier's own textiles.
    duty: '7%', retailMarkup: '×2.2', inHouse: false,
    colourways: hero.colourways,
  },
  {
    brand: 'Manuel Canovas', supplier: 'Manuel Canovas', design: 'Madina', currency: 'EUR',
    composition: '100% Linen', width: '150cm', application: 'Drapery', rubs: '—',
    priceBand: 'NZ$310 / m', status: 'In stock', statusTone: 'sage', ...pimg('Madina Beige'),
    duty: '7%', retailMarkup: '×2.2', inHouse: false,
    colourways: [
      { name: 'Beige', sku: 'MC-MAD-01', tone: ['#E6DAC2', '#C2AE86'], real: true },
      { name: 'Jade', sku: 'MC-MAD-02', tone: ['#7FA39A', '#3E6258'], real: true },
      { name: 'Rose', sku: 'MC-MAD-03', tone: ['#D7B3AE', '#B07A73'] },
    ],
  },
  {
    brand: 'Larsen', supplier: 'Larsen', design: 'Wright', currency: 'GBP',
    composition: '65% Cotton / 27% Polyamide / 8% Polyester', width: '140cm', application: 'Upholstery', rubs: '45,000',
    priceBand: 'NZ$386 / m', status: 'Low stock', statusTone: 'clay', ...pimg('Wright Black'),
    duty: '5%', retailMarkup: '×2.3', inHouse: false,
    colourways: [
      { name: 'Black', sku: 'LAR-WRT-01', tone: ['#4A453E', '#1C1815'], real: true },
      { name: 'Clay', sku: 'LAR-WRT-03', tone: ['#B7917A', '#7C5645'] },
      { name: 'Yellow', sku: 'LAR-WRT-02', tone: ['#E4C56A', '#B8932F'], real: true },
    ],
  },
  {
    brand: 'Dominique Kieffer by Rubelli', supplier: 'Rubelli Venezia', design: 'Rigatto', currency: 'EUR',
    composition: '54% Viscose / 34% Polyester / 12% Linen', width: '138cm', application: 'Upholstery', rubs: '30,000',
    priceBand: 'NZ$455 / m', status: 'In stock', statusTone: 'sage', ...pimg('Rigatto Cushion Cover - Blanc'),
    duty: '7%', retailMarkup: '×2.4', inHouse: false,
    colourways: [
      { name: 'Blanc', sku: 'DK-RIG-01', tone: ['#EDE6D6', '#CFC2A6'], real: true },
      { name: 'Mahogany', sku: 'DK-RIG-02', tone: ['#9A5B45', '#5E3023'], real: true },
    ],
  },
  {
    brand: 'Jim Thompson', supplier: 'Jim Thompson', design: 'Peacock', currency: 'USD',
    composition: '100% Linen', width: '137cm', application: 'Drapery', rubs: '—',
    priceBand: 'NZ$390 / m', status: 'In stock', statusTone: 'sage', ...pimg('Peacock'),
    // P3 — not all products are dutiable: Thai silk enters duty-free, so duty is null (no duty step).
    duty: null, retailMarkup: '×2.1', inHouse: false,
    colourways: [
      { name: 'Emerald', sku: 'JT-PEA-01', tone: ['#5E8F7A', '#2C5240'] },
      { name: 'Sapphire', sku: 'JT-PEA-02', tone: ['#5E7796', '#2E4666'] },
    ],
  },
  {
    brand: 'Colefax & Fowler', supplier: 'Colefax & Fowler', design: 'Swedish Tree', currency: 'GBP',
    composition: '49% Viscose / 26% Linen / 17% Cotton / 8% Polyester', width: '140cm', application: 'Drapery', rubs: '—',
    priceBand: 'NZ$365 / m', status: 'In stock', statusTone: 'sage', ...pimg('Swedish Tree'),
    // P6 — not all products carry a retail markup: this range is trade-only (retailMarkup null),
    // so if shown on the website it is login-gated until a retail price is set (P5).
    duty: '7%', retailMarkup: null, inHouse: false,
    colourways: [
      { name: 'Aqua', sku: 'CF-SWT-01', tone: ['#9CBEC0', '#5E8A8D'] },
      { name: 'Rose', sku: 'CF-SWT-02', tone: ['#D8B6B2', '#B07F78'] },
    ],
  },
  // Fabricut house (6 brands) — appended so the Catalogue's Fabricut supplier facet has rows.
  // Existing indices above are untouched (Catalogue's `selected`/`selectedSku` init reads designs[0]).
  ...fabricutDesigns,
]

// ---- pricing engine ---------------------------------------------------------
// The documented 8-step cost-plus waterfall (from the Health Check), applied to a real design.
export const pricing = {
  // `prefix` (Workshop 30 Jun, decision 5): range-based prefix appended to item codes for uniqueness.
  // supplier/supplierDiscount (P2): the discount is a supplier-level term; forexSetOn (P1): FX is set annually.
  subject: { brand: 'Pierre Frey', range: 'Cappuccino', prefix: 'PF-', design: 'Atlas', colourway: 'Indigo', sku: 'PF-ATL-04', supplier: 'Pierre Frey', supplierDiscount: '5%', forexSetOn: FX_SET_ON },
  mode: 'Automatic',
  // Editable inputs the waterfall reads by label (see PricingEngine). Forex margin (P1) and supplier
  // discount (P2) are now genuine, applied parameters; Trade markup (P7) replaces the old trade discount.
  params: [
    { label: 'Forex margin', value: '10%' }, { label: 'Supplier discount', value: '5%' },
    { label: 'Duty', value: '7%' }, { label: 'Freight', value: '8%' }, { label: 'Clearance', value: '2%' },
    { label: 'Retail markup', value: '×2.2' }, { label: 'Trade markup', value: '55%' },
  ],
  // Trade markup (P7) can be a percentage of cost OR a flat dollar value add — toggle in the engine.
  tradeMarkupDollar: `NZ$${pricingInputs.tradeMarkupDollar}`,
  inheritNote: 'Inherits to all 6 colourways',
  // `productTypeMarkups` (Action src #12 · range PriceParameters/RateSet): one range can carry several
  // retail markups by product type — fabrics/wallpaper vs. trims — beyond the single per-range markup.
  // The active type drives the live waterfall (its markup feeds step 6, Retail Sell). `default` loads first.
  productTypeMarkups: [
    { type: 'Fabrics', markup: '×2.2', note: 'Upholstery & drapery', default: true },
    { type: 'Wallpaper', markup: '×2.4', note: 'Wide-width papers' },
    { type: 'Trimmings', markup: '×1.8', note: 'Braids, cords & tapes' },
  ],
  // Step names/ops describe the waterfall; the live values are computed in PricingEngine from the
  // shared waterfall. The `value` snapshots below are derived from the same canonical figures.
  steps: [
    { n: 1, name: 'Wholesale Rate', op: `€48.00 / m  ·  FX €${fxTable.EUR.actual} per NZ$1 (NZ$${nzdMultiplier('EUR', { withMargin: false }).toFixed(2)} / €1)  ·  +10% forex margin`, value: nzd(canonical.wholesale) },
    // Renamed from "Export Price" (Workshop 30 Jun, decision 6): wholesale less the supplier's discount.
    { n: 2, name: 'Supplier Discounted Price', op: '− 5% supplier discount', value: nzd(canonical.supplierDiscounted) },
    { n: 3, name: 'Price ex Duty', op: '+ Freight 8%  + Clearance 2%', value: nzd(canonical.priceExDuty) },
    { n: 4, name: 'Price incl Duty · COGS', op: '+ Duty 7%', value: nzd(canonical.cogs), key: true },
    { n: 5, name: 'Landed Cost', op: 'Cost to warehouse (NZD)', value: nzd(canonical.landed) },
    { n: 6, name: 'Retail Sell', op: '× 2.2 retail markup', value: nzd(canonical.retail) },
    { n: 7, name: 'Trade Sell', op: '+ 55% trade markup on cost', value: nzd(canonical.trade), key: true },
    { n: 8, name: 'Client tiers', op: 'Tier 1 −10% / Tier 2 −5%', value: nzd(canonical.tier1) + ' / ' + nzd(canonical.tier2) },
  ],
  harderCases: {
    // Resolved per the workshop diagram (Discount Logic · D3): two client tiers, Tier 1 −10% /
    // Tier 2 −5%. Applied to the client's trade price and auto-triggered on qualifying orders (D1).
    tiersTitle: 'Client discount tiers — Tier 1 −10% / Tier 2 −5%',
    tiers: [
      { name: 'Tier 1 · Trade', pct: '−10%' },
      { name: 'Tier 2 · Studio', pct: '−5%' },
    ],
    // Both multi-brand houses render from the supplier master (GEN-05) so the Pricing Engine
    // and the Suppliers screen share one source. JV is the per-brand/compounded exception case.
    houseTitle: 'One supplier, many brands — the Fabricut house (6 brands)',
    fabricut: supplierByName('Fabricut').brands.map((b) => ({ name: b.name, markup: `×${b.markup}` })),
    jvTitle: 'Multi-tier & compounded — the Janelli Volpi house',
    jv: {
      tiers: supplierByName('Janelli Volpi')
        .brands.find((b) => b.discountTiers)
        .discountTiers.map((t) => ({ name: t.label, pct: `−${Math.round(t.pct * 100)}%` })),
      sisters: 'Altagamma · JWall · JV Design · Armani · Missoni — all −50%',
      fabrics: {
        name: 'JV Fabrics',
        chain: chainLabel([0.4, 0.4]),
        example: `Trade NZ$100 → NZ$${applyDiscountChain(100, [0.4]).toFixed(0)} → NZ$${applyDiscountChain(100, [0.4, 0.4]).toFixed(0)} (×0.36 — not −80%)`,
      },
    },
  },
  reviewCount: 6,
}

// ---- dashboard --------------------------------------------------------------
export const dashboard = {
  greetingDay: 'Tuesday',
  // `allCompany` marks a figure that is the whole firm's, not the reader's — withheld from a
  // login scoped to its own sales (RPT-03). Flagged in the data rather than matched by label
  // at the screen, so renaming a KPI cannot quietly un-gate it.
  kpis: [
    { label: 'Sales · MTD', value: 'NZ$248,400', note: 'Month to date', key: true, allCompany: true },
    { label: 'Open orders', value: '17', note: 'Awaiting fulfilment' },
    { label: 'Inbound shipments', value: '5', note: 'In transit' },
    { label: 'Stock alerts', value: '3', note: 'Below par level' },
  ],
  orders: [
    { client: 'Marlow & Finch Interiors', sub: 'Olivia Marlow · Jenette', amount: 'NZ$4,820' },
    { client: 'McKenzie & Willis', sub: 'Rebecca', amount: 'NZ$12,140' },
    { client: 'Indigo House Studio', sub: 'Charlotte', amount: 'NZ$2,360' },
    { client: 'Coast & Co Design', sub: 'Jenette', amount: 'NZ$6,015' },
  ],
  pos: [
    { supplier: 'Pierre Frey (FR)', eta: '24 Jun', amount: '€9,420' },
    { supplier: 'Rubelli Venezia (IT)', eta: '02 Jul', amount: '€5,180' },
    { supplier: 'Colefax & Fowler (UK)', eta: '09 Jul', amount: '£3,640' },
  ],
  // `finance` marks an entry that states a cost figure in prose. The FX line quotes all three
  // annual strike rates — the rates the waterfall computes landed cost from — so it answers to
  // finance.view exactly as the supplier spend figures above it do.
  activity: [
    { tone: 'clay', text: "Sample ‘Wright — Clay’ overdue with Marlow & Finch (12 days)" },
    { tone: 'sage', text: 'Pierre Frey price list refreshed' },
    { tone: 'muted', finance: true, text: `FX table loaded — €${fxTable.EUR.actual} · £${fxTable.GBP.actual} · US$${fxTable.USD.actual} per NZ$1 · set ${FX_SET_ON}` },
  ],
}

// ---- sales order (SO-2026-0418) --------------------------------------------
export const salesOrder = {
  number: 'SO-2026-0418', client: 'Marlow & Finch Interiors',
  project: 'Hāwera — Master Suite', salesperson: 'Rebecca',
  // Line totals derive from the shared trade unit price (unit × metres), so they cascade with the
  // pricing engine. `unit` is the trade $/m; `qty` carries the metres.
  rooms: [
    { room: 'Lounge', lines: [
      { design: 'Atlas', colourway: 'Indigo', sku: 'PF-ATL-04', tone: ['#5C6B86', '#2C3A55'], qty: '18 m', unit: tradeUnit('Atlas'), total: nzd(tradeUnit('Atlas') * 18) },
      { design: 'Madina', colourway: 'Jade', sku: 'MC-MAD-02', tone: ['#7FA39A', '#3E6258'], qty: '12 m', unit: tradeUnit('Madina'), total: nzd(tradeUnit('Madina') * 12) },
    ] },
    { room: 'Master Suite', lines: [
      { design: 'Atlas', colourway: 'Natural', sku: 'PF-ATL-01', tone: ['#E9DEC9', '#C7B189'], qty: '8 m', unit: tradeUnit('Atlas'), total: nzd(tradeUnit('Atlas') * 8) },
      // `delayed` (Workshop 30 Jun, decision 9): mark the short balance delayed with a supplier ETA so the client can be notified.
      { design: 'Wright', colourway: 'Clay', sku: 'LAR-WRT-03', tone: ['#B7917A', '#7C5645'], qty: '26 m', unit: tradeUnit('Wright'), total: nzd(tradeUnit('Wright') * 26), shortage: 'Short 14 m — 26 m required, 12 m on hand', delayed: { until: '14 Jul', note: 'Balance 14 m delayed — supplier ETA 14 Jul' } },
    ] },
  ],
  deliveryInstructions: 'Deliver to site rear, contact Olivia on arrival. Roll — do not fold.',
  // `timeline` (Charlotte's ask): a consolidated order-status view — arrived / dispatched / tracking-sent-to-client —
  // built on the existing tracking + delayed-status data. state: done | current | todo.
  timeline: [
    { label: 'Quote sent', date: '17 Jun', state: 'done', note: 'Emailed to Olivia Marlow' },
    { label: 'Order confirmed', date: '19 Jun', state: 'done' },
    { label: 'PO raised on supplier', date: '20 Jun', state: 'done', note: 'PO-2026-0142 · Pierre Frey' },
    { label: 'Stock arrived (part)', date: '02 Jul', state: 'current', note: '2 of 3 lines received · Wright balance delayed to 14 Jul' },
    { label: 'Dispatched', date: '—', state: 'todo' },
    { label: 'Tracking sent to client', date: '—', state: 'todo', note: 'Auto-notify in Phase 2' },
    { label: 'Delivered', date: '—', state: 'todo' },
  ],
  // Client tier (D3) + automatic volume discount (D1): orders over `volumeThreshold` metres/rolls
  // get the client's tier rate, with a manual override always available. Marlow & Finch is Tier 1.
  clientTier: 1,
  volumeThreshold: 5,
  // `excludeShipping` / `freightBase` (Workshop 30 Jun, decision 4 · SO-07): toggling excludes base freight
  // when goods ship direct from the supplier. Subtotal / discount / GST / total are derived in the screen.
  summary: { freightBase: 185.0, excludeShipping: false, gstRate: 0.15 },
}

// Derived order totals (single source for the Sales Order screen + CRM). The volume discount (D1)
// applies the client's tier rate (D3) when any line exceeds the threshold. `excludeShipping` and a
// manual discount override are layered on top of this in the screen.
export function computeOrderTotals(order, { excludeShipping = false, overridePct = null } = {}) {
  const meters = (l) => parseFloat(String(l.qty).replace(/[^0-9.]/g, '')) || 0
  const lines = order.rooms.flatMap((r) => r.lines)
  const subtotal = lines.reduce((s, l) => s + l.unit * meters(l), 0)
  const qualifies = lines.some((l) => meters(l) > order.volumeThreshold)
  const tierPct = (clientTiers[order.clientTier] || { pct: 0 }).pct
  const discountPct = overridePct != null ? overridePct : qualifies ? tierPct : 0
  const discount = subtotal * discountPct
  const freight = excludeShipping ? 0 : order.summary.freightBase
  const net = subtotal - discount + freight
  const gst = net * order.summary.gstRate
  return { subtotal, qualifies, tierPct, discountPct, discount, freight, gst, total: net + gst }
}

export const salesOrderTotals = computeOrderTotals(salesOrder)

// ---- purchase order (PO-2026-0142) -----------------------------------------
const pfSupplier = supplierByName('Pierre Frey')
export const purchaseOrder = {
  number: 'PO-2026-0142', supplier: 'Pierre Frey', city: 'Paris', currency: pfSupplier.currency,
  // Defaults sourced from the supplier master (GEN-05); FX shown in both conventions.
  fx: `NZ$${nzdMultiplier('EUR').toFixed(4)} / €1 · €${fxTable.EUR.actual} per NZ$1`,
  agent: pfSupplier.agent, incoterm: pfSupplier.incoterm, eta: '02 Jul',
  // `tracking` (Workshop 30 Jun, decision 12): Phase 1 = manual entry. Supplier ref captured now (Liz's ask);
  // customer ref is added at dispatch. Automated DHL/Toll integration is Phase 2.
  tracking: { carrier: 'DHL Express', supplierRef: '77 1244 5692 1', customerRef: '—' },
  origin: 'SO-2026-0418', status: 'Part-received',
  lines: [
    { sku: 'PF-ATL-01', design: 'Atlas — Natural', tone: ['#E9DEC9', '#C7B189'], ordered: 40, received: 40, unit: '€48.00', line: '€1,920.00' },
    { sku: 'PF-ATL-04', design: 'Atlas — Indigo', tone: ['#5C6B86', '#2C3A55'], ordered: 30, received: 18, unit: '€48.00', line: '€1,440.00' },
    { sku: 'PF-ATL-05', design: 'Atlas — Slate', tone: ['#9A9A92', '#5A5C57'], ordered: 20, received: 0, unit: '€48.00', line: '€960.00' },
  ],
  receipts: [
    { ref: 'RCT-0142-1', date: '14 Jun', note: 'Atlas — Natural ×40, Atlas — Indigo ×18' },
  ],
}

// ---- sample tracking --------------------------------------------------------
// `loanHistory` (Charlotte's ask): the loan trail per sample — who held it, out/returned dates, days out —
// so staff can see how a sample is performing. Append-only; the last entry is open when status is 'Out'.
export const samples = {
  stats: { out: 9, library: 214, overdue: 1 },
  rows: [
    { design: 'Wright — Clay', supplier: 'Larsen', barcode: 'ATL-0049-217', tone: ['#B7917A', '#7C5645'], status: 'Out', holder: 'Marlow & Finch', since: '12 days', overdue: true,
      loanHistory: [
        { holder: 'Marlow & Finch Interiors', out: '25 Jun', returned: null, days: 12, note: 'Project Hāwera — with client' },
        { holder: 'Coast & Co Design', out: '02 Jun', returned: '18 Jun', days: 16 },
        { holder: 'Indigo House Studio', out: '11 May', returned: '20 May', days: 9 },
        { holder: 'Maker Interiors', out: '02 Apr', returned: '15 Apr', days: 13 },
      ] },
    { design: 'Atlas — Indigo', supplier: 'Pierre Frey', barcode: 'ATL-0049-118', tone: ['#5C6B86', '#2C3A55'], status: 'In library', holder: '—', since: '—',
      loanHistory: [
        { holder: 'Marlow & Finch Interiors', out: '02 Jun', returned: '09 Jun', days: 7 },
        { holder: 'McKenzie & Willis', out: '18 Apr', returned: '29 Apr', days: 11 },
      ] },
    { design: 'Madina — Jade', supplier: 'Manuel Canovas', barcode: 'ATL-0049-203', tone: ['#7FA39A', '#3E6258'], status: 'Out', holder: 'Indigo House Studio', since: '3 days',
      loanHistory: [
        { holder: 'Indigo House Studio', out: '04 Jul', returned: null, days: 3 },
        { holder: 'Marlow & Finch Interiors', out: '11 Jun', returned: '17 Jun', days: 6 },
      ] },
    { design: 'Peacock — Emerald', supplier: 'Jim Thompson', barcode: 'ATL-0049-091', tone: ['#5E8F7A', '#2C5240'], status: 'In library', holder: '—', since: '—',
      loanHistory: [
        { holder: 'Coast & Co Design', out: '20 May', returned: '31 May', days: 11 },
      ] },
    { design: 'Rigatto — Mahogany', supplier: 'Rubelli', barcode: 'ATL-0049-066', tone: ['#9A5B45', '#5E3023'], status: 'Out', holder: 'Coast & Co Design', since: '6 days',
      loanHistory: [
        { holder: 'Coast & Co Design', out: '01 Jul', returned: null, days: 6 },
        { holder: 'Maker Interiors', out: '14 May', returned: '28 May', days: 14 },
        { holder: 'Marlow & Finch Interiors', out: '01 Apr', returned: '09 Apr', days: 8 },
      ] },
    { design: 'Swedish Tree — Aqua', supplier: 'Colefax & Fowler', barcode: 'ATL-0049-150', tone: ['#9CBEC0', '#5E8A8D'], status: 'In library', holder: '—', since: '—',
      loanHistory: [] },
  ],
}

// ---- showroom sample orders -------------------------------------------------
// `showrooms` + `sampleOrders` (Action src #8 · §2.6 Samples): the per-showroom cut of the sample
// workflow — which brand samples (hangers/books/cuttings) each Atelier showroom has ordered for display.
// Distinct from the client loan register above: this tracks stocking a showroom's own sample wall.
// status lifecycle: Requested → Ordered → In transit → Received → Displayed.
export const showrooms = [
  { id: 'parnell', name: 'Parnell', city: 'Auckland', region: 'Auckland', flagship: true },
  { id: 'christchurch', name: 'Christchurch', city: 'Christchurch', region: 'Canterbury' },
  { id: 'wellington', name: 'Wellington', city: 'Wellington', region: 'Wellington' },
]

export const sampleOrderFlow = ['Requested', 'Ordered', 'In transit', 'Received', 'Displayed']

export const sampleOrders = [
  // Parnell — the flagship, widest wall
  { showroom: 'parnell', design: 'Atlas', colourway: 'Natural', supplier: 'Pierre Frey', sku: 'PF-ATL-01', tone: ['#E9DEC9', '#C7B189'], kind: 'Books', qty: 2, orderedBy: 'Rebecca', date: '02 Jul', status: 'Displayed' },
  { showroom: 'parnell', design: 'Madina', colourway: 'Jade', supplier: 'Manuel Canovas', sku: 'MC-MAD-02', tone: ['#7FA39A', '#3E6258'], kind: 'Hangers', qty: 3, orderedBy: 'Jenette', date: '28 Jun', status: 'Received' },
  { showroom: 'parnell', design: 'Rigatto', colourway: 'Mahogany', supplier: 'Rubelli Venezia', sku: 'DK-RIG-02', tone: ['#9A5B45', '#5E3023'], kind: 'Book', qty: 1, orderedBy: 'Charlotte', date: '05 Jul', status: 'In transit' },
  { showroom: 'parnell', design: 'Peacock', colourway: 'Emerald', supplier: 'Jim Thompson', sku: 'JT-PEA-01', tone: ['#5E8F7A', '#2C5240'], kind: 'Cuttings', qty: 4, orderedBy: 'Rebecca', date: '06 Jul', status: 'Ordered' },
  { showroom: 'parnell', design: 'Swedish Tree', colourway: 'Aqua', supplier: 'Colefax & Fowler', sku: 'CF-SWT-01', tone: ['#9CBEC0', '#5E8A8D'], kind: 'Hangers', qty: 2, orderedBy: 'Liz', date: '07 Jul', status: 'Requested' },
  // Christchurch — McKenzie & Willis territory
  { showroom: 'christchurch', design: 'Wright', colourway: 'Clay', supplier: 'Larsen', sku: 'LAR-WRT-03', tone: ['#B7917A', '#7C5645'], kind: 'Hangers', qty: 3, orderedBy: 'Rebecca', date: '30 Jun', status: 'Received' },
  { showroom: 'christchurch', design: 'Atlas', colourway: 'Indigo', supplier: 'Pierre Frey', sku: 'PF-ATL-04', tone: ['#5C6B86', '#2C3A55'], kind: 'Book', qty: 1, orderedBy: 'Jenette', date: '01 Jul', status: 'In transit' },
  { showroom: 'christchurch', design: 'Madina', colourway: 'Beige', supplier: 'Manuel Canovas', sku: 'MC-MAD-01', tone: ['#E6DAC2', '#C2AE86'], kind: 'Cuttings', qty: 2, orderedBy: 'Charlotte', date: '04 Jul', status: 'Ordered' },
  { showroom: 'christchurch', design: 'Peacock', colourway: 'Sapphire', supplier: 'Jim Thompson', sku: 'JT-PEA-02', tone: ['#5E7796', '#2E4666'], kind: 'Hangers', qty: 2, orderedBy: 'Rebecca', date: '06 Jul', status: 'Requested' },
  // Wellington
  { showroom: 'wellington', design: 'Rigatto', colourway: 'Blanc', supplier: 'Rubelli Venezia', sku: 'DK-RIG-01', tone: ['#EDE6D6', '#CFC2A6'], kind: 'Book', qty: 1, orderedBy: 'Jenette', date: '27 Jun', status: 'Displayed' },
  { showroom: 'wellington', design: 'Wright', colourway: 'Yellow', supplier: 'Larsen', sku: 'LAR-WRT-02', tone: ['#E4C56A', '#B8932F'], kind: 'Hangers', qty: 2, orderedBy: 'Charlotte', date: '29 Jun', status: 'Received' },
  { showroom: 'wellington', design: 'Swedish Tree', colourway: 'Rose', supplier: 'Colefax & Fowler', sku: 'CF-SWT-02', tone: ['#D8B6B2', '#B07F78'], kind: 'Cuttings', qty: 3, orderedBy: 'Liz', date: '03 Jul', status: 'In transit' },
  { showroom: 'wellington', design: 'Atlas', colourway: 'Natural', supplier: 'Pierre Frey', sku: 'PF-ATL-01', tone: ['#E9DEC9', '#C7B189'], kind: 'Hanger', qty: 1, orderedBy: 'Rebecca', date: '07 Jul', status: 'Requested' },
]

// ---- reporting --------------------------------------------------------------
export const reporting = {
  stats: [
    { label: 'FY Sales', value: 'NZ$1.73M', delta: '+12.4%', up: true, key: true },
    { label: 'Avg order', value: 'NZ$3,940', delta: '+4.1%', up: true },
    { label: 'Active accounts', value: '146', delta: '+9', up: true },
    { label: 'Samples out', value: '9', delta: '−2', up: false },
  ],
  // 12-month series (indicative, NZ$ thousands)
  thisYear: [118, 132, 141, 128, 155, 162, 149, 171, 158, 166, 174, 168],
  lastYear: [104, 119, 122, 116, 134, 141, 138, 147, 142, 151, 149, 150],
  months: ['Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
  bySalesperson: [
    { name: 'Rebecca', fy: 'NZ$642,300', yoy: '+14.2%', up: true },
    { name: 'Jenette', fy: 'NZ$589,140', yoy: '+9.8%', up: true },
    { name: 'Charlotte', fy: 'NZ$498,560', yoy: '−3.1%', up: false },
  ],
  byRegion: [
    { region: 'Auckland', value: 712, pct: 41 }, { region: 'Canterbury', value: 396, pct: 23 },
    { region: 'Wellington', value: 311, pct: 18 }, { region: 'Otago / Queenstown', value: 191, pct: 11 },
    { region: 'Waikato / BoP', value: 120, pct: 7 },
  ],
  topRanges: [
    { name: 'Pierre Frey · Cappuccino', value: 'NZ$214,800' },
    { name: 'Manuel Canovas · Giverny', value: 'NZ$176,500' },
    { name: 'de Le Cuona · Nature’s Opera', value: 'NZ$151,200' },
    { name: 'Rubelli · Return to Arcadia', value: 'NZ$138,940' },
    { name: 'Larsen · 2024', value: 'NZ$119,360' },
  ],
  // Sales by brand (Charlotte's ask — "a sales report by brand, to see how each brand is tracking").
  // Indicative; groups the RPT-01 comparative dimensions at the brand level. value = FY26, prev = FY25.
  byBrand: [
    { brand: 'Pierre Frey', fy: 'NZ$391,600', prev: 'NZ$332,900', yoy: '+17.6%', up: true },
    { brand: 'Manuel Canovas', fy: 'NZ$284,050', prev: 'NZ$261,400', yoy: '+8.7%', up: true },
    { brand: 'de Le Cuona', fy: 'NZ$201,880', prev: 'NZ$188,200', yoy: '+7.3%', up: true },
    { brand: 'Rubelli Venezia', fy: 'NZ$182,340', prev: 'NZ$190,600', yoy: '−4.3%', up: false },
    { brand: 'Larsen', fy: 'NZ$156,720', prev: 'NZ$142,050', yoy: '+10.3%', up: true },
    { brand: 'Colefax & Fowler', fy: 'NZ$131,410', prev: 'NZ$124,800', yoy: '+5.3%', up: true },
    { brand: 'Jim Thompson', fy: 'NZ$98,600', prev: 'NZ$108,900', yoy: '−9.5%', up: false },
  ],
  // The 7 operational reports discussed 9 Jul — BLOCKED until the A-inputs land. No fake numbers:
  // each tile names the report and the decision/data gating it (A1 cost source, A2 sale
  // definition, A3 stock authority, A4 Xero boundary, plus Jenette's written delivery-report spec).
  blocked: [
    { name: 'Zero-cost sales', desc: 'Sales lines carrying no cost — the margin-leak candidates.', awaits: ['A1 · cost source', 'A2 · sale definition'] },
    { name: 'Margin exceptions', desc: 'Lines outside the 30–70% margin band, flagged for review.', awaits: ['A1 · cost source', 'A2 · sale definition'] },
    { name: 'Stock — holdings · allocations · value', desc: 'On-hand, allocated and valued stock across ~318 SKUs.', awaits: ['A3 · stock authority', 'A1 · cost source'] },
    { name: 'Purchases & purchase spend', desc: 'Spend by supplier and range across purchase orders.', awaits: ['A1 · cost source', 'A4 · Xero boundary'] },
    { name: 'Shipment tracking', desc: 'Inbound POs with carrier references and ETAs in one view.', awaits: ['A3 · stock authority', 'A4 · Xero boundary'] },
    { name: 'Inwards goods', desc: 'Receipts against POs — what landed, when, short or over.', awaits: ['A3 · stock authority'] },
    { name: 'Delivery details', desc: 'Order and delivery history for a named client (the Robert Andrews case).', awaits: ["Jenette's written spec", 'A2 · sale definition'] },
  ],
}

// ---- client account (Marlow & Finch 360) -----------------------------------
export const clientAccount = {
  name: 'Marlow & Finch Interiors', type: 'Trade', region: 'Auckland', salesperson: 'Rebecca',
  stats: [
    { label: 'FY26 sales', value: 'NZ$114,350', key: true }, { label: 'Lifetime', value: 'NZ$486,900' },
    { label: 'Avg order', value: 'NZ$4,210' }, { label: 'Orders FY26', value: '27' },
  ],
  contact: { name: 'Olivia Marlow', email: 'olivia@marlowfinch.co.nz', phone: '+64 21 555 0182' },
  timeline: [
    { date: '17 Jun', text: 'Quote sent — Project Hāwera, Master Suite (SO-2026-0418)' },
    { date: '11 Jun', text: 'Samples dispatched — Wright (Clay), Madina (Jade)' },
    { date: '02 Jun', text: 'Showroom visit — Olivia + client, Pierre Frey Cappuccino' },
  ],
  byRange: [
    { range: 'Pierre Frey · Atlas', fy: 'NZ$38,200', yoy: '+18%', up: true },
    { range: 'Manuel Canovas · Madina', fy: 'NZ$24,600', yoy: '+7%', up: true },
    { range: 'Larsen · Wright', fy: 'NZ$19,100', yoy: '−4%', up: false },
  ],
  samplesOut: [{ design: 'Wright — Clay', since: '12 days', overdue: 'Overdue at 14' }],
}

// ---- journal ----------------------------------------------------------------
export const journal = {
  hero: { eyebrow: 'Fibre & Craft', title: 'Cappuccino — natural tones, striking light', collection: 'Pierre Frey · Cappuccino', ...(findCollection('Cappuccino') || {}) },
  articles: [
    { eyebrow: 'House Story', title: 'Pierre Frey: a French house in its third generation', date: '14 Jun', read: '6 min', ...(findCollection('Cappuccino') || {}) },
    { eyebrow: 'Material', title: 'de Le Cuona and the art of understated linen', date: '09 Jun', read: '5 min', ...(findCollection("Nature's Opera") || {}) },
    { eyebrow: 'Collection', title: 'Rubelli: Return to Arcadia', date: '02 Jun', read: '4 min', ...(findCollection('Return to Arcadia') || {}) },
    { eyebrow: 'Atelier', title: 'Manuel Canovas — the colour of Giverny', date: '27 May', read: '7 min', ...(findCollection('Giverny') || {}) },
    { eyebrow: 'Craft', title: 'Jim Thompson — silk, from farm to loom', date: '19 May', read: '8 min', ...(findCollection('Earthly Elation') || {}) },
    { eyebrow: 'Collection', title: 'Larsen 2024 — woven landscapes', date: '11 May', read: '5 min', ...(findCollection('Larsen 2024') || {}) },
  ],
  story: {
    eyebrow: 'House Story', title: 'Inside Pierre Frey: Cappuccino',
    standfirst: 'New designs and timeless classics in natural tones — free-spirited, bold and resolutely contemporary, yet timeless.',
    byline: 'The Atelier Journal · 14 June 2026',
    shop: { brand: 'Pierre Frey', design: 'Atlas', from: `From ${nzd(canonical.retail)} / m · Indicative` },
    ...(findCollection('Cappuccino') || {}),
  },
}

// ---- storefront (Trade + Public) -------------------------------------------
const sp = (sub, retail) => { const p = findProduct(sub); return p ? { name: p.name, brand: p.brand, type: p.type, sku: p.sku, img: p.img, src: p.src, retail } : null }
export const storefront = [
  sp('Madina Beige', 'NZ$245'), sp('Atlas Cushion', 'NZ$265'), sp('Peacock', 'NZ$280'),
  sp('Wright Black', 'NZ$255'), sp('Plaid Classic Throw', 'NZ$390'), sp('Wolf Throw', 'NZ$420'),
].filter(Boolean)

// ---- project folder (Project Hāwera) ---------------------------------------
export const projectFolder = {
  name: 'Hāwera — Master Suite', client: 'Marlow & Finch Interiors', designer: 'Olivia Marlow',
  totalCloth: '64 m', lastEdited: '17 Jun', shareUrl: 'atelier.co.nz/p/hawera-3f9a',
  pieces: [
    { design: 'Atlas', colourway: 'Indigo', supplier: 'Pierre Frey', sku: 'PF-ATL-04', tone: ['#5C6B86', '#2C3A55'], note: 'Headboard + ottoman', qty: '18 m' },
    { design: 'Madina', colourway: 'Jade', supplier: 'Manuel Canovas', sku: 'MC-MAD-02', tone: ['#7FA39A', '#3E6258'], note: 'Curtains, master', qty: '12 m' },
    { design: 'Wright', colourway: 'Clay', supplier: 'Larsen', sku: 'LAR-WRT-03', tone: ['#B7917A', '#7C5645'], note: 'Bench seat', qty: '26 m' },
    { design: 'Rigatto', colourway: 'Blanc', supplier: 'Rubelli', sku: 'DK-RIG-01', tone: ['#EDE6D6', '#CFC2A6'], note: 'Cushions', qty: '8 m' },
  ],
}

// ---- price lists (My Account) ----------------------------------------------
export const priceLists = [
  { brand: 'Pierre Frey' }, { brand: 'Manuel Canovas' }, { brand: 'Larsen' },
  { brand: 'Rubelli Venezia' }, { brand: 'de Le Cuona' },
]

// ---- recent trade orders (My Account) --------------------------------------
export const tradeOrders = [
  { number: 'SO-2026-0418', design: 'Pierre Frey · Atlas — Indigo', qty: '18 m', status: 'In production', tone: 'muted' },
  { number: 'SO-2026-0391', design: 'Larsen · Wright — Clay', qty: '8 m', status: 'Shipped', tone: 'sage' },
  { number: 'SO-2026-0352', design: 'Manuel Canovas · Madina — Jade', qty: '22 m', status: 'Delivered', tone: 'sage' },
]
