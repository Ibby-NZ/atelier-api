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

  it('EMAIL_REDIRECT_TO defaults to the tester while testing; empty turns it off', () => {
    expect(loadConfig({ ...BASE }).emailRedirectTo).toBe('ibrahim@verum.nz')
    expect(loadConfig({ ...BASE, EMAIL_REDIRECT_TO: 'x@verum.nz' }).emailRedirectTo).toBe('x@verum.nz')
    expect(loadConfig({ ...BASE, EMAIL_REDIRECT_TO: '' }).emailRedirectTo).toBeNull()
  })
})

describe('loadConfig: media', () => {
  it('is null until both EMDASH_URL and EMDASH_TOKEN are set', () => {
    expect(loadConfig({ ...BASE }).media).toBeNull()
    expect(loadConfig({ ...BASE, EMDASH_URL: 'http://127.0.0.1:4321' }).media).toBeNull()
    expect(loadConfig({ ...BASE, EMDASH_TOKEN: 'ec_x' }).media).toBeNull()
  })

  it('drops a trailing slash from EMDASH_URL', () => {
    expect(loadConfig({ ...BASE, EMDASH_URL: 'http://127.0.0.1:4321/', EMDASH_TOKEN: 'ec_x' }).media).toEqual({
      emdashUrl: 'http://127.0.0.1:4321',
      token: 'ec_x',
    })
  })
})
