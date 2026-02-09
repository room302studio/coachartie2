/**
 * Memory Tracker - Logs memory lifecycle events
 */

import { logger, getDb } from '@coachartie/shared';
import { memoryEvents } from '@coachartie/shared';

export type MemoryEventType = 'created' | 'recalled' | 'updated' | 'forgotten' | 'pinned';

class MemoryTracker {
  private static instance: MemoryTracker;
  private enabled: boolean;

  private constructor() {
    this.enabled = process.env.ENABLE_TRACING !== 'false';
  }

  static getInstance(): MemoryTracker {
    if (!MemoryTracker.instance) {
      MemoryTracker.instance = new MemoryTracker();
    }
    return MemoryTracker.instance;
  }

  async logEvent(options: {
    memoryId: number;
    eventType: MemoryEventType;
    userId?: string;
    traceId?: string;
    query?: string;
    relevanceScore?: number;
    details?: Record<string, any>;
  }): Promise<void> {
    if (!this.enabled) return;

    try {
      const db = getDb();

      await db.insert(memoryEvents).values({
        memoryId: options.memoryId,
        eventType: options.eventType,
        userId: options.userId,
        traceId: options.traceId,
        query: options.query,
        relevanceScore: options.relevanceScore,
        detailsJson: options.details ? JSON.stringify(options.details) : null,
      });

      logger.debug(`🧠 Memory event: ${options.eventType} for memory ${options.memoryId}`);
    } catch (error) {
      logger.error('Failed to log memory event:', error);
    }
  }

  async logCreated(memoryId: number, userId?: string, details?: Record<string, any>): Promise<void> {
    await this.logEvent({ memoryId, eventType: 'created', userId, details });
  }

  async logRecalled(
    memoryId: number,
    query: string,
    relevanceScore: number,
    userId?: string,
    traceId?: string
  ): Promise<void> {
    await this.logEvent({
      memoryId,
      eventType: 'recalled',
      userId,
      traceId,
      query,
      relevanceScore,
    });
  }

  async logUpdated(memoryId: number, userId?: string, details?: Record<string, any>): Promise<void> {
    await this.logEvent({ memoryId, eventType: 'updated', userId, details });
  }

  async logForgotten(memoryId: number, userId?: string, reason?: string): Promise<void> {
    await this.logEvent({
      memoryId,
      eventType: 'forgotten',
      userId,
      details: reason ? { reason } : undefined,
    });
  }

  async logPinned(memoryId: number, newImportance: number, userId?: string): Promise<void> {
    await this.logEvent({
      memoryId,
      eventType: 'pinned',
      userId,
      details: { newImportance },
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const memoryTracker = MemoryTracker.getInstance();
