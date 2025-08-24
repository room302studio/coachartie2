import { IncomingMessage, logger } from '@coachartie/shared';
import { openRouterService } from '../services/openrouter.js';
import { capabilityOrchestrator } from '../services/capability-orchestrator.js';

export async function processMessage(
  message: IncomingMessage, 
  onPartialResponse?: (partial: string) => void
): Promise<string> {
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
      
      // Use capability orchestrator for full pipeline with streaming support
      const orchestratedResponse = await capabilityOrchestrator.orchestrateMessage(message, onPartialResponse);
      
      logger.info(`✅ Capability orchestration completed for user ${message.userId}`);
      return orchestratedResponse;
      
    } else {
      logger.info(`🤖 Processing message with simple AI chat: ${message.id}`);
      
      // Fallback to Context Alchemy-powered AI response  
      const { contextAlchemy } = await import('../services/context-alchemy.js');
      const { promptManager } = await import('../services/prompt-manager.js');
      
      const baseSystemPrompt = await promptManager.getCapabilityInstructions(message.message);
      const { messages } = await contextAlchemy.buildMessageChain(
        message.message,
        message.userId,
        baseSystemPrompt,
        message.context?.conversationHistory || []
      );
      
      // Use streaming if callback provided, otherwise regular generation
      const aiResponse = onPartialResponse 
        ? await openRouterService.generateFromMessageChainStreaming(messages, message.userId, onPartialResponse)
        : await openRouterService.generateFromMessageChain(messages, message.userId);
      
      logger.info(`Generated simple AI response for user ${message.userId}`);
      return aiResponse;
    }
    
  } catch (error) {
    logger.error('Error processing message:', error);
    return `🚨 VERBOSE ERROR DEBUG INFO 🚨
Message ID: ${message.id}
User ID: ${message.userId}
Source: ${message.source}
Original Message: "${message.message}"
Error: ${error instanceof Error ? error.message : String(error)}
Stack: ${error instanceof Error ? error.stack : 'No stack trace'}
Timestamp: ${new Date().toISOString()}
OpenRouter Key Status: ${process.env.OPENROUTER_API_KEY ? 'CONFIGURED' : 'MISSING'}
Capabilities Enabled: ${process.env.ENABLE_CAPABILITIES !== 'false'}
Environment: ${process.env.NODE_ENV || 'unknown'}
Available Capabilities: ${require('../services/capability-registry.js').capabilityRegistry.list().map((c: { name: string }) => c.name).join(', ')}`;
  }
}