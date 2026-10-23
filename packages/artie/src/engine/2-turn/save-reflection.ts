import { logger } from '../../shared/logger.js';
import { IncomingMessage } from '../../shared/queue/types.js';
import { llmResponseCoordinator } from '../4-generate/generate-reply.js';
import { OrchestrationContext } from './types.js';
import { REFLECTION_V3_TAG, formatReflectionNote } from './reflection-facts.js';

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
   *
   * Each reflection is {"facts": string[]} (2-turn/reflection-facts.ts). The facts of one
   * reflection become one memory row in the bullet-list shape reflection rows always had (same
   * context, importance and scope, so recall and ranking treat them as before), tagged
   * `reflection_v3` so the read-time legacy in-character filter skips them. No facts, no row.
   */
  async autoStoreReflectionMemory(
    context: OrchestrationContext,
    message: IncomingMessage,
    finalResponse: string
  ): Promise<void> {
    try {
      logger.info(`📝 Auto-storing reflection memory for interaction ${context.messageId}`);

      const memoryService = await import('../tools/core/memory.js');
      const service = memoryService.MemoryService.getInstance();

      // Create conversation summary for reflection
      const conversationText = `User: ${message.message}\nAssistant: ${finalResponse}`;

      // SECURITY FIX: Store reflection memories per user to prevent contamination
      // One model per conversation for reflections: the global rotation alternated models on
      // every call, so the reflection never hit its prompt cache (sticky rotation, 2026-09-29).
      const conversationKey =
        message.respondTo?.threadId || message.respondTo?.channelId || `user:${context.userId}`;
      // Scope the note to the server it came from (they were all stored server-less, so a
      // Subway Builder reflection could surface in Room 302).
      const guildId = message.context?.guildId as string | undefined;
      const channelId = (message.context?.channelId || message.respondTo?.channelId) as string | undefined;

      const generalFacts = await llmResponseCoordinator.generateReflection(
        conversationText,
        'general',
        context.userId,
        conversationKey
      );
      if (generalFacts.length > 0) {
        await service.remember(
          context.userId,
          formatReflectionNote(generalFacts),
          'reflection',
          3,
          undefined,
          [REFLECTION_V3_TAG],
          guildId,
          channelId
        );
        logger.info(`💾 Stored general reflection (${generalFacts.length} facts) for user ${context.userId}`);
      } else {
        logger.info(`⏭️ General reflection had nothing to remember; not stored`);
      }

      // If capabilities were used, store USER-SPECIFIC capability reflection
      // SECURITY FIX: Store capability reflections per user to prevent contamination
      if (context.capabilities.length > 0) {
        const capabilityContext = llmResponseCoordinator.buildCapabilityContext(context);
        const capabilityFacts = await llmResponseCoordinator.generateReflection(
          capabilityContext,
          'capability',
          context.userId,
          conversationKey
        );

        if (capabilityFacts.length > 0) {
          // Extract capability names and add them as explicit tags for retrieval
          const capabilityNames = [...new Set(context.capabilities.map((cap) => cap.name))];
          const tags = ['capability-reflection', REFLECTION_V3_TAG, ...capabilityNames];

          await service.remember(
            context.userId,
            formatReflectionNote(capabilityFacts),
            'capability-reflection',
            4,
            undefined, // relatedMessageId
            tags,
            guildId,
            channelId
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
