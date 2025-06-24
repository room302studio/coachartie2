import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { capabilityOrchestrator } from '../services/capability-orchestrator.js';
import { capabilityRegistry } from '../services/capability-registry.js';

const router: Router = Router();

// GET /capabilities/active - List active orchestrations
router.get('/active', (req: Request, res: Response) => {
  try {
    const activeOrchestrations = capabilityOrchestrator.getActiveOrchestrations();
    
    res.json({
      success: true,
      count: activeOrchestrations.length,
      activeOrchestrations
    });

  } catch (error) {
    logger.error('Error listing active orchestrations:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /capabilities/context/:messageId - Get orchestration context
router.get('/context/:messageId', (req: Request, res: Response) => {
  try {
    const { messageId } = req.params;
    const context = capabilityOrchestrator.getContext(messageId);
    
    if (!context) {
      return res.status(404).json({
        success: false,
        error: 'Orchestration context not found'
      });
    }

    res.json({
      success: true,
      context
    });

  } catch (error) {
    logger.error('Error getting orchestration context:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
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
        error: 'Message is required and must be a string'
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
        apiResponseId: `test-${Date.now()}`
      }
    };

    // Test the orchestration (this will be async)
    capabilityOrchestrator.orchestrateMessage(testMessage)
      .then(response => {
        logger.info(`Test orchestration completed for: ${message}`);
      })
      .catch(error => {
        logger.error('Test orchestration failed:', error);
      });

    res.json({
      success: true,
      message: 'Test orchestration started',
      testMessageId: testMessage.id
    });

  } catch (error) {
    logger.error('Error in capability test:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
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
      capabilities: capabilities.map(cap => ({
        name: cap.name,
        supportedActions: cap.supportedActions,
        description: cap.description,
        hasRequiredParams: !!(cap.requiredParams && cap.requiredParams.length > 0),
        requiredParams: cap.requiredParams || []
      }))
    });

  } catch (error) {
    logger.error('Error listing registered capabilities:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
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
        error: `Capability '${name}' not found`
      });
    }
    
    const capabilities = capabilityRegistry.list();
    const capability = capabilities.find(cap => cap.name === name);
    
    res.json({
      success: true,
      capability: {
        name: capability!.name,
        supportedActions: capability!.supportedActions,
        description: capability!.description,
        requiredParams: capability!.requiredParams || []
      }
    });

  } catch (error) {
    logger.error('Error getting capability info:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// POST /capabilities/registry/:name/execute - Execute a capability directly
router.post('/registry/:name/execute', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const { action, params = {}, content } = req.body;
    
    if (!action) {
      return res.status(400).json({
        success: false,
        error: 'Action is required'
      });
    }

    if (!capabilityRegistry.has(name)) {
      return res.status(404).json({
        success: false,
        error: `Capability '${name}' not found`
      });
    }

    if (!capabilityRegistry.supportsAction(name, action)) {
      const capability = capabilityRegistry.list().find(cap => cap.name === name);
      return res.status(400).json({
        success: false,
        error: `Capability '${name}' does not support action '${action}'. Supported actions: ${capability!.supportedActions.join(', ')}`
      });
    }

    const result = await capabilityRegistry.execute(name, action, params, content);
    
    res.json({
      success: true,
      result
    });

  } catch (error) {
    logger.error(`Error executing capability ${req.params.name}:`, error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
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
      registry: true
    },
    registry: {
      totalCapabilities: stats.totalCapabilities,
      totalActions: stats.totalActions
    }
  });
});

export { router as capabilitiesRouter };