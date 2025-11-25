import { logger, getDatabase } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

interface VariableParams {
  action: string;
  key?: string;
  value?: string;
  [key: string]: unknown;
}

/**
 * Global Variable Store - Simple DB-backed key/value store for mustache templates
 * No sessions, no complexity - just global persistent storage
 */
export class GlobalVariableStore {
  private static instance: GlobalVariableStore;

  static getInstance(): GlobalVariableStore {
    if (!GlobalVariableStore.instance) {
      GlobalVariableStore.instance = new GlobalVariableStore();
    }
    return GlobalVariableStore.instance;
  }

  /**
   * Shutdown method for graceful cleanup (no-op for DB-backed store)
   */
  shutdown(): void {
    // DB-backed store doesn't need cleanup
  }

  /**
   * Set a variable in the database
   */
  async set(key: string, value: any, description?: string): Promise<void> {
    const db = await getDatabase();

    // Determine value type and serialize if needed
    let valueType = 'string';
    let serialized = value;

    if (typeof value === 'object') {
      valueType = 'json';
      serialized = JSON.stringify(value);
    } else if (typeof value === 'number') {
      valueType = 'number';
      serialized = String(value);
    } else if (typeof value === 'boolean') {
      valueType = 'boolean';
      serialized = String(value);
    } else {
      serialized = String(value);
    }

    await db.run(
      `INSERT INTO global_variables (key, value, value_type, description)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         value_type = excluded.value_type,
         description = excluded.description,
         updated_at = CURRENT_TIMESTAMP`,
      [key, serialized, valueType, description || null]
    );

    logger.info(`📦 Set global variable: ${key} = ${serialized.substring(0, 100)}`);
  }

  /**
   * Get a variable from the database
   */
  async get(key: string): Promise<any> {
    const db = await getDatabase();
    const row = await db.get<{ value: string; value_type: string }>(
      'SELECT value, value_type FROM global_variables WHERE key = ?',
      [key]
    );

    if (!row) {
      return undefined;
    }

    // Deserialize based on type
    switch (row.value_type) {
      case 'json':
        return JSON.parse(row.value);
      case 'number':
        return Number(row.value);
      case 'boolean':
        return row.value === 'true';
      default:
        return row.value;
    }
  }

  /**
   * Substitute {{mustache}} variables in text
   */
  async substitute(text: string): Promise<string> {
    const db = await getDatabase();

    // Find all {{variables}} in the text
    const matches = text.match(/\{\{(\w+)\}\}/g);
    if (!matches) {
      return text;
    }

    // Get all variables in one query
    const keys = matches.map(m => m.replace(/\{\{|\}\}/g, ''));
    const placeholders = keys.map(() => '?').join(',');
    const rows = await db.all<{ key: string; value: string; value_type: string }>(
      `SELECT key, value, value_type FROM global_variables WHERE key IN (${placeholders})`,
      keys
    );

    // Create lookup map
    const values = new Map<string, any>();
    for (const row of rows) {
      let value: any = row.value;
      switch (row.value_type) {
        case 'json':
          value = JSON.parse(row.value);
          break;
        case 'number':
          value = Number(row.value);
          break;
        case 'boolean':
          value = row.value === 'true';
          break;
      }
      values.set(row.key, value);
    }

    // Replace {{variables}} with values
    return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = values.get(key);
      if (value !== undefined) {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
      return match; // Leave unchanged if not found
    });
  }

  /**
   * List all variables
   */
  async list(): Promise<Record<string, any>> {
    const db = await getDatabase();
    const rows = await db.all<{ key: string; value: string; value_type: string; description: string }>(
      'SELECT key, value, value_type, description FROM global_variables ORDER BY key'
    );

    const variables: Record<string, any> = {};
    for (const row of rows) {
      let value: any = row.value;
      switch (row.value_type) {
        case 'json':
          value = JSON.parse(row.value);
          break;
        case 'number':
          value = Number(row.value);
          break;
        case 'boolean':
          value = row.value === 'true';
          break;
      }
      variables[row.key] = value;
    }

    return variables;
  }

  /**
   * Delete a variable
   */
  async delete(key: string): Promise<boolean> {
    const db = await getDatabase();
    const result = await db.run('DELETE FROM global_variables WHERE key = ?', [key]);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Clear all variables
   */
  async clear(): Promise<number> {
    const db = await getDatabase();
    const result = await db.run('DELETE FROM global_variables');
    return result.changes ?? 0;
  }
}

