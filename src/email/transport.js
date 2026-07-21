// Nodemailer transport factory. With SMTP env vars set, a real SMTP transport is
// built; otherwise (dev/test, no SMTP configured) a jsonTransport is used — it
// serialises the message to JSON and returns it WITHOUT sending anything over the
// wire, so local runs and CI never send real mail (US-015).

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
 */
export const createMailTransport = (config, logger = console) => {
  if (!config.smtpHost) {
    logger.warn(
      'SMTP_HOST unset — using jsonTransport; emails are captured, not sent.'
    )
    return nodemailer.createTransport({ jsonTransport: true })
  }

  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: Boolean(config.smtpSecure),
    auth:
      config.smtpUser && config.smtpPass
        ? { user: config.smtpUser, pass: config.smtpPass }
        : undefined,
  })
}
