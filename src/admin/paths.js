// The AdminJS panel lives under its own prefix, deliberately NOT under /admin:
// the JSON API already owns /admin/orders (the storefront's AdminOrders island
// calls it cross-origin), and @fastify/cors is a fastify-plugin — it hoists to
// the root instance, so CORS cannot be scoped away from the panel by
// encapsulation. A distinct prefix makes "is this the panel?" an exact,
// auditable test instead of a guess about overlapping /admin paths.
export const ADMIN_PANEL_ROOT_PATH = '/panel'
export const ADMIN_PANEL_LOGIN_PATH = `${ADMIN_PANEL_ROOT_PATH}/login`
export const ADMIN_PANEL_LOGOUT_PATH = `${ADMIN_PANEL_ROOT_PATH}/logout`

export const isAdminPanelPath = (url) => {
  const path = url.split('?')[0]
  return path === ADMIN_PANEL_ROOT_PATH || path.startsWith(`${ADMIN_PANEL_ROOT_PATH}/`)
}
