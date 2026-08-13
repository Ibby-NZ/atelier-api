// The outstanding register and its reminders (W20-US-003, US-004, US-006,
// US-007 — FR-250, FR-253…FR-256, FR-267).
//
// The client's words: "we want them to get a reminder in 10 days to bring it
// back... so we can get a report of what's outstanding and we could click click
// click send them a reminder email, very politely." And on the letter: "there
// could be a set letter, but the option to edit it."
//
// What this file is built to catch:
//
//   - A READ THAT IS PER SAMPLE. `listSampleLoans` already answered "what
//     happened to this hanger"; the gap FR-250 names is the read ACROSS the
//     register, so the assertions span several samples at once.
//   - OVERDUE OR days_overdue GOING STORED. A derived value is only proved
//     derived by MOVING ITS INPUT: the test back-dates the loan's `due_back_at`
//     and asserts the answer flipped while nothing was written to the sample.
//     A single read passes against a stored boolean.
//   - A FALLBACK THAT IS NOT TOTAL. A deleted row, a store that cannot be read
//     at all — neither may break a send, because the code template is always
//     there.
//   - A PREVIEW THAT SENDS. "Editable before send" is only true while the draft
//     route delivers nothing, which is asserted over the capture transport
//     rather than over a status code.
//   - A RECORD WRITTEN FOR A LETTER THAT NEVER WENT, which would tell the
//     office a client had been chased and stop them chasing.
//
// There is no scheduler anywhere in this story, deliberately, so there is
// nothing here that waits: the queue is a read and the send is a call.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import runner from 'node-pg-migrate'
import { loadConfig } from '../src/config.js'
import { createPool } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { createMailer } from '../src/email/mailer.js'
import { listOutstandingLoans } from '../src/samples/sample-loan-queue.js'
import { REMINDER_TEMPLATE } from '../src/samples/sample-reminders.js'
import {
  renderStoredTemplate,
  listEmailTemplates,
  interpolate,
} from '../src/email/template-store.js'
import { TEMPLATE_NAMES } from '../src/email/templates.js'

const TEST_COOKIE_SECRET = 'test-cookie-secret-0123456789abcdef0123456789abcdef'
const PREFIX = 'w20-reminders-test'
const DOMAIN = 'w20-reminders-test.example.com'
const testEmail = (local) => `${local}@${DOMAIN}`
const PASSWORD = 'correct horse battery staple'
const FROM = 'atelier@example.test'
const BACKOFFICE = 'backoffice@example.test'

const DAY_MS = 86_400_000
const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString()

const sessionCookieFrom = (response) => {
  const setCookie = response.headers['set-cookie']
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header.split(';')[0]
}

// Captures instead of sending, so "the preview sends nothing" is an assertion
// about delivery rather than about a status code.
const captureTransport = () => {
  const sent = []
  return { sent, sendMail: async (message) => sent.push(message) }
}

