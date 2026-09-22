// The Xero integration's HTTP face (C4).
//
// `xero` is the injected service (src/xero/service.js) and MAY BE NULL — an
// unconfigured deployment answers 503 from every route here, the same posture
// as checkout without Stripe. Nothing else in the API imports the service;
// order confirm still takes a typed xero_invoice_ref, it just no longer has
// to be typed, because the push fills it.
//
// TWO DIRECTIONS. /sync/* and the two document pushes are platform → Xero;
// /pull/* is Xero → platform (contacts, and the status of every invoice and
// bill we pushed). server.js runs the pull on a timer when
// XERO_PULL_INTERVAL_MINUTES is set; these routes are the same calls by hand.
//
// WHO MAY DO WHAT: reading status and pushing/syncing is backoffice work
// (director inherits). CONNECTING AND DISCONNECTING ARE DIRECTOR-ONLY — the
// consent grants an external system access to the company's books, which is
// an ownership decision, not a desk task.
//
// THE CALLBACK IS A BROWSER NAVIGATION, NOT AN API CALL. Xero 302s the
// director's browser here after consent, so the route answers with redirects
// back to the CRM's Xero screen (?connected=1/0), never JSON — a JSON error
// at this URL would strand a person, not a program. The session cookie rides
// along because it is SameSite=Lax and this is a top-level GET. The `state`
// nonce is minted at Connect, stored on the connection row, and spent
// (read-and-cleared) here — a stale or replayed callback matches nothing and
// bounces back with a message instead of storing a token somebody else minted.

import {
  XeroNotConnectedError,
  XeroCallbackError,
  XeroConflictError,
  XeroValidationError,
} from '../xero/service.js'
import { XeroHttpError } from '../xero/xero-http.js'
import { loadReportAccess } from '../reports/access.js'

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'integer' } },
}

const invoiceBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // true = ask Xero to send its own invoice email to the contact.
    email: { type: 'boolean' },
  },
}

export const adminXeroRoutes = async (app, { pool, xero, crmBaseUrl }) => {
  const backoffice = app.guards.requireRole('backoffice')
  const director = app.guards.requireRole('director')
  // The purchase order handed back is finance-gated like every purchasing read
  // (see src/routes/admin-purchase-orders.js for why it is never request.user).
  const financeFor = async (request) => (await loadReportAccess(pool, request.user)).finance

  const unconfigured = (reply) => {
    reply.code(503)
    return {
      error: 'Service Unavailable',
      message: 'Xero is not configured. Set XERO_CLIENT_ID and XERO_CLIENT_SECRET.',
    }
  }

  /** Map service errors onto the API's status vocabulary. */
  const answer = async (reply, fn) => {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof XeroNotConnectedError || error instanceof XeroConflictError) {
        reply.code(409)
        return { error: 'Conflict', message: error.message }
      }
      if (error instanceof XeroValidationError) {
        reply.code(422)
        return { error: 'Unprocessable Entity', message: error.message }
      }
      if (error instanceof XeroHttpError) {
        // Xero itself failed (5xx, rate limit, network). Not the caller's
        // fault and not ours — a gateway problem, said plainly.
        app.log.error({ err: error }, 'xero call failed')
        reply.code(502)
        return { error: 'Bad Gateway', message: 'Xero did not answer that request — try again shortly.' }
      }
      throw error
    }
  }

  app.get('/admin/xero/status', { preHandler: backoffice }, async (request, reply) => {
    if (!xero) return { xero: { configured: false, connected: false } }
    return answer(reply, async () => ({ xero: await xero.status() }))
  })

  app.post('/admin/xero/connect', { preHandler: director }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    return answer(reply, async () => ({ consent_url: await xero.consentUrl() }))
  })

  app.get('/admin/xero/callback', { preHandler: director }, async (request, reply) => {
    const back = (query) => reply.redirect(`${crmBaseUrl}/#/admin/xero${query}`)
    if (!xero) return back('?connected=0&reason=unconfigured')
    const { code, state, error } = request.query ?? {}
    if (error || !code) {
      // The director cancelled on Xero's side, or Xero refused the consent.
      return back(`?connected=0&reason=${encodeURIComponent(error || 'cancelled')}`)
    }
    try {
      await xero.completeCallback({ code, state })
      return back('?connected=1')
    } catch (err) {
      const reason = err instanceof XeroCallbackError ? err.message : 'exchange-failed'
      app.log.error({ err }, 'xero callback failed')
      return back(`?connected=0&reason=${encodeURIComponent(reason)}`)
    }
  })

  app.post('/admin/xero/disconnect', { preHandler: director }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    await xero.disconnect()
    return { xero: { configured: true, connected: false } }
  })

  app.post('/admin/xero/sync/contacts', { preHandler: backoffice }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    return answer(reply, async () => ({ result: await xero.syncContacts() }))
  })

  app.post('/admin/xero/sync/suppliers', { preHandler: backoffice }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    return answer(reply, async () => ({ result: await xero.syncSuppliers() }))
  })

  app.post('/admin/xero/sync/items', { preHandler: backoffice }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    return answer(reply, async () => ({ result: await xero.syncItems() }))
  })

  // The Xero → platform direction. Contacts (customers AND suppliers) land
  // in the roster; invoice and bill statuses land on their documents, and a
  // PAID invoice marks its order paid. The same call the scheduled pull makes.
  app.post('/admin/xero/pull/contacts', { preHandler: backoffice }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    return answer(reply, async () => ({ result: await xero.pullContacts() }))
  })

  app.post('/admin/xero/pull/statuses', { preHandler: backoffice }, async (request, reply) => {
    if (!xero) return unconfigured(reply)
    return answer(reply, async () => ({ result: await xero.pullStatuses() }))
  })

  app.post(
    '/admin/xero/orders/:id/invoice',
    { preHandler: backoffice, schema: { params: idParamsSchema, body: invoiceBodySchema } },
    async (request, reply) => {
      if (!xero) return unconfigured(reply)
      return answer(reply, async () => {
        const result = await xero.pushOrderInvoice(request.params.id, {
          email: request.body?.email === true,
        })
        if (!result) {
          reply.code(404)
          return { error: 'Not Found', message: `No order ${request.params.id}.` }
        }
        return result
      })
    }
  )

  // A purchase order as a BILL against its supplier (ACCPAY). Normally raised
  // by Send; this is the retry for a send whose bill Xero refused, and the
  // manual path for an order sent before the integration existed.
  app.post(
    '/admin/xero/purchase-orders/:id/bill',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!xero) return unconfigured(reply)
      return answer(reply, async () => {
        const result = await xero.pushPurchaseOrderBill(request.params.id, {
          finance: await financeFor(request),
        })
        if (!result) {
          reply.code(404)
          return { error: 'Not Found', message: `No purchase order ${request.params.id}.` }
        }
        reply.code(201)
        return result
      })
    }
  )

  // Mirror Xero's answer about the bill (status, paid date) onto the order.
  // Polled by the CRM when it opens an order with a bill; no webhook.
  app.post(
    '/admin/xero/purchase-orders/:id/bill/sync',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      if (!xero) return unconfigured(reply)
      return answer(reply, async () => {
        const result = await xero.syncPurchaseOrderBill(request.params.id, {
          finance: await financeFor(request),
        })
        if (!result) {
          reply.code(404)
          return { error: 'Not Found', message: `No purchase order ${request.params.id}.` }
        }
        return result
      })
    }
  )
}
