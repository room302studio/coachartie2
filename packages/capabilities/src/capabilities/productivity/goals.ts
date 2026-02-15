/**
 * Goals Capability - Artie's Persistent Objectives
 *
 * Goals are directions Artie works toward over time, not tasks to complete.
 * They give Artie purpose and enable proactive, autonomous behavior.
 *
 * Goal Types:
 * - project: Help ship something
 * - care: Keep someone well
 * - growth: Build over time
 * - watch: Monitor conditions
 * - relationship: Maintain connections
 * - learning: Acquire knowledge
 */

import { eq, and, desc, isNull } from 'drizzle-orm';
import { logger, getDb, objectives, goalActions } from '@coachartie/shared';
import type { Objective, NewObjective } from '@coachartie/shared';
import type { RegisteredCapability, CapabilityContext } from '../../services/capability/capability-registry.js';
import { randomUUID } from 'crypto';

const GOAL_TYPES = ['project', 'care', 'growth', 'watch', 'relationship', 'learning'] as const;
const GOAL_STATUSES = ['dormant', 'active', 'blocked', 'achieved', 'abandoned'] as const;

type GoalType = typeof GOAL_TYPES[number];
type GoalStatus = typeof GOAL_STATUSES[number];

/**
 * Resolve a goal ID from a full UUID or short prefix
 */
async function resolveGoalId(db: ReturnType<typeof getDb>, id: string, userId: string): Promise<{
  goal: Objective | null;
  error?: string;
}> {
  // Try exact match first
  let goals = await db.select().from(objectives).where(eq(objectives.id, id)).limit(1);

  if (goals.length > 0) {
    return { goal: goals[0] };
  }

  // Try prefix match (minimum 8 characters)
  if (id.length >= 8) {
    const allGoals = await db.select().from(objectives).where(eq(objectives.owner, userId));
    const matches = allGoals.filter(g => g.id.startsWith(id));

    if (matches.length === 1) {
      return { goal: matches[0] };
    }
    if (matches.length > 1) {
      return { goal: null, error: `Multiple goals match "${id}". Use a longer prefix.` };
    }
  }

  return { goal: null, error: `Goal not found: ${id}` };
}

interface GoalsParams {
  action: string;
  id?: string;
  title?: string;
  description?: string;
  type?: GoalType;
  status?: GoalStatus;
  progress?: number;
  target_date?: string;
  parent_id?: string;
  budget?: number;
  notes?: string;
  blockers?: string;
  [key: string]: unknown;
}

function formatGoal(goal: Objective): string {
  const prog = goal.progress || 0;
  const progressBar = '█'.repeat(Math.floor(prog / 10)) + '░'.repeat(10 - Math.floor(prog / 10));
  const statusIcon = goal.status === 'active' ? '🟢' :
                     goal.status === 'blocked' ? '🔴' :
                     goal.status === 'achieved' ? '✅' :
                     goal.status === 'dormant' ? '💤' : '⚫';

  let result = `${statusIcon} **${goal.title}** (${goal.id.slice(0, 8)})\n`;
  result += `   [${progressBar}] ${prog}%\n`;
  result += `   Type: ${goal.goalType}`;

  if (goal.targetDate) {
    result += ` | Target: ${goal.targetDate}`;
  }

  if (goal.blockers) {
    result += `\n   ⚠️ Blocked: ${goal.blockers}`;
  }

  return result;
}

