import { getErrorMessage } from '../../../shared/errors.js';
/**
 * tasks: one tool for tracking work through steps.
 *
 * Merged on 2026-10-23 (wave 4) from three tools that each tracked progress their own way.
 * Each original handler survives unchanged as an internal function; nothing about their state
 * machines or storage changed:
 *
 *   tracker="todo"   (was `todo`)        named lists in the todo_lists / todo_items tables
 *   tracker="quest"  (was `quests`)      guided multi-step quests, persisted as tagged memories
 *   tracker="task"   (was `task-status`) in-memory progress updates during long operations
 *
 * Actions that more than one tracker knows (create, start, list, status, complete, …) are told
 * apart by `tracker`, default "todo". With no tracker, an action only quests know goes to the
 * quest tracker, and one only task-status knew goes to the task tracker.
 * The old names still work through TOOL_ALIASES in 5-tool-loop/registry.ts, which set tracker.
 */

import { logger } from '../../../shared/logger.js';
import { initializeDb, getSyncDb } from '../../../shared/db/client.js';
import type { RegisteredCapability, CapabilityContext } from '../../5-tool-loop/registry.js';

// Helper functions for ternary refactoring

function goalLinkSuffix(goalId: unknown): string {
  if (goalId) {
    return ` (linked to goal ${goalId})`;
  }
  return '';
}

function goalSuffix(goalId: unknown): string {
  if (goalId) {
    return ` (goal: ${goalId})`;
  }
  return '';
}

function itemStatusEmoji(status: string): string {
  if (status === 'completed') {
    return '✅';
  }
  return '⏳';
}

function calculatePercentage(completed: number, total: number): number {
  if (total > 0) {
    return Math.round((completed / total) * 100);
  }
  return 0;
}

function parseGoalId(goalId: unknown): number | undefined {
  if (goalId) {
    return parseInt(String(goalId));
  }
  return undefined;
}

function questStatusEmoji(status: string): string {
  if (status === 'completed') {
    return '✅';
  }
  if (status === 'abandoned') {
    return '❌';
  }
  return '🗺️';
}

function etaSuffix(eta: unknown): string {
  if (eta) {
    return ` • ETA: ${eta}`;
  }
  return '';
}

function detailsSuffix(details: unknown): string {
  if (details) {
    return `\n${details}`;
  }
  return '';
}

function errorDetailsSuffix(details: unknown): string {
  if (details) {
    return `\nError: ${details}`;
  }
  return '';
}

// =====================================================================================
// tracker="todo" (was the `todo` tool)
// =====================================================================================

interface _TodoListRow {
  id: number;
  user_id: string;
  name: string;
  goal_id?: number;
  created_at: string;
  updated_at: string;
}

interface TodoItemRow {
  id: number;
  list_id: number;
  content: string;
  status: string;
  position: number;
  created_at: string;
  completed_at?: string;
}

interface TodoParams {
  action: string;
  user_id?: string;
  list?: string;
  goal_id?: string;
  item?: string;
  [key: string]: unknown;
}

class TodoService {
  private static instance: TodoService;
  private dbReady = false;

  static getInstance(): TodoService {
    if (!TodoService.instance) {
      TodoService.instance = new TodoService();
    }
    return TodoService.instance;
  }

  async initializeDatabase(): Promise<void> {
    if (this.dbReady) {
      return;
    }

    try {
      // Initialize the database with Drizzle - tables are created by initializeDb
      initializeDb();
      this.dbReady = true;
      logger.info('✅ Todo database initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize todo database:', error);
      throw error;
    }
  }

  async createTodoList(
    userId: string,
    listName: string,
    content: string,
    goalId?: number
  ): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = getSyncDb();

      // Check if list already exists
      const existingList = db.get(
        `
        SELECT id FROM todo_lists WHERE user_id = ? AND name = ?
      `,
        [userId, listName]
      );

      if (existingList) {
        return `❌ Todo list "${listName}" already exists. Use action="add" to add more items.`;
      }

      // Create the todo list
      const result = db.run(
        `
        INSERT INTO todo_lists (user_id, name, goal_id)
        VALUES (?, ?, ?)
      `,
        [userId, listName, goalId || null]
      );

      const listId = result.lastInsertRowid!;

      // Parse content into todo items
      const items = this.parseContentIntoItems(content);

      if (items.length === 0) {
        return `❌ No todo items found in content. Use format like:
- Task 1
- Task 2
- Task 3`;
      }

      // Insert todo items
      for (let i = 0; i < items.length; i++) {
        db.run(
          `
          INSERT INTO todo_items (list_id, content, position)
          VALUES (?, ?, ?)
        `,
          [listId, items[i], i + 1]
        );
      }

      logger.info(
        `📋 Created todo list "${listName}" for user ${userId} with ${items.length} items`
      );

