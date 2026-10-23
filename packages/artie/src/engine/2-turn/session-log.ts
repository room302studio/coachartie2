/**
 * Session Manager - Tracks user engagement sessions
 */

import { logger, getDb } from '@coachartie/shared';
import { userSessions } from '@coachartie/shared';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, isNull, lt, desc } from 'drizzle-orm';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class SessionManager {
  private static instance: SessionManager;
  private enabled: boolean;

  private constructor() {
    this.enabled = process.env.ENABLE_TRACING !== 'false';
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  async trackActivity(userId: string, guildId?: string): Promise<string | null> {
    if (!this.enabled) return null;

    try {
      const db = getDb();
      const now = new Date();
      const cutoff = new Date(now.getTime() - SESSION_TIMEOUT_MS);

      const activeSessions = await db
        .select()
        .from(userSessions)
        .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)))
        .orderBy(desc(userSessions.lastActivityAt))
        .limit(1);

      const activeSession = activeSessions[0];

      if (activeSession) {
        const lastActivity = new Date(activeSession.lastActivityAt);
        if (lastActivity > cutoff) {
          await db
            .update(userSessions)
            .set({
              lastActivityAt: now.toISOString(),
              messageCount: (activeSession.messageCount || 0) + 1,
            })
            .where(eq(userSessions.id, activeSession.id));
          return activeSession.id;
        } else {
          await this.endSession(activeSession.id);
        }
      }

      const sessionId = uuidv4();
      await db.insert(userSessions).values({
        id: sessionId,
        userId,
        guildId,
        startedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        messageCount: 1,
      });

      logger.debug(`📊 New session started: ${sessionId.slice(-8)} for user ${userId.slice(-6)}`);
      return sessionId;
    } catch (error) {
      logger.error('Failed to track session activity:', error);
      return null;
    }
  }

  async endSession(sessionId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      const db = getDb();
      const sessions = await db
        .select()
        .from(userSessions)
        .where(eq(userSessions.id, sessionId))
        .limit(1);

      if (sessions.length === 0) return;

      const session = sessions[0];
      const startedAt = new Date(session.startedAt);
      const lastActivity = new Date(session.lastActivityAt);
      const durationMs = lastActivity.getTime() - startedAt.getTime();

      await db
        .update(userSessions)
        .set({
          endedAt: lastActivity.toISOString(),
          totalDurationMs: durationMs,
        })
        .where(eq(userSessions.id, sessionId));
    } catch (error) {
      logger.error('Failed to end session:', error);
    }
  }

  async recordFeedback(userId: string, sentiment: 'positive' | 'negative'): Promise<void> {
    if (!this.enabled) return;

    try {
      const db = getDb();
      const sessions = await db
        .select()
        .from(userSessions)
        .where(and(eq(userSessions.userId, userId), isNull(userSessions.endedAt)))
        .limit(1);

      if (sessions.length === 0) return;

      const session = sessions[0];
      const field = sentiment === 'positive' ? 'positiveReactions' : 'negativeReactions';
      const currentValue = session[field] || 0;

      await db
        .update(userSessions)
        .set({ [field]: currentValue + 1 })
        .where(eq(userSessions.id, session.id));
    } catch (error) {
      logger.error('Failed to record session feedback:', error);
    }
  }

  async closeStaleSessions(): Promise<number> {
    if (!this.enabled) return 0;

    try {
      const db = getDb();
      const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS);

      const staleSessions = await db
        .select()
        .from(userSessions)
        .where(
          and(isNull(userSessions.endedAt), lt(userSessions.lastActivityAt, cutoff.toISOString()))
        );

      for (const session of staleSessions) {
        await this.endSession(session.id);
      }

      return staleSessions.length;
    } catch (error) {
      logger.error('Failed to close stale sessions:', error);
      return 0;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const sessionManager = SessionManager.getInstance();
