import { logger, IncomingMessage } from '@coachartie/shared';
import { capabilityXMLParser } from '../../utils/xml-parser.js';
import { llmResponseCoordinator } from '../llm/llm-response-coordinator.js';
import { OrchestrationContext } from '../../types/orchestration-types.js';

// =====================================================
// MEMORY ORCHESTRATION SERVICE
// Handles memory pattern retrieval and reflection storage
// =====================================================

export class MemoryOrchestration {
  private static instance: MemoryOrchestration;

  static getInstance(): MemoryOrchestration {
    if (!MemoryOrchestration.instance) {
      MemoryOrchestration.instance = new MemoryOrchestration();
    }
    return MemoryOrchestration.instance;
  }

  /**
   * Auto-store reflection memories about successful interactions
   * Stores both general and capability-specific reflections per user
   */
  async autoStoreReflectionMemory(
    context: OrchestrationContext,
    message: IncomingMessage,
    finalResponse: string
  ): Promise<void> {
    try {
      logger.info(`📝 Auto-storing reflection memory for interaction ${context.messageId}`);

      const memoryService = await import('../../capabilities/memory/memory.js');
      const service = memoryService.MemoryService.getInstance();

      // Create conversation summary for reflection
      const conversationText = `User: ${message.message}\nAssistant: ${finalResponse}`;

      // Store USER-SPECIFIC interaction reflection using PROMPT_REMEMBER
      // SECURITY FIX: Store reflection memories per user to prevent contamination
      const generalReflection = await llmResponseCoordinator.generateReflection(
        conversationText,
        'general',
        context.userId
      );
      if (generalReflection && generalReflection !== '✨') {
        await service.remember(context.userId, generalReflection, 'reflection', 3);
        logger.info(`💾 Stored general reflection memory for user ${context.userId}`);
      }

      // If capabilities were used, store USER-SPECIFIC capability reflection
      // SECURITY FIX: Store capability reflections per user to prevent contamination
      if (context.capabilities.length > 0) {
        const capabilityContext = llmResponseCoordinator.buildCapabilityContext(context);
        const capabilityReflection = await llmResponseCoordinator.generateReflection(
          capabilityContext,
          'capability',
          context.userId
        );

        if (capabilityReflection && capabilityReflection !== '✨') {
          // Extract capability names and add them as explicit tags for retrieval
          const capabilityNames = [...new Set(context.capabilities.map((cap) => cap.name))];
          const tags = ['capability-reflection', ...capabilityNames];

          await service.remember(
            context.userId,
            capabilityReflection,
            'capability-reflection',
            4,
            undefined, // relatedMessageId
            tags
          );
          logger.info(
            `🔧 Stored capability reflection memory for user ${context.userId} (${context.capabilities.length} capabilities) with tags: ${tags.join(', ')}`
          );
        }
      }
    } catch (_error) {
      logger.error('❌ Failed to store reflection memory:', _error);
      // Don't throw - reflection failure shouldn't break the main flow
    }
  }
}

export const memoryOrchestration = MemoryOrchestration.getInstance();
