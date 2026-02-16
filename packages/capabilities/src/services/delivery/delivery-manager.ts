/**
 * Delivery Manager - Reliable message delivery with retries
 *
 * Handles delivery of proactive messages (nudges, briefings) with:
 * - Retry logic with exponential backoff
 * - Fallback channels (DM → channel mention → SMS)
 * - Delivery tracking for analytics
 */

import { logger, getSyncDb } from '@coachartie/shared';
import { Queue } from 'bullmq';
import { createRedisConnection, testRedisConnection } from '@coachartie/shared';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000]; // 5m, 30m, 2h

export type MessageType = 'goal_nudge' | 'morning_briefing' | 'quest_nudge' | 'todo_nudge' | 'alert';
export type DeliveryChannel = 'discord_dm' | 'discord_channel' | 'sms' | 'email';
export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'fallback_sent' | 'abandoned';

export interface DeliveryOptions {
  messageType: MessageType;
  userId: string;
  content: string;
  relatedId?: string;
  priority?: 'normal' | 'high';
  fallbackChannelId?: string; // Discord channel to mention user if DM fails
}

export interface DeliveryResult {
  success: boolean;
  channel?: DeliveryChannel;
  error?: string;
  attemptId?: number;
}

interface DeliveryAttempt {
  id: number;
  message_type: string;
  target_user_id: string;
  channel: string;
  status: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  payload: string | null;
  related_id: string | null;
  created_at: string;
  delivered_at: string | null;
  next_retry_at: string | null;
}

class DeliveryManager {
  private static instance: DeliveryManager;
  private discordQueue: Queue | null = null;
  private initialized = false;

  static getInstance(): DeliveryManager {
    if (!DeliveryManager.instance) {
      DeliveryManager.instance = new DeliveryManager();
    }
    return DeliveryManager.instance;
  }

  /**
   * Initialize the delivery manager (connects to Redis queue)
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;

    const redisOk = await testRedisConnection();
    if (!redisOk) {
      logger.warn('DeliveryManager: Redis unavailable');
      return false;
    }

    try {
      this.discordQueue = new Queue('coachartie-discord-outgoing', {
        connection: createRedisConnection(),
      });
      this.initialized = true;
      logger.info('DeliveryManager initialized');
      return true;
    } catch (error) {
      logger.error('DeliveryManager initialization failed:', error);
      return false;
    }
  }

  /**
   * Check if delivery manager is ready
   */
  isReady(): boolean {
    return this.initialized && this.discordQueue !== null;
  }

  /**
   * Deliver a message with automatic retry and fallback
   */
  async deliver(options: DeliveryOptions): Promise<DeliveryResult> {
    const db = getSyncDb();
    const now = new Date();

    // Create delivery attempt record
    const result = db.run(
      `INSERT INTO delivery_attempts (message_type, target_user_id, channel, status, payload, related_id, created_at)
       VALUES (?, ?, 'discord_dm', 'pending', ?, ?, ?)`,
      [
        options.messageType,
        options.userId,
        JSON.stringify({ content: options.content, fallbackChannelId: options.fallbackChannelId }),
        options.relatedId || null,
        now.toISOString(),
      ]
    );
    const attemptId = result.lastInsertRowid as number;

    // Try Discord DM first
    const dmResult = await this.tryDiscordDM(options.userId, options.content);

    if (dmResult.success) {
      await this.markDelivered(attemptId, 'discord_dm');
      return { success: true, channel: 'discord_dm', attemptId };
    }

    // DM failed - log and schedule retry
    await this.logAttempt(attemptId, 'discord_dm', dmResult.error);

    // If high priority or we have a fallback channel, try fallback immediately
    if (options.priority === 'high' && options.fallbackChannelId && this.discordQueue) {
      const channelResult = await this.tryDiscordChannel(
        options.fallbackChannelId,
        options.content,
        options.userId
      );

      if (channelResult.success) {
        await this.markDelivered(attemptId, 'discord_channel', 'fallback_sent');
        return { success: true, channel: 'discord_channel', attemptId };
      }
    }

    // Schedule retry
    await this.scheduleRetry(attemptId, 1);

    logger.warn(`Delivery failed for ${options.messageType} to ${options.userId}, scheduled retry`);
    return { success: false, error: dmResult.error, attemptId };
  }

