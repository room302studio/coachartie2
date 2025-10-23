import express from 'express';
import helmet from 'helmet';
import {
  logger,
  structuredLogger,
  createRequestLogger,
  parsePortWithFallback,
  registerServiceWithDiscovery,
  serviceDiscovery,
} from '@coachartie/shared';
import { startResponseConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { emailRouter } from './routes/email.js';

const app = express();

// Middleware
app.use(helmet());
app.use(express.json());
app.use(express.text({ type: 'text/plain' })); // For email webhooks
app.use(createRequestLogger('email'));

// Routes
app.use('/health', healthRouter);
app.use('/email', emailRouter);

// Start queue consumers
async function startQueueWorkers() {
  try {
    await startResponseConsumer();
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

    // Auto-discover available port
    const PORT = await parsePortWithFallback('EMAIL_SERVICE_PORT', 'email');

    // Start HTTP server
    const server = app.listen(PORT, '0.0.0.0', async () => {
      logger.info(`✅ email: ${PORT}`);

      // Register with service discovery
      await registerServiceWithDiscovery('email', PORT);
    });

    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`❌ UNEXPECTED PORT CONFLICT: Port ${PORT} became busy after discovery!`);
        logger.error(`❌ This suggests a race condition or rapid port allocation.`);
        logger.error(`❌ Check with: lsof -i :${PORT}`);
      } else {
        logger.error(`❌ Email server failed to start on port ${PORT}:`, error);
      }
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start email service:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  await serviceDiscovery.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await serviceDiscovery.shutdown();
  process.exit(0);
});

// Start the service
start();
