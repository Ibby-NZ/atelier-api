// Mailchimp audience sign-up for the storefront's footer form.
//
// One call: PUT /lists/{id}/members/{subscriber_hash} with status_if_new
// "pending" — Mailchimp then sends its own double opt-in mail and nothing here
// has to know whether the address was already on the list (PUT is upsert, so a
// repeat sign-up is a 200 and the person just sees "check your inbox" again).
// POST /members would 400 "Member Exists" on the second try and force a
// branch for something that is not an error.
//
// The data centre is the suffix of the API key (`...-us21`); MAILCHIMP_SERVER
// is that suffix. The audience id is Audience → Settings → Audience name and
// defaults → "Audience ID".

import { createHash } from 'node:crypto'

const NOT_CONFIGURED = 'Newsletter sign-up is not available yet.'
const FAILED = 'We could not add you to the list right now. Please try again shortly.'

export const NEWSLETTER_MESSAGES = Object.freeze({ NOT_CONFIGURED, FAILED })

/**
 * Subscriber hash: MD5 of the lowercased address, per Mailchimp's docs.
 * @param {string} email
 */
export const subscriberHash = (email) =>
  createHash('md5').update(email.trim().toLowerCase()).digest('hex')

/**
 * The request Mailchimp expects. Pure, so the test can assert it without a
 * network.
 * @param {{ server: string, audienceId: string, apiKey: string }} config
 * @param {string} email
 */
export const memberRequest = (config, email) => ({
  url: `https://${config.server}.api.mailchimp.com/3.0/lists/${config.audienceId}/members/${subscriberHash(email)}`,
  init: {
    method: 'PUT',
    headers: {
      authorization: `Basic ${Buffer.from(`key:${config.apiKey}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email_address: email.trim(), status_if_new: 'pending' }),
  },
})

/**
 * Add (or re-affirm) one address on the audience.
 * @param {{ server: string, audienceId: string, apiKey: string }} config
 * @param {string} email
 * @param {{ fetchImpl?: typeof fetch }} [deps]
 * @returns {Promise<{ status: string }>} Mailchimp's member status (pending|subscribed|…)
 */
export const subscribe = async (config, email, { fetchImpl = fetch } = {}) => {
  const { url, init } = memberRequest(config, email)
  const response = await fetchImpl(url, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    // Mailchimp's error body: { title, status, detail }. Surface the title so
    // the log says "Invalid Resource" / "Forgotten Email Not Subscribed"
    // rather than just 400.
    throw new Error(`Mailchimp ${response.status} ${body.title ?? ''}: ${body.detail ?? ''}`.trim())
  }
  return { status: body.status }
}