      const goalText = goalLinkSuffix(goalId);
      return `✅ Created todo list "${listName}" with ${items.length} items${goalText}:\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
    } catch (error) {
      logger.error('❌ Failed to create todo list:', error);
      throw new Error(`Failed to create todo list "${listName}": ${getErrorMessage(error)}`);
    }
  }

  async addItemsToList(userId: string, listName: string, content: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = getSyncDb();

      // Find the list
      const list = db.get(
        `
        SELECT id FROM todo_lists WHERE user_id = ? AND name = ?
      `,
        [userId, listName]
      );

      if (!list) {
        // Query actual lists that exist for this user
        const existingLists = db.all(
          `SELECT name,
                  (SELECT COUNT(*) FROM todo_items WHERE list_id = todo_lists.id AND status = 'pending') as pending_count,
                  (SELECT COUNT(*) FROM todo_items WHERE list_id = todo_lists.id) as total_count
           FROM todo_lists
           WHERE user_id = ?
           ORDER BY updated_at DESC
           LIMIT 10`,
          [userId]
        );

        const suggestions = existingLists
          .map((l: any) => `"${l.name}" (${l.pending_count}/${l.total_count} items)`)
          .join(', ');

        let suggestText: string;
        if (suggestions) {
          suggestText = `\n\nYour actual lists: ${suggestions}`;
        } else {
          suggestText = '\n\nNo lists exist yet. Create one with action="create"';
        }

        throw new Error(`Todo list "${listName}" not found.${suggestText}`);
      }

      // Get current highest position
      const maxPos = db.get(
        `
        SELECT MAX(position) as max_pos FROM todo_items WHERE list_id = ?
      `,
        [list.id]
      );

      const startPosition = (maxPos?.max_pos || 0) + 1;

      // Parse new items
      const items = this.parseContentIntoItems(content);

      if (items.length === 0) {
        throw new Error(
          `No todo items found in content. Use format like:\n- New task 1\n- New task 2`
        );
      }

      // Insert new items
      for (let i = 0; i < items.length; i++) {
        db.run(
          `
          INSERT INTO todo_items (list_id, content, position)
          VALUES (?, ?, ?)
        `,
          [list.id, items[i], startPosition + i]
        );
      }

      logger.info(`📋 Added ${items.length} items to todo list "${listName}" for user ${userId}`);

      return `✅ Added ${items.length} items to "${listName}":\n${items.map((item, i) => `${startPosition + i}. ${item}`).join('\n')}`;
    } catch (error) {
      logger.error('❌ Failed to add items to todo list:', error);
      throw new Error(`Failed to add items to "${listName}": ${getErrorMessage(error)}`);
    }
  }

  async getNextItem(userId: string, listName: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = getSyncDb();

      // Find the list and get next pending item
      const nextItem = db.get(
        `
        SELECT ti.id, ti.content, ti.position
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND tl.name = ? AND ti.status = 'pending'
        ORDER BY ti.position ASC
        LIMIT 1
      `,
        [userId, listName]
      );

      if (!nextItem) {
        return `📋 No pending items in "${listName}". All tasks completed! 🎉`;
      }

      return `📌 Next task: ${nextItem.content} (item ${nextItem.position})`;
    } catch (error) {
      logger.error('❌ Failed to get next item:', error);
      throw new Error(`Failed to get next item from "${listName}": ${getErrorMessage(error)}`);
    }
  }

  async completeItem(userId: string, listName: string, itemPosition: number): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = getSyncDb();

      // Find the specific item
      const item = db.get(
        `
        SELECT ti.id, ti.content, ti.status
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND tl.name = ? AND ti.position = ?
      `,
        [userId, listName, itemPosition]
      );

      if (!item) {
        return `❌ Item ${itemPosition} not found in "${listName}"`;
      }

      if (item.status === 'completed') {
        return `✅ Item "${item.content}" is already completed`;
      }

      // Mark as completed
      db.run(
        `
        UPDATE todo_items 
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        [item.id]
      );

      // Get progress
      const progress = await this.getListProgress(userId, listName);

      logger.info(
        `✅ Completed item ${itemPosition} in todo list "${listName}" for user ${userId}`
      );

      return `✅ Marked "${item.content}" as complete! Progress: ${progress}`;
    } catch (error) {
      logger.error('❌ Failed to complete item:', error);
      throw new Error(`Failed to complete item ${itemPosition} in "${listName}": ${getErrorMessage(error)}`);
    }
  }

  async getListStatus(userId: string, listName: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = getSyncDb();

      // Check if list exists
      const list = db.get(
        `
        SELECT id, goal_id FROM todo_lists WHERE user_id = ? AND name = ?
      `,
        [userId, listName]
      );

      if (!list) {
        return `❌ Todo list "${listName}" not found`;
      }

      // Get all items with status
      const items = db.all(
        `
        SELECT content, status, position, completed_at
        FROM todo_items 
        WHERE list_id = ?
        ORDER BY position ASC
      `,
        [list.id]
      );

      if (items.length === 0) {
        return `📋 "${listName}" is empty. Add some tasks!`;
      }

      const completed = items.filter((item: TodoItemRow) => item.status === 'completed').length;
      const total = items.length;
      const percentage = Math.round((completed / total) * 100);

      const statusList = items
        .map((item: TodoItemRow) => {
          const icon = itemStatusEmoji(item.status);
          return `${icon} ${item.content}`;
        })
        .join('\n');

      const goalText = goalLinkSuffix(list.goal_id);

      return `📋 ${listName}: ${completed}/${total} completed (${percentage}%)${goalText}\n${statusList}`;
    } catch (error) {
      logger.error('❌ Failed to get list status:', error);
      return 'Sorry, having trouble getting todo list status right now. Please try again.';
    }
  }

  async listAllLists(userId: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = getSyncDb();

      const lists = db.all(
        `
        SELECT tl.name, tl.goal_id, tl.created_at,
               COUNT(ti.id) as total_items,
               SUM(CASE WHEN ti.status = 'completed' THEN 1 ELSE 0 END) as completed_items
        FROM todo_lists tl
        LEFT JOIN todo_items ti ON tl.id = ti.list_id
        WHERE tl.user_id = ?
        GROUP BY tl.id, tl.name, tl.goal_id, tl.created_at
        ORDER BY tl.updated_at DESC
      `,
        [userId]
      );

      if (lists.length === 0) {
        return '📋 No todo lists found. Create one with: <capability name="tasks" action="create" list="my_list">- Task 1\\n- Task 2</capability>';
      }

      const listSummary = lists
        .map((list: any) => {
          const completed = list.completed_items || 0;
          const total = list.total_items || 0;
          const percentage = calculatePercentage(completed, total);
          const goalText = goalSuffix(list.goal_id);

          return `📋 **${list.name}**: ${completed}/${total} (${percentage}%)${goalText}`;
        })
        .join('\n');

      return `📚 Your todo lists (${lists.length}):\n\n${listSummary}`;
    } catch (error) {
      logger.error('❌ Failed to list todo lists:', error);
      return 'Sorry, having trouble listing todo lists right now. Please try again.';
    }
  }

  private async getListProgress(userId: string, listName: string): Promise<string> {
    try {
      const db = getSyncDb();

      const progress = db.get(
        `
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN ti.status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND tl.name = ?
      `,
        [userId, listName]
      );

      const completed = progress?.completed || 0;
      const total = progress?.total || 0;
      const percentage = calculatePercentage(completed, total);

      return `${completed}/${total} (${percentage}%)`;
    } catch (error) {
      logger.error('❌ Failed to get progress:', error);
      return 'unknown progress';
    }
  }

  private parseContentIntoItems(content: string): string[] {
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const items: string[] = [];

    for (const line of lines) {
      // Handle markdown lists (- item, * item, + item)
      if (line.match(/^[-*+]\s+/)) {
        items.push(line.replace(/^[-*+]\s+/, '').trim());
      }
      // Handle numbered lists (1. item, 2. item, etc.)
      else if (line.match(/^\d+\.\s+/)) {
        items.push(line.replace(/^\d+\.\s+/, '').trim());
      }
      // Handle plain text lines (treat as items)
      else if (line.length > 0) {
        items.push(line.trim());
      }
    }

    return items;
  }
}

