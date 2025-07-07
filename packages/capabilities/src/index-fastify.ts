#!/usr/bin/env node

/**
 * Coach Artie 2 - Capabilities Service (Fastify Rewrite)
 * 
 * Modern, reliable replacement for the Express server that was experiencing
 * phantom server issues where it would log "listening" but not actually accept connections.
 * 
 * Key improvements:
 * - Uses Fastify for better reliability and error handling
 * - Proper async/await error handling throughout
 * - No async operations in server listen callbacks
 * - Comprehensive error logging and crash detection
 * - Graceful startup failure handling
 */

import Fastify, { FastifyInstance } from 'fastify';
import { logger } from '@coachartie/shared/dist/utils/logger';
import { parsePortWithFallback } from '@coachartie/shared/dist/utils/port-discovery';
import { registerServiceWithDiscovery } from '@coachartie/shared/dist/utils/service-discovery';
import { CapabilityOrchestrator } from './services/capability-orchestrator';
import { CapabilityRegistry } from './services/capability-registry';
import { startMessageConsumer } from './queues/consumer';
import { SchedulerService } from './services/scheduler';
import { createHealthRoute } from './routes/health';
import { createChatRoute } from './routes/chat';
import { createCapabilitiesRoute } from './routes/capabilities';
import { createApiRoutes } from './routes/api';

// Using shared logger instance

class CapabilitiesServer {
  private fastify: FastifyInstance;
  private port: number = 0;
  private orchestrator: CapabilityOrchestrator;
  private registry: CapabilityRegistry;
  private scheduler: SchedulerService;
  private isShuttingDown = false;

