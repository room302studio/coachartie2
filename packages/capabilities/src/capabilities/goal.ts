import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { getDatabase } from '@coachartie/shared';

interface GoalRow {
  id: number;
  user_id: string;
  objective: string;
  status: string;
  priority: number;
  deadline?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

interface GoalParams {
  action: string;
  user_id?: string;
  goal_id?: string;
  objective?: string;
  deadline?: string;
  priority?: string;
  status?: string;
  days?: string;
  [key: string]: unknown;
}

export class GoalService {
  private static instance: GoalService;
  private dbReady = false;

  static getInstance(): GoalService {
    if (!GoalService.instance) {
      GoalService.instance = new GoalService();
    }
    return GoalService.instance;
  }

  async initializeDatabase(): Promise<void> {
    if (this.dbReady) {
      return;
    }

    try {
      const db = await getDatabase();

      // Create goals table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT DEFAULT 'not_started',
          priority INTEGER DEFAULT 5,
          deadline TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME
        )
      `);

      // Create indexes for fast searching
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);
        CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
        CREATE INDEX IF NOT EXISTS idx_goals_deadline ON goals(deadline);
      `);

      this.dbReady = true;
      logger.info('✅ Goal database initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize goal database:', error);
      throw error;
    }
  }

  async setGoal(
    userId: string,
    objective: string,
    deadline?: string,
    priority: number = 5
  ): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();

      // Validate deadline if provided
      if (deadline) {
        const deadlineDate = new Date(deadline);
        if (isNaN(deadlineDate.getTime())) {
          const now = new Date();
          const isoFullExample = now.toISOString();
          const dateOnlyExample = now.toISOString().split('T')[0];
          throw new Error(
            `Invalid deadline format. Use ISO format.\n\n` +
              `Examples with current time:\n` +
              `- Full ISO: "${isoFullExample}"\n` +
              `- Date only: "${dateOnlyExample}"\n\n` +
              `Your input: "${deadline}"`
          );
        }

        // Warn about past deadlines but still accept them
        if (deadlineDate < new Date()) {
          logger.warn(`Goal deadline is in the past: ${deadline}`);
        }
      }

      // Clamp priority to valid range
      const validPriority = Math.max(1, Math.min(10, priority));

      const result = await db.run(
        `
        INSERT INTO goals (user_id, objective, deadline, priority)
        VALUES (?, ?, ?, ?)
      `,
        [userId, objective, deadline || null, validPriority]
      );

      const goalId = result.lastID!;
      logger.info(`🎯 Created goal for user ${userId}: ${objective}`);

      const deadlineText = deadline ? ` by ${new Date(deadline).toLocaleDateString()}` : '';
      const pastWarning =
        deadline && new Date(deadline) < new Date() ? ' ⚠️ Note: deadline is in the past' : '';

      return `✅ Goal set: "${objective}" (ID: ${goalId}, priority: ${validPriority}/10${deadlineText})${pastWarning}`;
    } catch (error) {
      logger.error('❌ Failed to set goal:', error);
      return 'Sorry, having trouble setting goals right now. Please try again.';
    }
  }

  async checkGoals(userId: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();

      const goals = await db.all(
        `
        SELECT * FROM goals 
        WHERE user_id = ? AND status != 'completed' AND status != 'cancelled'
        ORDER BY 
          CASE WHEN deadline IS NOT NULL THEN 0 ELSE 1 END,
          deadline ASC,
          priority DESC,
          created_at ASC
      `,
        [userId]
      );

      if (goals.length === 0) {
        return '📝 No active goals found. Set a goal with: <capability name="goal" action="set" objective="Your goal here" />';
      }

      const formattedGoals = goals
        .map((goal: GoalRow) => {
          let deadlineText = '';
          if (goal.deadline) {
            const deadlineDate = new Date(goal.deadline);
            const now = new Date();
            const timeDiff = deadlineDate.getTime() - now.getTime();
            const daysDiff = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
            const hoursDiff = Math.ceil(timeDiff / (1000 * 60 * 60));

            if (daysDiff === 0) {
              deadlineText = ` 📅 Due: Today (${hoursDiff > 0 ? `in ${hoursDiff}h` : 'overdue'})`;
            } else if (daysDiff === 1) {
              deadlineText = ` 📅 Due: Tomorrow`;
            } else if (daysDiff > 0) {
              deadlineText = ` 📅 Due: ${deadlineDate.toLocaleDateString()} (in ${daysDiff} days)`;
            } else {
              deadlineText = ` 📅 Due: ${deadlineDate.toLocaleDateString()} (${Math.abs(daysDiff)} days overdue)`;
            }
          }

          const priority = '⭐'.repeat(Math.min(goal.priority, 5));
          const statusIcon =
            goal.status === 'in_progress' ? '🔄' : goal.status === 'blocked' ? '🚫' : '📋';

          return `${statusIcon} **${goal.objective}** ${priority} (ID: ${goal.id})${deadlineText}`;
        })
        .join('\n');

      return `🎯 Your active goals:\n\n${formattedGoals}`;
    } catch (error) {
      logger.error('❌ Failed to check goals:', error);
      return 'Sorry, having trouble checking goals right now. Please try again.';
    }
  }

  async updateGoal(userId: string, goalId: number, status?: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();

      // First check if goal exists and belongs to user
      const existingGoal = await db.get(
        `
        SELECT * FROM goals WHERE id = ? AND user_id = ?
      `,
        [goalId, userId]
      );

      if (!existingGoal) {
        return 'Goal not found';
      }

      // Validate status
      const validStatuses = ['not_started', 'in_progress', 'completed', 'blocked', 'cancelled'];
      if (status && !validStatuses.includes(status)) {
        return `❌ Invalid status. Use one of: ${validStatuses.join(', ')}`;
      }

      const updates: string[] = [];
      const values: any[] = [];

      if (status) {
        updates.push('status = ?');
        values.push(status);

        // Set completed_at if marking as completed
        if (status === 'completed') {
          updates.push('completed_at = CURRENT_TIMESTAMP');
        }
      }

      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(goalId, userId);

      await db.run(
        `
        UPDATE goals SET ${updates.join(', ')}
        WHERE id = ? AND user_id = ?
      `,
        values
      );

      logger.info(`🎯 Updated goal ${goalId} for user ${userId}`);

      const statusText = status ? ` Status: ${status}` : '';
      return `✅ Goal "${existingGoal.objective}" updated.${statusText}`;
    } catch (error) {
      logger.error('❌ Failed to update goal:', error);
      return 'Sorry, having trouble updating goals right now. Please try again.';
    }
  }

  async completeGoal(userId: string, goalId: number): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();

      // First check if goal exists and belongs to user
      const existingGoal = await db.get(
        `
        SELECT * FROM goals WHERE id = ? AND user_id = ?
      `,
        [goalId, userId]
      );

      if (!existingGoal) {
        return 'Goal not found';
      }

      await db.run(
        `
        UPDATE goals 
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `,
        [goalId, userId]
      );

      logger.info(`🎯 Completed goal ${goalId} for user ${userId}: ${existingGoal.objective}`);

      return `🎉 Congratulations! Completed goal: "${existingGoal.objective}"`;
    } catch (error) {
      logger.error('❌ Failed to complete goal:', error);
      return 'Sorry, having trouble completing goals right now. Please try again.';
    }
  }

  async getGoalHistory(userId: string, days: number = 7): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();

      const goals = await db.all(
        `
        SELECT * FROM goals 
        WHERE user_id = ? 
        AND (
          completed_at > datetime('now', '-${days} days')
          OR updated_at > datetime('now', '-${days} days')
        )
        ORDER BY 
          CASE WHEN completed_at IS NOT NULL THEN completed_at ELSE updated_at END DESC
      `,
        [userId]
      );

      if (goals.length === 0) {
        return `📈 No goal activity in the past ${days} days. Set some goals to build momentum!`;
      }

      const completed = goals.filter((g: GoalRow) => g.status === 'completed').length;
      const total = goals.length;

      const formattedGoals = goals
        .map((goal: GoalRow) => {
          const date = goal.completed_at
            ? new Date(goal.completed_at).toLocaleDateString()
            : new Date(goal.updated_at).toLocaleDateString();
          const statusIcon =
            goal.status === 'completed'
              ? '✅'
              : goal.status === 'in_progress'
                ? '🔄'
                : goal.status === 'blocked'
                  ? '🚫'
                  : '📋';

          return `${statusIcon} **${goal.objective}** (${date})`;
        })
        .join('\n');

      return `📈 Goal activity (past ${days} days): ${completed}/${total} completed\n\n${formattedGoals}`;
    } catch (error) {
      logger.error('❌ Failed to get goal history:', error);
      return 'Sorry, having trouble retrieving goal history right now. Please try again.';
    }
  }
}

