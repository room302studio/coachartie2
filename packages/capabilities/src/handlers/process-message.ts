import { IncomingMessage, logger } from '@coachartie/shared';

export async function processMessage(message: IncomingMessage): Promise<string> {
  try {
    // For now, just echo back with a prefix
    // Later we'll add OpenAI integration
    const response = `Hello! I received your message: "${message.message}"`;
    
    logger.info(`Processed message from user ${message.userId}`);
    
    return response;
  } catch (error) {
    logger.error('Error processing message:', error);
    return "I'm sorry, I encountered an error processing your message. Please try again.";
  }
}