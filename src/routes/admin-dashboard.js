// GET /admin/dashboard — the CRM's landing tiles in one round trip.
//
// Backoffice-only (director inherits). The finance flag comes through
// `loadReportAccess`, never `request.user.can_view_finance` — the guard's
// PUBLIC_USER_COLUMNS projection does not carry the flag, so reading it off the
// request would answer false to everyone, silently, for ever.
//
// It opts into the report-table rate limit for the reports' own reason: the MTD
// tile is an aggregate over the whole order ledger, so this is a back-office
// surface where a stuck screen re-fetching in a loop is a database problem
// rather than a permissions one. Same bucket size as a report table.

import { buildDashboard } from '../reports/dashboard.js'
import { loadReportAccess } from '../reports/access.js'

const DASHBOARD_RATE_LIMIT = { max: 60, timeWindow: '1 minute' }

export const adminDashboardRoutes = async (app, { pool }) => {
  app.get(
    '/admin/dashboard',
    {
      preHandler: app.guards.requireRole('backoffice'),
      config: { rateLimit: DASHBOARD_RATE_LIMIT },
    },
    async (request) => {
      const access = await loadReportAccess(pool, request.user)
      return buildDashboard(pool, { finance: access.finance })
    }
  )
}
