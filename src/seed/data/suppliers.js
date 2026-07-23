// Supplier → multi-brand master (GEN-05). Two documented houses (JV, Fabricut — Charlotte's
// email, 9 Jul); the other rows are the existing single-brand suppliers. agent / poEmail /
// incoterm are INDICATIVE defaults (real values owed under A13) — `indicativeDefaults` flags
// them so the UI can badge them honestly.
//
// terms: { method: 'averaged' | 'per-brand', excluded?, discountIncluded, list, net, averagedFrom?, note? }
//  · method 'averaged'  — the 9 Jul rule: ONE averaged supplier-level discount default (net);
//                         list terms are recorded alongside.
//  · method 'per-brand' + excluded: true — complex houses (JV) excluded from averaging,
//                         handled per brand by exception.
//  · discountIncluded: true — supplied prices are already net (Loro Piana): waterfall SKIPS P2.
//
// brands[]: { name, discount? | discountTiers? | discountChain? | markup?, indicative?, note? }

export const suppliers = [
  {
    id: 'pierre-frey', name: 'Pierre Frey', country: 'France', city: 'Paris',
    currency: 'EUR', agent: 'Mainfreight Air', incoterm: 'FCA',
    poEmail: 'commandes@pierrefrey.fr', indicativeDefaults: true, freightDollar: 30,
    terms: {
      method: 'averaged', discountIncluded: false, list: 0.0, net: 0.05,
      averagedFrom: [{ label: 'Fabrics', pct: 0.05 }, { label: 'Wallpapers', pct: 0.05 }],
    },
    brands: [{ name: 'Pierre Frey' }],
  },
  {
    id: 'manuel-canovas', name: 'Manuel Canovas', country: 'France', city: 'Paris',
    currency: 'EUR', agent: 'Mainfreight Air', incoterm: 'FCA',
    poEmail: 'orders@manuelcanovas.fr', indicativeDefaults: true, freightDollar: 30,
    terms: { method: 'averaged', discountIncluded: false, list: 0.0, net: 0.04 },
    brands: [{ name: 'Manuel Canovas' }],
  },
  {
    id: 'larsen', name: 'Larsen', country: 'United Kingdom', city: 'London',
    currency: 'GBP', agent: 'DHL Global Forwarding', incoterm: 'FCA',
    poEmail: 'orders@larsenfabrics.com', indicativeDefaults: true, freightDollar: 20,
    terms: { method: 'averaged', discountIncluded: false, list: 0.0, net: 0.06 },
    brands: [{ name: 'Larsen' }],
  },
  {
    id: 'rubelli-venezia', name: 'Rubelli Venezia', country: 'Italy', city: 'Venice',
    currency: 'EUR', agent: 'Mainfreight Air', incoterm: 'FCA',
    poEmail: 'export@rubelli.com', indicativeDefaults: true, freightDollar: 30,
    terms: { method: 'averaged', discountIncluded: false, list: 0.0, net: 0.05 },
    brands: [{ name: 'Rubelli Venezia' }, { name: 'Dominique Kieffer by Rubelli' }],
  },
  {
    id: 'colefax-fowler', name: 'Colefax & Fowler', country: 'United Kingdom', city: 'London',
    currency: 'GBP', agent: 'DHL Global Forwarding', incoterm: 'FCA',
    poEmail: 'trade@colefax.co.uk', indicativeDefaults: true, freightDollar: 20,
    terms: { method: 'averaged', discountIncluded: false, list: 0.0, net: 0.05 },
    brands: [{ name: 'Colefax & Fowler' }],
  },
  {
    id: 'jim-thompson', name: 'Jim Thompson', country: 'Thailand', city: 'Bangkok',
    currency: 'USD', agent: 'Mainfreight Air', incoterm: 'FOB',
    poEmail: 'export@jimthompson.com', indicativeDefaults: true, freightDollar: 35,
    terms: { method: 'averaged', discountIncluded: false, list: 0.0, net: 0.04 },
    brands: [{ name: 'Jim Thompson' }, { name: 'No.9 Thompson' }],
  },
  {
    id: 'loro-piana', name: 'Loro Piana', country: 'Italy', city: 'Quarona',
    currency: 'EUR', agent: 'Mainfreight Air', incoterm: 'FCA',
    poEmail: 'interiors@loropiana.com', indicativeDefaults: true, freightDollar: 30,
    // Decided 9 Jul: prices arrive DISCOUNT-INCLUSIVE — already net, ready to roll (P2 skipped).
    terms: {
      method: 'averaged', discountIncluded: true, list: 0.0, net: 0.0,
      note: 'Supplied trade prices are already net — no discount step',
    },
    brands: [{ name: 'Loro Piana Interiors' }],
  },
  {
    id: 'janelli-volpi', name: 'Janelli Volpi', short: 'JV', country: 'Italy', city: 'Milan',
    currency: 'EUR', agent: 'DHL Global Forwarding', incoterm: 'FCA',
    poEmail: 'orders@janellivolpi.it', indicativeDefaults: true, freightDollar: 30,
    // Excluded from the averaged default (9 Jul rule) — per-brand exception structure from
    // Charlotte's email. This is the case the current CRM cannot model.
    terms: {
      method: 'per-brand', excluded: true, discountIncluded: false, list: 0.0, net: null,
      note: 'Multi-tier + compounded — handled per brand, not averaged',
    },
    brands: [
      {
        name: 'Janelli Volpi',
        discountTiers: [
          { label: 'New collections + carry-over designs', pct: 0.45 },
          { label: 'Wallpapers by the metre', pct: 0.4 },
          { label: 'All other collections', pct: 0.5 }, // also the fallback tier
        ],
      },
      { name: 'Altagamma', discount: 0.5 },
      { name: 'JWall', discount: 0.5 },
      { name: 'JV Design', discount: 0.5 },
      { name: 'Armani', discount: 0.5 },
      { name: 'Missoni', discount: 0.5 },
      {
        name: 'JV Fabrics', discountChain: [0.4, 0.4],
        note: 'Compounded — 40% off, then 40% off the result (×0.36 net, not −80%)',
      },
    ],
  },
  {
    id: 'fabricut', name: 'Fabricut', country: 'United States', city: 'Tulsa',
    currency: 'USD', agent: 'Mainfreight Air', incoterm: 'FOB',
    poEmail: 'orders@fabricut.com', indicativeDefaults: true, freightDollar: 40,
    terms: { method: 'averaged', discountIncluded: false, list: 0.0, net: 0.05 },
    // The documented six-brand house — per-brand retail markups.
    brands: [
      { name: 'Fabricut', markup: 2.1 },
      { name: 'S. Harris', markup: 2.3 },
      { name: 'Stroheim', markup: 2.2 },
      { name: 'Vervain', markup: 2.4 },
      { name: 'Trend', markup: 2.0, indicative: true },
      { name: 'Clarence House', markup: 2.5, indicative: true },
    ],
  },
]

export const supplierByName = (name) => suppliers.find((s) => s.name === name) || null
export const supplierById = (id) => suppliers.find((s) => s.id === id) || null
export const multiBrandHouses = suppliers.filter((s) => s.brands.length > 1)
