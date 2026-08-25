import { processStripeEvent } from '../webhooks/stripe-webhook.js'
import {
  notifyCheckoutReceipt,
  notifyBackofficeNewOrder,
} from '../email/notifications.js'

// Stripe webhook endpoint. Signature verification needs the exact raw request
// bytes, so this encapsulated plugin parses application/json as a Buffer (the
// root instance keeps normal JSON parsing for every other route).
export const webhookRoutes = async (
  app,
  { pool, stripe, stripeWebhookSecret, mailer = null }
) => {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => done(null, body)
  )

  app.post('/webhooks/stripe', async (request, reply) => {
    if (!stripe || !stripeWebhookSecret) {
      reply.code(503)
      return { error: 'Stripe webhook is not configured.' }
    }

    const signature = request.headers['stripe-signature']
    let event
    try {
      event = stripe.webhooks.constructEvent(
        request.body,
        signature,
        stripeWebhookSecret
      )
    } catch (error) {
      request.log.warn(
        { err: error },
        'stripe webhook signature verification failed'
      )
      reply.code(400)
      return { error: `Webhook signature verification failed: ${error.message}` }
    }

    const result = await processStripeEvent(pool, event)
    // Send the receipt only for a freshly-created paid order (not on replays).
    // The back office learns about it in the same breath (W12 US-004, FR-119):
    // a card sale used to reach the desk only when somebody opened the queue.
    // Both are no-ops when the mailer is null and neither can fail the webhook.
    if (result.order) {
      await notifyCheckoutReceipt(mailer, pool, result.order)
      await notifyBackofficeNewOrder(mailer, pool, result.order)
    }
    return { received: true, duplicate: result.duplicate }
  })
}