/**
 * Todo capability handler
 */
async function handleTodoAction(params: TodoParams, content?: string): Promise<string> {
  const { action, user_id = 'unknown-user' } = params;
  const todoService = TodoService.getInstance();

  logger.info(`📋 Todo handler called - Action: ${action}, UserId: ${user_id}, Params:`, params);

  try {
    switch (action) {
      case 'create': {
        const listName = params.list;
        const goalId = parseGoalId(params.goal_id);

        if (!listName) {
          return '❌ Please provide a list name. Example: <capability name="tasks" action="create" list="my_tasks">- Task 1\\n- Task 2</capability>';
        }

        if (!content) {
          return '❌ Please provide todo items. Example: <capability name="tasks" action="create" list="my_tasks">- Task 1\\n- Task 2</capability>';
        }

        return await todoService.createTodoList(String(user_id), String(listName), content, goalId);
      }

      case 'add': {
        const listName = params.list;

        if (!listName) {
          return '❌ Please provide a list name. Example: <capability name="tasks" action="add" list="my_tasks">- New task</capability>';
        }

        if (!content) {
          return '❌ Please provide items to add. Example: <capability name="tasks" action="add" list="my_tasks">- New task</capability>';
        }

        return await todoService.addItemsToList(String(user_id), String(listName), content);
      }

      case 'next': {
        const listName = params.list;

        if (!listName) {
          return '❌ Please provide a list name. Example: <capability name="tasks" action="next" list="my_tasks" />';
        }

        return await todoService.getNextItem(String(user_id), String(listName));
      }

      case 'complete': {
        const listName = params.list;
        const itemPosition = params.item;

        if (!listName) {
          return '❌ Please provide a list name. Example: <capability name="tasks" action="complete" list="my_tasks" item="1" />';
        }

        if (!itemPosition) {
          return '❌ Please provide item position. Example: <capability name="tasks" action="complete" list="my_tasks" item="1" />';
        }

        return await todoService.completeItem(
          String(user_id),
          String(listName),
          parseInt(String(itemPosition))
        );
      }

      case 'status': {
        const listName = params.list;

        if (!listName) {
          return '❌ Please provide a list name. Example: <capability name="tasks" action="status" list="my_tasks" />';
        }

        return await todoService.getListStatus(String(user_id), String(listName));
      }

      case 'list': {
        return await todoService.listAllLists(String(user_id));
      }

      default:
        return `❌ Unknown todo action: ${action}. Supported actions: create, add, next, complete, status, list`;
    }
  } catch (error) {
    logger.error(`Todo capability error for action '${action}':`, error);
    return 'Sorry, having trouble with todo lists right now. Please try again.';
  }
}

