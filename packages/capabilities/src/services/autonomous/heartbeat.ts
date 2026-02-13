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
 */

import { logger, getSyncDb } from '@coachartie/shared';
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
        username: userId, // Could enhance with user profile lookup
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
      insight += `I learned ${memoryCount.count} new thing${memoryCount.count > 1 ? 's' : ''} about you today.\n\n`;
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
    // 1. Quest nudges - DISABLED until opt-in system is built
    // TODO: Only nudge users who have explicitly opted into proactive messages
    // This should check a user preference before sending ANY unsolicited DMs
    const stalledUsers = findStalledQuests();
    logger.info(`Heartbeat: Found ${stalledUsers.length} users with stalled quests (NOT sending - needs opt-in)`);

    // Log but don't send until opt-in is implemented
    for (const userData of stalledUsers) {
      for (const quest of userData.activeQuests) {
        logger.info(`Heartbeat: Would nudge ${userData.userId} about "${quest.title}" (DISABLED)`);
      }
    }

    // 2. Daily insights - DISABLED until opt-in system is built
    // TODO: Only send to users who have explicitly opted in
    // The previous code was sending to ALL active users which is NOT okay
    logger.info('Heartbeat: Daily insights DISABLED - needs opt-in system');

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
