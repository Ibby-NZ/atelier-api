// The staff-editable letters (W20-US-003 / US-006, FR-254/FR-255).
//
// The client asked for "a set letter, but the option to edit it". This is the
// SET letter: `email_templates` holds a subject and body per template name, and
// `renderStoredTemplate` prefers it over the code template every send. Editing
// one message on its way out is the other half and lives with the thing being
// sent (src/samples/sample-reminders.js).
//
// A ROW MAY ONLY EXIST FOR A NAME THE CODE ALSO RENDERS. `:name` is an enum of
// `TEMPLATE_NAMES`, so an unknown name is a 400 rather than an orphan row —
// which is what keeps the fallback total: every override has a code template
// behind it, so deleting a row can only ever revert a letter and never delete
// one. That check lives here rather than in a CHECK constraint because the
// vocabulary is JavaScript's and moves with a deploy.
//
// DELETE IS THE REVERT BUTTON, and it is safe by construction rather than by a
// dialog remembering to warn about it.
//
// Backoffice-only (director inherits). A letter that goes to clients over
// Atelier's name is not something a client edits.

import {
  listEmailTemplates,
  upsertEmailTemplate,
  deleteEmailTemplate,
} from '../email/template-store.js'
import { TEMPLATE_NAMES } from '../email/templates.js'

const nameParamsSchema = {
  type: 'object',
  required: ['name'],
  properties: {
    // The enum is the whitelist: an unknown name is a 400 here and never
    // reaches a row.
    name: { type: 'string', enum: [...TEMPLATE_NAMES] },
  },
}

// Both required: a row that overrides half a letter would leave the other half
// coming from the code template, and nothing on screen could say which half is
// which.
const putBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', minLength: 1, maxLength: 500 },
    body: { type: 'string', minLength: 1, maxLength: 20000 },
  },
}

export const adminEmailTemplateRoutes = async (app, { pool }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // Every letter, whether or not it has been edited: a name with no row comes
  // back as its CODE template rendered with its own field names still in it
  // (`{{ holder_name }}`), so the editor opens on the default text with its
  // placeholders visible rather than on an empty box.
  app.get('/admin/email-templates', { preHandler: backoffice }, async () => ({
    email_templates: await listEmailTemplates(pool),
  }))

  // PUT, not PATCH: a letter is replaced whole. An upsert, so saving twice is
  // one row and never a 409 a staffer has to interpret.
  app.put(
    '/admin/email-templates/:name',
    { preHandler: backoffice, schema: { params: nameParamsSchema, body: putBodySchema } },
    async (request) => ({
      email_template: await upsertEmailTemplate(pool, request.params.name, request.body),
    })
  )

  app.delete(
    '/admin/email-templates/:name',
    { preHandler: backoffice, schema: { params: nameParamsSchema } },
    async (request, reply) => {
      const removed = await deleteEmailTemplate(pool, request.params.name)
      if (!removed) {
        // "That name was never overridden" is a different statement from "that
        // name does not exist" — the enum already refused the second.
        reply.code(404)
        return {
          error: 'Not Found',
          message: `"${request.params.name}" has no stored override; it is already the set letter.`,
        }
      }
      reply.code(204)
      return null
    }
  )
}
