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
import { schedulerService } from './services/scheduler.js';
// Import orchestrator FIRST to trigger capability registration
import { capabilityOrchestrator } from './services/capability-orchestrator.js';
import { capabilityRegistry } from './services/capability-registry.js';
import { capabilitiesRouter } from './routes/capabilities.js';

const app = express();
const PORT = process.env.CAPABILITIES_PORT || process.env.PORT || 23701;

// Middleware
app.use(helmet());
app.use(express.json());

// Routes
app.use('/health', healthRouter);
app.use('/chat', chatRouter);
app.use('/capabilities', capabilitiesRouter);
app.use('/scheduler', schedulerRouter);

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

    // Start HTTP server (for health checks)
    app.listen(PORT, () => {
      logger.info(`Capabilities service listening on port ${PORT}`);
      logger.info('Service is ready to process messages from queue');
      logger.info('Scheduler service is ready for task management');
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