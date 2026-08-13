// The mailer renders a template and hands it to a transport. It NEVER throws:
// a send failure is logged and swallowed so a mail problem can't fail the API
// request that triggered it (US-015). Transport is injected (nodemailer in
// production, a capture object in tests), so the mailer has no I/O of its own.

import { renderTemplate } from './templates.js'

const noopLog = { error: () => {}, info: () => {} }

/**
 * @param {{
 *   transport: { sendMail: (msg: object) => Promise<unknown> },
 *   from: string,
 *   backofficeEmail: string,
 *   log?: { error: Function, info: Function },
 * }} deps
 */
export const createMailer = ({ transport, from, backofficeEmail, log = noopLog }) => {
  if (!transport) {
    throw new Error('createMailer requires a transport')
  }

  /**
   * Send a letter to `to`, in one of two forms:
   *   - `{ template, data }` — the code template, rendered here. Every
   *     order-lifecycle notification uses this.
   *   - `{ subject, text }` — an ALREADY-RENDERED letter, sent verbatim. This
   *     is what compose-before-send needs (W20-US-007): the body a staffer
   *     approved is the body that goes, so it cannot be re-rendered on the way
   *     out of a template the store may meanwhile have changed.
   *
   * Resolves to a result object; it does not reject — failures come back as
   * { ok: false }, including a caller that supplied neither form.
   *
   * @param {{ template?: string, to: string, data?: object, subject?: string, text?: string }} args
   * @returns {Promise<{ ok: boolean, error?: Error }>}
   */
  const send = async ({ template, to, data = {}, ...rendered }) => {
    try {
      const message = template ? renderTemplate(template, data) : rendered
      if (!message.subject || !message.text) {
        throw new Error('send requires either a template name or a subject and text')
      }
      await transport.sendMail({ from, to, subject: message.subject, text: message.text })
      log.info({ template: template ?? null, to }, 'transactional email sent')
      return { ok: true }
    } catch (error) {
      // Never rethrow — the caller (an order transition) must not fail because
      // email delivery did.
      log.error(
        { err: error, template: template ?? null, to },
        'failed to send transactional email'
      )
      return { ok: false, error }
    }
  }

  return Object.freeze({ send, backofficeEmail })
}
