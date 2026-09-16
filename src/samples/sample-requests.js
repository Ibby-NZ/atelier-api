// Sample requests — the storefront's sample enquiry cart, landed (16 Sep 2026).
//
// A shopper collects colourways on the site and sends them as ONE request with
// their contact details. It lands here as `pending`: a header (who, what they
// said) and lines that SNAPSHOT what was asked for — sku, design, colour,
// house — so the request still reads if the catalogue row is later archived or
// removed (`colourway_id` is SET NULL). The office moves it to `sent` or
// `declined` from the CRM; both are terminal.
//
// Not `sample_orders` (Atelier asking a HOUSE for showroom material) and not
// `samples` (the physical register). Nothing here touches stock.

import { orderNumber } from '../orders/order-number.js'
import { setArchived } from '../lifecycle/archive.js'
import {
  INITIAL_SAMPLE_REQUEST_STATUS,
  STATUS_STAMPS,
  assertTransition,
} from './sample-request-states.js'

export const DEFAULT_PAGE = 1
export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200
export const MAX_LINES = 20

const httpError = (statusCode, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode, ...extra })

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const trimToNull = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * Field-level refusals for the storefront (the order-request posture: the
 * schema is structural, this names the field). A guest must say who they are;
 * a signed-in shopper's account supplies it.
 *
 * @param {{ lines?: Array, contact?: object }} input
 * @param {{ hasUser: boolean }} ctx
 * @returns {Array<{field: string, message: string}>}
 */
export const validateSampleRequestInput = (input, { hasUser }) => {
  const errors = []
  const lines = Array.isArray(input.lines) ? input.lines : []
  if (lines.length === 0) errors.push({ field: 'lines', message: 'Add at least one colourway.' })
  if (lines.length > MAX_LINES) {
    errors.push({ field: 'lines', message: `A request can carry at most ${MAX_LINES} colourways.` })
  }
  lines.forEach((line, index) => {
    if (!trimToNull(line?.sku)) {
      errors.push({ field: `lines[${index}].sku`, message: 'Each line needs a SKU.' })
    }
  })
  const email = trimToNull(input.contact?.email)
  if (!hasUser && !email) {
    errors.push({ field: 'contact.email', message: 'Tell us where to send the samples — an email address.' })
  }
  if (email && !EMAIL_RE.test(email)) {
    errors.push({ field: 'contact.email', message: 'That email address does not look right.' })
  }
  return errors
}

const REQUEST_COLUMNS = `
  sr.id, sr.request_number, sr.user_id, sr.contact_name, sr.contact_email, sr.contact_phone,
  sr.notes, sr.status, sr.sent_at, sr.declined_at, sr.created_at, sr.updated_at, sr.archived_at,
  u.name AS account_name, u.email AS account_email
`
const REQUEST_FROM = `FROM sample_requests sr LEFT JOIN users u ON u.id = sr.user_id`

const LINE_COLUMNS = `
  l.id, l.sample_request_id, l.colourway_id, l.sku, l.product_name, l.colourway_name,
  l.brand_name, l.note, p.slug AS product_slug, p.id AS product_id
`

const toLine = (row) =>
  Object.freeze({
    id: row.id,
    colourway_id: row.colourway_id ?? null,
    product_id: row.product_id ?? null,
    product_slug: row.product_slug ?? null,
    sku: row.sku,
    product_name: row.product_name ?? null,
    colourway_name: row.colourway_name ?? null,
    brand_name: row.brand_name ?? null,
    note: row.note ?? null,
  })

const toRequest = (row, lines) =>
  Object.freeze({
    id: row.id,
    request_number: row.request_number,
    user_id: row.user_id ?? null,
    account_name: row.account_name ?? null,
    account_email: row.account_email ?? null,
    contact_name: row.contact_name ?? null,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone ?? null,
    notes: row.notes ?? null,
    status: row.status,
    sent_at: row.sent_at ?? null,
    declined_at: row.declined_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
    lines,
  })

