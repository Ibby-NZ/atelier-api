// Contact form endpoint + back-office enquiries inbox.
//
// POST /contact is public (guests contact us) and rate-limited like the auth
// routes so the store can't be used to spam the back office. The inbox routes
// under /admin are backoffice-only. Business logic lives in ../contact/contact.js;
// these handlers stay thin.

import {
  validateContactInput,
  createEnquiry,
  listEnquiries,
  setEnquiryArchived,
} from '../contact/contact.js'
import { deleteOrExplain, replyDelete } from '../lifecycle/delete.js'
import { notifyContactReceived } from '../email/notifications.js'

// Same posture as register/login: 10 submissions per 15 min per IP.
const CONTACT_RATE_LIMIT = Object.freeze({ max: 10, timeWindow: 15 * 60 * 1000 })

// Structural only (gross violations -> 400). Blank/invalid email is a 422 with a
// field-level message the storefront renders inline.
const contactBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'email', 'message'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    email: { type: 'string', minLength: 1, maxLength: 254 },
    phone: { type: 'string', maxLength: 50 },
    subject: { type: 'string', maxLength: 200 },
    message: { type: 'string', minLength: 1, maxLength: 5000 },
  },
}

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    include_archived: { type: 'boolean', default: false },
  },
}

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'integer', minimum: 1 },
  },
}

export const contactRoutes = async (app, { pool, mailer = null }) => {
  // Public: anyone can send an enquiry. A logged-in sender is linked via user_id
  // but a session is never required.
  app.post(
    '/contact',
    { schema: { body: contactBodySchema }, config: { rateLimit: CONTACT_RATE_LIMIT } },
    async (request, reply) => {
      const errors = validateContactInput(request.body)
      if (errors.length > 0) {
        reply.code(422)
        return { error: 'Unprocessable Entity', message: 'Validation failed.', errors }
      }

      const user = await app.guards.loadOptionalUser(request)
      const enquiry = await createEnquiry(pool, {
        name: request.body.name,
        email: request.body.email,
        phone: request.body.phone,
        subject: request.body.subject,
        message: request.body.message,
        userId: user?.id ?? null,
      })

      // Acknowledge + alert the back office. Never fails the request.
      await notifyContactReceived(mailer, enquiry)

      reply.code(201)
      return { enquiry }
    }
  )

  const backoffice = app.guards.requireRole('backoffice')

  // Back-office inbox, newest first. ?include_archived=true shows tidied ones.
  app.get(
    '/admin/contact-enquiries',
    { preHandler: backoffice, schema: { querystring: listQuerySchema } },
    async (request) => {
      const enquiries = await listEnquiries(pool, {
        includeArchived: request.query.include_archived,
      })
      return { enquiries }
    }
  )

  // Archive (soft-delete) an enquiry once it's been dealt with.
  app.post(
    '/admin/contact-enquiries/:id/archive',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const enquiry = await setEnquiryArchived(pool, request.params.id, true)
      if (!enquiry) {
        reply.code(404)
        return { error: 'Not Found', message: `Enquiry ${request.params.id} not found.` }
      }
      return { enquiry }
    }
  )

  app.post(
    '/admin/contact-enquiries/:id/restore',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) => {
      const enquiry = await setEnquiryArchived(pool, request.params.id, false)
      if (!enquiry) {
        reply.code(404)
        return { error: 'Not Found', message: `Enquiry ${request.params.id} not found.` }
      }
      return { enquiry }
    }
  )

  // Hard delete, for spam — archiving keeps it in the inbox behind a flag, which
  // is the wrong answer for a message nobody should ever read again. Nothing
  // references contact_enquiries, so the registry entry has no probes and no
  // guard; `deleteOrExplain` returns its refusal rather than throwing it, so the
  // handler pipes the result straight to `replyDelete`. The entity name is a
  // code literal, never `:entity` from the URL — the registry knows 'brand' and
  // 'user' alike, so it is not an authorisation boundary.
  app.delete(
    '/admin/contact-enquiries/:id',
    { preHandler: backoffice, schema: { params: idParamsSchema } },
    async (request, reply) =>
      replyDelete(
        reply,
        await deleteOrExplain(pool, 'contact_enquiry', request.params.id, {
          user: request.user,
        })
      )
  )
}
