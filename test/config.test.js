import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const BASE = Object.freeze({
  DATABASE_URL: 'postgresql://localhost:5432/atelier_test',
  COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789abcdef',
})

describe('loadConfig: mail', () => {
  it('without SMTP_HOST the placeholder sender defaults are fine (mail is captured)', () => {
    const config = loadConfig({ ...BASE })
    expect(config.smtpHost).toBeNull()
    expect(config.emailFrom).toContain('@')
  })

  it('SMTP_HOST without real EMAIL_FROM + BACKOFFICE_EMAIL refuses to boot', () => {
    expect(() => loadConfig({ ...BASE, SMTP_HOST: 'smtp.postmarkapp.com' })).toThrow(/EMAIL_FROM/)
    expect(() =>
      loadConfig({ ...BASE, SMTP_HOST: 'smtp.postmarkapp.com', EMAIL_FROM: 'a@atelier.co.nz' })
    ).toThrow(/BACKOFFICE_EMAIL/)
  })

  it('SMTP_HOST with both addresses set loads', () => {
    const config = loadConfig({
      ...BASE,
      SMTP_HOST: 'smtp.postmarkapp.com',
      EMAIL_FROM: 'Atelier Textiles <no-reply@atelier.co.nz>',
      BACKOFFICE_EMAIL: 'orders@atelier.co.nz',
    })
    expect(config.smtpHost).toBe('smtp.postmarkapp.com')
    expect(config.smtpPort).toBe(587)
  })
})
