import AdminJS, { Router as AdminRouter } from 'adminjs'
import { buildRouter } from '@adminjs/fastify'
import { Adapter, Database, Resource } from '@adminjs/sql'
import fastifySession from '@fastify/session'
import fastifyFormBody from '@fastify/formbody'
import { buildAdminResources } from './resources.js'
import { createAdminAuthenticate } from './authenticate.js'
import { deriveAdminSessionSecret } from './session-secret.js'
import {
  ADMIN_PANEL_ROOT_PATH,
  ADMIN_PANEL_LOGIN_PATH,
  ADMIN_PANEL_LOGOUT_PATH,
} from './paths.js'

// buildAuthenticatedRouter from @adminjs/fastify registers @fastify/cookie
// itself, which collides with the app's existing registration (decorators are
// single-shot even across scopes). This module recreates its small auth layer
// — session, guard hook, login/logout — on top of the public buildRouter.

const SESSION_COOKIE_NAME = 'adminjs_session'
// Mirrors the /auth/login budget; each attempt runs a memory-hard argon2 hash.
const LOGIN_RATE_LIMIT = Object.freeze({ max: 10, timeWindow: 15 * 60 * 1000 })

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// 'none' is a typed URL/bookmark; 'same-origin' is the panel's own UI. Notably
// 'same-site' is NOT safe here — a sibling subdomain is a different origin.
const SAME_ORIGIN_FETCH_SITES = new Set(['same-origin', 'none'])

const pathOf = (url) => url.split('?')[0]

// The panel's own UI is served from this origin, so every legitimate request is
// same-origin. AdminJS's React frontend cannot carry a CSRF token we mint, so
// origin checking is the defence available: browsers always attach Origin to
// cross-origin state-changing requests, and Sec-Fetch-Site to navigations.
const isCrossOrigin = (request) => {
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite && !SAME_ORIGIN_FETCH_SITES.has(fetchSite)) {
    return true
  }
  const origin = request.headers.origin
  if (!origin) {
    // Absent on same-origin navigations and non-browser clients; a browser
    // cross-origin write always sends it, so absence is not an attack signal.
    return false
  }
  const host = request.headers.host
  if (!host) {
    return true
  }
  try {
    const originUrl = new URL(origin)
    // Normalise both sides under the same scheme so a default port (:80 / :443)
    // written explicitly on one side still compares equal. Host only, not
    // scheme: behind a TLS-terminating proxy without TRUST_PROXY the request
    // looks like http while the browser reports https, and rejecting that would
    // lock staff out of every write.
    const normalisedHost = new URL(`${originUrl.protocol}//${host}`).host
    return originUrl.host !== normalisedHost
  } catch {
    return true
  }
}

const registerOriginGuard = (app, admin) => {
  const { logoutPath } = admin.options

  app.addHook('onRequest', async (request, reply) => {
    // Logout is a GET link in the AdminJS UI, so it needs the check too —
    // otherwise any cross-site <img> can force staff out.
    const guarded =
      STATE_CHANGING_METHODS.has(request.method) || pathOf(request.url) === logoutPath
    if (!guarded || !isCrossOrigin(request)) {
      return
    }
    return reply.code(403).send({ error: 'Cross-origin admin requests are not allowed.' })
  })
}

const registerSessionGuard = (app, admin) => {
  const { rootPath, loginPath, logoutPath } = admin.options
  const bundleRoute = AdminRouter.routes.find(
    (route) => route.action === 'bundleComponents'
  )?.path
  // Router asset paths are relative to rootPath (buildRouter mounts them that
  // way). Compared by exact path equality, never a substring or regex match:
  // request.url carries the query string, so `.match()` let any /admin URL
  // smuggle an asset path through `?x=/frontend/assets/…` and skip auth.
  const publicPaths = new Set(
    [...AdminRouter.assets.map((asset) => asset.path), bundleRoute]
      .filter(Boolean)
      .map((assetPath) => `${rootPath}${assetPath}`)
  )

  app.addHook('preHandler', async (request, reply) => {
    const path = pathOf(request.url)
    if (publicPaths.has(path)) return
    if (!path.startsWith(rootPath)) return
    if (request.session.get('adminUser')) return
    if (path === loginPath || path === logoutPath) return

    // API calls to record actions bounce back to the dashboard after login;
    // page URLs return to the page that was requested.
    const [redirectTo] = path.split('/actions')
    request.session.set(
      'redirectTo',
      redirectTo.includes(`${rootPath}/api`) ? rootPath : redirectTo
    )
    return reply.redirect(loginPath)
  })
}

const registerLoginRoutes = (app, admin, authenticate) => {
  const { rootPath, loginPath, logoutPath } = admin.options
  const renderLogin = (errorMessage = null) =>
    admin.renderLogin({ action: loginPath, errorMessage })

  app.get(loginPath, async (request, reply) => {
    reply.type('text/html')
    return reply.send(await renderLogin())
  })

  app.post(
    loginPath,
    { config: { rateLimit: LOGIN_RATE_LIMIT } },
    async (request, reply) => {
      const { email, password } = request.body ?? {}
      const adminUser = await authenticate(email, password)
      if (!adminUser) {
        reply.type('text/html')
        return reply.send(await renderLogin('invalidCredentials'))
      }

      // Read before regenerating: regenerate() swaps in a brand-new session.
      const redirectTo = request.session.get('redirectTo')
      // Session fixation guard — a session id issued before authentication must
      // never become an authenticated one.
      await request.session.regenerate()
      request.session.set('adminUser', adminUser)
      return reply.redirect(redirectTo ?? rootPath)
    }
  )

  app.get(logoutPath, async (request, reply) => {
    if (request.session) {
      await request.session.destroy()
    }
    return reply.redirect(loginPath)
  })
}

// Registered inside its own encapsulated scope (see buildApp) so the session,
// form-body, and multipart parsers never leak onto the JSON API routes, and so
// the storefront's CORS allowance never extends to the panel.
export const adminPanelPlugin = async (
  app,
  { pool, cookieSecret, adminSessionSecret = null, databaseUrl }
) => {
  AdminJS.registerAdapter({ Database, Resource })

  const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '')
  const db = await new Adapter('postgresql', {
    connectionString: databaseUrl,
    database: databaseName,
  }).init()

  // The sql adapter opens its own knex pool; tie it to the app lifecycle or
  // closed apps (and test runs) keep the event loop alive.
  const knex = db.tables()[0]?.knex
  app.addHook('onClose', async () => {
    await knex?.destroy()
  })

  const admin = new AdminJS({
    rootPath: ADMIN_PANEL_ROOT_PATH,
    loginPath: ADMIN_PANEL_LOGIN_PATH,
    logoutPath: ADMIN_PANEL_LOGOUT_PATH,
    resources: buildAdminResources(db),
    branding: { companyName: 'Atelier Textiles', withMadeWithLove: false },
  })

  await app.register(fastifyFormBody)
  await app.register(fastifySession, {
    secret: deriveAdminSessionSecret(cookieSecret, adminSessionSecret),
    cookieName: SESSION_COOKIE_NAME,
    // secure: 'auto' — secure over HTTPS (TRUST_PROXY makes Fastify see the
    // forwarded proto in production), plain HTTP allowed in local dev.
    cookie: {
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
      path: ADMIN_PANEL_ROOT_PATH,
    },
  })

  await buildRouter(admin, app)
  registerOriginGuard(app, admin)
  registerSessionGuard(app, admin)
  registerLoginRoutes(app, admin, createAdminAuthenticate(pool))
}
