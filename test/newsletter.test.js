// POST /newsletter — footer sign-up forwarded to Mailchimp. Registered on a
// bare Fastify instance with an injected fetch: no database, no network.
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'
import { newsletterRoutes } from '../src/routes/newsletter.js'
import { memberRequest, subscriberHash, subscribeQuietly } from '../src/newsletter/mailchimp.js'

const CONFIG = { apiKey: 'abc123-us21', server: 'us21', audienceId: 'list9' }

const fakeFetch = (status, body) => {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return { ok: status < 400, status, json: async () => body }
  }
  return { impl, calls }
}

const build = async ({ newsletter, fetchImpl }) => {
  const app = Fastify({ logger: false })
  app.register(fastifyRateLimit, { global: false })
  app.register(newsletterRoutes, { newsletter, fetchImpl })
  await app.ready()
  return app
}

const post = (app, payload) => app.inject({ method: 'POST', url: '/newsletter', payload })

describe('memberRequest', () => {
  it('PUTs to the audience member by md5 of the lowercased address, pending if new', () => {
    const { url, init } = memberRequest(CONFIG, ' Ada@Example.COM ')
    expect(url).toBe(
      `https://us21.api.mailchimp.com/3.0/lists/list9/members/${subscriberHash('ada@example.com')}`
    )
    expect(init.method).toBe('PUT')
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from('key:abc123-us21').toString('base64')}`)
    expect(JSON.parse(init.body)).toEqual({ email_address: 'Ada@Example.COM', status_if_new: 'pending' })
  })
})

describe('POST /newsletter', () => {
  let fetched
  beforeEach(() => {
    fetched = fakeFetch(200, { status: 'pending' })
  })

  it('503 when Mailchimp is not configured, and never calls out', async () => {
    const app = await build({ newsletter: null, fetchImpl: fetched.impl })
    const res = await post(app, { email: 'ada@example.com' })
    expect(res.statusCode).toBe(503)
    expect(res.json().message).toMatch(/not available/)
    expect(fetched.calls).toHaveLength(0)
  })

  it('422 with a field error for a malformed address', async () => {
    const app = await build({ newsletter: CONFIG, fetchImpl: fetched.impl })
    const res = await post(app, { email: 'not-an-email' })
    expect(res.statusCode).toBe(422)
    expect(res.json().errors[0].field).toBe('email')
    expect(fetched.calls).toHaveLength(0)
  })

  it('honeypot filled: 202 ok and nothing is sent to Mailchimp', async () => {
    const app = await build({ newsletter: CONFIG, fetchImpl: fetched.impl })
    const res = await post(app, { email: 'bot@example.com', website: 'http://spam' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ ok: true })
    expect(fetched.calls).toHaveLength(0)
  })

  it('202 with Mailchimp status after one PUT', async () => {
    const app = await build({ newsletter: CONFIG, fetchImpl: fetched.impl })
    const res = await post(app, { email: 'ada@example.com' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ ok: true, status: 'pending' })
    expect(fetched.calls).toHaveLength(1)
    expect(fetched.calls[0].url).toBe(memberRequest(CONFIG, 'ada@example.com').url)
  })

  it('502 with a printable sentence when Mailchimp refuses', async () => {
    const refused = fakeFetch(400, { title: 'Invalid Resource', detail: 'looks fake' })
    const app = await build({ newsletter: CONFIG, fetchImpl: refused.impl })
    const res = await post(app, { email: 'ada@example.com' })
    expect(res.statusCode).toBe(502)
    expect(res.json().message).toMatch(/try again/)
  })

  it('400 on an unknown key or a missing email (schema)', async () => {
    const app = await build({ newsletter: CONFIG, fetchImpl: fetched.impl })
    expect((await post(app, {})).statusCode).toBe(400)
  })
})

// The trade form's opt-in rides on an application that has already succeeded,
// so this must never throw and never hang the response.
describe('subscribeQuietly', () => {
  it('does nothing without Mailchimp config', async () => {
    const fetched = fakeFetch(200, { status: 'pending' })
    expect(await subscribeQuietly(null, 'ada@example.com', { fetchImpl: fetched.impl })).toBeNull()
    expect(fetched.calls).toHaveLength(0)
  })

  it('answers the member status after the same PUT the footer makes, with a timeout', async () => {
    const fetched = fakeFetch(200, { status: 'pending' })
    expect(await subscribeQuietly(CONFIG, 'ada@example.com', { fetchImpl: fetched.impl })).toBe('pending')
    expect(fetched.calls).toHaveLength(1)
    expect(fetched.calls[0].url).toBe(memberRequest(CONFIG, 'ada@example.com').url)
    expect(fetched.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('logs and swallows a refusal or a network failure', async () => {
    const logged = []
    const log = { error: (...args) => logged.push(args) }
    const refused = fakeFetch(400, { title: 'Invalid Resource', detail: 'looks fake' })
    expect(await subscribeQuietly(CONFIG, 'ada@example.com', { fetchImpl: refused.impl, log })).toBeNull()
    const down = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await subscribeQuietly(CONFIG, 'ada@example.com', { fetchImpl: down, log })).toBeNull()
    expect(logged).toHaveLength(2)
    expect(logged[0][0].err.message).toMatch(/Invalid Resource/)
  })
})
