// Back-office stock management endpoints. All routes are backoffice-only
// (director inherits via the role guard). Handlers stay thin — the rules live in
// ../inventory/admin-inventory.js.
//
// The URL is keyed on :colourwayId, not an inventory-row id: inventory is one
// row per colourway (colourway_id is unique), so the colourway is the natural
// address and matches how the storefront and order state machine refer to stock.

import {
  listInventory,
  updateInventory,
  adjustInventory,
} from '../inventory/admin-inventory.js'

// :colourwayId is coerced to an integer by Fastify; a non-numeric id is a 400.
const colourwayIdParamsSchema = {
  type: 'object',
  required: ['colourwayId'],
  properties: {
    colourwayId: { type: 'integer', minimum: 1 },
  },
}

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string' },
  },
}

// Absolute-set: quantities can never be negative, so the schema caps them at 0.
// (The module re-checks as belt-and-suspenders for direct callers.)
const qtyProp = { type: 'number', minimum: 0 }

const patchSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    qty_available: qtyProp,
    qty_reserved: qtyProp,
  },
}

// A signed delta — negative to write stock down — so no `minimum` here; the
// module rejects an adjustment that would drive qty_available below zero (422).
const adjustSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['delta'],
  properties: {
    delta: { type: 'number' },
  },
}

export const adminInventoryRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/inventory',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => ({
      inventory: await listInventory(pool, { q: request.query.q }),
    })
  )

  app.patch(
    '/admin/inventory/:colourwayId',
    {
      preHandler: backoffice,
      schema: { params: colourwayIdParamsSchema, body: patchSchema },
    },
    async (request) => ({
      inventory: await updateInventory(pool, request.params.colourwayId, request.body),
    })
  )

  app.post(
    '/admin/inventory/:colourwayId/adjust',
    {
      preHandler: backoffice,
      schema: { params: colourwayIdParamsSchema, body: adjustSchema },
    },
    async (request) => ({
      inventory: await adjustInventory(
        pool,
        request.params.colourwayId,
        request.body.delta
      ),
    })
  )
}
