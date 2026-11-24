import { Router, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';
import { mintTrusted } from '../../shared/trusted-ids.js';
import type { CapabilityContext } from '../capabilities/registry.js';
import { getErrorMessage } from '../../shared/errors.js';
import { type ApiResult, sendResult } from '../../shared/api-result.js';

// Wave 9: the handler body is an exported function returning the status + JSON it used to
// send; the route sends it and engine/api.ts calls it in-process for the gateway.
const reply = (status: number, body: any): ApiResult => ({ status, body });
import { turnRunner } from '../2-turn/run-turn.js';
import { capabilityRegistry } from '../capabilities/registry.js';

const router: Router = Router();

// GET /capabilities - List all registered capabilities
router.get('/', (_req: Request, res: Response) => sendResult(res, listCapabilities()));

// GET /capabilities/active - List active orchestrations
router.get('/active', (req: Request, res: Response) => {
  try {
    const activeOrchestrations = turnRunner.getActiveOrchestrations();

    res.json({
      success: true,
      count: activeOrchestrations.length,
      activeOrchestrations,
    });
  } catch (error) {
    logger.error('Error listing active orchestrations:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /capabilities/context/:messageId - Get orchestration context
router.get('/context/:messageId', (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const context = turnRunner.getContext(messageId);

    if (!context) {
      return res.status(404).json({
        success: false,
        error: 'Orchestration context not found',
      });
    }

    res.json({
      success: true,
      context,
    });
  } catch (error) {
    logger.error('Error getting orchestration context:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// POST /capabilities/test - Test capability extraction
router.post('/test', (req: Request, res: Response) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Message is required and must be a string',
      });
    }

    // Create a test message for capability extraction
    const testMessage = {
      id: `test-${Date.now()}`,
      timestamp: new Date(),
      retryCount: 0,
      source: 'api' as const,
      userId: 'test-user',
      message,
      respondTo: {
        type: 'api' as const,
        apiResponseId: `test-${Date.now()}`,
      },
    };

    // Test the orchestration (this will be async)
    turnRunner
      .orchestrateMessage(testMessage)
      .then((_response) => {
        logger.info(`Test orchestration completed for: ${message}`);
      })
      .catch((error) => {
        logger.error('Test orchestration failed:', error);
      });

    res.json({
      success: true,
      message: 'Test orchestration started',
      testMessageId: testMessage.id,
    });
  } catch (error) {
    logger.error('Error in capability test:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /capabilities/registry - List all registered capabilities
router.get('/registry', (req: Request, res: Response) => {
  try {
    const capabilities = capabilityRegistry.list();
    const stats = capabilityRegistry.getStats();

    res.json({
      success: true,
      stats,
      capabilities: capabilities.map((cap) => ({
        name: cap.name,
        supportedActions: cap.supportedActions,
        description: cap.description,
        hasRequiredParams: !!(cap.requiredParams && cap.requiredParams.length > 0),
        requiredParams: cap.requiredParams || [],
      })),
    });
  } catch (error) {
    logger.error('Error listing registered capabilities:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// GET /capabilities/registry/:name - Get specific capability info
router.get('/registry/:name', (req: Request, res: Response) => {
  try {
    const { name } = req.params;

    if (!capabilityRegistry.has(name)) {
      return res.status(404).json({
        success: false,
        error: `Capability '${name}' not found`,
      });
    }

    const capabilities = capabilityRegistry.list();
    const capability = capabilities.find((cap) => cap.name === name);

    res.json({
      success: true,
      capability: {
        name: capability!.name,
        supportedActions: capability!.supportedActions,
        description: capability!.description,
        requiredParams: capability!.requiredParams || [],
      },
    });
  } catch (error) {
    logger.error('Error getting capability info:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// POST /capabilities/registry/:name/execute - Execute a capability directly
router.post('/registry/:name/execute', async (req: Request, res: Response) =>
  sendResult(res, await executeTool(req.params as { name: string }, req.body))
);

// POST /capabilities/mcp/test - Direct MCP testing without LLM
router.post('/mcp/test', async (req: Request, res: Response) => {
  try {
    const { action, params = {} } = req.body;

    if (!action) {
      return res.status(400).json({
        success: false,
        error:
          'Action is required (connect, list_servers, list_tools, call_tool, health_check, disconnect)',
      });
    }

    // Execute MCP client action directly
    const mcpClientCapability = capabilityRegistry.get('mcp_client', action);
    const startTime = Date.now();

    const result = await mcpClientCapability.handler({ action, ...params }, params.content);

    const duration = Date.now() - startTime;

    res.json({
      success: true,
      action,
      params,
      result,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('MCP test endpoint error:', error);
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
    });
  }
});

// POST /capabilities/web/test - Direct web search testing without LLM
router.post('/web/test', async (req: Request, res: Response) => {
  try {
    const { query, url, action = 'search' } = req.body;

    if (!query && !url) {
      return res.status(400).json({
        success: false,
        error: 'Query (for search) or URL (for fetch) is required',
      });
    }

    let params: any;
    if (action === 'search') {
      params = { query };
    } else {
      params = { url };
    }
    const webCapability = capabilityRegistry.get('web', action);
    const startTime = Date.now();

    const result = await webCapability.handler({ action, ...params }, query || url);

    const duration = Date.now() - startTime;

    res.json({
      success: true,
      action,
      params,
      result,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Web test endpoint error:', error);
    res.status(500).json({
      success: false,
      error: getErrorMessage(error),
    });
  }
});

// GET /capabilities/health - Health check for capabilities
router.get('/health', (req: Request, res: Response) => {
  const stats = capabilityRegistry.getStats();

  res.json({
    status: 'healthy',
    service: 'capabilities',
    timestamp: new Date().toISOString(),
    features: {
      orchestration: true,
      extraction: true,
      chaining: true,
      registry: true,
    },
    registry: {
      totalCapabilities: stats.totalCapabilities,
      totalActions: stats.totalActions,
    },
  });
});

/** GET /capabilities's body: every registered capability plus registry stats. */
export function listCapabilities(): ApiResult {
  try {
    const capabilities = capabilityRegistry.list();
    const stats = capabilityRegistry.getStats();

    return reply(200, {
      success: true,
      stats,
      capabilities,
    });
  } catch (error) {
    logger.error('Error listing capabilities:', error);
    return reply(500, {
      success: false,
      error: 'Internal server error',
    });
  }
}

/**
 * POST /capabilities/registry/:name/execute's body: run one capability action directly, no LLM
 * (the gateway stores observation and reaction-feedback memories through this).
 */
export async function executeTool(routeParams: { name: string }, body: any): Promise<ApiResult> {
  try {
    const { name } = routeParams;
    const { action, params = {}, content, guildId, channelId, userId, messageId } = body;

    if (!action) {
      return reply(400, {
        success: false,
        error: 'Action is required',
      });
    }

    if (!capabilityRegistry.has(name)) {
      return reply(404, {
        success: false,
        error: `Capability '${name}' not found`,
      });
    }

    if (!capabilityRegistry.supportsAction(name, action)) {
      return reply(400, {
        success: false,
        error: capabilityRegistry.generateActionError(name, action),
      });
    }

    // Build context from request body
    // A trust boundary, named (shared/trusted-ids.ts): this route is local-only, so its caller
    // is our own process or EJ's tooling, and the ids it sends are taken as given.
    let context: CapabilityContext | undefined;
    if (guildId || channelId || userId || messageId) {
      context = mintTrusted({ guildId, channelId, userId, messageId }, 'local-api');
    }

    const result = await capabilityRegistry.execute(name, action, params, content, context);

    return reply(200, {
      success: true,
      result,
    });
  } catch (error) {
    logger.error(`Error executing capability ${routeParams.name}:`, error);
    return reply(500, {
      success: false,
      error: getErrorMessage(error),
    });
  }
}

export { router as capabilitiesRouter };
