import express from 'express';
import helmet from 'helmet';
import { logger } from '@coachartie/shared';
import { startResponseConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { emailRouter } from './routes/email.js';

const app = express();
const PORT = process.env.PORT || 9994;

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.text({ type: 'text/plain' })); // For email webhooks

// Routes
app.use('/health', healthRouter);
app.use('/email', emailRouter);

// Start queue consumers
async function startQueueWorkers() {
  try {
    logger.info('Starting email queue consumers...');
    await startResponseConsumer();
    logger.info('Email queue consumers started successfully');
  } catch (error) {
    logger.error('Failed to start email queue consumers:', error);
    process.exit(1);
  }
}

// Start server
async function start() {
  try {
    // Start queue workers first
    await startQueueWorkers();

    // Start HTTP server (for email webhooks)
    app.listen(PORT, () => {
      logger.info(`Email service listening on port ${PORT}`);
      logger.info('Ready to receive email webhooks and process email responses');
    });
  } catch (error) {
    logger.error('Failed to start email service:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received: closing email service');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT signal received: closing email service');
  process.exit(0);
});

// Start the service
start();