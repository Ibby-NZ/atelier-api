/**
 * Decodes one batch of D365 staging records off the wire for
 * POST /admin/legacy/import/:entity.
 *
 * The whole normalised corpus is ~125 MB of JSON but ~12 MB gzipped, so the
 * remote push sends gzipped batches: at ~1000 records a batch every request
 * stays well under nginx's 1 MB default `client_max_body_size`, which is what
 * makes the endpoint usable on a server we cannot reconfigure (no shell). A
 * plain `application/json` array is accepted too — that path is for a hand-made
 * curl, not for bulk.
 */
import { gunzipSync } from 'node:zlib'

// A gzip bomb is cheap to build and expensive to receive, so cap the DECOMPRESSED
// size rather than trusting the compressed body limit alone. 32 MB is ~25x the
// largest batch the push script sends.
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024

// Records per request. The importer upserts in one transaction per call, so a
// batch is also the retry unit — small enough to resend cheaply, large enough
// that a full refresh is tens of requests, not thousands.
export const MAX_RECORDS_PER_BATCH = 5000

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

/**
 * @param {Buffer|unknown} body  a Buffer for application/gzip, else the parsed JSON
 * @returns {Array<Record<string, unknown>>} the records, untouched
 * @throws  an Error carrying `statusCode` (400 malformed, 413 oversized)
 */
export const decodeImportPayload = (body) => {
  const records = Buffer.isBuffer(body) ? parseGzip(body) : body

  if (!Array.isArray(records)) {
    throw httpError(400, 'Body must be a JSON array of records.')
  }
  if (records.length === 0) {
    throw httpError(400, 'Body must contain at least one record.')
  }
  if (records.length > MAX_RECORDS_PER_BATCH) {
    throw httpError(
      413,
      `Batch of ${records.length} records exceeds the ${MAX_RECORDS_PER_BATCH} limit — split it.`
    )
  }
  return records
}

const parseGzip = (body) => {
  let json
  try {
    json = gunzipSync(body, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  } catch (error) {
    throw httpError(400, `Body is not valid gzip (${error.message}).`)
  }
  try {
    return JSON.parse(json.toString('utf8'))
  } catch (error) {
    throw httpError(400, `Gzipped body is not valid JSON (${error.message}).`)
  }
}
