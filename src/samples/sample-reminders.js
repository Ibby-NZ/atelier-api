// Chasing an outstanding sample (W20-US-007, FR-253…FR-256).
//
// The client's words: "we want them to get a reminder in 10 days to bring it
// back... so we can get a report of what's outstanding and we could click click
// click send them a reminder email, very politely." And, about the letter: "at
// the moment we have a workflow that does it but it's got a set letter. We
// would love it if... you could actually go in there and write something
// specific."
//
// THERE IS NO SCHEDULER, AND THAT IS THE DESIGN RATHER THAN AN OMISSION.
// "Editable before send" and "sent automatically at 2am" cannot both be true of
// one message, and she asked for the first. So a reminder is a STAFF ACTION off
// a work queue: `listOutstandingLoans` is the queue, `draftLoanReminders`
// renders what would be sent, a human edits it, and `sendLoanReminder` sends
// the body they approved. No cron, no worker, no queue and no timer is
// introduced anywhere by this story, which keeps a property the platform
// already has: there is no background process to monitor, no dead-letter state
// to reason about, and nothing that fails silently at 2am while everyone is
// asleep. (architecture.md § Scheduling — the runner that is not introduced.)
// If a runner is ever added it arrives with its own ADR, and the first thing it
// must not do is take over sending a message a human was promised the chance to
// edit.
//
// THE DRAFT AND THE SEND ARE TWO CALLS ON PURPOSE. A single "send with a
// template" route would render the letter at send time — which is to say, after
// the staffer stopped looking at it — so the text approved on screen and the
// text delivered would be two different renders of the same template, against
// a store an editor may have changed in between. The draft route therefore
// returns finished text and the send route takes finished text
// (`mailer.send({ subject, text })`, never a template name).
//
// A SEND IS RECORDED ONLY ONCE THE MAILER SAYS IT WENT. Writing the record
// first would tell the office a client had been chased when nothing left the
// building, and "already chased" is precisely what stops somebody chasing.
//
// SAMPLES ARE NOT STOCK: nothing here reads or writes a quantity.

import { listOutstandingLoans } from './sample-loan-queue.js'
import { renderStoredTemplate } from '../email/template-store.js'

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode })

// The set letter's name in both `src/email/templates.js` and `email_templates`.
// One constant, so the stored override and the code fallback are the same
// letter by construction.
export const REMINDER_TEMPLATE = 'sample_loan_reminder'

// Dates are formatted HERE, not in the template. A template is a pure function
// of already-presentable data — that is what lets the stored override be plain
// text with `{{ placeholders }}` and no formatting language behind it — and a
// letter to a client reading "2026-08-21T12:00:00.000Z" is the alternative.
const formatDate = (value) =>
  value == null
    ? null
    : new Date(value).toLocaleDateString('en-NZ', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })

// What the letter may interpolate. Every one of these is derived at read time
// from the loan; nothing is stored pre-rendered.
const reminderData = (loan) => ({
  holder_name: loan.holder_name,
  barcode: loan.barcode,
  label: loan.label,
  due_back_at: formatDate(loan.due_back_at),
  days_overdue: loan.days_overdue,
})

/**
 * Render — and do NOT send — one reminder per loan, so a staffer sees exactly
 * what would go out and can rewrite it first.
 *
 * A loan that is unknown or already back comes out in `missing` rather than
 * being silently dropped: the queue is a screen somebody selected rows on, and
 * a draft list quietly shorter than the selection reads as a rendering bug.
 *
 * @param {{ query: Function }} db
 * @param {number[]} loanIds
 * @param {{ log?: object }} [options]
 * @returns {Promise<{ drafts: object[], missing: number[] }>}
 */
