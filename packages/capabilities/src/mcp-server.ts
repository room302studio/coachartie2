import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@coachartie/shared';
import { capabilityRegistry, RegisteredCapability } from './services/capability-registry.js';

interface ToolInputSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown; // Allow additional properties
}
import { calculatorCapability } from './capabilities/calculator.js';
import { webCapability } from './capabilities/web.js';
import { schedulerService } from './services/scheduler.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import express from 'express';
import cors from 'cors';

/**
 * MCP Server for Coach Artie Capabilities
 *
 * This server exposes the capabilities as MCP tools that can be used by
 * other applications through the Model Context Protocol.
 */
class CapabilitiesMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'coachartie-capabilities',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const capabilities = capabilityRegistry.list();
      const tools = [];

      for (const capability of capabilities) {
        for (const action of capability.supportedActions) {
          const toolName = `${capability.name}_${action}`;
          const tool = {
            name: toolName,
            description: `${capability.description || capability.name} - ${action}`,
            inputSchema: {
              type: 'object',
              properties: {
                ...this.getToolInputSchema(capability, action),
                content: {
                  type: 'string',
                  description: 'Optional content to pass to the capability',
                },
              },
              required: capability.requiredParams || [],
            },
          };
          tools.push(tool);
        }
      }

      logger.info(`📋 Listed ${tools.length} MCP tools`);
      return { tools };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      logger.info(`🔧 MCP tool call: ${name}`);

      try {
        // Parse tool name to get capability and action
        const [capabilityName, action] = this.parseToolName(name);

        if (!capabilityRegistry.has(capabilityName)) {
          throw new Error(`Capability '${capabilityName}' not found`);
        }

        // Extract content from args if provided
        const { content, ...params } = args as any;

        // Execute the capability
        const result = await capabilityRegistry.execute(capabilityName, action, params, content);

        logger.info(`✅ MCP tool '${name}' executed successfully`);

        return {
          content: [
            {
              type: 'text',
              text: result,
            },
          ],
        };
      } catch (error) {
        logger.error(`❌ MCP tool '${name}' failed:`, error);

        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private parseToolName(toolName: string): [string, string] {
    const lastUnderscoreIndex = toolName.lastIndexOf('_');
    if (lastUnderscoreIndex === -1) {
      throw new Error(`Invalid tool name format: ${toolName}`);
    }

    const capabilityName = toolName.substring(0, lastUnderscoreIndex);
    const action = toolName.substring(lastUnderscoreIndex + 1);

    return [capabilityName, action];
  }

  private getToolInputSchema(capability: RegisteredCapability, action: string): ToolInputSchema {
    const schema: ToolInputSchema = { type: 'object' };

    // Add common parameters based on capability
    switch (capability.name) {
      case 'calculator':
        schema.expression = {
          type: 'string',
          description: 'Mathematical expression to evaluate',
        };
        break;

      case 'web':
        if (action === 'search') {
          schema.query = {
            type: 'string',
            description: 'Search query',
          };
        } else if (action === 'fetch') {
          schema.url = {
            type: 'string',
            description: 'URL to fetch content from',
          };
        }
        break;

      case 'memory':
        if (action === 'remember') {
          schema.content = {
            type: 'string',
            description: 'Content to remember',
          };
        } else if (action === 'recall') {
          schema.query = {
            type: 'string',
            description: 'Query to recall memories',
          };
        }
        break;

      case 'wolfram':
        schema.input = {
          type: 'string',
          description: 'Input query for Wolfram Alpha',
        };
        break;

      case 'scheduler':
        if (action === 'remind') {
          schema.message = {
            type: 'string',
            description: 'Reminder message',
          };
          schema.delay = {
            type: 'string',
            description: 'Delay in milliseconds (default: 60000)',
          };
          schema.userId = {
            type: 'string',
            description: 'User ID for the reminder',
          };
        } else if (action === 'schedule') {
          schema.name = {
            type: 'string',
            description: 'Task name',
          };
          schema.cron = {
            type: 'string',
            description: 'Cron expression for scheduling',
          };
          schema.message = {
            type: 'string',
            description: 'Task message (optional)',
          };
          schema.userId = {
            type: 'string',
            description: 'User ID for the task',
          };
        } else if (action === 'cancel') {
          schema.taskId = {
            type: 'string',
            description: 'Task ID to cancel',
          };
        }
        break;
    }

    return schema;
  }

  /**
   * Register all capabilities with the registry
   * Uses the same registration logic as the capability orchestrator
   */
  private async registerCapabilities() {
    logger.info('🔧 Registering capabilities for MCP server...');

    // Register calculator capability
    capabilityRegistry.register(calculatorCapability);

    // Register web capability
    capabilityRegistry.register(webCapability);

    // Register memory capability
    capabilityRegistry.register({
      name: 'memory',
      supportedActions: ['remember', 'recall'],
      description: 'Stores and retrieves information from memory',
      handler: async (params, content) => {
        const { action } = params;

        if (action === 'remember') {
          const contentToRemember = params.content || content;
          if (!contentToRemember) {
            throw new Error('No content provided to remember');
          }
          // CANCER REMOVED: Use real memory system
          throw new Error(
            'Use real memory capability: <capability name="memory" action="remember" content="..." />'
          );
        }

        if (action === 'recall') {
          const query = params.query || content;
          if (!query) {
            throw new Error('No query provided for recall');
          }
          // CANCER REMOVED: Use real memory system
          throw new Error(
            'Use real memory capability: <capability name="memory" action="recall" query="..." />'
          );
        }

        throw new Error(`Unknown memory action: ${action}`);
      },
    });

    // Register wolfram capability (optional - requires WOLFRAM_APP_ID)
    try {
      // Import wolfram service dynamically to avoid initialization errors
      const { wolframService } = await import('./services/wolfram.js');

      capabilityRegistry.register({
        name: 'wolfram',
        supportedActions: ['query', 'search'],
        description: 'Queries Wolfram Alpha for computational knowledge',
        requiredParams: ['input'],
        handler: async (params, content) => {
          const input = params.input || params.query || content;
          if (!input) {
            throw new Error('No input provided for Wolfram Alpha query');
          }

          try {
            const result = await wolframService.query(input);
            return result;
          } catch (error) {
            logger.error('Wolfram Alpha capability failed:', error);
            throw error;
          }
        },
      });
    } catch {
      logger.warn('⚠️  Wolfram Alpha capability not available (missing WOLFRAM_APP_ID)');
    }

    // Register scheduler capability
    capabilityRegistry.register({
      name: 'scheduler',
      supportedActions: ['remind', 'schedule', 'list', 'cancel'],
      description: 'Manages scheduled tasks and reminders',
      handler: async (params, _content) => {
        const { action } = params;

        switch (action) {
          case 'remind': {
            const { message, delay, userId } = params;
            if (!message) {
              throw new Error('Reminder message is required');
            }

            const delayMs = parseInt(delay) || 60000; // Default 1 minute
            const reminderName = `reminder-${Date.now()}`;

            await schedulerService.scheduleOnce(
              reminderName,
              {
                type: 'user-reminder',
                message,
                userId: userId || 'mcp-user',
                reminderType: 'one-time',
              },
              delayMs
            );

            const delayMinutes = Math.round(delayMs / 60000);
            return `✅ Reminder set: "${message}" in ${delayMinutes} minute${delayMinutes !== 1 ? 's' : ''}`;
          }

          case 'schedule': {
            const { name, cron, message, userId } = params;
            if (!name || !cron) {
              throw new Error('Task name and cron expression are required');
            }

            const taskId = `task-${Date.now()}`;

            await schedulerService.scheduleTask({
              id: taskId,
              name,
              cron,
              data: {
                type: 'user-task',
                message: message || `Scheduled task: ${name}`,
                userId: userId || 'mcp-user',
              },
            });

            return `✅ Recurring task scheduled: "${name}" (${cron})`;
          }

          case 'list': {
            const tasks = await schedulerService.getScheduledTasks();

            if (tasks.length === 0) {
              return '📋 No scheduled tasks found';
            }

            const taskList = tasks
              .map((task) => `• ${task.name} - Next: ${task.nextRun.toLocaleString()}`)
              .join('\n');

            return `📋 Scheduled tasks (${tasks.length}):\n${taskList}`;
          }

          case 'cancel': {
            const { taskId } = params;
            if (!taskId) {
              throw new Error('Task ID is required for cancellation');
            }

            await schedulerService.removeTask(taskId);
            return `✅ Task "${taskId}" cancelled successfully`;
          }

          default:
            throw new Error(`Unknown scheduler action: ${action}`);
        }
      },
    });

    const stats = capabilityRegistry.getStats();
    logger.info(
      `✅ Registered ${stats.totalCapabilities} capabilities with ${stats.totalActions} total actions`
    );
  }

  /**
   * Start the MCP server with STDIO transport
   */
  async startStdio() {
    // Register capabilities first
    await this.registerCapabilities();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    logger.info('🚀 MCP server started with STDIO transport');
    logger.info('📡 Server is ready to receive MCP requests');
  }

  /**
   * Start the MCP server with HTTP transport on the specified port
   */
  async startHttp(port: number = 47320) {
    // Register capabilities first
    await this.registerCapabilities();

    // Create Express app for HTTP transport
    const app = express();

    // Enable CORS for local development
    app.use(
      cors({
        origin: [
          'http://localhost:3000',
          'http://localhost:3001',
          'http://127.0.0.1:3000',
          'http://127.0.0.1:3001',
        ],
        credentials: true,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      })
    );

    // Middleware for parsing JSON
    app.use(express.json());

    // Store active MCP connections
    const mcpConnections = new Map<string, SSEServerTransport>();

    // Health check endpoint
    app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        service: 'coachartie-capabilities-mcp',
        version: '1.0.0',
        activeConnections: mcpConnections.size,
        capabilities: capabilityRegistry.getStats(),
      });
    });

    // MCP SSE endpoint
    app.get('/mcp', async (req, res) => {
      try {
        logger.info('📡 New MCP SSE connection request');

        // Create SSE transport
        const transport = new SSEServerTransport('/mcp/message', res);

        // Connect server to transport
        await this.server.connect(transport);

        // Store connection
        mcpConnections.set(transport.sessionId, transport);

        // Handle transport events
        transport.onclose = () => {
          logger.info(`🔌 MCP connection closed: ${transport.sessionId}`);
          mcpConnections.delete(transport.sessionId);
        };

        transport.onerror = (error) => {
          logger.error(`❌ MCP connection error: ${transport.sessionId}`, error);
          mcpConnections.delete(transport.sessionId);
        };

        // Start the SSE connection
        await transport.start();

        logger.info(`✅ MCP SSE connection established: ${transport.sessionId}`);
      } catch (error) {
        logger.error('❌ Failed to establish MCP SSE connection:', error);
        res.status(500).json({ error: 'Failed to establish MCP connection' });
      }
    });

    // MCP message endpoint for POST requests
    app.post('/mcp/message', async (req, res) => {
      try {
        const sessionId = req.body.sessionId || req.headers['x-session-id'];

        if (!sessionId) {
          return res.status(400).json({ error: 'Session ID required' });
        }

        const transport = mcpConnections.get(sessionId);
        if (!transport) {
          return res.status(404).json({ error: 'Session not found' });
        }

        // Handle the message through the transport
        await transport.handlePostMessage(req as IncomingMessage, res as ServerResponse);
      } catch (error) {
        logger.error('❌ Failed to handle MCP message:', error);
        res.status(500).json({ error: 'Failed to handle message' });
      }
    });

    // Start HTTP server
    const server = app.listen(port, () => {
      logger.info(`🚀 MCP HTTP server started on port ${port}`);
      logger.info(`📡 MCP endpoint: http://localhost:${port}/mcp`);
      logger.info(`🏥 Health check: http://localhost:${port}/health`);
      logger.info(`📋 Active capabilities: ${capabilityRegistry.getStats().totalCapabilities}`);
    });

    // Graceful shutdown handling
    const shutdown = async () => {
      logger.info('🛑 Shutting down MCP HTTP server...');

      // Close all MCP connections
      for (const [sessionId, transport] of mcpConnections) {
        try {
          await transport.close();
          logger.info(`🔌 Closed MCP connection: ${sessionId}`);
        } catch (error) {
          logger.error(`❌ Error closing MCP connection ${sessionId}:`, error);
        }
      }
      mcpConnections.clear();

      // Close HTTP server
      server.close(() => {
        logger.info('✅ MCP HTTP server shutdown complete');
      });

      // Close MCP server
      await this.server.close();
    };

    // Handle graceful shutdown signals
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    return server;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('🛑 Shutting down MCP server...');
    await this.server.close();
    logger.info('✅ MCP server shutdown complete');
  }
}

export { CapabilitiesMCPServer };
