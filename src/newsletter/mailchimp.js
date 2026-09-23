// Mailchimp audience sign-up for the storefront's footer form, and for the
// trade form's "happy to receive notifications from Mailchimp?" Yes.
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
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [deps]
 * @returns {Promise<{ status: string }>} Mailchimp's member status (pending|subscribed|…)
 */
export const subscribe = async (config, email, { fetchImpl = fetch, signal } = {}) => {
  const { url, init } = memberRequest(config, email)
  const response = await fetchImpl(url, { ...init, signal })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    // Mailchimp's error body: { title, status, detail }. Surface the title so
    // the log says "Invalid Resource" / "Forgotten Email Not Subscribed"
    // rather than just 400.
    throw new Error(`Mailchimp ${response.status} ${body.title ?? ''}: ${body.detail ?? ''}`.trim())
  }
  return { status: body.status }
}

// Long enough for a slow Mailchimp, short enough that an applicant is never
// left watching a spinner for it.
const SIDE_SIGN_UP_TIMEOUT_MS = 5000

/**
 * subscribe() as a side effect of something else that has already succeeded —
 * the trade form's opt-in, after the account and form are committed. Never
 * throws and never waits past SIDE_SIGN_UP_TIMEOUT_MS: unconfigured is a no-op,
 * a refusal or timeout is logged and swallowed, because the application must
 * not fail over its newsletter box.
 *
 * @param {{ server: string, audienceId: string, apiKey: string }|null} config
 * @param {string} email
 * @param {{ fetchImpl?: typeof fetch, log?: { error: Function } }} [deps]
 * @returns {Promise<string|null>} Mailchimp's member status, or null when nobody was added
 */
export const subscribeQuietly = async (config, email, { fetchImpl = fetch, log } = {}) => {
  if (!config) return null
  try {
    const signal = AbortSignal.timeout(SIDE_SIGN_UP_TIMEOUT_MS)
    const { status } = await subscribe(config, email, { fetchImpl, signal })
    return status
  } catch (error) {
    log?.error({ err: error }, 'newsletter: Mailchimp opt-in sign-up failed')
    return null
  }
}