async function handleGoals(
  params: GoalsParams,
  _content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const db = getDb();
  const userId = ctx?.userId || 'ej';

  logger.info(`Goals action: ${action}`);

  try {
    switch (action) {
      case 'create': {
        const { title, description, type, target_date, parent_id, budget } = params;

        if (!title) {
          return 'Need a title for the goal. What are we working toward?';
        }

        const goalType = type && GOAL_TYPES.includes(type) ? type : 'project';

        const newGoal: NewObjective = {
          id: randomUUID(),
          title,
          description: description || null,
          goalType,
          owner: userId,
          createdBy: userId,
          status: 'active',
          progress: 0,
          targetDate: target_date || null,
          parentGoalId: parent_id || null,
          budgetEth: budget || null,
          lastWorkedAt: new Date().toISOString(),
        };

        await db.insert(objectives).values(newGoal);

        // Log the creation
        await db.insert(goalActions).values({
          goalId: newGoal.id!,
          actionType: 'progress_update',
          actionDescription: 'Goal created',
        });

        return `**Goal Created**\n\n${formatGoal(newGoal as Objective)}\n\nI'll help you work toward this. Check in anytime with "goals status".`;
      }

      case 'list':
      case 'status': {
        const allGoals = await db
          .select()
          .from(objectives)
          .where(
            and(
              eq(objectives.owner, userId),
              isNull(objectives.parentGoalId)
            )
          )
          .orderBy(desc(objectives.updatedAt));

        if (allGoals.length === 0) {
          return `**No Active Goals**\n\nWhat are you working toward? Tell me and I'll help you track it.\n\nExample: "I want to launch my indie game"`;
        }

        const active = allGoals.filter(g => g.status === 'active');
        const blocked = allGoals.filter(g => g.status === 'blocked');
        const achieved = allGoals.filter(g => g.status === 'achieved').slice(0, 3);

        let result = '**Your Goals**\n\n';

        if (active.length > 0) {
          result += '**Active:**\n';
          result += active.map(formatGoal).join('\n\n');
          result += '\n\n';
        }

        if (blocked.length > 0) {
          result += '**Blocked:**\n';
          result += blocked.map(formatGoal).join('\n\n');
          result += '\n\n';
        }

        if (achieved.length > 0) {
          result += '**Recently Achieved:**\n';
          result += achieved.map(g => `✅ ${g.title}`).join('\n');
        }

        return result;
      }

      case 'progress':
      case 'update': {
        const { id, progress, status, notes, blockers } = params;

        if (!id) {
          return 'Which goal? Use `goals list` to see your goals and their IDs.';
        }

        const { goal: foundGoal, error } = await resolveGoalId(db, id, userId);
        if (!foundGoal) {
          return error || `Goal not found: ${id}`;
        }
        const goalId = foundGoal.id;

        const updates: Partial<Objective> = {
          updatedAt: new Date().toISOString(),
          lastWorkedAt: new Date().toISOString(),
        };

        if (progress !== undefined) {
          updates.progress = Math.min(100, Math.max(0, progress));
        }

        if (status && GOAL_STATUSES.includes(status)) {
          updates.status = status;
          if (status === 'achieved') {
            updates.achievedAt = new Date().toISOString();
            updates.progress = 100;
          }
        }

        if (notes) {
          updates.notes = notes;
        }

        if (blockers) {
          updates.blockers = blockers;
          if (!status) {
            updates.status = 'blocked';
          }
        }

        await db.update(objectives).set(updates).where(eq(objectives.id, goalId));

        // Log the update
        const actionDesc = progress !== undefined ? `Progress: ${progress}%` :
                          status ? `Status: ${status}` :
                          blockers ? `Blocked: ${blockers}` : 'Updated';

        await db.insert(goalActions).values({
          goalId: goalId,
          actionType: 'progress_update',
          actionDescription: actionDesc,
        });

        const updated = await db.select().from(objectives).where(eq(objectives.id, goalId)).limit(1);

        return `**Goal Updated**\n\n${formatGoal(updated[0])}`;
      }

      case 'achieve':
      case 'complete': {
        const { id } = params;

        if (!id) {
          return 'Which goal did you achieve? Use `goals list` to see your goals.';
        }

        const { goal: foundGoal, error } = await resolveGoalId(db, id, userId);
        if (!foundGoal) {
          return error || `Goal not found: ${id}`;
        }
        const goalId = foundGoal.id;

        await db.update(objectives).set({
          status: 'achieved',
          progress: 100,
          achievedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).where(eq(objectives.id, goalId));

        await db.insert(goalActions).values({
          goalId: goalId,
          actionType: 'celebrate',
          actionDescription: 'Goal achieved!',
        });

        return `🎉 **GOAL ACHIEVED!** 🎉\n\n**${foundGoal.title}**\n\nIncredible work. Take a moment to appreciate what you accomplished.`;
      }

      case 'abandon': {
        const { id } = params;

        if (!id) {
          return 'Which goal? Use `goals list` to see your goals.';
        }

        const { goal: foundGoal, error } = await resolveGoalId(db, id, userId);
        if (!foundGoal) {
          return error || `Goal not found: ${id}`;
        }
        const goalId = foundGoal.id;

        await db.update(objectives).set({
          status: 'abandoned',
          updatedAt: new Date().toISOString(),
        }).where(eq(objectives.id, goalId));

        await db.insert(goalActions).values({
          goalId: goalId,
          actionType: 'progress_update',
          actionDescription: 'Goal abandoned',
        });

        return `Goal marked as abandoned. That's okay - not every path is the right one. Focus on what matters most.`;
      }

      case 'subgoal': {
        const { parent_id, title, description } = params;

        if (!parent_id || !title) {
          return 'Need parent goal ID and title for subgoal.';
        }

        const { goal: parent, error } = await resolveGoalId(db, parent_id, userId);
        if (!parent) {
          return error || `Parent goal not found: ${parent_id}`;
        }

        const newGoal: NewObjective = {
          id: randomUUID(),
          title,
          description: description || null,
          goalType: parent.goalType,
          owner: userId,
          createdBy: 'artie',
          status: 'active',
          progress: 0,
          parentGoalId: parent.id,
          lastWorkedAt: new Date().toISOString(),
        };

        await db.insert(objectives).values(newGoal);

        return `**Subgoal Created**\n\nParent: ${parent.title}\n└── ${title}`;
      }

      case 'history': {
        const { id } = params;

        if (!id) {
          return 'Which goal? Provide the goal ID.';
        }

        const { goal, error } = await resolveGoalId(db, id, userId);
        if (!goal) {
          return error || `Goal not found: ${id}`;
        }

        const actions = await db
          .select()
          .from(goalActions)
          .where(eq(goalActions.goalId, goal.id))
          .orderBy(desc(goalActions.triggeredAt))
          .limit(10);

        if (actions.length === 0) {
          return 'No history for this goal yet.';
        }

        let result = `**History: ${goal.title}**\n\n`;

        for (const act of actions) {
          const date = new Date(act.triggeredAt!).toLocaleDateString();
          result += `• ${date}: ${act.actionDescription || act.actionType}\n`;
        }

        return result;
      }

      default:
        return `Unknown goals action: ${action}. Try: create, list, status, progress, achieve, abandon, subgoal, history`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Goals error:', err);
    return `Goals error: ${msg}`;
  }
}

/**
 * Get active goals for heartbeat evaluation
 */
export async function getActiveGoals(userId: string = 'ej'): Promise<Objective[]> {
  const db = getDb();
  return db
    .select()
    .from(objectives)
    .where(
      and(
        eq(objectives.owner, userId),
        eq(objectives.status, 'active')
      )
    );
}

/**
 * Get stalled goals (no activity in 3+ days)
 */
export async function getStalledGoals(userId: string = 'ej'): Promise<Objective[]> {
  const db = getDb();
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const activeGoals = await getActiveGoals(userId);
  return activeGoals.filter(g => !g.lastWorkedAt || g.lastWorkedAt < threeDaysAgo);
}

/**
 * Log an action for a goal
 */
export async function logGoalAction(
  goalId: string,
  actionType: string,
  description: string,
  result?: string
): Promise<void> {
  const db = getDb();
  await db.insert(goalActions).values({
    goalId,
    actionType,
    actionDescription: description,
    result,
  });

  // Update lastWorkedAt
  await db.update(objectives).set({
    lastWorkedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).where(eq(objectives.id, goalId));
}

export const goalsCapability: RegisteredCapability = {
  name: 'goals',
  emoji: '🎯',
  description: `Artie's goal tracking system. Goals are directions, not tasks.

- create: Create a new goal (title, type, description)
- list/status: See all your goals
- progress: Update progress on a goal (id, progress 0-100)
- achieve: Mark a goal as achieved
- abandon: Abandon a goal
- subgoal: Create a subgoal under a parent
- history: See history of a goal

Types: project, care, growth, watch, relationship, learning`,
  supportedActions: ['create', 'list', 'status', 'progress', 'update', 'achieve', 'complete', 'abandon', 'subgoal', 'history'],
  handler: handleGoals,
};
