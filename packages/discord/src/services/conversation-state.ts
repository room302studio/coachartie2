/**
 * Conversation State Management
 *
 * Manages multi-turn conversational flows where the bot needs to remember
 * context across multiple messages (e.g., "which repo?" -> "this one" -> sync).
 *
 * Features:
 * - Per-user conversation tracking
 * - Automatic timeout and cleanup
 * - Type-safe state management
 * - Support for multiple concurrent conversations
 */

import { logger } from '@coachartie/shared';

export interface ConversationContext {
  userId: string;
  conversationType: 'sync-discussions' | 'general';
  state: any;
  createdAt: Date;
  lastUpdatedAt: Date;
  expiresAt: Date;
}

const CONVERSATION_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Conversation State Manager
 */
export class ConversationStateManager {
  private conversations: Map<string, ConversationContext> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 1000); // Check every minute
  }

  /**
   * Start a new conversation for a user
   */
  startConversation(
    userId: string,
    conversationType: ConversationContext['conversationType'],
    initialState: any = {}
  ): ConversationContext {
    const now = new Date();
    const context: ConversationContext = {
      userId,
      conversationType,
      state: initialState,
      createdAt: now,
      lastUpdatedAt: now,
      expiresAt: new Date(now.getTime() + CONVERSATION_TTL),
    };

    this.conversations.set(userId, context);
    logger.info(`Started ${conversationType} conversation for user ${userId}`);

    return context;
  }

  /**
   * Get an active conversation for a user
   */
  getConversation(userId: string): ConversationContext | null {
    const conversation = this.conversations.get(userId);

    if (!conversation) {
      return null;
    }

    // Check if expired
    if (new Date() > conversation.expiresAt) {
      this.endConversation(userId);
      return null;
    }

    return conversation;
  }

  /**
   * Update conversation state
   */
  updateConversation(userId: string, newState: any): boolean {
    const conversation = this.getConversation(userId);

    if (!conversation) {
      logger.warn(`Attempted to update non-existent conversation for user ${userId}`);
      return false;
    }

    conversation.state = { ...conversation.state, ...newState };
    conversation.lastUpdatedAt = new Date();
    conversation.expiresAt = new Date(Date.now() + CONVERSATION_TTL); // Extend TTL

    this.conversations.set(userId, conversation);
    logger.debug(`Updated conversation state for user ${userId}`);

    return true;
  }

  /**
   * End a conversation
   */
  endConversation(userId: string): boolean {
    const existed = this.conversations.delete(userId);
    if (existed) {
      logger.info(`Ended conversation for user ${userId}`);
    }
    return existed;
  }

  /**
   * Check if a user has an active conversation
   */
  hasActiveConversation(userId: string): boolean {
    return this.getConversation(userId) !== null;
  }

  /**
   * Cleanup expired conversations
   */
  private cleanup(): void {
    const now = new Date();
    let cleanedCount = 0;

    for (const [userId, context] of this.conversations.entries()) {
      if (now > context.expiresAt) {
        this.conversations.delete(userId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug(`Cleaned up ${cleanedCount} expired conversations`);
    }
  }

  /**
   * Get all active conversations (for debugging)
   */
  getActiveConversations(): ConversationContext[] {
    return Array.from(this.conversations.values());
  }

  /**
   * Destroy the manager and cleanup
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.conversations.clear();
  }
}

/**
 * Global conversation state manager instance
 */
let conversationManager: ConversationStateManager | null = null;

export function initializeConversationState(): ConversationStateManager {
  if (conversationManager) {
    logger.warn('Conversation state manager already initialized');
    return conversationManager;
  }

  conversationManager = new ConversationStateManager();
  logger.info('Conversation state manager initialized');
  return conversationManager;
}

export function getConversationState(): ConversationStateManager {
  if (!conversationManager) {
    throw new Error(
      'Conversation state manager not initialized. Call initializeConversationState first.'
    );
  }
  return conversationManager;
}
