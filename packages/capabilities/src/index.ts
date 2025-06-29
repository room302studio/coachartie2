import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from monorepo root (go up from packages/capabilities/src to monorepo root)
config({ path: resolve(__dirname, '../../../.env') });
// Also try package-specific .env
config({ path: resolve(__dirname, '../.env') });
import express from 'express';
import helmet from 'helmet';
import { logger } from '@coachartie/shared';
import { startMessageConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';
import { schedulerRouter } from './routes/scheduler.js';
import { githubRouter } from './routes/github.js';
import { schedulerService } from './services/scheduler.js';
// Import orchestrator FIRST to trigger capability registration
import './services/capability-orchestrator.js';
import { capabilityRegistry } from './services/capability-registry.js';
import { capabilitiesRouter } from './routes/capabilities.js';

const app = express();
const PORT = parseInt(process.env.CAPABILITIES_PORT || process.env.PORT || '18239');

// Middleware
app.use(helmet());
app.use(express.json());

// Test route
app.get('/test', (req, res) => {
  res.send('Server is running!');
});

// Routes
app.use('/health', healthRouter);
app.use('/chat', chatRouter);
app.use('/capabilities', capabilitiesRouter);
app.use('/scheduler', schedulerRouter);
app.use('/github', githubRouter);

// Start queue consumers and scheduler
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

async function startScheduler() {
  try {
    logger.info('Setting up scheduled tasks...');
    
    // Setup default tasks if enabled
    if (process.env.ENABLE_SCHEDULING !== 'false') {
      await schedulerService.setupDefaultTasks();
      logger.info('Scheduler initialized with default tasks');
    } else {
      logger.info('Scheduling disabled by configuration');
    }
  } catch (error) {
    logger.error('Failed to setup scheduler:', error);
    // Don't exit - scheduler is optional
  }
}

// Start server
async function start() {
  try {
    // Ensure orchestrator is initialized (this will register all capabilities)
    logger.info('🚀 Initializing capability orchestrator...');
    // Just accessing the orchestrator will trigger its constructor and capability registration
    const stats = capabilityRegistry.getStats();
    logger.info(`📊 Capability registry initialized with ${stats.totalCapabilities} capabilities and ${stats.totalActions} actions`);
    
    // Start queue workers first
    await startQueueWorkers();
    
    // Start scheduler
    await startScheduler();

    // Start HTTP server (for health checks) - bind to 0.0.0.0 for both IPv4 and IPv6
    logger.info(`🔄 Attempting to bind to port ${PORT}...`);
    const server = app.listen(PORT, '0.0.0.0', () => {
      logger.info(`✅ Capabilities service successfully bound to port ${PORT} on 0.0.0.0`);
      logger.info('Service is ready to process messages from queue');
      logger.info('Scheduler service is ready for task management');
      
      // Double-check the server is actually listening
      const addr = server.address();
      logger.info(`🔍 Server address:`, addr);
    });

    server.on('error', (error: Error) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((error as any).code === 'EADDRINUSE') {
        logger.error(`❌ PORT CONFLICT: Port ${PORT} is already in use!`);
        logger.error(`❌ Another service is likely running on this port. Check with: lsof -i :${PORT}`);
        logger.error(`❌ Kill competing process or use a different port.`);
      } else {
        logger.error(`❌ Server failed to start on port ${PORT}:`, error);
      }
      process.exit(1);
    });

    // Verify the server is actually listening after a brief delay
    setTimeout(() => {
      const address = server.address();
      if (address && typeof address === 'object') {
        logger.info(`🔍 Verified: Server is listening on ${address.address}:${address.port}`);
        
        // Try to connect to ourselves
        fetch(`http://localhost:${PORT}/test`)
          .then(res => res.text())
          .then(text => logger.info(`✅ Self-test successful: ${text}`))
          .catch(err => logger.error(`❌ Self-test failed:`, err));
      } else {
        logger.error(`❌ Server address verification failed. Server may not be properly bound.`);
      }
    }, 1000);
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

// Catch unhandled errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Don't exit, just log
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit, just log
});

// Start the service
start();

// Keep the process alive
setInterval(() => {
  logger.debug('Process keepalive tick');
}, 30000); // Every 30 seconds