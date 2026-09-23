// Who hears about a sales order's status changes (23 Sep 2026): the client,
// the order's sales rep, and the extra addresses the office adds in the CRM's
// Emails section on the order (`orders.notify_emails`).
//
// THIS MODULE IS PURE AND IMPORTS NOTHING, the order-states.js posture: the
// route schema, the edit path and the notifier all read it, and the CRM mirrors
// it (src/screens/adminOrders.js) so its Add button refuses what the API would
// rather than discovering the 400.

/**
 * How many extra addresses one order may carry. A list is for the client's
 * own people — the accounts desk, the designer's assistant — not a mailing
 * list; ten is generous for that and small enough that a mistyped paste cannot
 * turn one status change into a blast.
 */
export const NOTIFY_EMAILS_MAX = 10

/**
 * Mirror of the auth EMAIL_PATTERN — Fastify's bundled Ajv carries no `email`
 * format. No whitespace anywhere, which is also what keeps a line break (a
 * header injection) out of a `to`.
 */
export const NOTIFY_EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

/**
 * Addresses in their given order, each ONCE. Blank, null and non-string
 * entries drop out; the comparison ignores case and surrounding space, and the
 * first spelling wins.
 *
 * Used twice, for two reasons: on the way IN, so the stored list never holds
 * one address twice; and at SEND time, across client + rep + list, so a rep who
 * is also the client (or an address typed into the list that is already the
 * client's) gets one letter, not two.
 *
 * @param {Array<string|null|undefined>} emails
 * @returns {string[]}
 */
export const uniqueEmails = (emails = []) => {
  const seen = new Set()
  const out = []
  for (const value of emails ?? []) {
    if (typeof value !== 'string') continue
    const email = value.trim()
    if (email === '') continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(email)
  }
  return out
}