// =====================================================================================
// tracker="quest" (was the `quests` tool)
//
// Track and guide users through complex multi-step real-world processes (onboarding,
// troubleshooting, learning paths). PERSISTENCE: quests are stored in Artie's memory system
// with tag "quest", so they survive restarts and can be accessed across platforms.
// =====================================================================================

interface QuestStep {
  id: number;
  title: string;
  description: string;
  completed: boolean;
  completedAt?: string;
  notes?: string;
}

interface Quest {
  id: string;
  userId: string;
  title: string;
  description: string;
  steps: QuestStep[];
  currentStep: number;
  status: 'active' | 'completed' | 'abandoned';
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

interface QuestParams {
  action: string;
  title?: string;
  description?: string;
  steps?: string[];
  questId?: string;
  stepNotes?: string;
  [key: string]: unknown;
}

// In-memory cache (backed by DB)
const questCache = new Map<string, Quest[]>();

/**
 * Load quests from database for a user
 */
function loadUserQuests(userId: string): Quest[] {
  // Check cache first
  if (questCache.has(userId)) {
    return questCache.get(userId)!;
  }

  try {
    const db = getSyncDb();
    const rows = db.all<{ id: number; content: string; metadata: string }>(
      `SELECT id, content, metadata FROM memories
       WHERE user_id = ? AND tags LIKE '%"quest"%'
       ORDER BY created_at DESC`,
      [userId]
    );

    const quests: Quest[] = [];
    for (const row of rows) {
      try {
        const metadata = JSON.parse(row.metadata || '{}');
        if (metadata.quest) {
          quests.push(metadata.quest as Quest);
        }
      } catch {
        // Skip malformed entries
      }
    }

    questCache.set(userId, quests);
    return quests;
  } catch (error) {
    logger.error('Failed to load quests from DB:', error);
    return [];
  }
}

/**
 * Save a quest to the database
 */
function saveQuest(quest: Quest): void {
  try {
    const db = getSyncDb();
    const questSummary = `Quest: ${quest.title} (${quest.status})`;
    const metadata = JSON.stringify({ quest, type: 'quest' });
    const tags = JSON.stringify(['quest', quest.status, 'workflow']);

    // Check if quest already exists
    const existing = db.get<{ id: number }>(
      `SELECT id FROM memories WHERE user_id = ? AND metadata LIKE ?`,
      [quest.userId, `%"id":"${quest.id}"%`]
    );

    if (existing) {
      // Update existing
      db.run(
        `UPDATE memories SET content = ?, metadata = ?, tags = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [questSummary, metadata, tags, existing.id]
      );
    } else {
      // Insert new
      db.run(
        `INSERT INTO memories (user_id, content, metadata, tags, timestamp, importance)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [quest.userId, questSummary, metadata, tags, new Date().toISOString(), 7]
      );
    }

    // Update cache
    const userQuests = questCache.get(quest.userId) || [];
    const existingIdx = userQuests.findIndex(q => q.id === quest.id);
    if (existingIdx >= 0) {
      userQuests[existingIdx] = quest;
    } else {
      userQuests.push(quest);
    }
    questCache.set(quest.userId, userQuests);
  } catch (error) {
    logger.error('Failed to save quest:', error);
  }
}

/**
 * Delete a quest from the database
 */
function deleteQuest(quest: Quest): void {
  try {
    const db = getSyncDb();
    db.run(
      `DELETE FROM memories WHERE user_id = ? AND metadata LIKE ?`,
      [quest.userId, `%"id":"${quest.id}"%`]
    );

    // Update cache
    const userQuests = questCache.get(quest.userId) || [];
    const idx = userQuests.findIndex(q => q.id === quest.id);
    if (idx >= 0) {
      userQuests.splice(idx, 1);
      questCache.set(quest.userId, userQuests);
    }
  } catch (error) {
    logger.error('Failed to delete quest:', error);
  }
}

/**
 * Generate a quest from a goal using simple heuristics
 */
function generateQuestSteps(goal: string): QuestStep[] {
  const goalLower = goal.toLowerCase();

  // Common quest templates
  if (goalLower.includes('dev environment') || goalLower.includes('development setup')) {
    return [
      { id: 1, title: 'Install prerequisites', description: 'Install Node.js, Git, and your preferred code editor', completed: false },
      { id: 2, title: 'Clone the repository', description: 'git clone the project repo to your local machine', completed: false },
      { id: 3, title: 'Install dependencies', description: 'Run npm install or pnpm install', completed: false },
      { id: 4, title: 'Set up environment variables', description: 'Copy .env.example to .env and fill in values', completed: false },
      { id: 5, title: 'Run the project', description: 'Start the dev server and verify it works', completed: false },
      { id: 6, title: 'Make a test change', description: 'Edit something small and see it reflected', completed: false },
    ];
  }

  if (goalLower.includes('learn') || goalLower.includes('tutorial')) {
    return [
      { id: 1, title: 'Understand the basics', description: 'Read intro docs or watch overview video', completed: false },
      { id: 2, title: 'Set up your environment', description: 'Install necessary tools and create a practice project', completed: false },
      { id: 3, title: 'Follow a tutorial', description: 'Complete a guided tutorial or course', completed: false },
      { id: 4, title: 'Build something small', description: 'Create a mini-project to practice', completed: false },
      { id: 5, title: 'Review and reflect', description: 'Note what you learned and what to explore next', completed: false },
    ];
  }

  if (goalLower.includes('debug') || goalLower.includes('fix') || goalLower.includes('troubleshoot')) {
    return [
      { id: 1, title: 'Reproduce the issue', description: 'Confirm you can consistently trigger the bug', completed: false },
      { id: 2, title: 'Gather information', description: 'Check logs, error messages, and recent changes', completed: false },
      { id: 3, title: 'Isolate the cause', description: 'Narrow down which component/code is responsible', completed: false },
      { id: 4, title: 'Research solutions', description: 'Search docs, Stack Overflow, or ask for help', completed: false },
      { id: 5, title: 'Implement the fix', description: 'Make the code changes', completed: false },
      { id: 6, title: 'Verify the fix', description: 'Test that the bug is gone and nothing else broke', completed: false },
    ];
  }

  if (goalLower.includes('deploy') || goalLower.includes('release') || goalLower.includes('ship')) {
    return [
      { id: 1, title: 'Run tests', description: 'Ensure all tests pass', completed: false },
      { id: 2, title: 'Review changes', description: 'Check diff, update changelog if needed', completed: false },
      { id: 3, title: 'Build production artifacts', description: 'Create optimized production build', completed: false },
      { id: 4, title: 'Deploy to staging', description: 'Test in staging environment first', completed: false },
      { id: 5, title: 'Deploy to production', description: 'Push to production', completed: false },
      { id: 6, title: 'Verify deployment', description: 'Check health endpoints and monitor for errors', completed: false },
    ];
  }

  // Generic quest for unknown goals
  return [
    { id: 1, title: 'Define success criteria', description: 'What does "done" look like?', completed: false },
    { id: 2, title: 'Break it down', description: 'List the major milestones', completed: false },
    { id: 3, title: 'Start with the first step', description: 'Begin working on the initial task', completed: false },
    { id: 4, title: 'Check progress', description: 'Review what\'s done and what remains', completed: false },
    { id: 5, title: 'Complete and celebrate', description: 'Finish up and acknowledge the accomplishment', completed: false },
  ];
}

/**
 * Quest capability handler
 */
async function handleQuests(
  params: QuestParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`Quest handler - Action: ${action}, UserId: ${userId}`);

