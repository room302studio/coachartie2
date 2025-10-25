import { IncomingMessage, logger } from '@coachartie/shared';
import { openRouterService } from '../services/openrouter.js';
import { capabilityOrchestrator } from '../services/capability-orchestrator.js';
import { costMonitor } from '../services/cost-monitor.js';

export async function processMessage(
  message: IncomingMessage,
  onPartialResponse?: (partial: string) => void
): Promise<string> {
  try {
    // Increment message counter for cost monitoring
    costMonitor.incrementMessageCount();
    const messageCount = costMonitor.getMessageCount();

    // Check if OpenRouter is configured
    if (
      !process.env.OPENROUTER_API_KEY ||
      process.env.OPENROUTER_API_KEY === 'sk-or-your-openrouter-key-here'
    ) {
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
      const orchestratedResponse = await capabilityOrchestrator.orchestrateMessage(
        message,
        onPartialResponse
      );

      // Check if we should auto-check credits
      const autoCheckEvery = parseInt(process.env.AUTO_CHECK_CREDITS_EVERY || '50');
      if (autoCheckEvery > 0 && messageCount % autoCheckEvery === 0) {
        logger.info(`📊 Auto-checking credits (message ${messageCount}/${autoCheckEvery})`);

        try {
          const { capabilityRegistry } = await import('../services/capability-registry.js');
          const creditStatus = await capabilityRegistry.execute(
            'credit_status',
            'check_balance',
            {}
          );
          logger.info(`💰 Auto Credit Check:\n${creditStatus}`);

          // Parse and check for critical alerts
          try {
            const statusData = JSON.parse(creditStatus);
            if (statusData.data?.active_alerts > 0) {
              logger.warn(`🚨 ${statusData.data.active_alerts} active credit alerts detected!`);
            }
          } catch (_e) {
            // Ignore parse errors
          }
        } catch (error) {
          logger.error('Failed to auto-check credits:', error);
        }
      }

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
        message.context?.conversationHistory || [],
        { source: message.source }
      );

      // Use streaming if callback provided, otherwise regular generation
      const aiResponse = onPartialResponse
        ? await openRouterService.generateFromMessageChainStreaming(
            messages,
            message.userId,
            onPartialResponse,
            message.id
          )
        : await openRouterService.generateFromMessageChain(messages, message.userId, message.id);

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
Available Capabilities: ${require('../services/capability-registry.js')
      .capabilityRegistry.list()
      .map((c: { name: string }) => c.name)
      .join(', ')}`;
  }
}