// Reminders first (loan_id is RESTRICT), then loans (sample_id is RESTRICT),
// then samples. The trade account goes last of the fixtures — its literal guid
// 23505s the next run if a row survives.
const cleanupFixtures = async (pool) => {
  await pool.query(
    `DELETE FROM sample_loan_reminders
      WHERE loan_id IN (SELECT l.id FROM sample_loans l
                          JOIN samples s ON s.id = l.sample_id
                         WHERE s.barcode LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query(
    `DELETE FROM sample_loans
      WHERE sample_id IN (SELECT id FROM samples WHERE barcode LIKE $1)`,
    [`${PREFIX}%`]
  )
  await pool.query(`DELETE FROM samples WHERE barcode LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM trade_accounts WHERE legacy_customer_name LIKE $1`, [`${PREFIX}%`])
  await pool.query(`DELETE FROM email_templates WHERE name = $1`, [REMINDER_TEMPLATE])
}

const insertSample = (pool, barcode) =>
  pool
    .query('INSERT INTO samples (barcode, label) VALUES ($1, $2) RETURNING id', [
      barcode,
      `${barcode} hanger`,
    ])
    .then(({ rows }) => rows[0].id)

const openLoan = (pool, sampleId, holderName, { dueBackAt = null, tradeAccountId = null } = {}) =>
  pool
    .query(
      `INSERT INTO sample_loans (sample_id, holder_name, due_back_at, trade_account_id)
       VALUES ($1, $2, $3::timestamptz, $4) RETURNING id`,
      [sampleId, holderName, dueBackAt, tradeAccountId]
    )
    .then(({ rows }) => rows[0].id)

describe('outstanding samples and their reminders (W20)', () => {
  let pool
  let app
  let transport
  let backofficeCookie
  let customerCookie
  let tradeAccountId
  let clientUserId

  const inject = (method, url, cookie, payload) =>
    app.inject({ method, url, headers: cookie ? { cookie } : {}, payload })

  beforeAll(async () => {
    const config = loadConfig()
    pool = createPool(config.databaseUrl)
    await runner({
      databaseUrl: config.databaseUrl,
      dir: 'migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    })

    transport = captureTransport()
    app = buildApp({
      pool,
      cookieSecret: TEST_COOKIE_SECRET,
      logger: false,
      mailer: createMailer({ transport, from: FROM, backofficeEmail: BACKOFFICE }),
    })
    await app.ready()

    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])

    // Registered once — register shares a 10-per-15-min per-IP bucket.
    const boss = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('boss'), password: PASSWORD, name: 'Boss' },
    })
    backofficeCookie = sessionCookieFrom(boss)
    await pool.query(`UPDATE users SET role = 'backoffice' WHERE email = $1`, [testEmail('boss')])

    const shopper = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('shopper'), password: PASSWORD, name: 'Shopper' },
    })
    customerCookie = sessionCookieFrom(shopper)

    const client = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: testEmail('client'), password: PASSWORD, name: 'Client' },
    })
    expect(client.statusCode).toBe(201)
    clientUserId = client.json().user.id
  })

  afterAll(async () => {
    await cleanupFixtures(pool)
    await pool.query('DELETE FROM users WHERE email LIKE $1', [`%@${DOMAIN}`])
    await app.close()
    await pool.end()
  })

  beforeEach(async () => {
    await cleanupFixtures(pool)
    transport.sent.length = 0
    const account = await pool.query(
      `INSERT INTO trade_accounts (legacy_account_guid, legacy_customer_name)
       VALUES (gen_random_uuid(), $1) RETURNING id`,
      [`${PREFIX} Kedgley Architects`]
    )
    tradeAccountId = account.rows[0].id
    // The link that makes a suggested address possible at all.
    await pool.query(
      `INSERT INTO trade_account_users (trade_account_id, user_id) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET trade_account_id = EXCLUDED.trade_account_id`,
      [tradeAccountId, clientUserId]
    )
  })

  describe('the schema (US-003 / US-007)', () => {
    it('is a no-op when migrations run again', async () => {
      const config = loadConfig()
      const applied = await runner({
        databaseUrl: config.databaseUrl,
        dir: 'migrations',
        direction: 'up',
        migrationsTable: 'pgmigrations',
        log: () => {},
      })
      expect(applied).toEqual([])
    })

    it('creates email_templates and sample_loan_reminders', async () => {
      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['email_templates', 'sample_loan_reminders']]
      )
      expect(rows.map((row) => row.table_name).sort()).toEqual([
        'email_templates',
        'sample_loan_reminders',
      ])
    })

    it('holds one override per template name', async () => {
      await pool.query(`INSERT INTO email_templates (name, subject, body) VALUES ($1, 'a', 'b')`, [
        REMINDER_TEMPLATE,
      ])
      await expect(
        pool.query(`INSERT INTO email_templates (name, subject, body) VALUES ($1, 'c', 'd')`, [
          REMINDER_TEMPLATE,
        ])
      ).rejects.toMatchObject({ code: '23505' })
    })

    it('introduces no scheduling column anywhere', async () => {
      // "Editable before send" and "sent automatically at 2am" cannot both be
      // true of one message. A `scheduled_for` or an `attempts` here would be
      // the first half of the runner this platform deliberately does not have.
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sample_loan_reminders'`
      )
      const names = rows.map((row) => row.column_name)
      expect(names).toContain('sent_at')
      const offending = names.filter((name) =>
        /schedul|attempt|retry|next_run|due_at|queue/.test(name)
      )
      expect(offending).toEqual([])
    })
  })

  describe('the outstanding read (US-004)', () => {
    let lateLoanId
    let onTimeLoanId

    beforeEach(async () => {
      const lateSample = await insertSample(pool, `${PREFIX}-0001`)
      const onTimeSample = await insertSample(pool, `${PREFIX}-0002`)
      const returnedSample = await insertSample(pool, `${PREFIX}-0003`)
      const undatedSample = await insertSample(pool, `${PREFIX}-0004`)

      lateLoanId = await openLoan(pool, lateSample, 'Kedgley Architects', {
        dueBackAt: daysFromNow(-3),
        tradeAccountId,
      })
      onTimeLoanId = await openLoan(pool, onTimeSample, 'Someone Else', {
        dueBackAt: daysFromNow(7),
      })
      const returnedLoanId = await openLoan(pool, returnedSample, 'Gave It Back', {
        dueBackAt: daysFromNow(-30),
      })
      await pool.query('UPDATE sample_loans SET returned_at = now() WHERE id = $1', [
        returnedLoanId,
      ])
      await openLoan(pool, undatedSample, 'No Date Agreed')
    })

    it('reads across the whole register, not one sample at a time', async () => {
      const { loans, total } = await listOutstandingLoans(pool, { q: PREFIX })
      // Three open loans over three different samples; the returned one is not
      // outstanding and no filter may bring it back.
      expect(total).toBe(3)
      expect(loans.map((loan) => loan.barcode).sort()).toEqual([
        `${PREFIX}-0001`,
        `${PREFIX}-0002`,
        `${PREFIX}-0004`,
      ])
      expect(loans.every((loan) => loan.holder_name)).toBe(true)
    })

    it('is a tri-state overdue filter', async () => {
      const chase = await listOutstandingLoans(pool, { q: PREFIX, overdue: true })
      expect(chase.loans.map((loan) => loan.barcode)).toEqual([`${PREFIX}-0001`])

      // False is "out but not late back" — which INCLUDES the loan with no
      // agreed date, because a deadline nobody set cannot have passed.
      const notLate = await listOutstandingLoans(pool, { q: PREFIX, overdue: false })
      expect(notLate.loans.map((loan) => loan.barcode).sort()).toEqual([
        `${PREFIX}-0002`,
        `${PREFIX}-0004`,
      ])
    })

    it('filters by trade account and by due date', async () => {
      const byAccount = await listOutstandingLoans(pool, { q: PREFIX, tradeAccountId })
      expect(byAccount.loans.map((loan) => loan.id)).toEqual([lateLoanId])

      const dueSoon = await listOutstandingLoans(pool, { q: PREFIX, dueBefore: daysFromNow(1) })
      // The undated loan is deliberately absent: "no date agreed" is not "due
      // by tomorrow".
      expect(dueSoon.loans.map((loan) => loan.id)).toEqual([lateLoanId])
    })

    it('states how long a loan is overdue, and nothing for one that is not', async () => {
      const { loans } = await listOutstandingLoans(pool, { q: PREFIX })
      const late = loans.find((loan) => loan.id === lateLoanId)
      const onTime = loans.find((loan) => loan.id === onTimeLoanId)
      expect(late.overdue).toBe(true)
      expect(late.days_overdue).toBe(3)
      expect(onTime.overdue).toBe(false)
      // Null, not 0 — 0 would read as "due today".
      expect(onTime.days_overdue).toBeNull()
    })

    it('derives overdue rather than storing it', async () => {
      // The only test shape that can tell a derivation from a flag somebody
      // remembered to set: move the INPUT and read again, and check the sample
      // itself was not written to in the process.
      const before = await listOutstandingLoans(pool, { loanIds: [onTimeLoanId] })
      expect(before.loans[0].overdue).toBe(false)
      const stamp = await pool.query(
        `SELECT s.updated_at FROM samples s
           JOIN sample_loans l ON l.sample_id = s.id WHERE l.id = $1`,
        [onTimeLoanId]
      )

      await pool.query(`UPDATE sample_loans SET due_back_at = $2 WHERE id = $1`, [
        onTimeLoanId,
        daysFromNow(-1),
      ])

      const after = await listOutstandingLoans(pool, { loanIds: [onTimeLoanId] })
      expect(after.loans[0].overdue).toBe(true)
      const stampAfter = await pool.query(
        `SELECT s.updated_at FROM samples s
           JOIN sample_loans l ON l.sample_id = s.id WHERE l.id = $1`,
        [onTimeLoanId]
      )
      expect(stampAfter.rows[0].updated_at).toEqual(stamp.rows[0].updated_at)
    })

    it('suggests the linked trade account login as the address, and null otherwise', async () => {
      const { loans } = await listOutstandingLoans(pool, { q: PREFIX })
      const late = loans.find((loan) => loan.id === lateLoanId)
      expect(late.suggested_email).toBe(testEmail('client'))
      // A borrower who is not a trade client at all — an architect, a stylist,
      // Atelier's own staff — has no address on file, and the screen has to be
      // able to say so.
      expect(loans.find((loan) => loan.id === onTimeLoanId).suggested_email).toBeNull()
    })

    it('is served over HTTP to the back office only', async () => {
      const response = await inject('GET', `/admin/sample-loans?q=${PREFIX}`, backofficeCookie)
      expect(response.statusCode).toBe(200)
      expect(response.json().meta.total).toBe(3)
      expect((await inject('GET', '/admin/sample-loans', undefined)).statusCode).toBe(401)
      expect((await inject('GET', '/admin/sample-loans', customerCookie)).statusCode).toBe(403)
    })
  })

  describe('the template store (US-006)', () => {
    it('falls back to the code template when nothing is stored', async () => {
      const rendered = await renderStoredTemplate(pool, REMINDER_TEMPLATE, {
        holder_name: 'Kedgley',
        barcode: 'ATL-S-001000',
      })
      expect(rendered.source).toBe('code')
      expect(rendered.subject).toContain('ATL-S-001000')
      expect(rendered.text).toContain('Kedgley')
    })

    it('prefers the stored row and interpolates it', async () => {
      await inject('PUT', `/admin/email-templates/${REMINDER_TEMPLATE}`, backofficeCookie, {
        subject: 'Your sample {{ barcode }}',
        body: 'Dear {{ holder_name }}, it was due {{ due_back_at }}.',
      })
      const rendered = await renderStoredTemplate(pool, REMINDER_TEMPLATE, {
        holder_name: 'Kedgley',
        barcode: 'ATL-S-001000',
        due_back_at: '1 August 2026',
      })
      expect(rendered.source).toBe('database')
      expect(rendered.subject).toBe('Your sample ATL-S-001000')
      expect(rendered.text).toBe('Dear Kedgley, it was due 1 August 2026.')
    })

    it('reverts to the set letter when the row is deleted', async () => {
      await inject('PUT', `/admin/email-templates/${REMINDER_TEMPLATE}`, backofficeCookie, {
        subject: 'Edited',
        body: 'Edited',
      })
      const removed = await inject(
        'DELETE',
        `/admin/email-templates/${REMINDER_TEMPLATE}`,
        backofficeCookie
      )
      expect(removed.statusCode).toBe(204)
      const rendered = await renderStoredTemplate(pool, REMINDER_TEMPLATE, { barcode: 'X' })
      expect(rendered.source).toBe('code')
    })

    it('falls back when the store cannot be read at all', async () => {
      // A migration that has not run, a permission problem, a dropped table:
      // none of them may break a send, which is the entire reason the code
      // template stays the default rather than a seed row.
      const broken = {
        query: async () => {
          throw new Error('relation "email_templates" does not exist')
        },
      }
      const rendered = await renderStoredTemplate(broken, REMINDER_TEMPLATE, { barcode: 'X' })
      expect(rendered.source).toBe('code')
      expect(rendered.subject).toContain('X')
    })

    it('renders an unknown placeholder empty rather than throwing', async () => {
      // A staffer's typo must degrade to a gap they can see on screen before
      // sending, never to a 500 in the middle of a work queue.
      expect(interpolate('Hello {{ nobody }}!', { holder_name: 'x' })).toBe('Hello !')
      expect(interpolate('Due {{ due_back_at }}.', { due_back_at: null })).toBe('Due .')
    })

    it('lists every letter, with its placeholders visible for an unedited one', async () => {
      const templates = await listEmailTemplates(pool)
      expect(templates.map((template) => template.name).sort()).toEqual([...TEMPLATE_NAMES].sort())
      const reminder = templates.find((template) => template.name === REMINDER_TEMPLATE)
      expect(reminder.source).toBe('code')
      // The editor opens on the default text with its fields still named, not
      // on an empty box or on "undefined".
      expect(reminder.body).toContain('{{ holder_name }}')
      expect(reminder.body).not.toContain('undefined')
    })

    it('refuses a name no code template backs', async () => {
      // Every stored row must have a code template behind it, which is what
      // makes the fallback total and DELETE a revert rather than a deletion.
      const response = await inject('PUT', '/admin/email-templates/not_a_letter', backofficeCookie, {
        subject: 'x',
        body: 'y',
      })
      expect(response.statusCode).toBe(400)
    })

    it('is back-office only', async () => {
      expect((await inject('GET', '/admin/email-templates', undefined)).statusCode).toBe(401)
      expect((await inject('GET', '/admin/email-templates', customerCookie)).statusCode).toBe(403)
      const write = await inject(
        'PUT',
        `/admin/email-templates/${REMINDER_TEMPLATE}`,
        customerCookie,
        { subject: 'x', body: 'y' }
      )
      expect(write.statusCode).toBe(403)
    })
  })

  describe('compose and send (US-007)', () => {
    let loanId

    beforeEach(async () => {
      const sampleId = await insertSample(pool, `${PREFIX}-0100`)
      loanId = await openLoan(pool, sampleId, 'Kedgley Architects', {
        dueBackAt: daysFromNow(-10),
        tradeAccountId,
      })
    })

    it('renders a draft per loan and SENDS NOTHING', async () => {
      const response = await inject(
        'POST',
        '/admin/sample-loans/reminders/preview',
        backofficeCookie,
        { loan_ids: [loanId] }
      )
      expect(response.statusCode).toBe(200)
      const [draft] = response.json().drafts
      expect(draft.loan_id).toBe(loanId)
      expect(draft.to).toBe(testEmail('client'))
      expect(draft.subject).toContain(`${PREFIX}-0100`)
      expect(draft.body).toContain('Kedgley Architects')
      expect(draft.days_overdue).toBe(10)
      // The whole of "editable before send": the preview is a render, and a
      // status code cannot tell you whether an email left the building.
      expect(transport.sent).toEqual([])
    })

    it('reports a loan it will not draft rather than dropping it', async () => {
      const response = await inject(
        'POST',
        '/admin/sample-loans/reminders/preview',
        backofficeCookie,
        { loan_ids: [loanId, 999_999_999] }
      )
      expect(response.json().drafts).toHaveLength(1)
      expect(response.json().missing).toEqual([999_999_999])
    })

    it('sends the body the staffer approved, verbatim', async () => {
      const draft = await inject(
        'POST',
        '/admin/sample-loans/reminders/preview',
        backofficeCookie,
        { loan_ids: [loanId] }
      )
      const [{ subject }] = draft.json().drafts
      const edited = 'Hi — any chance we could have the hanger back this week? No rush.'

      const response = await inject('POST', '/admin/sample-loans/reminders', backofficeCookie, {
        loan_id: loanId,
        to: testEmail('client'),
        subject,
        body: edited,
      })
      expect(response.statusCode).toBe(201)

      // Verbatim: nothing re-rendered it from a template on the way out, which
      // is the failure a second render would introduce.
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0]).toMatchObject({
        to: testEmail('client'),
        subject,
        text: edited,
      })
      expect(response.json().reminder).toMatchObject({
        loan_id: loanId,
        sent_to: testEmail('client'),
        body: edited,
      })
      expect(response.json().reminder.sent_by).not.toBeNull()
    })

    it('records what was sent, and a second chase reads as the second', async () => {
      const send = (body) =>
        inject('POST', '/admin/sample-loans/reminders', backofficeCookie, {
          loan_id: loanId,
          to: testEmail('client'),
          subject: 'A gentle reminder',
          body,
        })

      await send('First, very politely.')
      const first = await inject('GET', `/admin/sample-loans?q=${PREFIX}-0100`, backofficeCookie)
      expect(first.json().loans[0].reminder_count).toBe(1)
      expect(first.json().loans[0].last_reminded_at).not.toBeNull()

      await send('Second, still politely.')
      const second = await inject('GET', `/admin/sample-loans?q=${PREFIX}-0100`, backofficeCookie)
      // The count is the point: a `last_reminded_at` column alone could not say
      // whether this client has been chased once or four times, which is what
      // decides between another letter and a phone call.
      expect(second.json().loans[0].reminder_count).toBe(2)

      const { rows } = await pool.query(
        `SELECT subject, body, sent_to FROM sample_loan_reminders
          WHERE loan_id = $1 ORDER BY id ASC`,
        [loanId]
      )
      expect(rows.map((row) => row.body)).toEqual([
        'First, very politely.',
        'Second, still politely.',
      ])
    })

    it('refuses to chase a sample that is already back', async () => {
      await pool.query('UPDATE sample_loans SET returned_at = now() WHERE id = $1', [loanId])
      const response = await inject('POST', '/admin/sample-loans/reminders', backofficeCookie, {
        loan_id: loanId,
        to: testEmail('client'),
        subject: 'x',
        body: 'y',
      })
      expect(response.statusCode).toBe(409)
      expect(transport.sent).toEqual([])
    })

    it('404s an unknown loan', async () => {
      const response = await inject('POST', '/admin/sample-loans/reminders', backofficeCookie, {
        loan_id: 999_999_999,
        to: testEmail('client'),
        subject: 'x',
        body: 'y',
      })
      expect(response.statusCode).toBe(404)
    })

    it('records nothing when the send fails', async () => {
      // mailer.send never throws — it reports — so the failure path is a
      // decision this route makes, not an exception it inherits. A record
      // written anyway would tell the office a client had been chased.
      const failing = buildApp({
        pool,
        cookieSecret: TEST_COOKIE_SECRET,
        logger: false,
        mailer: createMailer({
          transport: {
            sendMail: async () => {
              throw new Error('smtp refused')
            },
          },
          from: FROM,
          backofficeEmail: BACKOFFICE,
        }),
      })
      await failing.ready()
      const response = await failing.inject({
        method: 'POST',
        url: '/admin/sample-loans/reminders',
        headers: { cookie: backofficeCookie },
        payload: { loan_id: loanId, to: testEmail('client'), subject: 'x', body: 'y' },
      })
      expect(response.statusCode).toBe(502)
      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM sample_loan_reminders WHERE loan_id = $1',
        [loanId]
      )
      expect(rows[0].total).toBe(0)
      await failing.close()
    })

    it('says so rather than silently doing nothing when email is not configured', async () => {
      const mailless = buildApp({ pool, cookieSecret: TEST_COOKIE_SECRET, logger: false })
      await mailless.ready()
      const response = await mailless.inject({
        method: 'POST',
        url: '/admin/sample-loans/reminders',
        headers: { cookie: backofficeCookie },
        payload: { loan_id: loanId, to: testEmail('client'), subject: 'x', body: 'y' },
      })
      // Every other mail trigger in this API is a no-op without a mailer,
      // because it is a side effect of a request that must succeed anyway.
      // This request IS the send.
      expect(response.statusCode).toBe(503)
      await mailless.close()
    })

    it('guards both reminder routes', async () => {
      // Payloads are VALID: Fastify validates before it runs a preHandler, so a
      // malformed body would 400 and the assertion would pass with no guard.
      const surface = [
        ['POST', '/admin/sample-loans/reminders/preview', { loan_ids: [1] }],
        [
          'POST',
          '/admin/sample-loans/reminders',
          { loan_id: 1, to: 'a@b.test', subject: 'x', body: 'y' },
        ],
      ]
      for (const [method, url, payload] of surface) {
        expect((await inject(method, url, undefined, payload)).statusCode).toBe(401)
        expect((await inject(method, url, customerCookie, payload)).statusCode).toBe(403)
      }
    })
  })
})