  // Load user's quests from DB
  const userQuests = loadUserQuests(userId);

  try {
    switch (action) {
      case 'start':
      case 'create': {
        const title = params.title || content;
        if (!title) {
          return 'Please provide a quest title or goal. Example: "start quest: learn TypeScript"';
        }

        let steps: any[];
        if (params.steps) {
          steps = params.steps.map((s, i) => ({ id: i + 1, title: s, description: s, completed: false }));
        } else {
          steps = generateQuestSteps(title);
        }

        const quest: Quest = {
          id: `quest-${Date.now()}`,
          userId,
          title,
          description: params.description || `Quest to: ${title}`,
          steps,
          currentStep: 0,
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        saveQuest(quest);

        const stepList = steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
        return `**Quest Started: ${title}**\n\nSteps:\n${stepList}\n\n**Next:** ${steps[0].title}\n${steps[0].description}`;
      }

      case 'next':
      case 'current':
      case 'status': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quests. Start one with: "start quest: [your goal]"';
        }

        const currentStep = activeQuest.steps[activeQuest.currentStep];
        const progress = activeQuest.steps.filter(s => s.completed).length;
        const total = activeQuest.steps.length;
        const progressBar = '█'.repeat(progress) + '░'.repeat(total - progress);

        return `**${activeQuest.title}**\n\nProgress: [${progressBar}] ${progress}/${total}\n\n**Current Step ${activeQuest.currentStep + 1}:** ${currentStep.title}\n${currentStep.description}`;
      }

      case 'complete':
      case 'done':
      case 'finish': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quest to mark progress on.';
        }

