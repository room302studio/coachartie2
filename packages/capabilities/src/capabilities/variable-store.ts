import { logger } from '@coachartie/shared';
import { RegisteredCapability } from '../services/capability-registry.js';

interface VariableParams {
  action: string;
  sessionId?: string;
  key?: string;
  value?: string;
  [key: string]: unknown;
}

interface SessionMetadata {
  created: number;
  lastAccess: number;
}

export class VariableStore {
  private static instance: VariableStore;
  private sessions: Map<string, Map<string, any>> = new Map();
  private sessionMetadata: Map<string, SessionMetadata> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  static getInstance(): VariableStore {
    if (!VariableStore.instance) {
      VariableStore.instance = new VariableStore();
      // Start cleanup interval
      VariableStore.instance.startCleanupInterval();
    }
    return VariableStore.instance;
  }

  /**
   * Graceful shutdown - clears cleanup interval
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      logger.info('VariableStore shutdown: cleanup interval cleared');
    }
  }

  /**
   * Get or create a session
   */
  getSession(sessionId: string): Map<string, any> {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map());
      this.sessionMetadata.set(sessionId, {
        created: Date.now(),
        lastAccess: Date.now(),
      });
      logger.info(`🗃️ Created new variable session: ${sessionId}`);
    }

    // Update last access
    const metadata = this.sessionMetadata.get(sessionId);
    if (metadata) {
      metadata.lastAccess = Date.now();
    }

    return this.sessions.get(sessionId)!;
  }

  /**
   * Set a variable in a session
   */
  setVariable(sessionId: string, key: string, value: any): void {
    const session = this.getSession(sessionId);
    session.set(key, value);
    logger.info(
      `📦 Set variable ${key} in session ${sessionId}: ${typeof value === 'object' ? JSON.stringify(value).substring(0, 100) + '...' : value}`
    );
  }

  /**
   * Get a variable from a session
   */
  getVariable(sessionId: string, key: string): any {
    const session = this.getSession(sessionId);
    const value = session.get(key);
    logger.info(
      `📭 Get variable ${key} from session ${sessionId}: ${value !== undefined ? 'found' : 'not found'}`
    );
    return value;
  }

  /**
   * Interpolate variables in a string using {{variable}} syntax
   */
  interpolateString(sessionId: string, template: string): string {
    const session = this.getSession(sessionId);

    return template.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      const trimmedVarName = varName.trim();
      const value = session.get(trimmedVarName);

      if (value !== undefined) {
        // Convert to string, handling objects
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
      } else {
        logger.warn(
          `🔍 Variable ${trimmedVarName} not found in session ${sessionId}, leaving unchanged`
        );
        return match; // Leave unchanged if variable not found
      }
    });
  }

  /**
   * List all variables in a session
   */
  listVariables(sessionId: string): Record<string, any> {
    const session = this.getSession(sessionId);
    const variables: Record<string, any> = {};

    for (const [key, value] of session.entries()) {
      variables[key] = value;
    }

    return variables;
  }

  /**
   * Clear a specific variable
   */
  clearVariable(sessionId: string, key: string): boolean {
    const session = this.getSession(sessionId);
    const existed = session.has(key);
    session.delete(key);

    if (existed) {
      logger.info(`🗑️ Cleared variable ${key} from session ${sessionId}`);
    }

    return existed;
  }

  /**
   * Clear all variables in a session
   */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const variableCount = session.size;
      this.sessions.delete(sessionId);
      this.sessionMetadata.delete(sessionId);
      logger.info(`🗑️ Cleared session ${sessionId} (${variableCount} variables)`);
    }
  }

  /**
   * Get session statistics
   */
  getSessionStats(
    sessionId: string
  ): { variableCount: number; created: string; lastAccess: string } | null {
    const session = this.sessions.get(sessionId);
    const metadata = this.sessionMetadata.get(sessionId);

    if (!session || !metadata) {
      return null;
    }

    return {
      variableCount: session.size,
      created: new Date(metadata.created).toISOString(),
      lastAccess: new Date(metadata.lastAccess).toISOString(),
    };
  }

  /**
   * Start automatic cleanup of old sessions (PROD: only in non-dev)
   */
  private startCleanupInterval(): void {
    // Only enable cleanup in production (not on every process restart in dev)
    if (process.env.NODE_ENV !== 'development') {
      this.cleanupInterval = setInterval(() => {
        const now = Date.now();
        const maxAge = 3600000; // 1 hour
        let cleanedCount = 0;

        for (const [sessionId, metadata] of this.sessionMetadata) {
          if (now - metadata.lastAccess > maxAge) {
            this.clearSession(sessionId);
            cleanedCount++;
          }
        }

        if (cleanedCount > 0) {
          logger.info(`🧹 Cleaned up ${cleanedCount} old variable sessions`);
        }
      }, 300000); // Check every 5 minutes
    }
  }

  /**
   * Generate a session ID for orchestrator use
   */
  static generateSessionId(userId: string): string {
    return `${userId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Variable store capability handler
 */
async function handleVariableAction(params: VariableParams, content?: string): Promise<string> {
  const { action, sessionId = 'default-session' } = params;
  const variableStore = VariableStore.getInstance();

  logger.info(
    `🗃️ Variable handler called - Action: ${action}, SessionId: ${sessionId}, Params:`,
    params
  );

  try {
    switch (action) {
      case 'set': {
        const key = params.key;
        const value = params.value || content;

        if (!key) {
          throw new Error(
            'Please provide a key. Example: <capability name="variable" action="set" key="myvar" value="myvalue" />'
          );
        }

        if (value === undefined) {
          throw new Error(
            'Please provide a value. Example: <capability name="variable" action="set" key="myvar" value="myvalue" />'
          );
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

        variableStore.setVariable(sessionId, String(key), parsedValue);
        return `✅ Variable "${key}" set to: ${typeof parsedValue === 'object' ? JSON.stringify(parsedValue).substring(0, 100) + '...' : parsedValue}`;
      }

      case 'get': {
        const key = params.key;
        if (!key) {
          throw new Error(
            'Please provide a key. Example: <capability name="variable" action="get" key="myvar" />'
          );
        }

        const value = variableStore.getVariable(sessionId, String(key));
        if (value !== undefined) {
          return typeof value === 'object' ? JSON.stringify(value) : String(value);
        } else {
          const availableVars = variableStore.listVariables(sessionId);
          const availableKeys = Object.keys(availableVars);
          const suggestions =
            availableKeys.length > 0
              ? `\n\nAvailable variables: ${availableKeys.join(', ')}`
              : '\n\nNo variables exist in this session. Use action="set" to create one.';
          throw new Error(`Variable "${key}" not found.${suggestions}`);
        }
      }

      case 'interpolate': {
        const template = content || String(params.template || '');
        if (!template) {
          throw new Error(
            'Please provide template content. Example: <capability name="variable" action="interpolate">Hello {{name}}</capability>'
          );
        }

        const interpolated = variableStore.interpolateString(sessionId, template);
        return interpolated;
      }

      case 'list': {
        const variables = variableStore.listVariables(sessionId);
        const keys = Object.keys(variables);

        if (keys.length === 0) {
          return '📭 No variables in current session';
        }

        const varList = keys
          .map((key) => {
            const value = variables[key];
            const preview =
              typeof value === 'object'
                ? JSON.stringify(value).substring(0, 50) + '...'
                : String(value).substring(0, 50);
            return `• ${key}: ${preview}`;
          })
          .join('\n');

        return `📦 Variables in session (${keys.length}):\n${varList}`;
      }

      case 'clear': {
        const key = params.key;
        if (!key) {
          throw new Error(
            'Please provide a key. Example: <capability name="variable" action="clear" key="myvar" />'
          );
        }

        const existed = variableStore.clearVariable(sessionId, String(key));
        if (!existed) {
          const availableVars = variableStore.listVariables(sessionId);
          const availableKeys = Object.keys(availableVars);
          const suggestions =
            availableKeys.length > 0
              ? `\n\nAvailable variables: ${availableKeys.join(', ')}`
              : '\n\nNo variables exist in this session.';
          throw new Error(`Variable "${key}" not found.${suggestions}`);
        }
        return `✅ Variable "${key}" cleared`;
      }

      case 'clear_all': {
        variableStore.clearSession(sessionId);
        return '✅ All variables cleared from session';
      }

      case 'stats': {
        const stats = variableStore.getSessionStats(sessionId);
        if (!stats) {
          throw new Error('Session not found or empty. Create variables with action="set" first.');
        }

        return `📊 Session Stats:
• Variables: ${stats.variableCount}
• Created: ${new Date(stats.created).toLocaleString()}
• Last Access: ${new Date(stats.lastAccess).toLocaleString()}`;
      }

      default:
        throw new Error(
          `Unknown variable action: ${action}. Supported actions: set, get, interpolate, list, clear, clear_all, stats`
        );
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
  supportedActions: ['set', 'get', 'interpolate', 'list', 'clear', 'clear_all', 'stats'],
  description: 'Session-scoped variable store for workflow orchestration',
  handler: handleVariableAction,
  examples: [
    '<capability name="variable" action="set" key="name" value="Coach Artie" />',
    '<capability name="variable" action="get" key="name" />',
    '<capability name="variable" action="interpolate">Hello {{name}}, how are you?</capability>',
    '<capability name="variable" action="list" />',
    '<capability name="variable" action="clear" key="name" />',
    '<capability name="variable" action="clear_all" />',
  ],
};
