// The test-drive valve — EMAIL_REDIRECT_TO.
//
// No database and no app: the valve lives in `createMailer`, which is the one
// function every send in the codebase passes through, and the whole point of
// putting it there is that no caller can opt out of it. These tests assert that
// property directly rather than through any one route.

import { describe, it, expect } from 'vitest'
import { createMailer } from '../src/email/mailer.js'
import { loadConfig } from '../src/config.js'

const REDIRECT = 'ibrahim@verum.nz'

const buildCapture = () => {
  const sent = []
  return { sent, sendMail: async (message) => void sent.push(message) }
}

const buildMailer = (redirectTo) => {
  const transport = buildCapture()
  return {
    transport,
    mailer: createMailer({
      transport,
      from: 'Atelier <no-reply@example.test>',
      backofficeEmail: 'orders@atelier.co.nz',
      redirectTo,
    }),
  }
}

describe('EMAIL_REDIRECT_TO', () => {
  it('delivers a supplier letter to the redirect address, never the supplier', async () => {
    const { transport, mailer } = buildMailer(REDIRECT)

    await mailer.send({
      to: 'commandes@maison-lelievre.fr',
      subject: 'Purchase order PO-000042',
      text: 'Please find our purchase order below.',
    })

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].to).toBe(REDIRECT)
    // The real recipient survives where a reader can see it — a redirected
    // inbox full of identical subjects is unreadable.
    expect(transport.sent[0].subject).toContain('commandes@maison-lelievre.fr')
    expect(transport.sent[0].text).toContain('REDIRECTED')
    expect(transport.sent[0].text).toContain('Please find our purchase order below.')
  })

  it('redirects the back-office address too, so orders@atelier.co.nz is never written to', async () => {
    const { transport, mailer } = buildMailer(REDIRECT)

    await mailer.send({
      to: mailer.backofficeEmail,
      subject: 'Purchase order sent: PO-000042',
      text: 'body',
    })

    expect(transport.sent[0].to).toBe(REDIRECT)
    expect(transport.sent.some((message) => message.to === 'orders@atelier.co.nz')).toBe(false)
  })

  it('leaves a letter already addressed to the redirect target untouched', async () => {
    const { transport, mailer } = buildMailer(REDIRECT)

    await mailer.send({ to: REDIRECT, subject: 'Direct', text: 'body' })

    expect(transport.sent[0].subject).toBe('Direct')
    expect(transport.sent[0].text).toBe('body')
  })

  it('delivers where it is addressed when the valve is closed', async () => {
    const { transport, mailer } = buildMailer(null)

    await mailer.send({ to: 'commandes@maison-lelievre.fr', subject: 'PO', text: 'body' })

    expect(transport.sent[0].to).toBe('commandes@maison-lelievre.fr')
    expect(transport.sent[0].subject).toBe('PO')
  })

  it('redirects a TEMPLATE send, not just a verbatim one', async () => {
    const { transport, mailer } = buildMailer(REDIRECT)

    await mailer.send({
      template: 'purchase_order_cancelled',
      to: 'commandes@maison-lelievre.fr',
      data: { po_number: 'PO-000042', supplier_name: 'Maison Lelievre' },
    })

    expect(transport.sent[0].to).toBe(REDIRECT)
    expect(transport.sent[0].text).toContain('PO-000042')
  })

  it('keeps Reply-To intact — the valve moves the recipient, not the conversation', async () => {
    const { transport, mailer } = buildMailer(REDIRECT)

    await mailer.send({
      to: 'orders@atelier.co.nz',
      replyTo: 'client@example.test',
      subject: 'New enquiry',
      text: 'body',
    })

    expect(transport.sent[0].to).toBe(REDIRECT)
    expect(transport.sent[0].replyTo).toBe('client@example.test')
  })

  it('is what the working .env has set — suppliers are not live yet', () => {
    // A guard on the actual configuration, not on the code: this repo is
    // mid-test-drive, and unsetting the valve is what makes purchase orders
    // start reaching real fabric houses. When the office is happy, DELETE this
    // test in the same commit that unsets the variable — deliberately, so that
    // going live is a decision somebody makes rather than a line that rots.
    expect(loadConfig().emailRedirectTo).toBe(REDIRECT)
  })
})
