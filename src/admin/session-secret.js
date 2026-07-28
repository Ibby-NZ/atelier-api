import { createHmac } from 'node:crypto'

// Label binds the derived key to this purpose; bump the suffix to force every
// panel session to be re-established.
const DERIVATION_LABEL = 'adminjs-session-v1'

// The panel's session cookie and the API's `atelier_session` cookie are separate
// trust boundaries (backoffice vs customer), so they must not share a signing
// key — @fastify/session and @fastify/cookie both default to HMAC-SHA256, so a
// value signed for one would verify under the other. Derived rather than a new
// required env var, so existing deployments keep booting; set
// ADMIN_SESSION_SECRET to rotate the panel independently.
export const deriveAdminSessionSecret = (cookieSecret, adminSessionSecret = null) => {
  if (adminSessionSecret) {
    return adminSessionSecret
  }
  if (!cookieSecret) {
    throw new Error('deriveAdminSessionSecret requires a cookieSecret')
  }
  return createHmac('sha256', cookieSecret).update(DERIVATION_LABEL).digest('hex')
}
