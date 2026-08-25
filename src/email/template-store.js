// The editable half of a letter (W20-US-006, FR-254/FR-255).
//
// `templates.js` holds a CODE template per name — a pure function of its data.
// This module puts a database row in front of it: `email_templates` carries a
// staff-edited `subject` and `body` for a name, and `renderStoredTemplate`
// prefers that row and falls back to the code template.
//
// THE FALLBACK IS THE WHOLE POINT AND IT IS TOTAL. A deleted row, an empty
// table, a database that has not run the migration yet, a row whose text is
// nonsense, a query that fails outright — none of them may break a send. So the
// database read is wrapped and ANY failure returns the code template, which is
// always there. Deleting a row is therefore the revert action rather than a
// destructive one. The failure is logged, never swallowed silently: a store
// that has quietly stopped being read looks exactly like one nobody has edited.
//
// A STORED TEMPLATE IS TEXT WITH `{{ placeholders }}`, not code. It cannot
// branch, cannot format and cannot throw — a code template can do all three
// (`formatCents`, the `xero_invoice_ref ? … : …` arm), which is why the code
// copy stays the source of the DEFAULT letter and this is only an override.
// An unknown or null placeholder renders EMPTY rather than throwing or leaving
// `{{ braces }}` in a client's inbox: a staffer who mistypes a field name gets a
// gap in the letter they are about to read on screen before sending, which is
// the one failure mode compose-before-send already catches.
//
// The name a row may carry is checked against TEMPLATE_NAMES at the route, not
// here and not by a CHECK constraint: the vocabulary is JavaScript's and moves
// with a deploy, so a constraint would have to be migrated in lockstep or start
// refusing rows the code is willing to render. Keeping the two in step is what
// makes the fallback total — every stored row has a code template behind it.

import { renderTemplate, TEMPLATE_NAMES } from './templates.js'

const noopLog = { error: () => {}, info: () => {} }

// `{{ field }}`, with or without the spaces. Deliberately not a general
// expression language: a letter is text.
const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi

/**
 * Substitute `{{ field }}` from `data`. A field that is absent, null or
 * undefined renders as an empty string — see the header for why that is not an
 * error.
 *
 * @param {string} text
 * @param {object} data
 * @returns {string}
 */
export const interpolate = (text, data = {}) =>
  String(text).replace(PLACEHOLDER, (_match, key) => {
    const value = data?.[key]
    return value === null || value === undefined ? '' : String(value)
  })

// Reading any field off this yields its own placeholder, so rendering a CODE
// template against it produces the default letter with `{{ field }}` still in
// it — which is exactly the editable "set letter" the CRM's editor opens for a
// name that has no row yet. Symbol keys answer undefined so the object still
// behaves as a plain value (a `then` that returned a string would make it look
// thenable to `await`).
const PLACEHOLDER_DATA = new Proxy(
  {},
  {
    get: (_target, key) => (typeof key === 'symbol' ? undefined : `{{ ${key} }}`),
    has: () => true,
  }
)

/**
 * The stored override for a name, or null. Never throws: a query failure is a
 * missing override, because the caller's next move is the code template.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {string} name
 * @param {{ log?: object }} [options]
 * @returns {Promise<{ subject: string, body: string }|null>}
 */
export const getStoredTemplate = async (db, name, { log = noopLog } = {}) => {
  try {
    const { rows } = await db.query(
      `SELECT subject, body FROM email_templates WHERE name = $1`,
      [name]
    )
    return rows[0] ?? null
  } catch (error) {
    log.error({ err: error, template: name }, 'email template store unreadable; using the code template')
    return null
  }
}

/**
 * Render a template, preferring the stored row. Returns the same
 * `{ subject, text }` shape `renderTemplate` does, plus `source` so a draft can
 * tell a staffer which letter they are looking at.
 *
 * @param {{ query: Function }} db pool or open client
 * @param {string} name one of TEMPLATE_NAMES
 * @param {object} [data]
 * @param {{ log?: object }} [options]
 * @returns {Promise<{ subject: string, text: string, source: 'database'|'code' }>}
 */
export const renderStoredTemplate = async (db, name, data = {}, { log = noopLog } = {}) => {
  const stored = await getStoredTemplate(db, name, { log })
  if (stored) {
    return Object.freeze({
      subject: interpolate(stored.subject, data),
      text: interpolate(stored.body, data),
      source: 'database',
    })
  }
  // Throws only for a name no code template knows, which is a code fault (the
  // route validates the name against TEMPLATE_NAMES) and not a caller's.
  return Object.freeze({ ...renderTemplate(name, data), source: 'code' })
}

/**
 * Every editable letter: the stored text where there is a row, the code
 * template rendered with its own placeholder names where there is not. One
 * entry per TEMPLATE_NAME, so the editor lists what exists rather than what has
 * been edited.
 *
 * @param {{ query: Function }} db
 * @returns {Promise<object[]>}
 */
export const listEmailTemplates = async (db) => {
  const { rows } = await db.query(
    `SELECT name, subject, body, created_at, updated_at FROM email_templates`
  )
  const stored = new Map(rows.map((row) => [row.name, row]))
  return TEMPLATE_NAMES.map((name) => {
    const row = stored.get(name)
    if (row) {
      return Object.freeze({
        name,
        subject: row.subject,
        body: row.body,
        source: 'database',
        updated_at: row.updated_at,
      })
    }
    const { subject, text } = renderTemplate(name, PLACEHOLDER_DATA)
    return Object.freeze({ name, subject, body: text, source: 'code', updated_at: null })
  })
}

/**
 * Write the override for a name. Upsert on `name`, so an editor saving twice is
 * one row and never a 409 the staffer has to interpret.
 *
 * @param {{ query: Function }} db
 * @param {string} name
 * @param {{ subject: string, body: string }} input
 * @returns {Promise<object>}
 */
export const upsertEmailTemplate = async (db, name, { subject, body }) => {
  const { rows } = await db.query(
    `INSERT INTO email_templates (name, subject, body)
     VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE
        SET subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = now()
     RETURNING name, subject, body, updated_at`,
    [name, subject, body]
  )
  return Object.freeze({ ...rows[0], source: 'database' })
}

/**
 * Drop the override, reverting the name to its code template. Returns whether a
 * row was there — the caller answers 404 for a name that was never overridden,
 * which is a different statement from "that name does not exist".
 *
 * @param {{ query: Function }} db
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export const deleteEmailTemplate = async (db, name) => {
  const { rowCount } = await db.query(`DELETE FROM email_templates WHERE name = $1`, [name])
  return rowCount > 0
}