        const currentStep = activeQuest.steps[activeQuest.currentStep];
        currentStep.completed = true;
        currentStep.completedAt = new Date().toISOString();
        if (params.stepNotes) {
          currentStep.notes = params.stepNotes;
        }

        activeQuest.currentStep++;
        activeQuest.updatedAt = new Date().toISOString();

        // Check if quest is complete
        if (activeQuest.currentStep >= activeQuest.steps.length) {
          activeQuest.status = 'completed';
          activeQuest.completedAt = new Date().toISOString();
          saveQuest(activeQuest);
          return `**Quest Complete: ${activeQuest.title}!**\n\nAll ${activeQuest.steps.length} steps finished. Well done!`;
        }

        saveQuest(activeQuest);

        const nextStep = activeQuest.steps[activeQuest.currentStep];
        const progress = activeQuest.steps.filter(s => s.completed).length;
        const total = activeQuest.steps.length;

        return `Step completed: ${currentStep.title}\n\nProgress: ${progress}/${total}\n\n**Next:** ${nextStep.title}\n${nextStep.description}`;
      }

      case 'skip': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quest.';
        }

        const skippedStep = activeQuest.steps[activeQuest.currentStep];
        activeQuest.currentStep++;
        activeQuest.updatedAt = new Date().toISOString();

        if (activeQuest.currentStep >= activeQuest.steps.length) {
          activeQuest.status = 'completed';
          activeQuest.completedAt = new Date().toISOString();
          saveQuest(activeQuest);
          return `Skipped: ${skippedStep.title}\n\nQuest complete (with skipped steps)!`;
        }

        saveQuest(activeQuest);

        const nextStep = activeQuest.steps[activeQuest.currentStep];
        return `Skipped: ${skippedStep.title}\n\n**Next:** ${nextStep.title}\n${nextStep.description}`;
      }

      case 'list': {
        if (userQuests.length === 0) {
          return 'No quests yet. Start one with: "start quest: [your goal]"';
        }

        const questList = userQuests.map(q => {
          const progress = q.steps.filter(s => s.completed).length;
          const emoji = questStatusEmoji(q.status);
          return `${emoji} **${q.title}** - ${progress}/${q.steps.length} steps (${q.status})`;
        }).join('\n');

        return `**Your Quests:**\n\n${questList}`;
      }

      case 'abandon':
      case 'cancel': {
        const activeQuest = userQuests.find(q => q.status === 'active');
        if (!activeQuest) {
          return 'No active quest to abandon.';
        }

        activeQuest.status = 'abandoned';
        activeQuest.updatedAt = new Date().toISOString();
        saveQuest(activeQuest);

        return `Quest abandoned: ${activeQuest.title}`;
      }

      case 'resume': {
        // Find most recent abandoned or completed quest to resume
        const resumable = userQuests.find(q => q.status === 'abandoned' || q.status === 'completed');
        if (!resumable) {
          return 'No quest to resume.';
        }

        resumable.status = 'active';
        resumable.updatedAt = new Date().toISOString();
        saveQuest(resumable);

        const currentStep = resumable.steps[resumable.currentStep];
        return `Quest resumed: ${resumable.title}\n\n**Current Step:** ${currentStep?.title || 'Complete!'}`;
      }

      case 'clear': {
        // Clear all completed/abandoned quests
        const toDelete = userQuests.filter(q => q.status !== 'active');
        for (const quest of toDelete) {
          deleteQuest(quest);
        }
        return `Cleared ${toDelete.length} completed/abandoned quests.`;
      }

      default:
        return `Unknown quest action: ${action}. Try: start, next, complete, skip, list, abandon, resume, clear`;
    }
  } catch (error) {
    logger.error('Quest error:', error);
    return `Quest error: ${getErrorMessage(error)}`;
  }
}

