import { FastifyPluginAsync } from 'fastify';
import { CapabilityOrchestrator } from '../services/capability-orchestrator';
import { logger } from '@coachartie/shared/dist/utils/logger';

interface ChatRequest {
  message: string;
  userId: string;
  conversationId?: string;
  metadata?: Record<string, any>;
}

interface ChatResponse {
  response: string;
  conversationId: string;
  timestamp: string;
  tokensUsed?: number;
  model?: string;
  capabilities?: any[];
}

export function createChatRoute(orchestrator: CapabilityOrchestrator): FastifyPluginAsync {
  return async (fastify) => {
    fastify.post<{ Body: ChatRequest }>('/chat', {
      schema: {
        body: {
          type: 'object',
          required: ['message', 'userId'],
          properties: {
            message: { type: 'string', minLength: 1 },
            userId: { type: 'string', minLength: 1 },
            conversationId: { type: 'string' },
            metadata: { type: 'object' }
          }
        }
      }
    }, async (request, reply) => {
      const startTime = Date.now();
      const { message, userId, conversationId, metadata } = request.body;

      logger.info('💬 Chat request received:', {
        userId,
        conversationId,
        messageLength: message.length,
        hasMetadata: !!metadata
      });

      try {
        // Process the message through the orchestrator
        const result = await orchestrator.processMessage({
          message,
          userId,
          conversationId,
          metadata,
          timestamp: new Date()
        });

        const processingTime = Date.now() - startTime;

        logger.info('✅ Chat request processed successfully:', {
          userId,
          conversationId: result.conversationId,
          responseLength: result.response.length,
          processingTime: `${processingTime}ms`,
          tokensUsed: result.tokensUsed,
          model: result.model
        });

        const response: ChatResponse = {
          response: result.response,
          conversationId: result.conversationId || conversationId || `conv_${Date.now()}`,
          timestamp: new Date().toISOString(),
          tokensUsed: result.tokensUsed,
          model: result.model,
          capabilities: result.capabilities
        };

        await reply.send(response);

      } catch (error) {
        const processingTime = Date.now() - startTime;
        
        logger.error('❌ Chat request failed:', {
          userId,
          conversationId,
          error: error instanceof Error ? error.message : 'Unknown error',
          processingTime: `${processingTime}ms`,
          stack: error instanceof Error ? error.stack : undefined
        });

        await reply.status(500).send({
          error: 'Chat processing failed',
          message: error instanceof Error ? error.message : 'An unexpected error occurred',
          timestamp: new Date().toISOString(),
          conversationId: conversationId || `conv_${Date.now()}`
        });
      }
    });

    // Health check endpoint for chat service
    fastify.get('/chat/health', async (request, reply) => {
      try {
        const stats = await orchestrator.getStats();
        return {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          orchestrator: {
            capabilities: stats.capabilities,
            totalActions: stats.totalActions,
            activeConnections: stats.activeConnections || 0
          }
        };
      } catch (error) {
        await reply.status(503).send({
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    });
  };
}