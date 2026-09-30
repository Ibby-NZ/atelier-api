// POST /admin/media — the CRM's image upload, handed on to EmDash. Registered on
// a bare Fastify instance with a stub guard and an injected fetch: no database,
// no network, no EmDash.
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import {
  adminMediaRoutes,
  sniffImageType,
  storedFilename,
  MAX_IMAGE_BYTES,
  MEDIA_MESSAGES,
} from '../src/routes/admin-media.js'

const MEDIA = Object.freeze({ emdashUrl: 'http://127.0.0.1:4321', token: 'ec_test' })
const STORE = 'https://store.example.com/'

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const fakeEmdash = (status = 201, body = { data: { item: { id: '01M', storageKey: '01M.png', width: 640, height: 480 } } }) => {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return { ok: status < 400, status, json: async () => body }
  }
  return { impl, calls }
}

// Anyone with the header is back office; anyone without is refused, as the
// real requireRole would.
const stubGuards = {
  requireRole: () => async (request, reply) => {
    if (request.headers['x-staff'] !== 'yes') return reply.code(401).send({ error: 'Authentication required.' })
  },
}

const build = async ({ media = MEDIA, fetchImpl }) => {
  const app = Fastify({ logger: false })
  app.decorate('guards', stubGuards)
  app.register(adminMediaRoutes, { media, storeBaseUrl: STORE, fetchImpl })
  await app.ready()
  return app
}

const upload = (app, { field = 'brands.image_url', filename, body = PNG, type = 'image/png', staff = true } = {}) => {
  const query = new URLSearchParams({ field, ...(filename ? { filename } : {}) })
  return app.inject({
    method: 'POST',
    url: `/admin/media?${query}`,
    headers: { 'content-type': type, ...(staff ? { 'x-staff': 'yes' } : {}) },
    payload: body,
  })
}

describe('sniffImageType', () => {
  it('reads the three formats from their bytes and nothing else', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg')
    expect(sniffImageType(PNG)).toBe('image/png')
    expect(sniffImageType(WEBP)).toBe('image/webp')
    expect(sniffImageType(SVG)).toBeNull()
    expect(sniffImageType(Buffer.from('%PDF-1.7'))).toBeNull()
    expect(sniffImageType(Buffer.alloc(0))).toBeNull()
    expect(sniffImageType(undefined)).toBeNull()
  })
})

describe('storedFilename', () => {
  it('keeps a readable name, never a path, with the extension the bytes earned', () => {
    expect(storedFilename('Pierre Frey Logo.PNG', 'image/png')).toBe('pierre-frey-logo.png')
    expect(storedFilename('../../etc/passwd.jpg', 'image/webp')).toBe('etc-passwd.webp')
    expect(storedFilename('', 'image/jpeg')).toBe('image.jpg')
    expect(storedFilename(undefined, 'image/jpeg')).toBe('image.jpg')
    expect(storedFilename(`${'a'.repeat(300)}.jpg`, 'image/jpeg')).toBe(`${'a'.repeat(80)}.jpg`)
  })
})

describe('POST /admin/media', () => {
  let emdash
  beforeEach(() => {
    emdash = fakeEmdash()
  })

  it('hands the file to EmDash and answers an absolute address on the storefront', async () => {
    const app = await build({ fetchImpl: emdash.impl })
    const response = await upload(app, { field: 'brands.logo_url', filename: 'Pierre Frey.png' })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      media: {
        id: '01M',
        url: 'https://store.example.com/_emdash/api/media/file/01M.png',
        filename: 'pierre-frey.png',
        mime: 'image/png',
        size: PNG.length,
        width: 640,
        height: 480,
      },
    })

    expect(emdash.calls).toHaveLength(1)
    const [{ url, init }] = emdash.calls
    expect(url).toBe('http://127.0.0.1:4321/_emdash/api/media')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer ec_test')
    const file = init.body.get('file')
    expect(file.name).toBe('pierre-frey.png')
    expect(file.type).toBe('image/png')
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('takes the file EmDash already had (deduplicated, 200) the same way', async () => {
    const dedupe = fakeEmdash(200, { data: { item: { id: '01OLD', storageKey: '01OLD.jpg' }, deduplicated: true } })
    const app = await build({ fetchImpl: dedupe.impl })
    const response = await upload(app, { body: JPEG, type: 'image/jpeg' })
    expect(response.statusCode).toBe(201)
    expect(response.json().media).toMatchObject({
      url: 'https://store.example.com/_emdash/api/media/file/01OLD.jpg',
      width: null,
      height: null,
    })
  })

  it('refuses anyone but the back office before reading the file', async () => {
    const app = await build({ fetchImpl: emdash.impl })
    const response = await upload(app, { staff: false })
    expect(response.statusCode).toBe(401)
    expect(emdash.calls).toHaveLength(0)
  })

  it('answers 503 with the CRM sentence while EmDash is not configured', async () => {
    const app = await build({ media: null, fetchImpl: emdash.impl })
    const response = await upload(app)
    expect(response.statusCode).toBe(503)
    expect(response.json().message).toBe(MEDIA_MESSAGES.NOT_CONFIGURED)
    expect(emdash.calls).toHaveLength(0)
  })

  it('judges the bytes, not the stated type', async () => {
    const app = await build({ fetchImpl: emdash.impl })
    const svg = await upload(app, { body: SVG, type: 'image/png' })
    expect(svg.statusCode).toBe(415)
    expect(svg.json().message).toBe(MEDIA_MESSAGES.NOT_AN_IMAGE)
    expect(emdash.calls).toHaveLength(0)
  })

  it('refuses a JPEG logo — a logo needs transparency', async () => {
    const app = await build({ fetchImpl: emdash.impl })
    const response = await upload(app, { field: 'brands.logo_url', body: JPEG, type: 'image/jpeg' })
    expect(response.statusCode).toBe(415)
    expect(response.json().message).toBe(MEDIA_MESSAGES.LOGO_NEEDS_TRANSPARENCY)
    expect(emdash.calls).toHaveLength(0)
  })

  it('refuses a type it has no parser for, an unknown field and an oversized file', async () => {
    const app = await build({ fetchImpl: emdash.impl })
    expect((await upload(app, { body: SVG, type: 'image/svg+xml' })).statusCode).toBe(415)
    expect((await upload(app, { field: 'users.email' })).statusCode).toBe(400)
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])
    expect((await upload(app, { body: huge })).statusCode).toBe(413)
    expect(emdash.calls).toHaveLength(0)
  })

  it('answers 503 when EmDash refuses or answers without a storage key', async () => {
    for (const refusal of [fakeEmdash(403, { error: { message: 'INSUFFICIENT_SCOPE' } }), fakeEmdash(201, { data: {} })]) {
      const app = await build({ fetchImpl: refusal.impl })
      const response = await upload(app)
      expect(response.statusCode).toBe(503)
      expect(response.json().message).toBe(MEDIA_MESSAGES.LIBRARY_REFUSED)
    }
  })
})
