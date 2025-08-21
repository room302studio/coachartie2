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
import { logger, createRequestLogger, parsePortWithFallback, registerServiceWithDiscovery, serviceDiscovery } from '@coachartie/shared';
import { startMessageConsumer } from './queues/consumer.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';
import { schedulerRouter } from './routes/scheduler.js';
import { githubRouter } from './routes/github.js';
import { servicesRouter } from './routes/services.js';
import { memoriesRouter } from './routes/memories.js';
import modelsRouter from './routes/models.js';
import { logsRouter } from './routes/logs.js';
import { schedulerService } from './services/scheduler.js';
// Import orchestrator FIRST to trigger capability registration
import './services/capability-orchestrator.js';
import { capabilityRegistry } from './services/capability-registry.js';
import { capabilitiesRouter } from './routes/capabilities.js';
import { simpleHealer } from './runtime/simple-healer.js';

// Export openRouterService for models endpoint
export { openRouterService } from './services/openrouter.js';

const app = express();

// Middleware
app.use(helmet());
app.use(express.json());
app.use(createRequestLogger('capabilities'));

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
app.use('/services', servicesRouter);
app.use('/api/memories', memoriesRouter);
app.use('/api/models', modelsRouter);
app.use('/logs', logsRouter);

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
    // Setup scheduler
    
    // Setup default tasks if enabled
    if (process.env.ENABLE_SCHEDULING !== 'false') {
      await schedulerService.setupDefaultTasks();
    }
  } catch (error) {
    logger.error('Failed to setup scheduler:', error);
    // Don't exit - scheduler is optional
  }
}

// Start server
async function start() {
  try {
    // Initialize orchestrator
    const stats = capabilityRegistry.getStats();
    
    // Start queue workers first
    await startQueueWorkers();
    
    // Start scheduler
    await startScheduler();

    // Start simple healer
    simpleHealer.start();
    const PORT = await parsePortWithFallback('CAPABILITIES_PORT', 'capabilities');

    // Start HTTP server
    const server = app.listen(PORT, '0.0.0.0', async () => {
      logger.info(`✅ capabilities: ${PORT} [${stats.totalCapabilities} caps, ${stats.totalActions} actions]`);
      await registerServiceWithDiscovery('capabilities', PORT);
    });

    // Enhanced error handling with helpful developer guidance
    server.on('error', (error: Error) => {
      if ((error as any).code === 'EADDRINUSE') {
        console.error('\n' + '='.repeat(60));
        console.error('❌ PORT CONFLICT DETECTED!');
        console.error('='.repeat(60));
        console.error(`Port ${PORT} is already in use!\n`);
        
        console.error('This usually means one of the following:');
        console.error('1. Docker is running Coach Artie (check: docker ps)');
        console.error('2. A previous instance is still running');
        console.error('3. Another service is using this port\n');
        
        console.error('TO FIX THIS:');
        console.error('------------');
        console.error('Option 1: If Docker is running Coach Artie:');
        console.error('  $ docker-compose down');
        console.error('  $ pnpm run dev\n');
        
        console.error('Option 2: Kill the process using this port:');
        console.error(`  $ lsof -ti :${PORT} | xargs kill -9`);
        console.error('  $ pnpm run dev\n');
        
        console.error('Option 3: Use the built-in port checker:');
        console.error('  $ pnpm run check-ports');
        console.error('  (This will show you exactly what\'s using each port)\n');
        
        console.error('='.repeat(60) + '\n');
      } else {
        logger.error(`❌ Server failed to start on port ${PORT}:`, error);
      }
      process.exit(1);
    });

    // DELETE the self-test - if it works, it works
  } catch (error) {
    logger.error('Failed to start capabilities service:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  simpleHealer.stop();
  await serviceDiscovery.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  simpleHealer.stop();
  await serviceDiscovery.shutdown();
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