// Nodemailer transport factory. With SMTP env vars set, a real SMTP transport is
// built; otherwise (dev/test, no SMTP configured) a capture transport stands in
// — it PRINTS each letter to the log and sends nothing over the wire, so local
// runs and CI never send real mail (US-015).
//
// Both shapes carry `delivers`, and it is the honest answer to "did that go
// anywhere?": the mailer surfaces it, and a route whose whole point is the
// email (the password reset link) answers 503 when it is false rather than
// telling the person a letter is on its way. The captured letter used to be
// serialised and dropped — a reset link "sent" on a box with no SMTP simply
// vanished, and nothing in the UI or the log said so.

import nodemailer from 'nodemailer'

/**
 * @param {{
 *   smtpHost?: string|null,
 *   smtpPort?: number,
 *   smtpSecure?: boolean,
 *   smtpUser?: string|null,
 *   smtpPass?: string|null,
 * }} config
 * @param {{ warn: Function }} [logger]
 * @returns {{ delivers: boolean, sendMail: (message: object) => Promise<unknown> }}
 */
export const createMailTransport = (config, logger = console) => {
  if (!config.smtpHost) {
    logger.warn(
      'SMTP_HOST unset — mail is NOT delivered. Every letter, password reset links included, is printed here instead, and the reset routes answer 503.'
    )
    const capture = nodemailer.createTransport({ jsonTransport: true })
    return Object.freeze({
      delivers: false,
      sendMail: async (message) => {
        const info = await capture.sendMail(message)
        const attached = (message.attachments ?? []).map((file) => file.filename).join(', ')
        logger.warn(
          `[mail NOT sent — SMTP_HOST unset]\nTo: ${message.to}\nSubject: ${message.subject}\n${
            attached ? `Attachments: ${attached}\n` : ''
          }\n${message.text}\n`
        )
        return info
      },
    })
  }

  const smtp = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: Boolean(config.smtpSecure),
    auth:
      config.smtpUser && config.smtpPass
        ? { user: config.smtpUser, pass: config.smtpPass }
        : undefined,
  })
  return Object.freeze({ delivers: true, sendMail: (message) => smtp.sendMail(message) })
}
