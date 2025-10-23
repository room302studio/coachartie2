import { Router, type Router as ExpressRouter } from 'express';
import { logger } from '@coachartie/shared';
import { handleIncomingSMS } from '../handlers/incoming-sms.js';

export const smsRouter: ExpressRouter = Router();

// Twilio webhook endpoint for incoming SMS
smsRouter.post('/webhook', async (req, res) => {
  try {
    logger.info('Received Twilio webhook');

    // Extract SMS data from Twilio webhook
    const { From, To, Body, MessageSid } = req.body;

    if (!From || !Body) {
      logger.warn('Invalid webhook data received:', req.body);
      return res.status(400).send('Missing required fields');
    }

    // Process the incoming SMS
    await handleIncomingSMS({
      from: From,
      to: To,
      body: Body,
      messageSid: MessageSid,
    });

    // Respond to Twilio (empty response means success)
    res.status(200).send('');
  } catch (error) {
    logger.error('Error handling SMS webhook:', error);
    res.status(500).send('Internal server error');
  }
});

// Health check specific to SMS functionality
smsRouter.get('/status', (req, res) => {
  res.json({
    service: 'sms',
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
});
