import express from 'express';
import helmet from 'helmet';
import { logger } from '@coachartie/shared';
import { startMessageConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';

const app = express();
const PORT = process.env.PORT || 9991;

// Middleware
app.use(helmet());
app.use(express.json());

// Routes
app.use('/health', healthRouter);
app.use('/chat', chatRouter);

// Start queue consumers
async function startQueueWorkers() {
  try {
    logger.info('Starting queue consumers...');
    await startMessageConsumer();
    logger.info('Queue consumers started successfully');
  } catch (error) {
    logger.error('Failed to start queue consumers:', error);
    process.exit(1);
  }
}

// Start server
async function start() {
  try {
    // Start queue workers first
    await startQueueWorkers();

    // Start HTTP server (for health checks)
    app.listen(PORT, () => {
      logger.info(`Capabilities service listening on port ${PORT}`);
      logger.info('Service is ready to process messages from queue');
    });
  } catch (error) {
    logger.error('Failed to start capabilities service:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

// Start the service
start();