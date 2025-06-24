import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { capabilityOrchestrator } from '../services/capability-orchestrator.js';

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

// GET /capabilities/health - Health check for capabilities
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'capabilities',
    timestamp: new Date().toISOString(),
    features: {
      orchestration: true,
      extraction: true,
      chaining: true
    }
  });
});

export { router as capabilitiesRouter };