// POST /newsletter — the storefront footer's "Receive our Newsletter" form.
//
// Public and rate-limited like /contact. Nothing is stored here: the audience
// lives in Mailchimp and this route is the only place the API key is used.
// Unconfigured (no MAILCHIMP_* env) answers 503 with a sentence the footer can
// print, the posture /admin/xero takes without Xero.
//
// `website` is the honeypot the storefront's public forms all carry: a person
// never sees the field, a form-filling bot fills it. A non-empty value answers
// 202 and calls nobody — the bot is told "ok" and learns nothing.

import { subscribe, NEWSLETTER_MESSAGES } from '../newsletter/mailchimp.js'

const NEWSLETTER_RATE_LIMIT = Object.freeze({ max: 10, timeWindow: 15 * 60 * 1000 })
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email'],
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 254 },
    website: { type: 'string', maxLength: 500 },
  },
}

export const newsletterRoutes = async (app, { newsletter = null, fetchImpl = fetch }) => {
  app.post(
    '/newsletter',
    { schema: { body: bodySchema }, config: { rateLimit: NEWSLETTER_RATE_LIMIT } },
    async (request, reply) => {
      const email = request.body.email.trim()
      if (!EMAIL_RE.test(email)) {
        reply.code(422)
        return {
          error: 'Unprocessable Entity',
          message: 'A valid email address is required.',
          errors: [{ field: 'email', message: 'A valid email address is required.' }],
        }
      }

      if (request.body.website) {
        reply.code(202)
        return { ok: true }
      }

      if (!newsletter) {
        reply.code(503)
        return { error: 'Service Unavailable', message: NEWSLETTER_MESSAGES.NOT_CONFIGURED }
      }

      try {
        const { status } = await subscribe(newsletter, email, { fetchImpl })
        reply.code(202)
        return { ok: true, status }
      } catch (error) {
        request.log.error({ err: error }, 'newsletter: Mailchimp refused the sign-up')
        reply.code(502)
        return { error: 'Bad Gateway', message: NEWSLETTER_MESSAGES.FAILED }
      }
    }
  )
}
