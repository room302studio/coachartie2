/**
 * Heartbeat Service
 *
 * n8nClaw-inspired autonomous heartbeat that runs hourly to:
 * - Check on stalled quests and nudge users
 * - Review pending tasks
 * - Surface important memories
 * - Deliver proactive insights
 *
 * This is the core of Artie's autonomous behavior.
 *
 * IMPORTANT: Only sends proactive DMs to whitelisted users (owner only by default).
 * See @coachartie/shared config/owner.ts for the whitelist.
 */

import { logger, getSyncDb, canReceiveProactiveDMs, OWNER_USER_ID } from '@coachartie/shared';
import { sendDiscordDM } from '../../capabilities/communication/proactive-dm.js';

interface StuckQuest {
  questId: string;
  title: string;
  currentStep: number;
  stepTitle: string;
  stuckDays: number;
}

interface UserHeartbeatData {
  userId: string;
  username: string;
  activeQuests: StuckQuest[];
  lastActivity: string;
  daysSinceActivity: number;
}

/**
 * Find users with stalled quests (no progress in 24+ hours)
 * Only returns whitelisted users who can receive proactive DMs
 */
function findStalledQuests(): UserHeartbeatData[] {
  try {
    const db = getSyncDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Find quest memories that haven't been updated recently
    const rows = db.all<{ user_id: string; metadata: string; updated_at: string }>(
      `SELECT user_id, metadata, updated_at FROM memories
       WHERE tags LIKE '%"quest"%'
       AND metadata LIKE '%"status":"active"%'
       AND updated_at < ?
       ORDER BY updated_at ASC`,
      [oneDayAgo]
    );

    const userQuests = new Map<string, StuckQuest[]>();

    for (const row of rows) {
      // CRITICAL: Only include whitelisted users
      if (!canReceiveProactiveDMs(row.user_id)) {
        continue;
      }

      try {
        const metadata = JSON.parse(row.metadata || '{}');
        if (metadata.quest && metadata.quest.status === 'active') {
          const quest = metadata.quest;
          const updatedAt = new Date(row.updated_at || quest.updatedAt);
          const stuckDays = Math.floor((Date.now() - updatedAt.getTime()) / (24 * 60 * 60 * 1000));

          if (stuckDays >= 1) {
            const currentStep = quest.steps[quest.currentStep];
            const stuckQuest: StuckQuest = {
              questId: quest.id,
              title: quest.title,
              currentStep: quest.currentStep + 1,
              stepTitle: currentStep?.title || 'Unknown step',
              stuckDays,
            };

            if (!userQuests.has(row.user_id)) {
              userQuests.set(row.user_id, []);
            }
            userQuests.get(row.user_id)!.push(stuckQuest);
          }
        }
      } catch {
        // Skip malformed entries
      }
    }

    // Convert to array
    const results: UserHeartbeatData[] = [];
    for (const [userId, quests] of userQuests) {
      results.push({
        userId,
        username: userId,
        activeQuests: quests,
        lastActivity: '',
        daysSinceActivity: 0,
      });
    }

    return results;
  } catch (error) {
    logger.error('Failed to find stalled quests:', error);
    return [];
  }
}

/**
 * Generate a friendly nudge message for a stuck quest
 */
function generateNudgeMessage(quest: StuckQuest): string {
  const dayText = quest.stuckDays === 1 ? 'a day' : `${quest.stuckDays} days`;

  const nudges = [
    `Hey! I noticed you've been on step ${quest.currentStep} of "${quest.title}" for ${dayText}. The current step is: **${quest.stepTitle}**. Need any help moving forward?`,
    `Quick check-in: Your quest "${quest.title}" has been paused at "${quest.stepTitle}" for ${dayText}. Want to tackle it together or skip this step?`,
    `Friendly nudge: "${quest.title}" is waiting for you! You're on: **${quest.stepTitle}**. Say "quest status" to see where you are, or "skip step" if you want to move on.`,
  ];

  return nudges[Math.floor(Math.random() * nudges.length)];
}

/**
 * Check for users who haven't interacted in a while
 * Only returns whitelisted users
 */
function findInactiveUsers(dayThreshold: number = 3): string[] {
  try {
    const db = getSyncDb();
    const cutoff = new Date(Date.now() - dayThreshold * 24 * 60 * 60 * 1000).toISOString();

    // Find users with recent activity
    const activeUsers = db.all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM messages
       WHERE created_at > ? AND user_id != 'system'`,
      [cutoff]
    );

    // Find users with quests but no recent activity
    const questUsers = db.all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM memories
       WHERE tags LIKE '%"quest"%' AND metadata LIKE '%"status":"active"%'`,
      []
    );

    const activeSet = new Set(activeUsers.map(u => u.user_id));
    const inactiveWithQuests = questUsers
      .filter(u => !activeSet.has(u.user_id))
      .filter(u => canReceiveProactiveDMs(u.user_id)) // Only whitelisted users
      .map(u => u.user_id);

    return inactiveWithQuests;
  } catch (error) {
    logger.error('Failed to find inactive users:', error);
    return [];
  }
}

