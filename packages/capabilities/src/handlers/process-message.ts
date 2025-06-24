import { IncomingMessage, logger } from '@coachartie/shared';
import { openRouterService } from '../services/openrouter.js';
import { capabilityOrchestrator } from '../services/capability-orchestrator.js';

export async function processMessage(message: IncomingMessage): Promise<string> {
  try {
    // Check if OpenRouter is configured
    if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'sk-or-your-openrouter-key-here') {
      // Fallback to echo response if no API key
      const response = `Hello! I received your message: "${message.message}" (OpenRouter not configured - add your API key to enable AI responses)`;
      logger.info(`Processed message from user ${message.userId} (echo mode)`);
      return response;
    }

    // Check if capabilities should be enabled
    const enableCapabilities = process.env.ENABLE_CAPABILITIES !== 'false';
    
    if (enableCapabilities) {
      logger.info(`🎬 Processing message with capability orchestration: ${message.id}`);
      
      // Use capability orchestrator for full pipeline
      const orchestratedResponse = await capabilityOrchestrator.orchestrateMessage(message);
      
      logger.info(`✅ Capability orchestration completed for user ${message.userId}`);
      return orchestratedResponse;
      
    } else {
      logger.info(`🤖 Processing message with simple AI chat: ${message.id}`);
      
      // Fallback to simple AI response (previous behavior)
      const aiResponse = await openRouterService.generateResponse(
        message.message,
        message.userId,
        message.context?.conversationHistory
      );
      
      logger.info(`Generated simple AI response for user ${message.userId}`);
      return aiResponse;
    }
    
  } catch (error) {
    logger.error('Error processing message:', error);
    return "I'm sorry, I encountered an error processing your message. Please try again.";
  }
}