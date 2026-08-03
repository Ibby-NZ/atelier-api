// Back-office trade application review (the CRM's Users -> Applicants tab).
//
// Read-only: staff review the submitted form here, then approve by flipping
// trade_approved via the existing PATCH /admin/users/:id — approval state lives
// on the users row, never on the application. Business logic lives in
// ../users/trade-applications.js; these handlers stay thin.

import {
  listTradeApplications,
  getTradeApplication,
} from '../users/trade-applications.js'

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

export const adminTradeApplicationRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  app.get(
    '/admin/trade-applications',
    { preHandler: backoffice },
    async () => {
      const applications = await listTradeApplications(pool)
      return { applications }
    }
  )

  app.get(
    '/admin/trade-applications/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const application = await getTradeApplication(pool, request.params.id)
      if (!application) {
        reply.code(404)
        return {
          error: 'Not Found',
          message: `Trade application ${request.params.id} not found.`,
        }
      }
      return { application }
    }
  )
}