// =====================================================================================
// tracker="task" (was the `task-status` tool)
//
// Brief status updates during extended operations, so users stay informed during long-running
// work without waiting for full completion. Inspired by Clawdbot's "task-status" skill.
// =====================================================================================

interface TaskStatusParams {
  action: string;
  taskName?: string;
  status?: string;
  progress?: number; // 0-100
  eta?: string;
  details?: string;
  [key: string]: unknown;
}

interface ActiveTask {
  id: string;
  name: string;
  status: string;
  progress: number;
  startedAt: string;
  lastUpdate: string;
  eta?: string;
  details?: string;
}

// Track active tasks per user
const activeTasks = new Map<string, ActiveTask[]>();

/**
 * Format progress bar
 */
function progressBar(progress: number, width: number = 10): string {
  const filled = Math.round((progress / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format time elapsed
 */
function formatElapsed(startedAt: string): string {
  const elapsed = Date.now() - new Date(startedAt).getTime();
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Task status capability handler
 */
async function handleTaskStatus(
  params: TaskStatusParams,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const { action } = params;
  const userId = ctx?.userId || 'unknown-user';

  logger.info(`📊 Task status - Action: ${action}, UserId: ${userId}`);

  // Get or initialize user's tasks
  if (!activeTasks.has(userId)) {
    activeTasks.set(userId, []);
  }
  const userTasks = activeTasks.get(userId)!;

  try {
    switch (action) {
      case 'start':
      case 'begin': {
        const taskName = params.taskName || content || 'Unnamed task';
        const task: ActiveTask = {
          id: `task-${Date.now()}`,
          name: taskName,
          status: params.status || 'Starting...',
          progress: params.progress || 0,
          startedAt: new Date().toISOString(),
          lastUpdate: new Date().toISOString(),
          eta: params.eta,
          details: params.details,
        };

        userTasks.push(task);

        return `🚀 **Started:** ${taskName}\n[${progressBar(0)}] 0%`;
      }

      case 'update':
      case 'progress': {
        const taskName = params.taskName;
        let task: any;
        if (taskName) {
          task = userTasks.find(t => t.name.toLowerCase().includes(taskName.toLowerCase()));
        } else {
          task = userTasks[userTasks.length - 1];
        }

        if (!task) {
          return '⚠️ No active task to update.';
        }

        if (params.status) task.status = params.status;
        if (params.progress !== undefined) task.progress = params.progress;
        if (params.eta) task.eta = params.eta;
        if (params.details) task.details = params.details;
        task.lastUpdate = new Date().toISOString();

        const elapsed = formatElapsed(task.startedAt);
        const etaStr = etaSuffix(task.eta);

        return `📊 **${task.name}**\n[${progressBar(task.progress)}] ${task.progress}%${etaStr}\n${task.status} (${elapsed})`;
      }

      case 'complete':
      case 'done':
      case 'finish': {
        const taskName = params.taskName;
        let taskIndex: number;
        if (taskName) {
          taskIndex = userTasks.findIndex(t => t.name.toLowerCase().includes(taskName.toLowerCase()));
        } else {
          taskIndex = userTasks.length - 1;
        }

        if (taskIndex === -1) {
          return '⚠️ No active task to complete.';
        }

        const task = userTasks[taskIndex];
        const elapsed = formatElapsed(task.startedAt);
        userTasks.splice(taskIndex, 1);

        return `✅ **Completed:** ${task.name}\nFinished in ${elapsed}${detailsSuffix(params.details)}`;
      }

      case 'fail':
      case 'error': {
        const taskName = params.taskName;
        let taskIndex: number;
        if (taskName) {
          taskIndex = userTasks.findIndex(t => t.name.toLowerCase().includes(taskName.toLowerCase()));
        } else {
          taskIndex = userTasks.length - 1;
        }

        if (taskIndex === -1) {
          return '⚠️ No active task.';
        }

        const task = userTasks[taskIndex];
        const elapsed = formatElapsed(task.startedAt);
        userTasks.splice(taskIndex, 1);

        return `❌ **Failed:** ${task.name}\nAfter ${elapsed}${errorDetailsSuffix(params.details)}`;
      }

      case 'list':
      case 'active': {
        if (userTasks.length === 0) {
          return '📭 No active tasks.';
        }

        const taskList = userTasks.map(task => {
          const elapsed = formatElapsed(task.startedAt);
          return `📊 **${task.name}**\n   [${progressBar(task.progress)}] ${task.progress}% • ${task.status} (${elapsed})`;
        }).join('\n\n');

        return `🔄 **Active Tasks:**\n\n${taskList}`;
      }

      case 'cancel':
      case 'abort': {
        const taskName = params.taskName;
        let taskIndex: number;
        if (taskName) {
          taskIndex = userTasks.findIndex(t => t.name.toLowerCase().includes(taskName.toLowerCase()));
        } else {
          taskIndex = userTasks.length - 1;
        }

        if (taskIndex === -1) {
          return '⚠️ No active task to cancel.';
        }

        const task = userTasks[taskIndex];
        userTasks.splice(taskIndex, 1);

        return `🚫 **Cancelled:** ${task.name}`;
      }

      default:
        return `Unknown task-status action: ${action}. Try: start, update, complete, fail, list, cancel`;
    }
  } catch (error) {
    logger.error('Task status error:', error);
    return `❌ Task status error: ${getErrorMessage(error)}`;
  }
}

// =====================================================================================
// The one registered tool
// =====================================================================================

type Tracker = 'todo' | 'quest' | 'task';

const TRACKER_ACTIONS: Record<Tracker, string[]> = {
  todo: ['create', 'add', 'next', 'complete', 'status', 'list'],
  quest: [
    'start', 'create', 'next', 'current', 'status', 'complete', 'done', 'finish', 'skip', 'list',
    'abandon', 'cancel', 'resume', 'clear',
  ],
  task: [
    'start', 'begin', 'update', 'progress', 'complete', 'done', 'finish', 'fail', 'error', 'list',
    'active', 'cancel', 'abort',
  ],
};

/** Which tracker a call goes to: explicit `tracker`, else todo, else the one tracker that knows the action. */
function pickTracker(action: string, tracker: unknown): Tracker | null {
  if (tracker === 'todo' || tracker === 'quest' || tracker === 'task') {
    return tracker;
  }
  if (tracker !== undefined && tracker !== null && tracker !== '') {
    return null;
  }
  if (TRACKER_ACTIONS.todo.includes(action)) return 'todo';
  if (TRACKER_ACTIONS.quest.includes(action)) return 'quest';
  if (TRACKER_ACTIONS.task.includes(action)) return 'task';
  return 'todo';
}

async function handleTasks(
  params: any,
  content?: string,
  ctx?: CapabilityContext
): Promise<string> {
  const action = String(params?.action ?? '');
  const tracker = pickTracker(action, params?.tracker);

  if (!tracker) {
    return `❌ Unknown tracker "${params.tracker}". Use tracker="todo" (named lists), "quest" (guided multi-step quests) or "task" (progress updates during long work).`;
  }
  if (!TRACKER_ACTIONS[tracker].includes(action)) {
    return `❌ tracker="${tracker}" has no action "${action}". Its actions: ${TRACKER_ACTIONS[tracker].join(', ')}`;
  }

  switch (tracker) {
    case 'todo':
      return handleTodoAction(params as TodoParams, content);
    case 'quest':
      return handleQuests(params as QuestParams, content, ctx);
    case 'task':
      return handleTaskStatus(params as TaskStatusParams, content, ctx);
  }
}

export const tasksCapability: RegisteredCapability = {
  name: 'tasks',
  emoji: '✅',
  supportedActions: Array.from(
    new Set([...TRACKER_ACTIONS.todo, ...TRACKER_ACTIONS.quest, ...TRACKER_ACTIONS.task])
  ),
  description: `Track work through steps. Pick a tracker with tracker= (default "todo"):

tracker="todo": named todo lists (list= name, items as "- item" lines in the tag content)
- create, add, next, complete (item= position), status, list

tracker="quest": guide someone through a multi-step real-world process; persists across sessions
- start/create (title=, auto-generated steps), next/current/status, complete/done/finish, skip,
  list, abandon/cancel, resume, clear
- Templates exist for dev setup, learning, debugging, deployment; other goals get generic steps.

tracker="task": brief progress updates during your own long operations
- start/begin (taskName=), update/progress (progress 0-100, status, eta), complete/done/finish,
  fail/error, list/active, cancel/abort`,
  handler: handleTasks,
  examples: [
    '<capability name="tasks" action="create" list="build_resume">- Gather professional memories\\n- Extract key achievements\\n- Generate resume content\\n- Save to filesystem</capability>',
    '<capability name="tasks" action="next" list="build_resume" />',
    '<capability name="tasks" action="complete" list="build_resume" item="1" />',
    '<capability name="tasks" action="status" list="build_resume" />',
    '<capability name="tasks" action="list" />',
    '<capability name="tasks" tracker="quest" action="start" title="set up my dev environment" />',
    '<capability name="tasks" tracker="quest" action="next" />',
    '<capability name="tasks" tracker="task" action="start" taskName="deep research run" />',
    '<capability name="tasks" tracker="task" action="update" progress="60" status="reading sources" />',
  ],
};
