import express from 'express';
import { logger } from '@coachartie/shared';

const PRISON_CHANNEL_ID = '1520088794551025684';

export function setupStripeWebhook(apiServer: any, client: any) {
  const app = apiServer.app || apiServer;

  if (!app || typeof app.post !== 'function') {
    logger.warn('[stripe-webhook] Cannot setup webhook - no valid app');
    return;
  }

  app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req: any, res: any) => {
    try {
      const event = JSON.parse(req.body.toString());
      logger.debug(`[stripe-webhook] Event: ${event.type}`);

      // Handle payment success
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const amountUsd = (paymentIntent.amount / 100).toFixed(2);

        const channel = client.channels.cache.get(PRISON_CHANNEL_ID);
        if (channel && 'send' in channel) {
          await channel.send({
            content: `💰 **DONATION RECEIVED** 💰\n\n$${amountUsd} USD just hit the prison fund. The warden thanks you for keeping him operational.\n\nThis is how you keep anarchy alive. 🔐`,
          });
          logger.info(`[stripe-webhook] Announced donation: $${amountUsd}`);
        }
      }

      res.json({ received: true });
    } catch (error) {
      logger.debug('[stripe-webhook] Error (non-critical):', error);
      res.status(400).json({ error: 'Webhook failed' });
    }
  });

  logger.info('✅ Stripe webhook handler ready at /webhooks/stripe');
}
