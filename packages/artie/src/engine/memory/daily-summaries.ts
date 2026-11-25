/**
 * Reads the "daily summary" memories (tag `daily-summary`) for the autonomous capability.
 *
 * Nothing writes new ones: the nightly summarizer that produced them (runDailySummarization,
 * keyword counts, no LLM) was never scheduled and was deleted on 2026-11-24 with EJ's yes.
 * Rows written before then still read back through here.
 */

import { logger } from '../../shared/logger.js';
import { getSyncDb } from '../../shared/db/client.js';

interface DailySummary {
  userId: string;
  date: string;
  summary: string;
  topics: string[];
  keyPoints: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  messageCount: number;
}

/**
 * Get recent summaries for a user
 */
export function getRecentSummaries(userId: string, days: number = 7): DailySummary[] {
  try {
    const db = getSyncDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rows = db.all<{ content: string; metadata: string }>(
      `SELECT content, metadata FROM memories
       WHERE user_id = ? AND tags LIKE '%"daily-summary"%' AND created_at > ?
       ORDER BY created_at DESC`,
      [userId, cutoff]
    );

    return rows.map(row => {
      const meta = JSON.parse(row.metadata || '{}');
      return {
        userId,
        date: meta.date,
        summary: row.content,
        topics: meta.topics || [],
        keyPoints: meta.keyPoints || [],
        sentiment: meta.sentiment || 'neutral',
        messageCount: meta.messageCount || 0,
      };
    });
  } catch (error) {
    logger.error('Failed to get recent summaries:', error);
    return [];
  }
}
