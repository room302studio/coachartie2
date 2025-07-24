import { Router, Request, Response } from 'express';
import { logger } from '@coachartie/shared';
import { processMessage } from '../handlers/process-message.js';
import { v4 as uuidv4 } from 'uuid';

const router: Router = Router();

interface ChatRequest {
  message: string;
  userId?: string;
}

interface ChatResponse {
  success: boolean;
  messageId: string;
  response?: string;
  error?: string;
}

// POST /chat - Process message and return AI response immediately
router.post('/', async (req: Request, res: Response) => {
  try {
    const { message, userId = 'api-user' }: ChatRequest = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({
        success: false,
        messageId: '',
        error: 'Message is required and must be a string'
      } as ChatResponse);
    }

    const messageId = uuidv4();
    
    logger.info(`Processing chat message from ${userId}: ${message.substring(0, 100)}...`);

    // Create message object for processing
    const incomingMessage = {
      id: messageId,
      timestamp: new Date(),
      retryCount: 0,
      source: 'api' as const,
      userId,
      message: message.trim(),
      respondTo: {
        type: 'api' as const,
        apiResponseId: messageId
      }
    };

    // Return immediately, process async
    res.json({
      success: true,
      messageId,
      response: "working on it..."
    } as ChatResponse);

    // Process in background
    processMessage(incomingMessage)
      .then(aiResponse => logger.info(`✅ Background processing complete: ${aiResponse.substring(0, 100)}`))
      .catch(error => logger.error(`❌ Background processing failed:`, error));

  } catch (error) {
    logger.error('Error in chat endpoint:', error);
    res.status(500).json({
      success: false,
      messageId: '',
      error: 'Internal server error'
    } as ChatResponse);
  }
});

// GET /chat/health - Simple health check for chat endpoint
router.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    endpoint: 'chat',
    timestamp: new Date().toISOString()
  });
});

export { router as chatRouter };