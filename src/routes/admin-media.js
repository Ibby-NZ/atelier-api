// POST /admin/media — the CRM's image fields upload here (atelier-crm
// src/admin/imageUpload.js, crm#81) and the file is handed on to EmDash, the
// storefront's own media library. This API still stores no blobs: EmDash keeps
// the file on the storefront's disk and serves it publicly at
// /_emdash/api/media/file/<key>. The address answered here goes into the same
// `*_url` column a pasted link did, on Save, through the existing PATCH — so
// nothing downstream of the column changes.
//
//   POST /admin/media?field=<table.column>&filename=<name>
//        Content-Type: image/jpeg | image/png | image/webp   body: the raw bytes
//     → 201 { media: { id, url, filename, mime, size, width, height } }
//
// RAW BYTES, NOT MULTIPART — the product sheet's pattern. The parser is
// encapsulated to this plugin, so no other route's body handling changes.
//
// THE CONTENT-TYPE IS NOT TRUSTED. The first bytes decide what the file is, and
// the logo column takes PNG or WebP only (it is drawn over a photograph, so it
// needs transparency). SVG is refused everywhere: it is a document that can
// carry script, and it would be served from the storefront's own origin.
//
// `url` IS ABSOLUTE. brands.* and collections.image_url go through
// websiteUrlFrom, which 422s a root-relative path, and EmDash answers one — so
// the storefront's public origin (STORE_BASE_URL) goes in front of it.
//
// Unconfigured (no EMDASH_URL / EMDASH_TOKEN) answers 503 with the sentence the
// CRM prints, the posture /newsletter and /admin/xero take.

// Must equal the CRM's MAX_IMAGE_BYTES. Whatever sits in front of the API must
// let a body this size through: nginx's default client_max_body_size is 1 MB.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const EMDASH_TIMEOUT_MS = 30_000

const EXTENSIONS = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })
const PHOTO = Object.freeze(['image/jpeg', 'image/png', 'image/webp'])
const LOGO = Object.freeze(['image/png', 'image/webp'])

// Keyed `table.column`, exactly the CRM's IMAGE_FIELDS.
export const MEDIA_FIELDS = Object.freeze({
  'brands.image_url': PHOTO,
  'brands.logo_url': LOGO,
  'collections.image_url': PHOTO,
  'products.hi_res_asset_url': PHOTO,
  'colourways.image_url': PHOTO,
})

export const MEDIA_MESSAGES = Object.freeze({
  NOT_CONFIGURED: 'Image upload is not switched on in the API yet. Paste a link to the image for now.',
  NOT_AN_IMAGE: 'That file is not a JPEG, PNG or WebP image.',
  LOGO_NEEDS_TRANSPARENCY: 'A logo must be a PNG or WebP with a transparent background.',
})

// The refusal names its cause, so a misconfigured EMDASH_URL or token is read
// off the CRM rather than out of the server log. Back office only, and the
// reason is a status or error code — never the address or the token.
export const libraryRefused = (reason) =>
  `The image library did not take the file (${reason}). Try again, or paste a link to the image for now.`

// A code staff can pass on: EmDash's own (INSUFFICIENT_SCOPE), the socket's
// (ECONNREFUSED — nothing listening at EMDASH_URL), or the timeout's.
export const refusalReason = (error) =>
  error?.emdash ?? error?.cause?.code ?? (error?.name === 'TimeoutError' ? 'timed out' : 'no answer')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** What the bytes are by their signature, or null for anything but the three. */
export const sniffImageType = (bytes) => {
  if (!Buffer.isBuffer(bytes)) return null
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

/**
 * The name EmDash files it under: the person's own name cut down to [a-z0-9-],
 * with the extension the BYTES earned rather than the one it arrived with.
 * EmDash keys storage by a ULID plus this extension, so it is display only.
 */
export const storedFilename = (filename, type) => {
  const base = String(filename ?? '')
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '')
  return `${base || 'image'}.${EXTENSIONS[type]}`
}

const querySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['field'],
  properties: {
    field: { type: 'string', enum: Object.keys(MEDIA_FIELDS) },
    filename: { type: 'string', maxLength: 200 },
  },
}

// EmDash answers `{ data: { item } }` — 201 for a new file, 200 with
// `deduplicated: true` when the same bytes are already in the library.
const sendToEmdash = async ({ media, fetchImpl }, bytes, type, name) => {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type }), name)
  const response = await fetchImpl(`${media.emdashUrl}/_emdash/api/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${media.token}` },
    body: form,
    signal: AbortSignal.timeout(EMDASH_TIMEOUT_MS),
  })
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const code = typeof json?.error?.code === 'string' ? json.error.code.slice(0, 60) : 'no code'
    throw Object.assign(new Error(`EmDash answered ${response.status}: ${json?.error?.message ?? 'no message'}`), {
      emdash: `EmDash ${response.status} ${code}`,
    })
  }
  const item = json?.data?.item
  if (typeof item?.storageKey !== 'string' || item.storageKey === '') {
    throw Object.assign(new Error('EmDash answered without a storage key'), { emdash: 'EmDash sent no file key' })
  }
  return item
}

export const adminMediaRoutes = async (app, { media = null, storeBaseUrl, fetchImpl = fetch }) => {
  app.addContentTypeParser(
    Object.keys(EXTENSIONS),
    { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES },
    (request, body, done) => done(null, body)
  )

  const backoffice = app.guards.requireRole('backoffice')
  const publicBase = String(storeBaseUrl ?? '').replace(/\/+$/, '')

  app.post(
    '/admin/media',
    {
      // onRequest, not preHandler: a stranger's 10 MB is refused before it is read.
      onRequest: backoffice,
      bodyLimit: MAX_IMAGE_BYTES,
      schema: { querystring: querySchema },
    },
    async (request, reply) => {
      if (!media) {
        reply.code(503)
        return { error: 'Service Unavailable', message: MEDIA_MESSAGES.NOT_CONFIGURED }
      }

      const { field, filename } = request.query
      const type = sniffImageType(request.body)
      if (!type || !MEDIA_FIELDS[field].includes(type)) {
        reply.code(415)
        return {
          error: 'Unsupported Media Type',
          message: type ? MEDIA_MESSAGES.LOGO_NEEDS_TRANSPARENCY : MEDIA_MESSAGES.NOT_AN_IMAGE,
        }
      }

      const name = storedFilename(filename, type)
      let item
      try {
        item = await sendToEmdash({ media, fetchImpl }, request.body, type, name)
      } catch (error) {
        request.log.error({ err: error, field }, 'media: EmDash refused the upload')
        // 503, not 502: the proxy in front of production swaps an origin 502
        // for its own page without CORS headers, and the CRM could not read it.
        reply.code(503)
        return { error: 'Service Unavailable', message: libraryRefused(refusalReason(error)) }
      }

      reply.code(201)
      return {
        media: {
          id: item.id ?? null,
          url: `${publicBase}/_emdash/api/media/file/${encodeURIComponent(item.storageKey)}`,
          filename: name,
          mime: type,
          size: request.body.length,
          width: item.width ?? null,
          height: item.height ?? null,
        },
      }
    }
  )
}
