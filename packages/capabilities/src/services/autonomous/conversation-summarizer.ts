/**
 * Conversation Summarizer Service
 *
 * n8nClaw-inspired daily summarization pipeline:
 * 1. Aggregate recent conversations
 * 2. Generate summaries using LLM
 * 3. Store as high-importance memories for future retrieval
 *
 * This creates persistent long-term context from daily interactions.
 */

import { logger, getSyncDb } from '@coachartie/shared';

interface ConversationChunk {
  userId: string;
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
  channelId?: string;
  guildId?: string;
}

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
 * Get conversations from the past day for a user
 */
function getDailyConversations(userId: string): ConversationChunk[] {
  try {
    const db = getSyncDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const messages = db.all<{
      value: string;
      role: string;
      created_at: string;
      channel_id: string;
      guild_id: string;
    }>(
      `SELECT value, role, created_at, channel_id, guild_id FROM messages
       WHERE user_id = ? AND created_at > ?
       ORDER BY created_at ASC`,
      [userId, oneDayAgo]
    );

    if (messages.length === 0) {
      return [];
    }

    // Group by channel
    const byChannel = new Map<string, typeof messages>();
    for (const msg of messages) {
      const key = msg.channel_id || 'direct';
      if (!byChannel.has(key)) {
        byChannel.set(key, []);
      }
      byChannel.get(key)!.push(msg);
    }

    // Convert to chunks
    const chunks: ConversationChunk[] = [];
    for (const [channelId, channelMsgs] of byChannel) {
      chunks.push({
        userId,
        messages: channelMsgs.map(m => ({
          role: m.role || 'user',
          content: m.value,
          timestamp: m.created_at,
        })),
        channelId: channelId !== 'direct' ? channelId : undefined,
        guildId: channelMsgs[0]?.guild_id,
      });
    }

    return chunks;
  } catch (error) {
    logger.error('Failed to get daily conversations:', error);
    return [];
  }
}

/**
 * Generate a summary of conversations (simplified - no LLM call)
 * In production, this would call the LLM for better summarization
 */
function generateSummary(chunks: ConversationChunk[]): DailySummary | null {
  if (chunks.length === 0) {
    return null;
  }

  const allMessages = chunks.flatMap(c => c.messages);
  const userMessages = allMessages.filter(m => m.role === 'user');

  if (userMessages.length === 0) {
    return null;
  }

  // Extract topics from messages (simple keyword extraction)
  const words = userMessages
    .map(m => m.content.toLowerCase())
    .join(' ')
    .split(/\s+/)
    .filter(w => w.length > 4);

  const wordFreq = new Map<string, number>();
  for (const word of words) {
    wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
  }

  const topics = [...wordFreq.entries()]
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  // Extract key points (first sentence of longer messages)
  const keyPoints = userMessages
    .filter(m => m.content.length > 50)
    .map(m => m.content.split(/[.!?]/)[0].trim())
    .filter(s => s.length > 10)
    .slice(0, 3);

  // Simple sentiment (could be enhanced with actual sentiment analysis)
  const positiveWords = ['thanks', 'great', 'awesome', 'good', 'love', 'helpful', 'perfect'];
  const negativeWords = ['bad', 'wrong', 'error', 'fail', 'broken', 'issue', 'problem'];

  const text = userMessages.map(m => m.content.toLowerCase()).join(' ');
  const positiveCount = positiveWords.filter(w => text.includes(w)).length;
  const negativeCount = negativeWords.filter(w => text.includes(w)).length;

  let sentiment: 'positive' | 'neutral' | 'negative' = 'neutral';
  if (positiveCount > negativeCount + 1) sentiment = 'positive';
  if (negativeCount > positiveCount + 1) sentiment = 'negative';

  // Generate summary text
  const summaryParts: string[] = [];
  summaryParts.push(`${allMessages.length} messages exchanged`);

  if (topics.length > 0) {
    summaryParts.push(`Topics discussed: ${topics.join(', ')}`);
  }

  if (keyPoints.length > 0) {
    summaryParts.push(`Key points: ${keyPoints.join('; ')}`);
  }

  return {
    userId: chunks[0].userId,
    date: new Date().toISOString().split('T')[0],
    summary: summaryParts.join('. '),
    topics,
    keyPoints,
    sentiment,
    messageCount: allMessages.length,
  };
}

/**
 * Store summary as a high-importance memory
 */
function storeSummary(summary: DailySummary): void {
  try {
    const db = getSyncDb();
    const content = `Daily summary (${summary.date}): ${summary.summary}`;
    const metadata = JSON.stringify({
      type: 'daily-summary',
      date: summary.date,
      topics: summary.topics,
      keyPoints: summary.keyPoints,
      sentiment: summary.sentiment,
      messageCount: summary.messageCount,
    });
    const tags = JSON.stringify(['daily-summary', 'conversation', summary.sentiment]);

    // Check if summary already exists for this date
    const existing = db.get<{ id: number }>(
      `SELECT id FROM memories WHERE user_id = ? AND metadata LIKE ?`,
      [summary.userId, `%"date":"${summary.date}"%`]
    );

    if (existing) {
      // Update existing
      db.run(
        `UPDATE memories SET content = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [content, metadata, existing.id]
      );
      logger.info(`Updated daily summary for user ${summary.userId}`);
    } else {
      // Insert new
      db.run(
        `INSERT INTO memories (user_id, content, metadata, tags, timestamp, importance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [summary.userId, content, metadata, tags, new Date().toISOString(), 8]
      );
      logger.info(`Created daily summary for user ${summary.userId}`);
    }
  } catch (error) {
    logger.error('Failed to store daily summary:', error);
  }
}

/**
 * Run daily summarization for all active users
 */
export async function runDailySummarization(): Promise<{
  usersProcessed: number;
  summariesCreated: number;
  errors: number;
}> {
  logger.info('Starting daily conversation summarization');

  const stats = {
    usersProcessed: 0,
    summariesCreated: 0,
    errors: 0,
  };

  try {
    const db = getSyncDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Get users with recent activity
    const activeUsers = db.all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM messages
       WHERE created_at > ? AND user_id != 'system'`,
      [oneDayAgo]
    );

    logger.info(`Found ${activeUsers.length} users with recent activity`);

    for (const { user_id: userId } of activeUsers) {
      try {
        stats.usersProcessed++;

        const chunks = getDailyConversations(userId);
        if (chunks.length === 0) continue;

        const summary = generateSummary(chunks);
        if (summary) {
          storeSummary(summary);
          stats.summariesCreated++;
        }
      } catch (error) {
        stats.errors++;
        logger.error(`Failed to summarize for user ${userId}:`, error);
      }
    }

    logger.info(
      `Daily summarization complete: ${stats.usersProcessed} users, ${stats.summariesCreated} summaries, ${stats.errors} errors`
    );

    return stats;
  } catch (error) {
    logger.error('Daily summarization failed:', error);
    return stats;
  }
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