/**
 * Generate daily insights from recent activity
 */
async function generateDailyInsights(userId: string): Promise<string | null> {
  // CRITICAL: Only generate for whitelisted users
  if (!canReceiveProactiveDMs(userId)) {
    return null;
  }

  try {
    const db = getSyncDb();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Count recent memories created
    const memoryCount = db.get<{ count: number }>(
      `SELECT COUNT(*) as count FROM memories
       WHERE user_id = ? AND created_at > ?`,
      [userId, oneDayAgo]
    );

    // Get recent high-importance memories
    const gems = db.all<{ content: string }>(
      `SELECT content FROM memories
       WHERE user_id = ? AND importance >= 7 AND created_at > ?
       ORDER BY importance DESC LIMIT 3`,
      [userId, oneDayAgo]
    );

    if (!memoryCount?.count && gems.length === 0) {
      return null;
    }

    let insight = `**Your Daily Digest**\n\n`;

    if (memoryCount?.count) {
      insight += `Captured ${memoryCount.count} new memory${memoryCount.count > 1 ? 'ies' : ''} today.\n\n`;
    }

    if (gems.length > 0) {
      insight += `**Notable memories:**\n`;
      for (const gem of gems) {
        insight += `- ${gem.content.slice(0, 100)}${gem.content.length > 100 ? '...' : ''}\n`;
      }
    }

    return insight;
  } catch (error) {
    logger.error('Failed to generate daily insights:', error);
    return null;
  }
}

/**
 * Main heartbeat execution
 * Called by scheduler every hour
 *
 * IMPORTANT: Only sends to whitelisted users (owner by default)
 */
export async function executeHeartbeat(): Promise<{
  questNudges: number;
  insightsDelivered: number;
  errors: number;
}> {
  logger.info('Heartbeat: Starting autonomous check-in cycle');

  const stats = {
    questNudges: 0,
    insightsDelivered: 0,
    errors: 0,
  };

  try {
    // 1. Quest nudges - Only for whitelisted users (owner)
    const stalledUsers = findStalledQuests();
    logger.info(`Heartbeat: Found ${stalledUsers.length} whitelisted users with stalled quests`);

    for (const userData of stalledUsers) {
      for (const quest of userData.activeQuests) {
        try {
          const message = generateNudgeMessage(quest);
          const sent = await sendDiscordDM(userData.userId, message, 'heartbeat-nudge');
          if (sent) {
            stats.questNudges++;
            logger.info(`Heartbeat: Sent quest nudge to ${userData.userId} about "${quest.title}"`);
          }
        } catch (error) {
          logger.error(`Heartbeat: Failed to nudge ${userData.userId}:`, error);
          stats.errors++;
        }
      }
    }

    // 2. Daily insights - Only for owner at specific times (9 AM and 6 PM UTC)
    const hour = new Date().getUTCHours();
    if (hour === 9 || hour === 18) {
      const insight = await generateDailyInsights(OWNER_USER_ID);
      if (insight) {
        try {
          const sent = await sendDiscordDM(OWNER_USER_ID, insight, 'daily-insight');
          if (sent) {
            stats.insightsDelivered++;
            logger.info(`Heartbeat: Sent daily insight to owner`);
          }
        } catch (error) {
          logger.error(`Heartbeat: Failed to send insight to owner:`, error);
          stats.errors++;
        }
      }
    }

    logger.info(`Heartbeat complete: ${stats.questNudges} nudges, ${stats.insightsDelivered} insights, ${stats.errors} errors`);
    return stats;

  } catch (error) {
    logger.error('Heartbeat failed:', error);
    stats.errors++;
    return stats;
  }
}

/**
 * Quick health check for the heartbeat system
 */
export function heartbeatStatus(): {
  healthy: boolean;
  stalledQuests: number;
  inactiveUsers: number;
} {
  const stalledUsers = findStalledQuests();
  const inactiveUsers = findInactiveUsers();

  return {
    healthy: true,
    stalledQuests: stalledUsers.reduce((sum, u) => sum + u.activeQuests.length, 0),
    inactiveUsers: inactiveUsers.length,
  };
}
