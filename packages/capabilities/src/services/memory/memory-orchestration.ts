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
   * Get relevant memory patterns for the current user message
   * Searches user-specific memories for capability usage patterns
   */
  async getRelevantMemoryPatterns(userMessage: string, userId: string): Promise<string[]> {
    try {
      logger.info(`🔍 Getting memory patterns for user ${userId}, message: "${userMessage}"`);

      // SECURITY FIX: Use user-specific memory instead of shared 'system' memory
      // This prevents parallel request contamination between users
      const memoryService = await import('../../capabilities/memory/memory.js');
      const service = memoryService.MemoryService.getInstance();

      // Search for USER-SPECIFIC capability usage patterns in memories
      const capabilityMemories = await service.recall(userId, 'capability usage patterns', 3);
      logger.info(
        `🗃️ Found user ${userId} capability memories: ${capabilityMemories ? capabilityMemories.substring(0, 100) : 'None'}...`
      );

      // Also search for any patterns related to current query type for THIS USER ONLY
      let queryTypeMemories = '';
      const lowerMessage = userMessage.toLowerCase();

      if (
        lowerMessage.includes('food') ||
        lowerMessage.includes('like') ||
        lowerMessage.includes('prefer')
      ) {
        queryTypeMemories = await service.recall(userId, 'food preferences memory search', 2);
      } else if (lowerMessage.match(/\d+.*[+\-*/].*\d+/)) {
        queryTypeMemories = await service.recall(userId, 'calculator math calculation', 2);
      } else if (
        lowerMessage.includes('what is') ||
        lowerMessage.includes('search') ||
        lowerMessage.includes('find')
      ) {
        queryTypeMemories = await service.recall(userId, 'web search latest recent', 2);
      }

      // Extract capability patterns from memory results
      const patterns: string[] = [];
      logger.info(
        `🧩 Processing capability memories: ${capabilityMemories ? capabilityMemories.length : 0} chars`
      );
      logger.info(
        `🧩 Processing query type memories: ${queryTypeMemories ? queryTypeMemories.length : 0} chars`
      );

      // Parse capability patterns from memory responses
      if (capabilityMemories && !capabilityMemories.includes('No memories found')) {
        logger.info(`✅ Found capability memories to process`);
        // Look for capability tags in the memory content
        const capabilityTags = capabilityXMLParser.findCapabilityTags(capabilityMemories);
        logger.info(`🔍 Found ${capabilityTags.length} capability matches`);

        if (capabilityTags.length > 0) {
          capabilityTags.forEach((tag) => {
            logger.info(`📝 Processing capability match: ${tag}`);
            patterns.push(`When similar queries arise, use: ${tag}`);
          });
        }
      }

      // Limit to top 3 most relevant patterns
      logger.info(
        `🎯 Returning ${patterns.length} memory patterns: ${patterns.map((p) => p.substring(0, 50)).join('; ')}`
      );
      return patterns.slice(0, 3);
    } catch (_error) {
      logger.error('❌ Failed to get memory patterns:', _error);
      return [];
    }
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