/**
 * Goal capability handler
 */
async function handleGoalAction(params: GoalParams, content?: string): Promise<string> {
  const { action, user_id = 'unknown-user' } = params;
  const goalService = GoalService.getInstance();

  logger.info(`🎯 Goal handler called - Action: ${action}, UserId: ${user_id}, Params:`, params);

  try {
    switch (action) {
      case 'set': {
        const objective = params.objective || content;
        if (!objective) {
          return '❌ Please provide an objective. Example: <capability name="goal" action="set" objective="Complete project" />';
        }

        const deadline = params.deadline ? String(params.deadline) : undefined;
        const priority = params.priority ? parseInt(String(params.priority)) || 5 : 5;

        return await goalService.setGoal(String(user_id), String(objective), deadline, priority);
      }

      case 'check': {
        return await goalService.checkGoals(String(user_id));
      }

      case 'update': {
        const goalId = params.goal_id;
        if (!goalId) {
          return '❌ Please provide a goal_id. Example: <capability name="goal" action="update" goal_id="123" status="in_progress" />';
        }

        const status = params.status ? String(params.status) : undefined;
        return await goalService.updateGoal(String(user_id), parseInt(String(goalId)), status);
      }

      case 'complete': {
        const goalId = params.goal_id;
        if (!goalId) {
          return '❌ Please provide a goal_id. Example: <capability name="goal" action="complete" goal_id="123" />';
        }

        return await goalService.completeGoal(String(user_id), parseInt(String(goalId)));
      }

      case 'history': {
        const days = params.days ? parseInt(String(params.days)) || 7 : 7;
        return await goalService.getGoalHistory(String(user_id), days);
      }

      default:
        return `❌ Unknown goal action: ${action}. Supported actions: set, check, update, complete, history`;
    }
  } catch (error) {
    logger.error(`Goal capability error for action '${action}':`, error);
    return 'Sorry, having trouble with goals right now. Please try again.';
  }
}

/**
 * Goal capability definition
 */
export const goalCapability: RegisteredCapability = {
  name: 'goal',
  supportedActions: ['set', 'check', 'update', 'complete', 'history'],
  description: 'Manage goals and long-term objectives',
  handler: handleGoalAction,
  examples: [
    '<capability name="goal" action="set" objective="Complete PR review" deadline="2024-01-15T14:00:00Z" priority="8" />',
    '<capability name="goal" action="check" />',
    '<capability name="goal" action="update" goal_id="123" status="in_progress" />',
    '<capability name="goal" action="complete" goal_id="123" />',
    '<capability name="goal" action="history" days="7" />',
  ],
};
