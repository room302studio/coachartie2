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

import { logger, getSyncDb, canReceiveProactiveDMs, OWNER_USER_ID, getDb, objectives, eq } from '@coachartie/shared';
import type { Objective } from '@coachartie/shared';
import { sendDiscordDM } from '../../capabilities/communication/proactive-dm.js';
import { getStalledGoals, logGoalAction } from '../../capabilities/productivity/goals.js';
import { deliveryManager } from '../delivery/index.js';

const NUDGE_COOLDOWN_HOURS = 24;

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
 * Find stalled todos (lists with pending items not touched in 2+ days)
 */
function findStalledTodos(): Array<{ userId: string; listName: string; pendingCount: number; staleDays: number }> {
  try {
    const db = getSyncDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const rows = db.all<{
      user_id: string;
      name: string;
      pending_count: number;
      updated_at: string;
    }>(`
      SELECT tl.user_id, tl.name, tl.updated_at,
             COUNT(ti.id) as pending_count
      FROM todo_lists tl
      JOIN todo_items ti ON tl.id = ti.list_id
      WHERE ti.status = 'pending'
        AND tl.updated_at < ?
      GROUP BY tl.id
      HAVING pending_count > 0
    `, [twoDaysAgo]);

    return rows
      .filter(row => canReceiveProactiveDMs(row.user_id))
      .map(row => ({
        userId: row.user_id,
        listName: row.name,
        pendingCount: row.pending_count,
        staleDays: Math.floor((Date.now() - new Date(row.updated_at).getTime()) / (24 * 60 * 60 * 1000)),
      }));
  } catch (error) {
    logger.error('Failed to find stalled todos:', error);
    return [];
  }
}

/**
 * Generate a nudge message for a stalled goal
 */
function generateGoalNudgeMessage(goal: Objective): string {
  const lastWorked = goal.lastWorkedAt ? new Date(goal.lastWorkedAt) : new Date(goal.createdAt || Date.now());
  const staleDays = Math.floor((Date.now() - lastWorked.getTime()) / (24 * 60 * 60 * 1000));
  const dayText = staleDays === 1 ? 'a day' : `${staleDays} days`;

  const progressBar = '█'.repeat(Math.floor((goal.progress || 0) / 10)) + '░'.repeat(10 - Math.floor((goal.progress || 0) / 10));

  const nudges = [
    `🎯 Your goal **"${goal.title}"** hasn't seen action in ${dayText}.\n\n[${progressBar}] ${goal.progress || 0}%\n\nWhat's one small thing you could do today to move it forward?`,
    `Checking in on **"${goal.title}"** - it's been ${dayText} since any progress. Currently at ${goal.progress || 0}%.\n\nNeed help breaking it down into smaller steps?`,
    `Quick nudge: **"${goal.title}"** is waiting for you! You're at ${goal.progress || 0}%. Say "goals progress ${goal.id.slice(0, 8)} 60" to update your progress.`,
  ];

  // Add blocker-specific message if goal is blocked
  if (goal.status === 'blocked' && goal.blockers) {
    return `🚧 Your goal **"${goal.title}"** is blocked: ${goal.blockers}\n\nCan I help unblock this? Let me know what's in the way.`;
  }

  return nudges[Math.floor(Math.random() * nudges.length)];
}

/**
 * Check kanban for cards assigned to Artie
 */
