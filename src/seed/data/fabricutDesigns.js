// Fabricut house catalogue designs — one per house brand (GEN-05). The supplier master models
// Fabricut's six brands and their per-brand retail markups, but the real catalogue maps the demo's
// heroes onto Pierre Frey et al., so no Fabricut designs existed to back the `/catalogue` supplier
// facet (it filtered to zero rows). These six dummy designs give the facet its rows.
//
// Shape mirrors `designs` in ./atelier.js exactly so the Catalogue renders them unchanged:
//  · supplier:'Fabricut' — matches the facet via `d.supplier === activeSupplier`
//  · brand — matches each child facet via `d.brand.includes(activeSupplier)`
//  · img/src null — WeaveImage falls back to the woven gradient (no assets needed)
//  · retailMarkup — mirrors ./suppliers.js Fabricut brands exactly (×2.1 … ×2.5)
//  · duty '7%' — placeholder convention (real duty owed under A13); all figures INDICATIVE
//  · colourway SKUs follow the ../utils/sku.js triple convention (Range acronym + Code + ColorCode)
//    so parseSku/buildSku round-trip and the Catalogue can generate per-colour codes.

export const fabricutDesigns = [
  {
    brand: 'Fabricut', supplier: 'Fabricut', design: 'Mesa', currency: 'USD',
    composition: '100% Polyester', width: '137cm', application: 'Upholstery', rubs: '51,000',
    priceBand: 'NZ$189 / m', status: 'In stock', statusTone: 'sage', img: null, src: null,
    duty: '7%', retailMarkup: '×2.1', inHouse: false,
    colourways: [
      { name: 'Adobe', sku: 'FB-MES-01', tone: ['#C89B7B', '#8F5F3F'] },
      { name: 'Juniper', sku: 'FB-MES-02', tone: ['#8AA08E', '#4E6653'] },
      { name: 'Denim', sku: 'FB-MES-03', tone: ['#6E82A0', '#3B4E6B'] },
    ],
  },
  {
    brand: 'S. Harris', supplier: 'Fabricut', design: 'Ondine', currency: 'USD',
    composition: '62% Cotton / 38% Viscose', width: '140cm', application: 'Upholstery', rubs: '36,000',
    priceBand: 'NZ$412 / m', status: 'In stock', statusTone: 'sage', img: null, src: null,
    duty: '7%', retailMarkup: '×2.3', inHouse: false,
    colourways: [
      { name: 'Pearl', sku: 'SH-OND-01', tone: ['#EAE4D6', '#C8BCA2'] },
      { name: 'Celadon', sku: 'SH-OND-02', tone: ['#A9BFAE', '#6E8A75'] },
      { name: 'Ink', sku: 'SH-OND-03', tone: ['#4A5568', '#232C3B'] },
    ],
  },
  {
    brand: 'Stroheim', supplier: 'Fabricut', design: 'Callais', currency: 'USD',
    composition: '55% Linen / 45% Cotton', width: '138cm', application: 'Drapery', rubs: '—',
    priceBand: 'NZ$298 / m', status: 'In stock', statusTone: 'sage', img: null, src: null,
    duty: '7%', retailMarkup: '×2.2', inHouse: false,
    colourways: [
      { name: 'Oyster', sku: 'ST-CAL-01', tone: ['#E5DCCB', '#C0B294'] },
      { name: 'Mist', sku: 'ST-CAL-02', tone: ['#B9C4C6', '#7E9093'] },
    ],
  },
  {
    brand: 'Vervain', supplier: 'Fabricut', design: 'Tashkent', currency: 'USD',
    composition: '71% Viscose / 29% Silk', width: '130cm', application: 'Drapery', rubs: '—',
    priceBand: 'NZ$486 / m', status: 'Low stock', statusTone: 'clay', img: null, src: null,
    duty: '7%', retailMarkup: '×2.4', inHouse: false,
    colourways: [
      { name: 'Saffron', sku: 'VV-TAS-01', tone: ['#D9A44A', '#A06E1F'] },
      { name: 'Garnet', sku: 'VV-TAS-02', tone: ['#A45048', '#6B2A26'] },
      { name: 'Peacock', sku: 'VV-TAS-03', tone: ['#3F7E82', '#1F4A4E'] },
    ],
  },
  {
    brand: 'Trend', supplier: 'Fabricut', design: '04620', currency: 'USD',
    composition: '100% Cotton', width: '140cm', application: 'Upholstery', rubs: '30,000',
    priceBand: 'NZ$142 / m', status: 'In stock', statusTone: 'sage', img: null, src: null,
    duty: '7%', retailMarkup: '×2.0', inHouse: false,
    colourways: [
      { name: 'Natural', sku: 'TR-046-01', tone: ['#E7DFCE', '#C3B393'] },
      { name: 'Charcoal', sku: 'TR-046-02', tone: ['#6A675F', '#3A382F'] },
    ],
  },
  {
    brand: 'Clarence House', supplier: 'Fabricut', design: 'Velluto Cielo', currency: 'USD',
    composition: '100% Cotton Velvet', width: '130cm', application: 'Upholstery', rubs: '45,000',
    priceBand: 'NZ$618 / m', status: 'In stock', statusTone: 'sage', img: null, src: null,
    duty: '7%', retailMarkup: '×2.5', inHouse: false,
    colourways: [
      { name: 'Cielo', sku: 'CH-VEL-01', tone: ['#7FA0BE', '#42648C'] },
      { name: 'Malachite', sku: 'CH-VEL-02', tone: ['#4E8A6A', '#245240'] },
      { name: 'Rosso', sku: 'CH-VEL-03', tone: ['#B0483C', '#752B22'] },
    ],
  },
]
