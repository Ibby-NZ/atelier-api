// The raw HTTP surface of Xero — and nothing else.
//
// Deliberately NOT the xero-node SDK: the SDK's client does OpenID discovery
// over the network at initialise time (a boot-order landmine for a server that
// must start with Xero down), and everything this integration needs is four
// endpoints with stable shapes. A ~hundred lines of fetch keeps the dependency
// tree flat and makes the test double trivial — inject `fetchImpl` exactly the
// way the mailer injects its transport and checkout injects Stripe.
//
// This module knows URLs, auth headers and error shapes. It does NOT know
// about tokens' lifecycles (service.js), the database (connection-store.js) or
// what an invoice looks like (mapping.js). Keep it that way.

export const XERO_IDENTITY_BASE = 'https://identity.xero.com'
export const XERO_LOGIN_BASE = 'https://login.xero.com'
export const XERO_API_BASE = 'https://api.xero.com'

/**
 * Anything Xero answered outside 2xx. `status` is the HTTP status;
 * `body` is the parsed JSON body when there was one (Xero's validation
 * failures arrive as a 400 with per-element ValidationErrors — see
 * `validationMessages` below for how callers read them).
 */
export class XeroHttpError extends Error {
  constructor(message, { status, body, retryAfter = null } = {}) {
    super(message)
    this.name = 'XeroHttpError'
    this.status = status
    this.body = body
    // Seconds, from a 429's Retry-After header: short for the per-minute
    // limit, hours for the daily one.
    this.retryAfter = retryAfter
  }
}

/** Pull every human-readable validation message out of a Xero error body. */
export const validationMessages = (body) => {
  const elements = body?.Elements ?? []
  const messages = elements.flatMap((element) =>
    (element?.ValidationErrors ?? []).map((v) => v?.Message).filter(Boolean)
  )
  if (messages.length > 0) return messages
  // Non-element failures (bad grant, revoked consent) carry one of these.
  const single = body?.Detail ?? body?.Message ?? body?.error_description ?? body?.error
  return single ? [String(single)] : []
}

const parseJson = async (response) => {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export const createXeroHttp = ({ clientId, clientSecret, fetchImpl = fetch }) => {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  // identity.xero.com/connect/token — all three grants go through here.
  const token = async (params) => {
    const response = await fetchImpl(`${XERO_IDENTITY_BASE}/connect/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicAuth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    })
    const body = await parseJson(response)
    if (!response.ok) {
      throw new XeroHttpError(
        `Xero token request failed (${response.status}): ${validationMessages(body).join('; ') || 'no detail'}`,
        { status: response.status, body }
      )
    }
    return body
  }

  const bearer = (accessToken, tenantId) => ({
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    // Custom-connection tokens are org-bound and Xero accepts the header
    // missing; a code-flow token REQUIRES it. Always sending what we know
    // keeps one code path.
    ...(tenantId ? { 'xero-tenant-id': tenantId } : {}),
  })

  return {
    tokenWithClientCredentials: () => token({ grant_type: 'client_credentials' }),

    tokenFromCode: (code, redirectUri) =>
      token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),

    // Xero ROTATES the refresh token: the one in this response replaces the
    // one just spent, which is now dead. The caller must persist the new set
    // before doing anything else with it — see service.js for the lock.
    tokenFromRefresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    /** The tenants this token can see. One org in practice; we take the first. */
    connections: async (accessToken) => {
      const response = await fetchImpl(`${XERO_API_BASE}/connections`, {
        headers: bearer(accessToken),
      })
      const body = await parseJson(response)
      if (!response.ok) {
        throw new XeroHttpError(`Xero connections request failed (${response.status})`, {
          status: response.status,
          body,
        })
      }
      return body ?? []
    },

    /**
     * One Accounting API call. `path` is relative to /api.xro/2.0 (e.g.
     * 'Invoices' or 'Invoices/abc/Email'). `query` is an object;
     * `idempotencyKey` maps to Xero's Idempotency-Key header, which is what
     * makes a retried invoice POST return the original invoice instead of
     * minting a duplicate.
     */
    accounting: async (accessToken, tenantId, method, path, { body, query, idempotencyKey } = {}) => {
      const url = new URL(`${XERO_API_BASE}/api.xro/2.0/${path}`)
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value)
      }
      const response = await fetchImpl(url, {
        method,
        headers: {
          ...bearer(accessToken, tenantId),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      const parsed = await parseJson(response)
      if (!response.ok) {
        throw new XeroHttpError(
          `Xero ${method} ${path} failed (${response.status}): ${validationMessages(parsed).join('; ') || 'no detail'}`,
          {
            status: response.status,
            body: parsed,
            retryAfter: Number(response.headers?.get?.('retry-after')) || null,
          }
        )
      }
      return parsed
    },
  }
}
