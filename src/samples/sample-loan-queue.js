// The outstanding register: what is out, everywhere (W20-US-004, FR-250/FR-267).
//
// `listSampleLoans` in ./admin-samples.js answers "what happened to THIS
// sample" — a loan history, one sample at a time. That was the whole of the
// register's loan read, and the gap FR-250 names is this one: the read ACROSS
// the register, which is at once the outstanding report and the reminder work
// queue, because those two screens ask one question.
//
// OVERDUE STAYS DERIVED AT READ TIME. `overdueExpression` is imported from
// admin-samples.js rather than re-spelled here, which is the point of it being
// a function of its alias: a queue and a sample card that computed "late"
// separately would eventually disagree, and the badge would be the one nobody
// believed. `sample_loans_overdue_idx` is what makes deriving it cheap.
//
// SAMPLES ARE NOT STOCK: nothing here reads or writes a quantity.

import {
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  escapeLike,
  overdueExpression,
} from './admin-samples.js'

// How long past its date a loan is, for the queue and for the letter it
// composes (FR-267: "with its holder, its due date and how long it is
// overdue"). Derived exactly as `overdue` is, and NULL rather than 0 for a loan
// that is not late — 0 would read as "due today".
const daysOverdueExpression = (alias) =>
  `CASE WHEN ${overdueExpression(alias)}
        THEN floor(EXTRACT(EPOCH FROM now() - ${alias}.due_back_at) / 86400)::int
        ELSE NULL END`

// A loan is outstanding iff `returned_at IS NULL`. That predicate is not a
// filter and is not overridable: a returned sample is not outstanding, and a
// route offering to include one would be answering a different question.
// ARCHIVED samples stay in: archiving is a decision about a CRM list, and an
// object somebody still has is still out.
const OUTSTANDING_FROM = `FROM sample_loans l
         JOIN samples s ON s.id = l.sample_id`

// Where the reminder goes, when we can tell — the loan's trade account's linked
// login. A SUGGESTION and nothing more: `sample_loans` carries no email column
// because plenty of borrowers are not trade clients at all (an architect, a
// stylist, Atelier's own staff), so the address is confirmed by the staffer at
// send time and snapshotted onto the reminder. Archived logins are skipped —
// every other auth path excludes them and a reminder to one bounces.
const SUGGESTED_EMAIL = `(SELECT u.email
                            FROM trade_account_users tau
                            JOIN users u ON u.id = tau.user_id
                           WHERE tau.trade_account_id = l.trade_account_id
                             AND u.archived_at IS NULL
                           ORDER BY u.id ASC
                           LIMIT 1)`

// How often this client has already been chased, and when last. Correlated
// scalar subqueries for the same reason `loan_count` is one: an aggregate join
// would need a GROUP BY over every selected column and would drag the counts
// into the COUNT query, where they are dead weight.
const REMINDER_COLUMNS = `(SELECT count(*)::int FROM sample_loan_reminders r WHERE r.loan_id = l.id)
                            AS reminder_count,
                          (SELECT max(r.sent_at) FROM sample_loan_reminders r WHERE r.loan_id = l.id)
                            AS last_reminded_at`

const toOutstandingLoan = (row) =>
  Object.freeze({
    id: row.id,
    sample_id: row.sample_id,
    barcode: row.barcode,
    label: row.label,
    sample_type: row.sample_type,
    location: row.location,
    holder_name: row.holder_name,
    trade_account_id: row.trade_account_id,
    suggested_email: row.suggested_email,
    out_at: row.out_at,
    due_back_at: row.due_back_at,
    notes: row.notes,
    // Derived every read, never stored — see the module header.
    overdue: row.overdue,
    days_overdue: row.days_overdue,
    // So the office can see a client has already been chased, and how often.
    reminder_count: row.reminder_count,
    last_reminded_at: row.last_reminded_at,
  })

const buildOutstandingWhere = ({ tradeAccountId, overdue, dueBefore, loanIds, q }) => {
  const clauses = ['l.returned_at IS NULL']
  const params = []

  if (Number.isInteger(tradeAccountId)) {
    params.push(tradeAccountId)
    clauses.push(`l.trade_account_id = $${params.length}`)
  }

  // Tri-state, like the register's: absent leaves the list alone, true is the
  // chase list, false is out but not yet late.
  if (overdue === true) {
    clauses.push(overdueExpression('l'))
  } else if (overdue === false) {
    clauses.push(`NOT ${overdueExpression('l')}`)
  }

  // "Due back before X". A loan with no agreed date is deliberately NOT matched
  // — the comparison yields NULL — because "no date agreed" is not "due by
  // Friday", and defaulting one would invent a deadline nobody set.
  if (dueBefore) {
    params.push(dueBefore)
    clauses.push(`l.due_back_at < $${params.length}::timestamptz`)
  }

  // The compose step's selection: exactly these loans, still subject to every
  // rule above, so a draft can never be rendered for a loan that came back.
  if (Array.isArray(loanIds)) {
    params.push(loanIds)
    clauses.push(`l.id = ANY($${params.length}::int[])`)
  }

  const term = typeof q === 'string' ? q.trim() : ''
  if (term) {
    params.push(`%${escapeLike(term)}%`)
    const i = params.length
    // The holder IS searched here, unlike the register's `q`: "what has Kedgley
    // got out" is a question about loans, and this is the loan list.
    clauses.push(`(
      l.holder_name ILIKE $${i} ESCAPE '\\'
      OR s.barcode ILIKE $${i} ESCAPE '\\'
      OR s.label ILIKE $${i} ESCAPE '\\'
    )`)
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params }
}

/**
 * Every open loan across the whole register, filtered and paginated. The
 * reminder work queue and the outstanding report are the same read.
 *
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @param {{ tradeAccountId?: number, overdue?: boolean, dueBefore?: string,
 *           loanIds?: number[], q?: string, page?: number, limit?: number }} [options]
 * @returns {Promise<{ loans: object[], total: number }>}
 */
export const listOutstandingLoans = async (
  db,
  { tradeAccountId, overdue, dueBefore, loanIds, q, page, limit } = {}
) => {
  const safePage = Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE
  const safeLimit =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const offset = (safePage - 1) * safeLimit

  const { where, params } = buildOutstandingWhere({
    tradeAccountId,
    overdue,
    dueBefore,
    loanIds,
    q,
  })

  const countResult = await db.query(
    `SELECT count(*)::int AS total ${OUTSTANDING_FROM} ${where}`,
    params
  )

  const { rows } = await db.query(
    `SELECT l.id, l.sample_id, l.holder_name, l.trade_account_id, l.out_at,
            l.due_back_at, l.notes,
            s.barcode, s.label, s.sample_type, s.location,
            ${overdueExpression('l')} AS overdue,
            ${daysOverdueExpression('l')} AS days_overdue,
            ${SUGGESTED_EMAIL} AS suggested_email,
            ${REMINDER_COLUMNS}
       ${OUTSTANDING_FROM}
       ${where}
      ORDER BY l.due_back_at ASC NULLS LAST, l.out_at ASC, l.id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, safeLimit, offset]
  )

  return { loans: rows.map(toOutstandingLoan), total: countResult.rows[0].total }
}

