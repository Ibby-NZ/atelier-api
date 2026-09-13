// The honeypot behind every public, mail-sending form (contact, order
// request, trade application, forgot password). The storefront renders a
// `website` input a person never sees — off-screen, out of the tab order,
// autofill off — and form-filling bots fill it anyway. A non-empty value
// means "not a person": the route answers exactly as it would for a real
// submission and does NOTHING — no row, no mail — so the bot learns nothing
// from the response and cannot tune around it.
//
// The key MUST be declared in each route's body schema: Fastify's Ajv runs
// removeAdditional, so an undeclared key is stripped before the handler could
// look at it (root CLAUDE.md, cross-cutting traps). Spread `honeypotProperty`
// into the schema's `properties`.
//
// ponytail: a honeypot + the per-IP rate limits is the whole defence. Add
// Cloudflare Turnstile behind the same check if targeted spam gets past it.
export const HONEYPOT_FIELD = 'website'

export const honeypotProperty = Object.freeze({
  [HONEYPOT_FIELD]: { type: 'string', maxLength: 200 },
})

/**
 * True when the request filled the honeypot. Logs it (with the client IP,
 * which the rate limiter already keys on) so a burst is visible in the log.
 *
 * @param {{ body?: object, url: string, ip: string, log: { warn: Function } }} request
 */
export const honeypotTripped = (request) => {
  const value = request.body?.[HONEYPOT_FIELD]
  if (typeof value !== 'string' || value.trim() === '') {
    return false
  }
  request.log.warn({ url: request.url, ip: request.ip }, 'honeypot tripped; submission dropped')
  return true
}