  constructor() {
    // Create Fastify instance with comprehensive error handling
    this.fastify = Fastify({
      logger: {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname'
          }
        }
      },
      // Disable default error handler to use our custom one
      disableRequestLogging: false,
      requestTimeout: 30000,
      keepAliveTimeout: 5000,
      maxParamLength: 500
    });

    // Initialize core services
    this.registry = new CapabilityRegistry();
    this.orchestrator = new CapabilityOrchestrator(this.registry);
    this.scheduler = new SchedulerService();

    this.setupErrorHandlers();
    this.setupRoutes();
  }

  private setupErrorHandlers(): void {
    // Global error handler for unhandled requests
    this.fastify.setErrorHandler(async (error, request, reply) => {
      logger.error('🚨 Request error:', {
        error: error.message,
        stack: error.stack,
        url: request.url,
        method: request.method,
        statusCode: error.statusCode || 500
      });

      await reply.status(error.statusCode || 500).send({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
        statusCode: error.statusCode || 500
      });
    });

    // Not found handler
    this.fastify.setNotFoundHandler(async (request, reply) => {
      logger.warn('🔍 Route not found:', {
        url: request.url,
        method: request.method
      });

      await reply.status(404).send({
        error: 'Not Found',
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404
      });
    });

    // Process-level error handlers
    process.on('uncaughtException', (error) => {
      logger.error('🚨 UNCAUGHT EXCEPTION - Server will shut down:', {
        error: error.message,
        stack: error.stack
      });
      this.gracefulShutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('🚨 UNHANDLED REJECTION - Server will shut down:', {
        reason: reason instanceof Error ? reason.message : reason,
        stack: reason instanceof Error ? reason.stack : undefined,
        promise: promise.toString()
      });
      this.gracefulShutdown('unhandledRejection');
    });

    // Graceful shutdown handlers
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
  }

  private setupRoutes(): void {
    // Register CORS if needed
    this.fastify.register(import('@fastify/cors'), {
      origin: true,
      credentials: true
    });

    // Register routes
    this.fastify.register(createHealthRoute);
    this.fastify.register(createChatRoute(this.orchestrator));
    this.fastify.register(createCapabilitiesRoute(this.registry));
    this.fastify.register(createApiRoutes);

    // Root route
    this.fastify.get('/', async (request, reply) => {
      return {
        service: 'Coach Artie 2 - Capabilities Service',
        version: '2.0.0',
        status: 'running',
        framework: 'Fastify',
        timestamp: new Date().toISOString(),
        capabilities: this.registry.getCapabilityNames(),
        endpoints: [
          'GET /health - Health check',
          'POST /chat - Process chat messages',
          'GET /capabilities - List available capabilities',
          'GET /api/memories - Browse memories',
          'GET /api/messages - Browse messages'
        ]
      };
    });
  }

  private async initializeServices(): Promise<void> {
    logger.info('🚀 Initializing services...');

    try {
      // Registry should be initialized automatically in constructor
      logger.info('🔧 Capability registry ready...');
      logger.info(`📊 Registry loaded with ${this.registry.getCapabilityNames().length} capabilities`);

      // Initialize orchestrator
      logger.info('🚀 Initializing capability orchestrator...');
      await this.orchestrator.initialize();

      // Start queue consumers
      logger.info('📥 Starting queue consumers...');
      await this.startQueueWorkers();

      // Start scheduler
      logger.info('📅 Starting scheduler...');
      await this.startScheduler();

      logger.info('✅ All services initialized successfully');
    } catch (error) {
      logger.error('❌ Service initialization failed:', error);
      throw error;
    }
  }

  private async startQueueWorkers(): Promise<void> {
    try {
      await startMessageConsumer();
      logger.info('✅ Queue consumers started successfully');
    } catch (error) {
      logger.error('❌ Failed to start queue consumers:', error);
      throw error;
    }
  }

  private async startScheduler(): Promise<void> {
    try {
      await this.scheduler.initialize();
      logger.info('✅ Scheduler initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to start scheduler:', error);
      throw error;
    }
  }

  private async discoverPort(): Promise<number> {
    try {
      const port = await parsePortWithFallback('CAPABILITIES_PORT', 'capabilities');
      logger.info(`🔍 Using port ${port} for capabilities service`);
      return port;
    } catch (error) {
      logger.error('❌ Failed to discover port:', error);
      throw error;
    }
  }

  private async registerService(): Promise<void> {
    try {
      await registerServiceWithDiscovery('capabilities', this.port);
      logger.info(`📡 Service registered in discovery at port ${this.port}`);
    } catch (error) {
      logger.warn('⚠️ Service registration failed (non-critical):', error);
      // Don't throw - service can run without discovery
    }
  }

  private async selfTest(): Promise<void> {
    try {
      // Wait a moment for server to fully start
      await new Promise(resolve => setTimeout(resolve, 500));

      const response = await fetch(`http://localhost:${this.port}/health`);
      if (response.ok) {
        const data = await response.text();
        logger.info('✅ Self-test successful:', data);
      } else {
        throw new Error(`Self-test failed with status ${response.status}`);
      }
    } catch (error) {
      logger.error('❌ Self-test failed:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    try {
      logger.info('🎯 Starting Coach Artie 2 - Capabilities Service (Fastify)');

      // Step 1: Initialize all services
      await this.initializeServices();

      // Step 2: Discover available port
      this.port = await this.discoverPort();

      // Step 3: Start Fastify server
      logger.info(`🔄 Starting Fastify server on port ${this.port}...`);
      
      const address = await this.fastify.listen({
        port: this.port,
        host: '0.0.0.0'
      });

      logger.info(`✅ Fastify server listening at ${address}`);
      logger.info(`🌐 Health check available at: http://localhost:${this.port}/health`);

      // Step 4: Register with service discovery (non-blocking)
      this.registerService().catch(err => {
        logger.warn('Service registration failed but continuing:', err);
      });

      // Step 5: Run self-test
      await this.selfTest();

      logger.info('🎉 Capabilities service fully operational!');

    } catch (error) {
      logger.error('💥 Failed to start capabilities service:', error);
      await this.gracefulShutdown('startup-failure');
      throw error;
    }
  }

  private async gracefulShutdown(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('⚠️ Shutdown already in progress, skipping...');
      return;
    }

    this.isShuttingDown = true;
    logger.info(`🛑 Graceful shutdown initiated (reason: ${reason})`);

    try {
      // Stop accepting new requests
      await this.fastify.close();
      logger.info('✅ Fastify server closed');

      // Stop scheduler
      if (this.scheduler && typeof this.scheduler.stop === 'function') {
        await this.scheduler.stop();
        logger.info('✅ Scheduler stopped');
      }

      // Additional cleanup can go here

      logger.info('✅ Graceful shutdown completed');
    } catch (error) {
      logger.error('❌ Error during shutdown:', error);
    } finally {
      process.exit(reason === 'startup-failure' ? 1 : 0);
    }
  }
}

// Start the server
const server = new CapabilitiesServer();

server.start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

export { CapabilitiesServer };