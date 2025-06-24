import { IncomingMessage, logger } from '@coachartie/shared';
import { openRouterService } from '../services/openrouter.js';

export async function processMessage(message: IncomingMessage): Promise<string> {
  try {
    // Check if OpenRouter is configured
    if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY === 'sk-or-your-openrouter-key-here') {
      // Fallback to echo response if no API key
      const response = `Hello! I received your message: "${message.message}" (OpenRouter not configured - add your API key to enable AI responses)`;
      logger.info(`Processed message from user ${message.userId} (echo mode)`);
      return response;
    }

    // Generate AI response using OpenRouter
    const aiResponse = await openRouterService.generateResponse(
      message.message,
      message.userId,
      message.context?.conversationHistory
    );
    
    logger.info(`Generated AI response for user ${message.userId}`);
    return aiResponse;
    
  } catch (error) {
    logger.error('Error processing message:', error);
    return "I'm sorry, I encountered an error processing your message. Please try again.";
  }
}