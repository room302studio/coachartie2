import express from 'express';
import helmet from 'helmet';
import { logger } from '@coachartie/shared';
import { startResponseConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { smsRouter } from './routes/sms.js';

const app = express();
const PORT = process.env.SMS_PORT || process.env.PORT || 27461;

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For Twilio webhooks

// Routes
app.use('/health', healthRouter);
app.use('/sms', smsRouter);

// Start queue consumers
async function startQueueWorkers() {
  try {
    logger.info('Starting SMS queue consumers...');
    await startResponseConsumer();
    logger.info('SMS queue consumers started successfully');
  } catch (error) {
    logger.error('Failed to start SMS queue consumers:', error);
    process.exit(1);
  }
}

// Start server
async function start() {
  try {
    // Start queue workers first
    await startQueueWorkers();

    // Start HTTP server (for Twilio webhooks)
    const server = app.listen(PORT, () => {
      logger.info(`✅ SMS service successfully bound to port ${PORT}`);
      logger.info('Ready to receive Twilio webhooks and process SMS responses');
    });

    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`❌ PORT CONFLICT: Port ${PORT} is already in use!`);
        logger.error(`❌ Another SMS service is likely running. Check with: lsof -i :${PORT}`);
      } else {
        logger.error(`❌ SMS server failed to start on port ${PORT}:`, error);
      }
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start SMS service:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received: closing SMS service');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT signal received: closing SMS service');
  process.exit(0);
});

// Start the service
start();