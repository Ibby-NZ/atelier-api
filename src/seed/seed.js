/**
 * Idempotent seed: upserts catalogue + shipping rows built by catalogue-data.js.
 * Upsert keys: brands.slug, collections (brand_id, slug), products.slug, colourways.sku.
 * Inventory and shipping_rates are INSERT … DO NOTHING — they become live operational
 * data after first seed (reservations, admin-edited rates) and must not be clobbered.
 */
import {
  buildBrandRows,
  buildCollectionRows,
  buildProductRows,
  buildShippingRateRows,
} from './catalogue-data.js'

const upsertBrands = async (client, rows) => {
  const idsByName = new Map()
  for (const row of rows) {
    // website_url fills blanks only (COALESCE keeps the DB value when set): a
    // URL staff typed into the CRM outlives every reseed, while a house whose
    // site we later verify picks it up on the next seed run.
    const { rows: result } = await client.query(
      `INSERT INTO brands (name, slug, story, country, currency, is_international, website_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         story = EXCLUDED.story,
         country = EXCLUDED.country,
         currency = EXCLUDED.currency,
         is_international = EXCLUDED.is_international,
         website_url = COALESCE(brands.website_url, EXCLUDED.website_url)
       RETURNING id`,
      [
        row.name,
        row.slug,
        row.story,
        row.country,
        row.currency,
        row.is_international,
        row.website_url ?? null,
      ]
    )
    idsByName.set(row.name, result[0].id)
  }
  return idsByName
}

const requireBrandId = (brandIds, brandName, context) => {
  const id = brandIds.get(brandName)
  if (!id) {
    throw new Error(`Seed error: brand "${brandName}" missing for ${context}`)
  }
  return id
}

const upsertCollections = async (client, rows, brandIds) => {
  for (const row of rows) {
    const brandId = requireBrandId(brandIds, row.brand_name, `collection "${row.name}"`)
    // Editorial refreshes on reseed like the rest of the catalogue (DO UPDATE);
    // staff edits made in the CRM between reseeds are snapshot corrections, not
    // operational data like inventory, so freshest-vendored wins.
    await client.query(
      `INSERT INTO collections (brand_id, name, slug, description, image_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (brand_id, slug) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         image_url = EXCLUDED.image_url`,
      [brandId, row.name, row.slug, row.description, row.image_url]
    )
  }
  return rows.length
}

const upsertColourway = async (client, productId, colourway) => {
  const { rows: result } = await client.query(
    `INSERT INTO colourways (product_id, name, sku, hex_tones, image_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sku) DO UPDATE SET
       product_id = EXCLUDED.product_id,
       name = EXCLUDED.name,
       hex_tones = EXCLUDED.hex_tones,
       image_url = EXCLUDED.image_url
     RETURNING id`,
    [
      productId,
      colourway.name,
      colourway.sku,
      colourway.hex_tones ? JSON.stringify(colourway.hex_tones) : null,
      colourway.image_url,
    ]
  )
  await client.query(
    `INSERT INTO inventory (colourway_id, qty_available, qty_reserved, unit)
     VALUES ($1, $2, 0, $3)
     ON CONFLICT (colourway_id) DO NOTHING`,
    [result[0].id, colourway.qty_available, colourway.unit]
  )
}

const upsertProducts = async (client, rows, brandIds) => {
  let colourways = 0
  for (const row of rows) {
    const brandId = requireBrandId(brandIds, row.brand_name, `product "${row.name}"`)
    const { rows: result } = await client.query(
      `INSERT INTO products (
         brand_id, name, slug, product_type, composition, width, application, rubs,
         price_band, lead_time, retail_price_cents, trade_price_cents, currency,
         show_on_website, hi_res_asset_url
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (slug) DO UPDATE SET
         brand_id = EXCLUDED.brand_id,
         name = EXCLUDED.name,
         product_type = EXCLUDED.product_type,
         composition = EXCLUDED.composition,
         width = EXCLUDED.width,
         application = EXCLUDED.application,
         rubs = EXCLUDED.rubs,
         price_band = EXCLUDED.price_band,
         lead_time = EXCLUDED.lead_time,
         retail_price_cents = EXCLUDED.retail_price_cents,
         trade_price_cents = EXCLUDED.trade_price_cents,
         currency = EXCLUDED.currency,
         show_on_website = EXCLUDED.show_on_website,
         hi_res_asset_url = EXCLUDED.hi_res_asset_url
       RETURNING id`,
      [
        brandId,
        row.name,
        row.slug,
        row.product_type,
        row.composition,
        row.width,
        row.application,
        row.rubs,
        row.price_band,
        row.lead_time,
        row.retail_price_cents,
        row.trade_price_cents,
        row.currency,
        row.show_on_website,
        row.hi_res_asset_url,
      ]
    )
    for (const colourway of row.colourways) {
      await upsertColourway(client, result[0].id, colourway)
      colourways += 1
    }
  }
  return { products: rows.length, colourways }
}

const insertShippingRates = async (client, rows) => {
  for (const row of rows) {
    await client.query(
      `INSERT INTO shipping_rates (zone, threshold_qty, rate_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (zone, threshold_qty) DO NOTHING`,
      [row.zone, row.threshold_qty, row.rate_cents]
    )
  }
  return rows.length
}

export const runSeed = async (pool) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const brandIds = await upsertBrands(client, buildBrandRows())
    const collections = await upsertCollections(client, buildCollectionRows(), brandIds)
    const productStats = await upsertProducts(client, buildProductRows(), brandIds)
    const shippingRates = await insertShippingRates(client, buildShippingRateRows())
    await client.query('COMMIT')
    return Object.freeze({
      brands: brandIds.size,
      collections,
      products: productStats.products,
      colourways: productStats.colourways,
      shippingRates,
    })
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
