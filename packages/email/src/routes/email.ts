import { Router, type Router as ExpressRouter } from 'express';
import { logger } from '@coachartie/shared';
import { handleIncomingEmail } from '../handlers/incoming-email.js';

export const emailRouter: ExpressRouter = Router();

// Webhook endpoint for incoming emails (e.g., from SendGrid, Mailgun, etc.)
emailRouter.post('/webhook', async (req, res) => {
  try {
    logger.info('Received email webhook');

    // The webhook format depends on your email provider
    // This is a generic implementation that can be adapted
    const { from, to, subject, text, html } = req.body;

    if (!from || !text) {
      logger.warn('Invalid email webhook data received:', req.body);
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Process the incoming email
    await handleIncomingEmail({
      from,
      to,
      subject: subject || 'No Subject',
      text,
      html,
    });

    res.status(200).json({ status: 'processed' });
  } catch (error) {
    logger.error('Error handling email webhook:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Alternative endpoint for simple email processing
emailRouter.post('/inbound', async (req, res) => {
  try {
    // Simple format for testing or custom implementations
    const { from, subject, body } = req.body;

    if (!from || !body) {
      return res.status(400).json({ error: 'Missing from or body' });
    }

    await handleIncomingEmail({
      from,
      to: process.env.EMAIL_FROM || 'coach@example.com',
      subject: subject || 'Message to Coach Artie',
      text: body,
      html: null,
    });

    res.status(200).json({ status: 'processed' });
  } catch (error) {
    logger.error('Error handling inbound email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check specific to email functionality
emailRouter.get('/status', (req, res) => {
  res.json({
    service: 'email',
    status: 'operational',
    timestamp: new Date().toISOString(),
  });
});
