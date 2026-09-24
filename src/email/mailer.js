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
 *   orderCopyEmail?: string|null,
 *   redirectTo?: string|null,
 *   log?: { error: Function, info: Function },
 * }} deps
 */
export const createMailer = ({
  transport,
  from,
  backofficeEmail,
  orderCopyEmail = null,
  redirectTo = null,
  log = noopLog,
}) => {
  if (!transport) {
    throw new Error('createMailer requires a transport')
  }

  /**
   * THE TEST-DRIVE VALVE (`EMAIL_REDIRECT_TO` → `config.emailRedirectTo`). With
   * it set, NO letter reaches the address it names: every one is delivered to
   * `redirectTo` instead, carrying the real recipient in the subject and in a
   * banner above the body, so the reader can see who it was FOR.
   *
   * It lives HERE, in the one function every send already passes through,
   * rather than in each route. Purchasing and reserves address people OUTSIDE
   * the business — a purchase order goes to a fabric house, a reserve request
   * asks a mill to hold stock — and those are live commercial contacts. A valve
   * each caller has to remember to open is a valve that gets forgotten exactly
   * once, and a half-finished template reaching a supplier is not recallable.
   * Put here, it also covers every notification added later without being told.
   *
   * The rewrite builds a NEW message; the caller's object is never mutated.
   */
  const applyRedirect = (message) => {
    if (!redirectTo || message.to === redirectTo) {
      return message
    }
    return {
      ...message,
      to: redirectTo,
      subject: `[to: ${message.to}] ${message.subject}`,
      text: [
        `— REDIRECTED — this letter was addressed to ${message.to}.`,
        'EMAIL_REDIRECT_TO is set, so it was delivered here instead.',
        '',
        message.text,
      ].join('\n'),
    }
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
   * `replyTo` is optional and only the back-office alerts set it: it is the
   * person the alert is ABOUT, so a staffer answering from the inbox reaches
   * them rather than the no-reply sender.
   *
   * @param {{ template?: string, to: string, data?: object, subject?: string, text?: string, replyTo?: string|null }} args
   * @returns {Promise<{ ok: boolean, error?: Error }>}
   */
  const send = async ({ template, to, data = {}, replyTo = null, ...rendered }) => {
    try {
      const message = template ? renderTemplate(template, data) : rendered
      if (!message.subject || !message.text) {
        throw new Error('send requires either a template name or a subject and text')
      }
      // Reply-To is a caller-supplied address. Every route validates it with a
      // no-whitespace pattern first; this is the belt to that brace — an
      // address carrying a line break is a header injection, so it is dropped
      // rather than handed to the transport.
      const safeReplyTo = replyTo && !/\s/.test(replyTo) ? replyTo : null
      const outgoing = applyRedirect({
        from,
        to,
        subject: message.subject,
        text: message.text,
        ...(safeReplyTo ? { replyTo: safeReplyTo } : {}),
      })
      await transport.sendMail(outgoing)
      log.info(
        { template: template ?? null, to: outgoing.to, addressed_to: to },
        'transactional email sent'
      )
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

  // `delivers` is the transport's word on whether a letter reaches an inbox.
  // A transport that does not say (the tests' capture objects) is taken to
  // deliver: only the SMTP-less capture transport declares otherwise.
  return Object.freeze({
    send,
    backofficeEmail,
    // Copied on every sales-order letter (notifications.js
    // orderLetterRecipients). Null — every test mailer that does not name one —
    // copies nobody.
    orderCopyEmail: orderCopyEmail || null,
    delivers: transport.delivers !== false,
    // Surfaced so a boot log can say the valve is open. Never read to decide
    // WHETHER to send: a redirected letter is still a letter that was sent.
    redirectTo,
  })
}
