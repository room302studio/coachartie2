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
 * See shared/config/owner.ts for the whitelist.
 */

import { logger } from '../../shared/logger.js';
import { getSyncDb, getDb, eq } from '../../shared/db/client.js';
import { canReceiveProactiveDMs, OWNER_USER_ID } from '../../shared/config/owner.js';
import { objectives } from '../../shared/db/schema.js';
import type { Objective } from '../../shared/db/schema.js';
import { sendDiscordDM } from './proactive-dm.js';
import { getStalledGoals, logGoalAction } from '../capabilities/planning/goals.js';
import { deliveryManager } from './delivery.js';
import { readState, writeState } from '../../shared/db/kv-state.js';

const NUDGE_COOLDOWN_HOURS = 24;

// Goals created by the tool are owned by the caller's Discord id; older ones by 'ej'.
const LEGACY_OWNER_ID = 'ej';

/**
 * Durable per-item nudge cooldown in kv_state, key `nudge:<kind>:<id>` (2026-10-31). Todo
 * lists and quests had none (nothing updates todo_lists.updated_at), so lifting
 * AUTONOMOUS_PAUSED would have DMed the same stale list every hour, forever.
 */
function nudgedRecently(kind: string, id: string | number): boolean {
  const last = readState(`nudge:${kind}:${id}`);
  if (!last) return false;
  const hoursSince = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60);
  return hoursSince < NUDGE_COOLDOWN_HOURS;
}

function markNudged(kind: string, id: string | number): void {
  writeState(`nudge:${kind}:${id}`, new Date().toISOString());
}

/** Stalled goals under the owner's real id plus the legacy 'ej' owner, deduped. */
async function getOwnerStalledGoals(): Promise<Objective[]> {
  const byId = new Map<string, Objective>();
  for (const owner of [OWNER_USER_ID, LEGACY_OWNER_ID]) {
    for (const goal of await getStalledGoals(owner)) {
      byId.set(goal.id, goal);
    }
  }
  return [...byId.values()];
}

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
 * Format a number of days as a human-readable string
 */
function formatDays(days: number): string {
  if (days === 1) {
    return 'a day';
  }
  return `${days} days`;
}

/**
 * Format a content suffix for truncated text
 */
function formatTruncationSuffix(contentLength: number, maxLength: number): string {
  if (contentLength > maxLength) {
    return '...';
  }
  return '';
}

/**
 * Format a plural suffix (ies vs blank)
 */
function formatPluralIes(count: number): string {
  if (count > 1) {
    return 'ies';
  }
  return '';
}

/**
 * Get the priority level for a goal status
 */
function getPriorityForStatus(status: string | null): 'high' | 'normal' {
  if (status === 'blocked') {
    return 'high';
  }
  return 'normal';
}

/**
 * Generate a friendly nudge message for a stuck quest
 */
function generateNudgeMessage(quest: StuckQuest): string {
  const dayText = formatDays(quest.stuckDays);

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
// Unused as of 2026-11-23 (lint pass); kept for reference.
async function _generateDailyInsights(userId: string): Promise<string | null> {
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
      const pluralSuffix = formatPluralIes(memoryCount.count);
      insight += `Captured ${memoryCount.count} new memory${pluralSuffix} today.\n\n`;
    }

    if (gems.length > 0) {
      insight += `**Notable memories:**\n`;
      for (const gem of gems) {
        const truncationSuffix = formatTruncationSuffix(gem.content.length, 100);
        insight += `- ${gem.content.slice(0, 100)}${truncationSuffix}\n`;
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
function findStalledTodos(): Array<{ listId: number; userId: string; listName: string; pendingCount: number; staleDays: number }> {
  try {
    const db = getSyncDb();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const rows = db.all<{
      id: number;
      user_id: string;
      name: string;
      pending_count: number;
      updated_at: string;
    }>(`
      SELECT tl.id, tl.user_id, tl.name, tl.updated_at,
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
        listId: row.id,
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
  let lastWorked: Date;
  if (goal.lastWorkedAt) {
    lastWorked = new Date(goal.lastWorkedAt);
  } else {
    lastWorked = new Date(goal.createdAt || Date.now());
  }
  const staleDays = Math.floor((Date.now() - lastWorked.getTime()) / (24 * 60 * 60 * 1000));
  const dayText = formatDays(staleDays);

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
          if (nudgedRecently('quest', quest.questId)) {
            continue;
          }
          const message = generateNudgeMessage(quest);
          const sent = await sendDiscordDM(userData.userId, message, 'heartbeat-nudge');
          if (sent) {
            markNudged('quest', quest.questId);
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
        if (nudgedRecently('todo', todo.listId)) {
          continue;
        }
        const message = `📋 Your todo list "${todo.listName}" has ${todo.pendingCount} pending items and hasn't been touched in ${todo.staleDays} days. Say "todo status ${todo.listName}" to review.`;
        const sent = await sendDiscordDM(todo.userId, message, 'heartbeat-todo');
        if (sent) {
          markNudged('todo', todo.listId);
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
      // By the owner's real id as well as legacy 'ej' (2026-10-31): querying 'ej' alone
      // skipped every goal the tool had created (4 of 6 in prod).
      const stalledGoals = await getOwnerStalledGoals();
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
          // last_nudged_at is only written on success; a nudge left with the delivery manager
          // for retry must not be sent again next hour too.
          if (nudgedRecently('goal', goal.id)) {
            continue;
          }

          const message = generateGoalNudgeMessage(goal);

          // Use delivery manager for reliable delivery with retry
          const priority = getPriorityForStatus(goal.status);
          const result = await deliveryManager.deliver({
            messageType: 'goal_nudge',
            userId: OWNER_USER_ID,
            content: message,
            relatedId: goal.id,
            priority,
          });
          markNudged('goal', goal.id);

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

    // 5. Daily insights — DISABLED: redundant with artie-digest.ts (8:45 AM cron)
    // Was sending low-value "Captured N memories" DMs at 9 AM / 6 PM UTC

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
  const stalledGoals = await getOwnerStalledGoals();
  const inactiveUsers = findInactiveUsers();

  return {
    healthy: true,
    stalledQuests: stalledUsers.reduce((sum, u) => sum + u.activeQuests.length, 0),
    stalledTodos: stalledTodos.length,
    stalledGoals: stalledGoals.length,
    inactiveUsers: inactiveUsers.length,
  };
}
