/**
 * Pure transform layer: maps atelier-app demo data onto seed row objects.
 * Sources (read-only, per PRD seed mapping):
 *  - realCatalogue.js — brands, collections, finished-good products
 *  - atelier.js designs[] — fabric designs + colourways (SKUs, specs, price bands)
 *  - suppliers.js — currency + international flag resolution
 * No database access here; seed.js turns these rows into upserts.
 */
import {
  brands as realBrands,
  collections as realCollections,
  products as realProducts,
} from '../../../atelier-app/src/data/realCatalogue.js'
import { designs } from '../../../atelier-app/src/data/atelier.js'
import { suppliers } from '../../../atelier-app/src/data/suppliers.js'
import { slugify } from './slugify.js'

const HOUSE_BRAND = 'Atelier Textiles NZ'

// Brands referenced by products/designs but absent from realCatalogue.brands.
// Currency still resolves from suppliers.js first (Vervain/Trend are Fabricut house brands).
const EXTRA_BRAND_META = Object.freeze({
  Brochier: Object.freeze({ slug: 'brochier', country: 'Italy', currency: 'EUR' }),
  Vervain: Object.freeze({ slug: 'vervain', country: 'USA', currency: 'USD' }),
  Trend: Object.freeze({ slug: 'trend', country: 'USA', currency: 'USD' }),
  [HOUSE_BRAND]: Object.freeze({
    slug: 'atelier-textiles-nz',
    country: 'New Zealand',
    currency: 'NZD',
  }),
})

// INDICATIVE retail prices (NZD cents) for Atelier's own finished goods — the only products
// retail-priced online. International houses keep retail_price_cents null (FR-3).
const HOUSE_RETAIL_PRICE_CENTS = Object.freeze({
  'ATL-1032': 38900, // Plaid Classic Throw
  'ATL-1033': 54900, // Wolf Throw XL
  'ATL-1034': 42900, // Heritage Duvet Cover
  'ATE-1035': 12900, // Galata Organic Towels
})

// Opening stock by design status. 'Low stock' = 12 matches the sales-order demo
// ("26 m required, 12 m on hand" for Larsen Wright Clay).
const STOCK_BY_STATUS = Object.freeze({ 'In stock': 60, 'Low stock': 12 })
const FINISHED_GOOD_STOCK_UNITS = 10

const supplierFor = (brandName) =>
  suppliers.find((supplier) => supplier.brands.some((brand) => brand.name === brandName)) ?? null

const brandMeta = (brandName) =>
  realBrands.find((brand) => brand.name === brandName) ?? EXTRA_BRAND_META[brandName] ?? null

const toBrandRow = (name) => {
  const meta = brandMeta(name)
  if (!meta) {
    throw new Error(`No brand metadata for "${name}" — add it to EXTRA_BRAND_META`)
  }
  const currency = supplierFor(name)?.currency ?? meta.currency
  if (!currency) {
    throw new Error(`No currency resolvable for brand "${name}"`)
  }
  return Object.freeze({
    name,
    slug: meta.slug,
    story: meta.story ?? null,
    country: meta.country ?? null,
    currency,
    is_international: name !== HOUSE_BRAND,
  })
}

export const buildBrandRows = () => {
  const catalogueNames = realBrands.map((brand) => brand.name)
  const referencedNames = [
    ...realProducts.map((product) => product.brand ?? HOUSE_BRAND),
    ...designs.map((design) => design.brand),
  ]
  const allNames = [...new Set([...catalogueNames, ...referencedNames])]
  return allNames.map(toBrandRow)
}

export const buildCollectionRows = () =>
  realCollections.map((collection) =>
    Object.freeze({
      brand_name: collection.brand,
      name: collection.name,
      slug: slugify(collection.name),
    })
  )

const finishedGoodRows = () =>
  realProducts.map((product) => {
    const brandName = product.brand ?? HOUSE_BRAND
    return Object.freeze({
      brand_name: brandName,
      name: product.name,
      slug: slugify(product.name),
      product_type: 'finished_good',
      composition: product.composition ?? null,
      width: null,
      application: null,
      rubs: null,
      price_band: null,
      lead_time: null,
      retail_price_cents: HOUSE_RETAIL_PRICE_CENTS[product.sku] ?? null,
      currency: toBrandRow(brandName).currency,
      show_on_website: true,
      hi_res_asset_url: product.src ?? null,
      colourways: [
        Object.freeze({
          name: product.design ?? 'Standard',
          sku: product.sku,
          hex_tones: null,
          image_url: product.src ?? null,
          qty_available: FINISHED_GOOD_STOCK_UNITS,
          unit: 'units',
        }),
      ],
    })
  })

const fabricRows = () =>
  designs.map((design) =>
    Object.freeze({
      brand_name: design.brand,
      name: design.design,
      slug: slugify(`${design.brand} ${design.design}`),
      product_type: 'fabric',
      composition: design.composition ?? null,
      width: design.width ?? null,
      application: design.application ?? null,
      rubs: design.rubs && design.rubs !== '—' ? design.rubs : null,
      price_band: design.priceBand ?? null,
      lead_time: null,
      retail_price_cents: null,
      currency: design.currency,
      show_on_website: true,
      hi_res_asset_url: design.src ?? null,
      colourways: design.colourways.map((colourway) =>
        Object.freeze({
          name: colourway.name,
          sku: colourway.sku,
          hex_tones: colourway.tone ?? null,
          image_url: null,
          qty_available: STOCK_BY_STATUS[design.status] ?? 0,
          unit: 'metres',
        })
      ),
    })
  )

export const buildProductRows = () => [...finishedGoodRows(), ...fabricRows()]

// Flat-rate shipping (meeting decision): two tiers per zone with the boundary at qty 20.
// threshold_qty is the tier floor — a quote picks the highest threshold <= qty. Rates INDICATIVE.
const SHIPPING_TIER_THRESHOLD = 20
export const buildShippingRateRows = () =>
  [
    { zone: 'Auckland', threshold_qty: 0, rate_cents: 1000 },
    { zone: 'Auckland', threshold_qty: SHIPPING_TIER_THRESHOLD, rate_cents: 2500 },
    { zone: 'North Island', threshold_qty: 0, rate_cents: 1500 },
    { zone: 'North Island', threshold_qty: SHIPPING_TIER_THRESHOLD, rate_cents: 3500 },
    { zone: 'South Island', threshold_qty: 0, rate_cents: 2000 },
    { zone: 'South Island', threshold_qty: SHIPPING_TIER_THRESHOLD, rate_cents: 4500 },
  ].map(Object.freeze)
