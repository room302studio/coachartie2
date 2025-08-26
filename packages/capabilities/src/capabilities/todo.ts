import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';
import { getDatabase } from '@coachartie/shared';

interface TodoListRow {
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

export class TodoService {
  private static instance: TodoService;
  private dbReady = false;

  static getInstance(): TodoService {
    if (!TodoService.instance) {
      TodoService.instance = new TodoService();
    }
    return TodoService.instance;
  }

  async initializeDatabase(): Promise<void> {
    if (this.dbReady) return;

    try {
      const db = await getDatabase();
      
      // Create todo_lists table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS todo_lists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          goal_id INTEGER,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, name)
        )
      `);

      // Create todo_items table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS todo_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          list_id INTEGER NOT NULL,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          position INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME,
          FOREIGN KEY (list_id) REFERENCES todo_lists(id)
        )
      `);

      // Create indexes
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_todo_lists_user_id ON todo_lists(user_id);
        CREATE INDEX IF NOT EXISTS idx_todo_items_list_id ON todo_items(list_id);
        CREATE INDEX IF NOT EXISTS idx_todo_items_status ON todo_items(status);
      `);

      this.dbReady = true;
      logger.info('✅ Todo database initialized successfully');
    } catch (error) {
      logger.error('❌ Failed to initialize todo database:', error);
      throw error;
    }
  }

  async createTodoList(userId: string, listName: string, content: string, goalId?: number): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Check if list already exists
      const existingList = await db.get(`
        SELECT id FROM todo_lists WHERE user_id = ? AND name = ?
      `, [userId, listName]);

      if (existingList) {
        return `❌ Todo list "${listName}" already exists. Use action="add" to add more items.`;
      }

      // Create the todo list
      const result = await db.run(`
        INSERT INTO todo_lists (user_id, name, goal_id)
        VALUES (?, ?, ?)
      `, [userId, listName, goalId || null]);

      const listId = result.lastID!;

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
        await db.run(`
          INSERT INTO todo_items (list_id, content, position)
          VALUES (?, ?, ?)
        `, [listId, items[i], i + 1]);
      }

      logger.info(`📋 Created todo list "${listName}" for user ${userId} with ${items.length} items`);
      
      const goalText = goalId ? ` (linked to goal ${goalId})` : '';
      return `✅ Created todo list "${listName}" with ${items.length} items${goalText}:\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
    } catch (error) {
      logger.error('❌ Failed to create todo list:', error);
      return 'Sorry, having trouble creating todo lists right now. Please try again.';
    }
  }

  async addItemsToList(userId: string, listName: string, content: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Find the list
      const list = await db.get(`
        SELECT id FROM todo_lists WHERE user_id = ? AND name = ?
      `, [userId, listName]);

      if (!list) {
        return `❌ Todo list "${listName}" not found. Create it first with action="create".`;
      }

      // Get current highest position
      const maxPos = await db.get(`
        SELECT MAX(position) as max_pos FROM todo_items WHERE list_id = ?
      `, [list.id]);

      const startPosition = (maxPos?.max_pos || 0) + 1;

      // Parse new items
      const items = this.parseContentIntoItems(content);
      
      if (items.length === 0) {
        return `❌ No todo items found in content. Use format like:
- New task 1
- New task 2`;
      }

      // Insert new items
      for (let i = 0; i < items.length; i++) {
        await db.run(`
          INSERT INTO todo_items (list_id, content, position)
          VALUES (?, ?, ?)
        `, [list.id, items[i], startPosition + i]);
      }

      logger.info(`📋 Added ${items.length} items to todo list "${listName}" for user ${userId}`);
      
      return `✅ Added ${items.length} items to "${listName}":\n${items.map((item, i) => `${startPosition + i}. ${item}`).join('\n')}`;
    } catch (error) {
      logger.error('❌ Failed to add items to todo list:', error);
      return 'Sorry, having trouble adding todo items right now. Please try again.';
    }
  }

  async getNextItem(userId: string, listName: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Find the list and get next pending item
      const nextItem = await db.get(`
        SELECT ti.id, ti.content, ti.position
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND tl.name = ? AND ti.status = 'pending'
        ORDER BY ti.position ASC
        LIMIT 1
      `, [userId, listName]);

      if (!nextItem) {
        return `📋 No pending items in "${listName}". All tasks completed! 🎉`;
      }

      return `📌 Next task: ${nextItem.content} (item ${nextItem.position})`;
    } catch (error) {
      logger.error('❌ Failed to get next item:', error);
      return 'Sorry, having trouble getting next todo item right now. Please try again.';
    }
  }

  // New simplified complete by text match
  async completeByText(userId: string, searchText: string): Promise<string> {
    await this.initializeDatabase();
    
    try {
      const db = await getDatabase();
      
      // Find matching uncompleted items
      const matches = await db.all(`
        SELECT ti.id, ti.content, tl.name as list_name
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND ti.content LIKE ? AND ti.status = 'pending'
        LIMIT 5
      `, [userId, `%${searchText}%`]);

      if (matches.length === 0) {
        return `❌ No pending tasks match "${searchText}"`;
      }

      if (matches.length === 1) {
        // Single match - complete it
        await db.run(`
          UPDATE todo_items 
          SET status = 'completed', completed_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [matches[0].id]);
        
        return `✅ Completed: "${matches[0].content}"`;
      }
      
      // Multiple matches
      const list = matches.map((m: any) => `• "${m.content}" (${m.list_name})`).join('\n');
      return `🤔 Multiple matches:\n${list}\n\nBe more specific.`;
    } catch (error) {
      logger.error('Failed to complete by text:', error);
      return '❌ Could not complete task';
    }
  }

  async completeItem(userId: string, listName: string, itemPosition: number): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Find the specific item
      const item = await db.get(`
        SELECT ti.id, ti.content, ti.status
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND tl.name = ? AND ti.position = ?
      `, [userId, listName, itemPosition]);

      if (!item) {
        return `❌ Item ${itemPosition} not found in "${listName}"`;
      }

      if (item.status === 'completed') {
        return `✅ Item "${item.content}" is already completed`;
      }

      // Mark as completed
      await db.run(`
        UPDATE todo_items 
        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [item.id]);

      // Get progress
      const progress = await this.getListProgress(userId, listName);
      
      logger.info(`✅ Completed item ${itemPosition} in todo list "${listName}" for user ${userId}`);
      
      return `✅ Marked "${item.content}" as complete! Progress: ${progress}`;
    } catch (error) {
      logger.error('❌ Failed to complete item:', error);
      return 'Sorry, having trouble completing todo items right now. Please try again.';
    }
  }

  async getListStatus(userId: string, listName: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      // Check if list exists
      const list = await db.get(`
        SELECT id, goal_id FROM todo_lists WHERE user_id = ? AND name = ?
      `, [userId, listName]);

      if (!list) {
        return `❌ Todo list "${listName}" not found`;
      }

      // Get all items with status
      const items = await db.all(`
        SELECT content, status, position, completed_at
        FROM todo_items 
        WHERE list_id = ?
        ORDER BY position ASC
      `, [list.id]);

      if (items.length === 0) {
        return `📋 "${listName}" is empty. Add some tasks!`;
      }

      const completed = items.filter((item: TodoItemRow) => item.status === 'completed').length;
      const total = items.length;
      const percentage = Math.round((completed / total) * 100);

      const statusList = items.map((item: TodoItemRow) => {
        const icon = item.status === 'completed' ? '✅' : '⏳';
        return `${icon} ${item.content}`;
      }).join('\n');

      const goalText = list.goal_id ? ` (linked to goal ${list.goal_id})` : '';
      
      return `📋 ${listName}: ${completed}/${total} completed (${percentage}%)${goalText}\n${statusList}`;
    } catch (error) {
      logger.error('❌ Failed to get list status:', error);
      return 'Sorry, having trouble getting todo list status right now. Please try again.';
    }
  }

  async listAllLists(userId: string): Promise<string> {
    await this.initializeDatabase();

    try {
      const db = await getDatabase();
      
      const lists = await db.all(`
        SELECT tl.name, tl.goal_id, tl.created_at,
               COUNT(ti.id) as total_items,
               SUM(CASE WHEN ti.status = 'completed' THEN 1 ELSE 0 END) as completed_items
        FROM todo_lists tl
        LEFT JOIN todo_items ti ON tl.id = ti.list_id
        WHERE tl.user_id = ?
        GROUP BY tl.id, tl.name, tl.goal_id, tl.created_at
        ORDER BY tl.updated_at DESC
      `, [userId]);

      if (lists.length === 0) {
        return '📋 No todo lists found. Create one with: <capability name="todo" action="create" list="my_list">- Task 1\\n- Task 2</capability>';
      }

      const listSummary = lists.map((list: any) => {
        const completed = list.completed_items || 0;
        const total = list.total_items || 0;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
        const goalText = list.goal_id ? ` (goal: ${list.goal_id})` : '';
        
        return `📋 **${list.name}**: ${completed}/${total} (${percentage}%)${goalText}`;
      }).join('\n');

      return `📚 Your todo lists (${lists.length}):\n\n${listSummary}`;
    } catch (error) {
      logger.error('❌ Failed to list todo lists:', error);
      return 'Sorry, having trouble listing todo lists right now. Please try again.';
    }
  }

  private async getListProgress(userId: string, listName: string): Promise<string> {
    try {
      const db = await getDatabase();
      
      const progress = await db.get(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN ti.status = 'completed' THEN 1 ELSE 0 END) as completed
        FROM todo_items ti
        JOIN todo_lists tl ON ti.list_id = tl.id
        WHERE tl.user_id = ? AND tl.name = ?
      `, [userId, listName]);

      const completed = progress?.completed || 0;
      const total = progress?.total || 0;
      const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
      
      return `${completed}/${total} (${percentage}%)`;
    } catch (error) {
      logger.error('❌ Failed to get progress:', error);
      return 'unknown progress';
    }
  }

  private parseContentIntoItems(content: string): string[] {
    const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
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
  const { action, user_id = 'default-user' } = params;
  const todoService = TodoService.getInstance();

  logger.info(`📋 Todo handler called - Action: ${action}, UserId: ${user_id}, Params:`, params);

  try {
    switch (action) {
      case 'add': {
        // Simplified: combines create + add, auto-creates list
        const listName = params.list || 'tasks';  // Default list name
        
        if (!content) {
          return '❌ What tasks do you want to add?';
        }
        
        // Try to add to existing list first
        const addResult = await todoService.addItemsToList(String(user_id), String(listName), content);
        
        // If list doesn't exist, create it
        if (addResult.includes('not found')) {
          return await todoService.createTodoList(String(user_id), String(listName), content);
        }
        
        return addResult;
      }

      case 'complete': {
        // Simplified: complete by text match instead of position
        if (!content) {
          return '❌ Which task did you complete?';
        }
        
        return await todoService.completeByText(String(user_id), content);
      }

      case 'show': {
        // Simplified: combines list, status, and next
        const listName = params.list;
        
        if (listName) {
          // Show specific list with next item
          const status = await todoService.getListStatus(String(user_id), String(listName));
          const next = await todoService.getNextItem(String(user_id), String(listName));
          const nextText = next.includes('❌') ? '' : `\n\n💡 **Next:** ${next}`;
          return status + nextText;
        } else {
          // Show all lists
          return await todoService.listAllLists(String(user_id));
        }
      }

      default:
        return `📋 Simple todos! Just use:\n• add - Add tasks\n• complete - Mark done\n• show - See everything`;
    }
  } catch (error) {
    logger.error(`Todo capability error for action '${action}':`, error);
    return 'Sorry, having trouble with todo lists right now. Please try again.';
  }
}

/**
 * Todo capability definition
 */
export const todoCapability: RegisteredCapability = {
  name: 'todo',
  supportedActions: ['add', 'complete', 'show'],  // Simplified to just 3 actions
  description: 'Simple todo lists - add tasks, complete them, see progress',
  handler: handleTodoAction,
  examples: [
    '<capability name="todo" action="add">Build feature X</capability>',
    '<capability name="todo" action="complete">Build feature X</capability>',
    '<capability name="todo" action="show" />',
  ]
};