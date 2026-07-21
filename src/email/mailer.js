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
   * Render `template` with `data` and send it to `to`. Resolves to a result
   * object; it does not reject — failures come back as { ok: false }.
   *
   * @param {{ template: string, to: string, data?: object }} args
   * @returns {Promise<{ ok: boolean, error?: Error }>}
   */
  const send = async ({ template, to, data = {} }) => {
    try {
      const { subject, text } = renderTemplate(template, data)
      await transport.sendMail({ from, to, subject, text })
      log.info({ template, to }, 'transactional email sent')
      return { ok: true }
    } catch (error) {
      // Never rethrow — the caller (an order transition) must not fail because
      // email delivery did.
      log.error({ err: error, template, to }, 'failed to send transactional email')
      return { ok: false, error }
    }
  }

  return Object.freeze({ send, backofficeEmail })
}