async function checkKanbanForArtie(): Promise<Array<{ id: string; title: string; lane: string }>> {
  try {
    const { execSync } = await import('child_process');
    const result = execSync('~/scripts/kanban list Active 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Parse kanban CLI output (format: "ID: title [lane]")
    const cards: Array<{ id: string; title: string; lane: string }> = [];
    for (const line of result.split('\n')) {
      const match = line.match(/^(\d+):\s+(.+?)\s+\[(\w+)\]/);
      if (match) {
        cards.push({ id: match[1], title: match[2], lane: match[3] });
      }
    }
    return cards;
  } catch {
    return [];
  }
}

/**
 * Main heartbeat execution
 * Called by scheduler every hour
 *
 * IMPORTANT: Only sends to whitelisted users (owner by default)
 *
 * Systems mesh: Aggregates across quests, todos, and kanban
 */
export async function executeHeartbeat(): Promise<{
  questNudges: number;
  todoNudges: number;
  goalNudges: number;
  kanbanAlerts: number;
  insightsDelivered: number;
  errors: number;
}> {
  logger.info('Heartbeat: Starting autonomous check-in cycle');

  const stats = {
    questNudges: 0,
    todoNudges: 0,
    goalNudges: 0,
    kanbanAlerts: 0,
    insightsDelivered: 0,
    errors: 0,
  };

  try {
    // 1. Quest nudges - stalled multi-step journeys
    const stalledUsers = findStalledQuests();
    logger.info(`Heartbeat: Found ${stalledUsers.length} users with stalled quests`);

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

    // 2. Todo nudges - stalled todo lists (not touched in 2+ days)
    const stalledTodos = findStalledTodos();
    logger.info(`Heartbeat: Found ${stalledTodos.length} stalled todo lists`);

    for (const todo of stalledTodos) {
      try {
        const message = `📋 Your todo list "${todo.listName}" has ${todo.pendingCount} pending items and hasn't been touched in ${todo.staleDays} days. Say "todo status ${todo.listName}" to review.`;
        const sent = await sendDiscordDM(todo.userId, message, 'heartbeat-todo');
        if (sent) {
          stats.todoNudges++;
        }
      } catch (error) {
        logger.error(`Heartbeat: Failed to send todo nudge:`, error);
        stats.errors++;
      }
    }

    // 3. Goal nudges - stalled autonomous objectives (3+ days inactive)
    // Uses delivery manager for reliable delivery with retry
    try {
      const stalledGoals = await getStalledGoals('ej'); // Goals use 'ej' as owner
      logger.info(`Heartbeat: Found ${stalledGoals.length} stalled goals`);

      // Initialize delivery manager if needed
      await deliveryManager.initialize();

      const db = getDb();
      for (const goal of stalledGoals) {
        try {
          // Rate limit: skip if nudged within last 24 hours
          if (goal.lastNudgedAt) {
            const hoursSinceNudge = (Date.now() - new Date(goal.lastNudgedAt).getTime()) / (1000 * 60 * 60);
            if (hoursSinceNudge < NUDGE_COOLDOWN_HOURS) {
              logger.info(`Heartbeat: Skipping nudge for "${goal.title}" - nudged ${hoursSinceNudge.toFixed(1)}h ago`);
              continue;
            }
          }

          const message = generateGoalNudgeMessage(goal);

          // Use delivery manager for reliable delivery with retry
          const result = await deliveryManager.deliver({
            messageType: 'goal_nudge',
            userId: OWNER_USER_ID,
            content: message,
            relatedId: goal.id,
            priority: goal.status === 'blocked' ? 'high' : 'normal',
          });

          if (result.success) {
            stats.goalNudges++;

            // Update lastNudgedAt to prevent spam
            await db.update(objectives)
              .set({ lastNudgedAt: new Date().toISOString() })
              .where(eq(objectives.id, goal.id));

            // Log the nudge action
            await logGoalAction(goal.id, 'reminder', 'Sent stalled goal reminder');
            logger.info(`Heartbeat: Sent goal nudge about "${goal.title}"`);
          } else {
            // Delivery manager will handle retry scheduling
            logger.warn(`Heartbeat: Goal nudge queued for retry: "${goal.title}" - ${result.error}`);
          }
        } catch (error) {
          logger.error(`Heartbeat: Failed to send goal nudge:`, error);
          stats.errors++;
        }
      }
    } catch (error) {
      logger.error('Heartbeat: Failed to check stalled goals:', error);
      stats.errors++;
    }

    // 4. Kanban awareness - check for active cards (once per hour is fine)
    const activeCards = await checkKanbanForArtie();
    if (activeCards.length > 0) {
      logger.info(`Heartbeat: ${activeCards.length} active kanban cards`);
      // Don't spam - just log. Owner sees these in briefing.
    }

    // 5. Daily insights - aggregate across all systems (9 AM and 6 PM UTC)
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

    logger.info(`Heartbeat complete: ${stats.questNudges} quest nudges, ${stats.todoNudges} todo nudges, ${stats.goalNudges} goal nudges, ${stats.insightsDelivered} insights, ${stats.errors} errors`);
    return stats;

  } catch (error) {
    logger.error('Heartbeat failed:', error);
    stats.errors++;
    return stats;
  }
}

/**
 * Quick health check for the heartbeat system
 * Returns status across all meshed task systems
 */
export async function heartbeatStatus(): Promise<{
  healthy: boolean;
  stalledQuests: number;
  stalledTodos: number;
  stalledGoals: number;
  inactiveUsers: number;
}> {
  const stalledUsers = findStalledQuests();
  const stalledTodos = findStalledTodos();
  const stalledGoals = await getStalledGoals('ej'); // Goals use 'ej' as owner
  const inactiveUsers = findInactiveUsers();

  return {
    healthy: true,
    stalledQuests: stalledUsers.reduce((sum, u) => sum + u.activeQuests.length, 0),
    stalledTodos: stalledTodos.length,
    stalledGoals: stalledGoals.length,
    inactiveUsers: inactiveUsers.length,
  };
}