// Lines for a set of requests in ONE query (the order-history posture: no N+1).
const linesFor = async (db, ids) => {
  if (ids.length === 0) return new Map()
  const { rows } = await db.query(
    `SELECT ${LINE_COLUMNS}
       FROM sample_request_lines l
       LEFT JOIN colourways c ON c.id = l.colourway_id
       LEFT JOIN products p ON p.id = c.product_id
      WHERE l.sample_request_id = ANY($1::int[])
      ORDER BY l.id`,
    [ids]
  )
  const byRequest = new Map()
  for (const row of rows) {
    const list = byRequest.get(row.sample_request_id) ?? []
    list.push(toLine(row))
    byRequest.set(row.sample_request_id, list)
  }
  return byRequest
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`)

/**
 * The office's list, newest first, paged. `q` searches the request number,
 * the contact and the lines' SKU / design text.
 */
export const listSampleRequests = async (
  pool,
  { q, status, includeArchived = false, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const clauses = []
  const params = []
  if (!includeArchived) clauses.push('sr.archived_at IS NULL')
  if (status) {
    params.push(status)
    clauses.push(`sr.status = $${params.length}`)
  }
  const term = trimToNull(q)
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const n = params.length
    clauses.push(
      `(sr.request_number ILIKE $${n} ESCAPE '\\' OR sr.contact_email ILIKE $${n} ESCAPE '\\'
        OR sr.contact_name ILIKE $${n} ESCAPE '\\' OR u.name ILIKE $${n} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM sample_request_lines l WHERE l.sample_request_id = sr.id
                    AND (l.sku ILIKE $${n} ESCAPE '\\' OR l.product_name ILIKE $${n} ESCAPE '\\'
                         OR l.brand_name ILIKE $${n} ESCAPE '\\')))`
    )
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  const count = await pool.query(`SELECT count(*)::int AS total ${REQUEST_FROM} ${where}`, params)
  const { rows } = await pool.query(
    `SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} ${where}
      ORDER BY sr.created_at DESC, sr.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )
  const lines = await linesFor(pool, rows.map((row) => row.id))
  return {
    sample_requests: rows.map((row) => toRequest(row, lines.get(row.id) ?? [])),
    total: count.rows[0].total,
  }
}

/** One request by id, archived or not, or null. */
export const getSampleRequest = async (db, id) => {
  const { rows } = await db.query(`SELECT ${REQUEST_COLUMNS} ${REQUEST_FROM} WHERE sr.id = $1`, [id])
  if (!rows[0]) return null
  const lines = await linesFor(db, [rows[0].id])
  return toRequest(rows[0], lines.get(rows[0].id) ?? [])
}

/**
 * The storefront's submission. Every SKU is resolved against the catalogue
 * before anything is written — an unknown one refuses the whole request with
 * the field named, rather than storing a line nobody can act on — and what the
 * line says (design, colour, house) is snapshotted from the row it resolved to.
 *
 * @param {import('pg').Pool} pool
 * @param {{ lines: Array<{sku: string, note?: string}>, contact?: object, notes?: string|null, user?: object|null }} input
 */
export const createSampleRequest = async (pool, { lines, contact = {}, notes = null, user = null }) => {
  const skus = [...new Set(lines.map((line) => String(line.sku).trim()))]
  const { rows: found } = await pool.query(
    `SELECT c.id, c.sku, c.name AS colourway_name, p.name AS product_name, b.name AS brand_name
       FROM colourways c
       JOIN products p ON p.id = c.product_id
       JOIN brands b ON b.id = p.brand_id
      WHERE c.sku = ANY($1::text[]) AND c.archived_at IS NULL`,
    [skus]
  )
  const bySku = new Map(found.map((row) => [row.sku, row]))
  const errors = []
  lines.forEach((line, index) => {
    if (!bySku.has(String(line.sku).trim())) {
      errors.push({ field: `lines[${index}].sku`, message: `${line.sku} is not a colourway we list.` })
    }
  })
  if (errors.length) {
    throw httpError(422, 'Validation failed.', { errors })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `INSERT INTO sample_requests
         (request_number, user_id, contact_name, contact_email, contact_phone, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        orderNumber('SR'),
        user?.id ?? null,
        trimToNull(contact.name) ?? user?.name ?? null,
        trimToNull(contact.email) ?? user?.email,
        trimToNull(contact.phone) ?? user?.phone ?? null,
        trimToNull(notes),
        INITIAL_SAMPLE_REQUEST_STATUS,
      ]
    )
    const id = rows[0].id
    for (const line of lines) {
      const row = bySku.get(String(line.sku).trim())
      await client.query(
        `INSERT INTO sample_request_lines
           (sample_request_id, colourway_id, sku, product_name, colourway_name, brand_name, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, row.id, row.sku, row.product_name, row.colourway_name, row.brand_name, trimToNull(line.note)]
      )
    }
    await client.query('COMMIT')
    return getSampleRequest(pool, id)
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * A move. The row is locked, the machine consulted, and the state and its
 * stamp are written together — the sample-order posture.
 */
export const transitionSampleRequest = async (pool, id, status) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT status, archived_at FROM sample_requests WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (!rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (rows[0].archived_at) {
      throw httpError(409, 'An archived sample request cannot be moved — restore it first.')
    }
    assertTransition(rows[0].status, status)
    const stamp = STATUS_STAMPS[status]
    await client.query(
      `UPDATE sample_requests
          SET status = $2, ${stamp} = now(), updated_at = now()
        WHERE id = $1`,
      [id, status]
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return getSampleRequest(pool, id)
}

/** Archive or restore; null when the id is unknown. */
export const setSampleRequestArchived = async (pool, id, archived) => {
  const row = await setArchived(pool, 'sample_request', id, archived, {
    extraSets: ['updated_at = now()'],
    returning: 'id',
  })
  return row ? getSampleRequest(pool, row.id) : null
}
