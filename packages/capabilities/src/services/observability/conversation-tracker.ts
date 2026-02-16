/**
 * Conversation Tracker - Groups messages into conversation threads
 */

import { logger, getDb } from '@coachartie/shared';
import { conversations } from '@coachartie/shared';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, isNull, desc } from 'drizzle-orm';

const CONVERSATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class ConversationTracker {
  private static instance: ConversationTracker;
  private enabled: boolean;

  private constructor() {
    this.enabled = process.env.ENABLE_TRACING !== 'false';
  }

  static getInstance(): ConversationTracker {
    if (!ConversationTracker.instance) {
      ConversationTracker.instance = new ConversationTracker();
    }
    return ConversationTracker.instance;
  }

  async getOrCreateConversation(
    userId: string,
    channelId: string,
    guildId?: string
  ): Promise<string | null> {
    if (!this.enabled) return null;

    try {
      const db = getDb();
      const now = new Date();
      const cutoff = new Date(now.getTime() - CONVERSATION_TIMEOUT_MS);

      const activeConversations = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.userId, userId),
            eq(conversations.channelId, channelId),
            isNull(conversations.endedAt)
          )
        )
        .orderBy(desc(conversations.lastActivityAt))
        .limit(1);

      const active = activeConversations[0];

      if (active) {
        const lastActivity = new Date(active.lastActivityAt);
        if (lastActivity > cutoff) {
          await db
            .update(conversations)
            .set({
              lastActivityAt: now.toISOString(),
              messageCount: (active.messageCount || 0) + 1,
            })
            .where(eq(conversations.id, active.id));
          return active.id;
        } else {
          await this.endConversation(active.id);
        }
      }

      const conversationId = uuidv4();
      await db.insert(conversations).values({
        id: conversationId,
        userId,
        guildId,
        channelId,
        startedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        messageCount: 1,
        turnCount: 0,
      });

      logger.debug(`💬 New conversation started: ${conversationId.slice(-8)}`);
      return conversationId;
    } catch (error) {
      logger.error('Failed to get/create conversation:', error);
      return null;
    }
  }

  async incrementTurn(conversationId: string): Promise<void> {
    if (!this.enabled || !conversationId) return;

    try {
      const db = getDb();
      const convos = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (convos.length === 0) return;

      await db
        .update(conversations)
        .set({
          turnCount: (convos[0].turnCount || 0) + 1,
          lastActivityAt: new Date().toISOString(),
        })
        .where(eq(conversations.id, conversationId));
    } catch (error) {
      logger.error('Failed to increment conversation turn:', error);
    }
  }

  async recordFeedback(conversationId: string, sentiment: 'positive' | 'negative'): Promise<void> {
    if (!this.enabled || !conversationId) return;

    try {
      const db = getDb();
      const convos = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (convos.length === 0) return;

      const convo = convos[0];
      const field = sentiment === 'positive' ? 'positiveReactions' : 'negativeReactions';
      const currentValue = convo[field] || 0;

      await db
        .update(conversations)
        .set({ [field]: currentValue + 1 })
        .where(eq(conversations.id, conversationId));
    } catch (error) {
      logger.error('Failed to record conversation feedback:', error);
    }
  }

  async endConversation(conversationId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const db = getDb();
      const convos = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);

      if (convos.length === 0) return;

      const convo = convos[0];
      const startedAt = new Date(convo.startedAt);
      const lastActivity = new Date(convo.lastActivityAt);
      const durationMs = lastActivity.getTime() - startedAt.getTime();

      await db
        .update(conversations)
        .set({
          endedAt: lastActivity.toISOString(),
          totalDurationMs: durationMs,
        })
        .where(eq(conversations.id, conversationId));
    } catch (error) {
      logger.error('Failed to end conversation:', error);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const conversationTracker = ConversationTracker.getInstance();