export const draftLoanReminders = async (db, loanIds, { log } = {}) => {
  const ids = [...new Set(loanIds)]
  const { loans } = await listOutstandingLoans(db, { loanIds: ids, limit: ids.length })

  const drafts = []
  for (const loan of loans) {
    // One store read per loan. The alternative — read the template once and
    // interpolate per loan — would need the store's interpolation rules out
    // here, in a second copy, and this is a queue of tens of rows.
    const { subject, text, source } = await renderStoredTemplate(
      db,
      REMINDER_TEMPLATE,
      reminderData(loan),
      { log }
    )
    drafts.push(
      Object.freeze({
        loan_id: loan.id,
        sample_id: loan.sample_id,
        barcode: loan.barcode,
        label: loan.label,
        holder_name: loan.holder_name,
        trade_account_id: loan.trade_account_id,
        // A suggestion the staffer confirms or replaces — a loan carries no
        // email column, deliberately. Null means "we have no address for this
        // borrower", which the screen has to be able to say out loud.
        to: loan.suggested_email,
        subject,
        body: text,
        // Which letter this is: the stored override or the code default.
        source,
        due_back_at: loan.due_back_at,
        overdue: loan.overdue,
        days_overdue: loan.days_overdue,
        reminder_count: loan.reminder_count,
        last_reminded_at: loan.last_reminded_at,
      })
    )
  }

  const found = new Set(drafts.map((draft) => draft.loan_id))
  return Object.freeze({
    drafts: Object.freeze(drafts),
    missing: Object.freeze(ids.filter((id) => !found.has(id))),
  })
}

/**
 * Send the letter a staffer approved, then record what went, to whom, by whom
 * and when.
 *
 * The body is used VERBATIM. Nothing re-renders it and nothing appends to it:
 * the point of the story is that the text on the screen is the text delivered.
 *
 * @param {import('pg').Pool} pool
 * @param {object|null} mailer
 * @param {{ loanId: number, to: string, subject: string, body: string, sentBy?: number|null }} input
 * @returns {Promise<{ reminder: object, loan: object|null }>}
 */
export const sendLoanReminder = async (pool, mailer, { loanId, to, subject, body, sentBy }) => {
  // Two states to tell apart, so the answer names the actual problem: an id
  // nobody has (404) against a sample that is already back (409, and sending
  // would be the register arguing with a client who did what was asked).
  const { rows } = await pool.query(`SELECT id, returned_at FROM sample_loans WHERE id = $1`, [
    loanId,
  ])
  if (!rows[0]) {
    throw httpError(404, `Sample loan ${loanId} not found.`)
  }
  if (rows[0].returned_at !== null) {
    throw httpError(409, `Sample loan ${loanId} is already back, so there is nothing to chase.`)
  }

  // A no-op mailer would let the office believe a client had been chased. Every
  // other trigger in src/email/notifications.js is a side effect of a request
  // that must succeed regardless; this request IS the send, so it fails loudly.
  if (!mailer) {
    throw httpError(503, 'Email is not configured on this server, so no reminder was sent.')
  }

  const result = await mailer.send({ to, subject, text: body })
  if (!result.ok) {
    // mailer.send never throws — it reports. Nothing is recorded: a record of a
    // send that failed is worse than no record, because it stops the chase.
    throw httpError(502, 'The reminder could not be sent, so nothing was recorded. Try again.')
  }

  const inserted = await pool.query(
    `INSERT INTO sample_loan_reminders (loan_id, sent_by, sent_to, subject, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, loan_id, sent_by, sent_to, subject, body, sent_at`,
    [loanId, sentBy ?? null, to, subject, body]
  )

  // The queue row as it now reads — reminder_count bumped, last_reminded_at
  // stamped — so the screen re-renders from the same read model it listed from
  // rather than patching a row locally. Same posture as every sample write
  // returning through `getSample`.
  const { loans } = await listOutstandingLoans(pool, { loanIds: [loanId], limit: 1 })

  return Object.freeze({
    reminder: Object.freeze(inserted.rows[0]),
    loan: loans[0] ?? null,
  })
}
