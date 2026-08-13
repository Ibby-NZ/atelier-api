// The outstanding register and its reminders (W20-US-004 / US-007, FR-250,
// FR-253…FR-256, FR-267).
//
// `GET /admin/sample-loans` reads ACROSS the whole register — the gap FR-250
// names, since the loan read was per sample and answered "what happened to this
// hanger". It is the outstanding report and the reminder work queue at once,
// because those two screens ask one question.
//
// NOTHING HERE IS SCHEDULED, and that is the design. "Editable before send" and
// "sent automatically at 2am" cannot both be true of one message, and the
// client asked for the first — so the queue is a read, the send is a click, and
// the letter is editable in between. No cron, no worker, no queue.
//
// THE DRAFT AND THE SEND ARE TWO ROUTES on purpose: a single "send from a
// template" call would render the letter after the staffer stopped looking at
// it, so the text approved on screen and the text delivered would be two
// renders of a template an editor may have changed in between.
//
// It is its own plugin rather than a block in ./admin-samples.js — the only
// samples surface that is — for two reasons: that file had reached the
// 800-line ceiling, and this is the one that needs the MAILER, which no other
// route in the register does. Same guard, same domain, one more line in
// src/app.js.

import { listOutstandingLoans } from '../samples/sample-loan-queue.js'
import { draftLoanReminders, sendLoanReminder } from '../samples/sample-reminders.js'
import { DEFAULT_PAGE, DEFAULT_LIMIT, MAX_LIMIT } from '../samples/admin-samples.js'

// Fastify's bundled Ajv carries no `format` keywords (the same reason the auth
// schemas use EMAIL_PATTERN), so a timestamp is a pattern: a date, optionally
// with a time and an offset. It polices the SHAPE only — `2026-02-31` gets
// through and Postgres refuses it.
const timestampProp = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}([T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?)?$',
}

const loanListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    trade_account_id: { type: 'integer', minimum: 1 },
    // Tri-state, like the register's: absent is everything still out, true is
    // the chase list, false is out but not yet late.
    overdue: { type: 'boolean' },
    due_before: timestampProp,
    q: { type: 'string', maxLength: 200 },
    page: { type: 'integer', minimum: 1, default: DEFAULT_PAGE },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
}

// A page of the work queue at a time, so one click cannot render the whole
// register into a response nobody reads.
const MAX_DRAFTS = 50

const reminderDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['loan_ids'],
  properties: {
    loan_ids: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_DRAFTS,
      items: { type: 'integer', minimum: 1 },
    },
  },
}

// Mirror of the auth EMAIL_PATTERN — Fastify's bundled Ajv carries no `email`
// format, the same reason every timestamp here is a regex.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

// Everything is required and nothing is defaulted: the address, the subject and
// the body are what a person approved on screen, and a field the server filled
// in behind them is a field nobody read before it reached a client.
const reminderSendSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['loan_id', 'to', 'subject', 'body'],
  properties: {
    loan_id: { type: 'integer', minimum: 1 },
    to: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    subject: { type: 'string', minLength: 1, maxLength: 500 },
    body: { type: 'string', minLength: 1, maxLength: 20000 },
  },
}

export const adminSampleLoanRoutes = async (app, { pool, mailer = null }) => {
  const backoffice = app.guards.requireRole('backoffice')

  // Every open loan, everywhere (W20-US-004). `/admin/sample-loans` shares no
  // prefix with `/admin/samples/:id`, so the two cannot collide the way a
  // `/admin/samples/loans` would have.
  app.get(
    '/admin/sample-loans',
    { preHandler: backoffice, schema: { querystring: loanListQuerySchema } },
    async (request) => {
      const { trade_account_id, overdue, due_before, q, page, limit } = request.query
      const { loans, total } = await listOutstandingLoans(pool, {
        tradeAccountId: trade_account_id,
        overdue,
        dueBefore: due_before,
        q,
        page,
        limit,
      })
      return { loans, meta: { total, page, limit } }
    }
  )

  // RENDERED, NOT SENT. The staffer reads what would go out, edits it, and
  // posts it back to the route below — which is the whole of "there could be a
  // set letter, but the option to edit it".
  app.post(
    '/admin/sample-loans/reminders/preview',
    { preHandler: backoffice, schema: { body: reminderDraftSchema } },
    async (request) => draftLoanReminders(pool, request.body.loan_ids, { log: request.log })
  )

  // The send. `sent_by` comes from the SESSION, never the body: who chased a
  // client is not something the caller gets to state.
  app.post(
    '/admin/sample-loans/reminders',
    { preHandler: backoffice, schema: { body: reminderSendSchema } },
    async (request, reply) => {
      const sent = await sendLoanReminder(pool, mailer, {
        loanId: request.body.loan_id,
        to: request.body.to,
        subject: request.body.subject,
        body: request.body.body,
        sentBy: request.user.id,
      })
      reply.code(201)
      return sent
    }
  )
}
