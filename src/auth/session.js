const SESSION_COOKIE = 'atelier_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

// Secure is safe for local dev: browsers treat http://localhost as a secure context.
const BASE_COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
})

export const setSessionCookie = (reply, userId) => {
  reply.setCookie(SESSION_COOKIE, String(userId), {
    ...BASE_COOKIE_OPTIONS,
    signed: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}

export const clearSessionCookie = (reply) => {
  reply.clearCookie(SESSION_COOKIE, BASE_COOKIE_OPTIONS)
}

export const readSessionUserId = (request) => {
  const raw = request.cookies?.[SESSION_COOKIE]
  if (!raw) {
    return null
  }
  const { valid, value } = request.unsignCookie(raw)
  if (!valid) {
    return null
  }
  const userId = Number.parseInt(value, 10)
  return Number.isInteger(userId) && userId > 0 ? userId : null
}
