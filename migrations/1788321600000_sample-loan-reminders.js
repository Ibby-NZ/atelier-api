/**
 * What was sent, to whom, by whom and when (W20-US-007, FR-256).
 *
 * The client's words: "we want them to get a reminder in 10 days to bring it
 * back... so we can get a report of what's outstanding and we could click click
 * click send them a reminder email, very politely."
 *
 * NO SCHEDULER IS INTRODUCED BY THIS TABLE OR ANYWHERE ELSE, and that is a
 * decision rather than an omission (architecture.md § Scheduling — the runner
 * that is not introduced). "Editable before send" and "sent automatically at
 * 2am" cannot both be true of one message, and the client asked for the first.
 * So there is no `due_at`, no `scheduled_for`, no `attempts` and no state
 * column: a row here is the record of a send that has ALREADY happened, written
 * after the mailer reported success. The queue is a read
 * (`GET /admin/sample-loans`), the send is a click, and the template is
 * editable in between. If a runner is ever introduced it arrives with its own
 * ADR, and the first thing it must not do is take over sending a message a
 * human was promised the chance to edit.
 *
 * THE ROW IS A COPY OF THE LETTER, NOT A POINTER TO A TEMPLATE. `subject` and
 * `body` hold the text that actually left the building. A template reference
 * would answer "which letter shape was used" and not "what did we say to this
 * client", and the second is the question the office asks when a client rings
 * back — especially given the whole point of the story is that a staffer may
 * rewrite the letter before sending it. It also means editing the stored
 * template later cannot rewrite history.
 *
 * WHY A TABLE AND NOT `sample_loans.last_reminded_at`. A column answers only
 * "when was the most recent chase", which is exactly the wrong grain: a second
 * reminder to the same client has to read as the SECOND one — the count and the
 * previous date are what tell a staffer whether to send a politer letter or
 * pick up the phone. `GET /admin/sample-loans` carries both as correlated
 * subqueries off this table.
 *
 * `loan_id` IS RESTRICT, like `sample_loans.sample_id`. A reminder is history
 * about a movement; CASCADE would let removing the movement destroy the record
 * that a client was chased, silently. `sample_loans` itself carries no
 * `archived_at` and no delete route, so nothing routinely tries.
 *
 * `sent_by` IS SET NULL. Who sent it is a fact about the day, and a staff
 * account being archived or deleted afterwards must not rewrite it — the same
 * reasoning `orders.user_id` and `trade_applications.user_id` carry. There is
 * no NOT NULL to hold here anyway: the row survives the person.
 *
 * `sent_to` IS A SNAPSHOT, exactly like `sample_loans.holder_name`. A loan has
 * no email column — plenty of borrowers are not trade clients at all — so the
 * address is approved by the staffer at send time and written here as what was
 * used, never re-derived. Re-deriving it later would answer the question with
 * today's contact details for a letter posted months ago.
 *
 * SAMPLES ARE NOT STOCK: nothing here holds a quantity and no send writes one.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('sample_loan_reminders', {
    id: 'id',
    // RESTRICT: see the header. History about a movement is not an owned child.
    loan_id: {
      type: 'integer',
      notNull: true,
      references: 'sample_loans',
      onDelete: 'RESTRICT',
    },
    // The staff login that clicked send. SET NULL — the record outlives them.
    sent_by: {
      type: 'integer',
      references: 'users',
      onDelete: 'SET NULL',
    },
    // The address it actually went to, as approved at send time.
    sent_to: { type: 'text', notNull: true },
    // The letter as sent, after any edit. Both NOT NULL: half a record of what
    // was said is not a record of what was said.
    subject: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    // Its own column rather than `created_at` alone, the posture
    // `sample_loans.out_at` and `sample_orders.requested_at` already take.
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  // The queue's two derived figures — how many times this loan has been chased
  // and when it last was — are correlated subqueries on this column.
  pgm.createIndex('sample_loan_reminders', 'loan_id')
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('sample_loan_reminders')
}