/**
 * Variable store capability handler
 */
async function handleVariableAction(params: VariableParams, content?: string): Promise<string> {
  const { action } = params;
  const store = GlobalVariableStore.getInstance();

  logger.info(`🗃️ Variable handler called - Action: ${action}`, params);

  try {
    switch (action) {
      case 'set': {
        const key = params.key;
        const value = params.value || content;

        if (!key) {
          throw new Error('Missing required parameter: key. Example: <capability name="variable" action="set" key="myvar" value="myvalue" />');
        }

        if (value === undefined) {
          throw new Error('Missing required parameter: value. Example: <capability name="variable" action="set" key="myvar" value="myvalue" />');
        }

        // Try to parse JSON if it looks like JSON
        let parsedValue = value;
        if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
          try {
            parsedValue = JSON.parse(value);
          } catch {
            // Keep as string if not valid JSON
          }
        }

        await store.set(String(key), parsedValue, params.description as string);
        const preview = typeof parsedValue === 'object'
          ? JSON.stringify(parsedValue).substring(0, 100) + '...'
          : parsedValue;
        return `✅ Variable "${key}" set to: ${preview}`;
      }

      case 'get': {
        const key = params.key;
        if (!key) {
          throw new Error('Missing required parameter: key. Example: <capability name="variable" action="get" key="myvar" />');
        }

        const value = await store.get(String(key));
        if (value !== undefined) {
          return typeof value === 'object' ? JSON.stringify(value) : String(value);
        } else {
          const allVars = await store.list();
          const availableKeys = Object.keys(allVars);
          const suggestions = availableKeys.length > 0
            ? `\n\nAvailable variables: ${availableKeys.join(', ')}`
            : '\n\nNo variables exist. Use action="set" to create one.';
          throw new Error(`Variable "${key}" not found.${suggestions}`);
        }
      }

      case 'substitute': {
        const template = content || String(params.template || '');
        if (!template) {
          throw new Error('Missing template content. Example: <capability name="variable" action="substitute">Hello {{name}}</capability>');
        }

        const result = await store.substitute(template);
        return result;
      }

      case 'list': {
        const variables = await store.list();
        const keys = Object.keys(variables);

        if (keys.length === 0) {
          return '📭 No global variables stored';
        }

        const varList = keys
          .map(key => {
            const value = variables[key];
            const preview = typeof value === 'object'
              ? JSON.stringify(value).substring(0, 50) + '...'
              : String(value).substring(0, 50);
            return `• ${key}: ${preview}`;
          })
          .join('\n');

        return `📦 Global Variables (${keys.length}):\n${varList}`;
      }

      case 'delete': {
        const key = params.key;
        if (!key) {
          throw new Error('Missing required parameter: key. Example: <capability name="variable" action="delete" key="myvar" />');
        }

        const deleted = await store.delete(String(key));
        if (!deleted) {
          const allVars = await store.list();
          const availableKeys = Object.keys(allVars);
          const suggestions = availableKeys.length > 0
            ? `\n\nAvailable variables: ${availableKeys.join(', ')}`
            : '\n\nNo variables exist.';
          throw new Error(`Variable "${key}" not found.${suggestions}`);
        }
        return `✅ Variable "${key}" deleted`;
      }

      case 'clear': {
        const count = await store.clear();
        return `✅ Cleared ${count} global variable${count === 1 ? '' : 's'}`;
      }

      default:
        throw new Error(`Unknown action: ${action}. Supported: set, get, substitute, list, delete, clear`);
    }
  } catch (error) {
    logger.error(`Variable capability error for action '${action}':`, error);
    throw error;
  }
}

/**
 * Variable store capability definition
 */
export const variableStoreCapability: RegisteredCapability = {
  name: 'variable',
  emoji: '💾',
  supportedActions: ['set', 'get', 'substitute', 'list', 'delete', 'clear'],
  description: 'Global persistent variable store for mustache template substitution and LEGO-block orchestration',
  handler: handleVariableAction,
  examples: [
    '<capability name="variable" action="set" key="name" value="Coach Artie" />',
    '<capability name="variable" action="get" key="name" />',
    '<capability name="variable" action="substitute">Hello {{name}}, how are you?</capability>',
    '<capability name="variable" action="list" />',
    '<capability name="variable" action="delete" key="name" />',
    '<capability name="variable" action="clear" />',
  ],
};
