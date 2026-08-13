/**
 * Staff-editable letters (W20-US-003, FR-254/FR-255).
 *
 * The client's words: "at the moment we have a workflow that does it but it's
 * got a set letter. We would love it if rather than the set template letter you
 * could actually go in there and write something specific. So there could be a
 * set letter, but the option to edit it."
 *
 * That is two requirements, and this table is the first of them: the SET LETTER
 * is editable without a deploy. The second — editing one message on its way out
 * — is the compose-before-send half in src/samples/sample-reminders.js, where
 * the staffer is handed a rendered draft and sends the body they approved.
 *
 * A ROW IS AN OVERRIDE, NEVER THE ONLY COPY. `src/email/templates.js` still
 * holds a code template for every name, and `renderStoredTemplate`
 * (src/email/template-store.js) prefers this row and FALLS BACK to the code
 * one — so a deleted row, an empty table or a database that has not been
 * migrated yet can never break a send. Deleting a row is therefore the revert
 * action, and it is safe by construction rather than by a screen remembering to
 * warn about it.
 *
 * `name` IS UNIQUE AND IS THE KEY. One letter per moment; a duplicate is the
 * database's 23505 mapped to a 409, never a pre-check. The route validates the
 * name against `TEMPLATE_NAMES` so a row can only ever exist for a name the
 * code can also render — which is what keeps the fallback total. There is
 * deliberately no CHECK here holding that list: the vocabulary lives in
 * JavaScript, it changes with a deploy, and a CHECK would have to be migrated
 * in lockstep or start refusing rows the code is willing to render.
 *
 * `body` IS TEXT, NOT HTML. Every template in src/email/templates.js renders
 * `{ subject, text }` and the mailer sends `text`; a stored row that held
 * markup would be delivered as literal angle brackets. Placeholders are
 * `{{ field }}` and an unknown one renders empty — see template-store.js for
 * why an unknown placeholder must not throw.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('email_templates', {
    id: 'id',
    // The moment this letter belongs to, e.g. `sample_loan_reminder`. Unique:
    // one override per template.
    name: { type: 'text', notNull: true, unique: true },
    // Both NOT NULL: a row that overrides half a letter would leave the other
    // half coming from the code template, and a reader of the CRM's editor
    // could not tell which of the two they were looking at.
    subject: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
  pgm.dropTable('email_templates')
}