  /**
   * Process pending retries (called by scheduler)
   */
  async processRetries(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const db = getSyncDb();
    const now = new Date().toISOString();

    const pending = db.all<DeliveryAttempt>(
      `SELECT * FROM delivery_attempts
       WHERE status = 'pending'
       AND next_retry_at IS NOT NULL
       AND next_retry_at <= ?
       AND attempts < ?`,
      [now, MAX_ATTEMPTS]
    ) || [];

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const attempt of pending) {
      processed++;
      const payload = attempt.payload ? JSON.parse(attempt.payload) : {};

      // Try DM again
      const dmResult = await this.tryDiscordDM(attempt.target_user_id, payload.content);

      if (dmResult.success) {
        await this.markDelivered(attempt.id, 'discord_dm');
        succeeded++;
        continue;
      }

      await this.logAttempt(attempt.id, 'discord_dm', dmResult.error);

      // Check if we should try fallback
      if (attempt.attempts >= 2 && payload.fallbackChannelId && this.discordQueue) {
        const channelResult = await this.tryDiscordChannel(
          payload.fallbackChannelId,
          payload.content,
          attempt.target_user_id
        );

        if (channelResult.success) {
          await this.markDelivered(attempt.id, 'discord_channel', 'fallback_sent');
          succeeded++;
          continue;
        }
      }

      // Check if max attempts reached
      if (attempt.attempts >= MAX_ATTEMPTS) {
        await this.markAbandoned(attempt.id);
        failed++;
        logger.error(`Delivery abandoned after ${MAX_ATTEMPTS} attempts`, {
          attemptId: attempt.id,
          messageType: attempt.message_type,
          userId: attempt.target_user_id,
        });
      } else {
        await this.scheduleRetry(attempt.id, attempt.attempts + 1);
      }
    }

    if (processed > 0) {
      logger.info(`Delivery retry batch: ${processed} processed, ${succeeded} succeeded, ${failed} abandoned`);
    }

    return { processed, succeeded, failed };
  }

  /**
   * Get delivery stats for analytics
   */
  async getStats(days: number = 7): Promise<{
    total: number;
    sent: number;
    failed: number;
    fallback: number;
    byType: Record<string, { sent: number; failed: number }>;
  }> {
    const db = getSyncDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const stats = db.get<{ total: number; sent: number; failed: number; fallback: number }>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'fallback_sent' THEN 1 ELSE 0 END) as fallback
      FROM delivery_attempts
      WHERE created_at > ?`,
      [cutoff]
    );

    const byTypeRows = db.all<{ message_type: string; sent: number; failed: number }>(
      `SELECT
        message_type,
        SUM(CASE WHEN status IN ('sent', 'fallback_sent') THEN 1 ELSE 0 END) as sent,
        SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) as failed
      FROM delivery_attempts
      WHERE created_at > ?
      GROUP BY message_type`,
      [cutoff]
    ) || [];

    const byType: Record<string, { sent: number; failed: number }> = {};
    for (const row of byTypeRows) {
      byType[row.message_type] = { sent: row.sent, failed: row.failed };
    }

    return {
      total: stats?.total || 0,
      sent: stats?.sent || 0,
      failed: stats?.failed || 0,
      fallback: stats?.fallback || 0,
      byType,
    };
  }

  // Private helper methods

  private async tryDiscordDM(userId: string, content: string, source: string = 'delivery-manager'): Promise<{ success: boolean; error?: string }> {
    if (!this.discordQueue) {
      return { success: false, error: 'Discord queue not initialized' };
    }

    try {
      await this.discordQueue.add('send-dm', {
        userId,
        content,
        source,
      });
      // Queue add succeeded - actual delivery happens async
      // We'll track failures via the Discord worker's error handling
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async tryDiscordChannel(
    channelId: string,
    content: string,
    mentionUserId?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.discordQueue) {
      return { success: false, error: 'Discord queue not initialized' };
    }

    try {
      // Add mention prefix if user specified
      const messageContent = mentionUserId ? `<@${mentionUserId}> ${content}` : content;

      await this.discordQueue.add('send-channel', {
        channelId,
        content: messageContent,
        source: 'delivery-fallback',
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async markDelivered(attemptId: number, channel: DeliveryChannel, status: DeliveryStatus = 'sent'): Promise<void> {
    const db = getSyncDb();
    db.run(
      `UPDATE delivery_attempts SET status = ?, channel = ?, delivered_at = ? WHERE id = ?`,
      [status, channel, new Date().toISOString(), attemptId]
    );
  }

  private async markAbandoned(attemptId: number): Promise<void> {
    const db = getSyncDb();
    db.run(`UPDATE delivery_attempts SET status = 'abandoned' WHERE id = ?`, [attemptId]);
  }

  private async logAttempt(attemptId: number, channel: string, error?: string): Promise<void> {
    const db = getSyncDb();
    db.run(
      `UPDATE delivery_attempts
       SET attempts = attempts + 1, last_attempt_at = ?, last_error = ?, channel = ?
       WHERE id = ?`,
      [new Date().toISOString(), error || null, channel, attemptId]
    );
  }

  private async scheduleRetry(attemptId: number, attemptNumber: number): Promise<void> {
    const db = getSyncDb();
    const delayMs = RETRY_DELAYS_MS[Math.min(attemptNumber - 1, RETRY_DELAYS_MS.length - 1)];
    const nextRetry = new Date(Date.now() + delayMs).toISOString();

    db.run(`UPDATE delivery_attempts SET next_retry_at = ? WHERE id = ?`, [nextRetry, attemptId]);
  }
}

export const deliveryManager = DeliveryManager.getInstance();
